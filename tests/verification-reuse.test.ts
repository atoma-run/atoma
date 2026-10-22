import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { VERIFICATION_REUSE_GUIDANCE } from '../src/atoms/taskContext.js';
import { createAttestationLog, attestingExecutor } from '../src/core/attestation.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { readFileTool, recordProbeTool } from '../src/tools/builtin.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { LlmCompletionRequest, RunContext, ToolExecutor } from '../src/core/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

describe('verification receipts in the production supervision path', () => {
  let root: string;
  let sandbox: ToolSandbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atoma-verification-reuse-'));
    sandbox = new ToolSandbox(root);
    writeFileSync(join(root, 'value.json'), '{"ready":true}');
    writeFileSync(join(root, 'check.cjs'), [
      "const fs = require('node:fs');",
      "const assert = require('node:assert/strict');",
      "const n = fs.existsSync('check-count.txt') ? Number(fs.readFileSync('check-count.txt', 'utf8')) : 0;",
      "fs.writeFileSync('check-count.txt', String(n + 1));",
      "assert.equal(JSON.parse(fs.readFileSync('value.json', 'utf8')).ready, true);",
      "console.log('actual-ready-assertion: passed');",
    ].join('\n'));
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const builtins = [readFileTool({ sandbox }), recordProbeTool({ sandbox })];
    const tools = builtins.map(tool => tool.declaration);
    const executor: ToolExecutor = {
      has: name => builtins.some(tool => tool.declaration.name === name),
      execute: (name, args) => {
        const tool = builtins.find(candidate => candidate.declaration.name === name);
        if (!tool) throw new Error('undeclared tool');
        return tool.execute(args);
      },
    };
    const db = openDb(':memory:');
    const registry = new AtomRegistry(db);
    const seed = { description: 'Run local checks and report their observations', systemPrompt: 'Perform the assigned checks.', tools, params: {}, createdBy: 'test' };
    const cell = L2Atom.fromType(registry.create(2, seed), registry);
    const molecule = L1Atom.fromType(registry.create(1, seed));
    const attestations = createAttestationLog();
    const ctx = { ...makeCtx(), tools: executor, attestations, requireObservedToolAction: true };
    return { db, ctx, cell, molecule, executor };
  }

  async function observed(request: LlmCompletionRequest, name: string, args: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const result = await request.executor!.execute(name, args);
    request.onToolInvocation?.({ name, args, startedAt, durationMs: Date.now() - startedAt, result });
    return result;
  }
  const response = (summary: string) => ({
    text: jsonText({ output: summary, summary }), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 },
  });
  const plan = { reasoning: 'Use current observations.', proposedAction: 'Read the recorded check and its assertions; complete missing work only.', expectedOutput: 'Actual results.' };

  it('corrects a missing report detail without replaying the successful command', async () => {
    const { db, ctx, cell } = setup();
    try {
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'Fits.' }));
      ctx.llm.enqueueText(jsonText(plan));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Run the actual check.' }));
      ctx.llm.enqueue(async request => {
        await observed(request, 'record_probe', { cmd: 'node check.cjs' });
        return response('Check passed; detailed accounting is missing.');
      });
      ctx.llm.enqueueText(jsonText({
        approved: false, reasoning: 'The report omits the actual assertion result.', scope: 'ephemeral',
        modifications: { additionalContext: 'Complete the reporting gap from existing recorded results and test assertions.' },
      }));
      ctx.llm.enqueue(request => {
        expect(request.userContent).toContain('actual-ready-assertion: passed');
        expect(request.userContent).toContain(VERIFICATION_REUSE_GUIDANCE);
        return { ...response(''), text: jsonText(plan) };
      });
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Inspect the existing receipt and assertions.' }));
      ctx.llm.enqueue(async request => {
        expect(request.userContent).toContain('actual-ready-assertion: passed');
        await observed(request, 'read_file', { path: '.atoma-probes.json' });
        await observed(request, 'read_file', { path: 'check.cjs' });
        return response('node check.cjs exited 0; its real ready=true assertion passed.');
      });
      ctx.llm.enqueue(request => {
        expect(request.role).toBe('validate-result');
        expect(request.userContent).toContain(VERIFICATION_REUSE_GUIDANCE);
        expect(request.userContent).toContain('actual-ready-assertion: passed');
        expect(request.userContent).toContain('assert.equal');
        return { ...response(''), text: jsonText({ approved: true, reasoning: 'The observed process result and actual assertion support the report.' }) };
      });

      const result = await cell.handleDirect({ description: 'Execute node check.cjs and report the actual assertion result.' }, ctx);
      expect(result.trace.filter(entry => entry.kind === 'verdict-result')).toHaveLength(2);
      expect(readFileSync(join(root, 'check-count.txt'), 'utf8')).toBe('1');
      expect(ctx.llm.calls.filter(call => call.role === 'validate-result')).toHaveLength(2);
    } finally { db.close(); }
  });

  it('executes the check again after source changes and refuses its now-failing result', async () => {
    const { db, ctx, cell, molecule, executor } = setup();
    const scoped: RunContext = {
      ...ctx, tools: attestingExecutor(executor, ctx.attestations, undefined, undefined, 1),
    };
    const task = { description: 'Require node check.cjs to pass on the final value.json and report its result.' };
    try {
      ctx.llm.enqueue(async request => {
        await observed(request, 'record_probe', { cmd: 'node check.cjs' });
        return response('The ready assertion passed.');
      });
      await molecule.execute(task, makePlan(), scoped);
      writeFileSync(join(root, 'value.json'), '{"ready":false}');
      ctx.llm.enqueue(async request => {
        expect(request.userContent).toContain('actual-ready-assertion: passed');
        expect(request.userContent).toContain('unknown freshness requires verification');
        const raw = await observed(request, 'record_probe', { cmd: 'node check.cjs' }) as { exitCode: number };
        expect(raw.exitCode).not.toBe(0);
        return response('Final source still fails the required ready assertion.');
      });
      const result = await molecule.execute(task, makePlan(), scoped);
      const verdict = await cell.validateResult(molecule, result, task, scoped);
      expect(verdict.approved).toBe(false);
      expect(readFileSync(join(root, 'check-count.txt'), 'utf8')).toBe('2');
      const manifest = JSON.parse(readFileSync(join(root, '.atoma-probes.json'), 'utf8')) as { entries: { exitCode: number }[] };
      expect(manifest.entries[0]!.exitCode).not.toBe(0);
    } finally { db.close(); }
  });

  it('does not turn a receipt into a current tool action or bypass the zero-action gate', async () => {
    const { db, ctx, cell, molecule } = setup();
    const task = { description: 'Verify the ready assertion and report its result.' };
    try {
      ctx.llm.enqueue(async request => {
        await observed(request, 'record_probe', { cmd: 'node check.cjs' });
        return response('First check passed.');
      });
      await molecule.execute(task, makePlan(), ctx);
      ctx.llm.enqueue(request => {
        expect(request.userContent).toContain('actual-ready-assertion: passed');
        return response('Claimed current verification without reading or executing anything.');
      });
      const result = await molecule.execute(task, makePlan(), ctx);
      expect(result.toolCallResults).toEqual([]);
      expect((await cell.validateResult(molecule, result, task, ctx)).approved).toBe(false);
      expect(readFileSync(join(root, 'check-count.txt'), 'utf8')).toBe('1');
    } finally { db.close(); }
  });
});
