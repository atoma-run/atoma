import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { ASSERTION_EVIDENCE_GUIDANCE } from '../src/atoms/prompts.js';
import { renderTransportEvidence, llmVerdict } from '../src/atoms/verdict.js';
import { remediationTask } from '../src/run/depth.js';
import { delegatedTaskContext } from '../src/atoms/taskContext.js';
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

  it('carries a real contrasting outcome through validation and a fresh remediation planner without replay', async () => {
    const { db, ctx, cell, molecule, executor } = setup();
    const scoped = { ...ctx, tools: attestingExecutor(executor, ctx.attestations, undefined, undefined, 1) };
    const task = { description: 'Prove the ready assertion rejects false, then restore true.' };
    try {
      ctx.llm.enqueue(async request => {
        writeFileSync(join(root, 'value.json'), '{"ready":false}');
        expect((await observed(request, 'record_probe', { cmd: 'node check.cjs', note: 'negative control' }) as { exitCode: number }).exitCode).toBe(1);
        writeFileSync(join(root, 'value.json'), '{"ready":true}');
        await observed(request, 'record_probe', { cmd: 'node check.cjs', note: 'restored' });
        return response('Both outcomes were observed; final source restored.');
      });
      const result = await molecule.execute(task, makePlan(), scoped);
      const rendered = renderTransportEvidence(result.evidence);
      expect(rendered.lines.join('\n')).toContain('observed exitCode=1');
      expect(rendered.lines.join('\n')).toContain('observed exitCode=0');
      expect(rendered.lines.join('\n')).toContain('EARLIER CONTRASTING OUTCOME');
      ctx.llm.enqueue(request => {
        expect(request.userContent).toContain('observed exitCode=1');
        expect(request.userContent).toContain('observed exitCode=0');
        expect(request.systemPrompt).toContain(ASSERTION_EVIDENCE_GUIDANCE);
        expect(request.systemPrompt).toContain('including when a version guard correctly discards it');
        return { ...response(''), text: jsonText({ approved: false, reasoning: 'An additional required assertion is absent.' }) };
      });
      // Keeping a negative control cannot automatically approve missing coverage.
      const verdict = await llmVerdict({ ctx: scoped, model: 'test', supervisorName: cell.name,
        supervisorTier: 2, child: molecule, task, subject: 'RESULT', payload: result,
        evidence: result.evidence, groundTruthBlock: '' });
      expect(verdict.approved).toBe(false);
      const retry = remediationTask(task, { approved: false, reasoning: verdict.reasoning,
        attempt: 1, acceptor: { name: 'root', tier: 3, role: 'root-acceptor' },
        executor: { name: molecule.name, tier: 1, viaFallback: false }, phaseCoverage: [], basis: 'validation-call',
        floorCoverage: [], gates: [], probe: { requiresReview: false, contradiction: false } }, result);
      const nested = { description: task.description, ...delegatedTaskContext(retry, { description: task.description }) };
      const fresh = new L1Atom({ name: 'Fresh', ordinal: 1, systemPrompt: 'Repair the missing assertion.', tools: [], params: {} });
      ctx.llm.enqueue(request => {
        expect(request.userContent).toContain('observed exitCode=1');
        expect(request.userContent).toContain('observed exitCode=0');
        expect(request.userContent).toContain('select the affected test case');
        expect(request.userContent).toContain('not a reason to rerun an unchanged passing baseline');
        return { ...response(''), text: jsonText(plan) };
      });
      await fresh.plan(nested, scoped);
      expect(readFileSync(join(root, 'check-count.txt'), 'utf8')).toBe('2');
    } finally { db.close(); }
  });

  it.each(['guarded', 'guard-removed', 'concurrent'] as const)('executes the temporal boundary counterexample: %s', async mode => {
    const { db, ctx, molecule, executor } = setup();
    const scoped = { ...ctx, tools: attestingExecutor(executor, ctx.attestations, undefined, undefined, 1) };
    // Reduced asynchronous consumer from the incident: a later request is a
    // completion boundary only when the refresh loop serializes handlers.
    writeFileSync(join(root, 'temporal.cjs'), `
      const assert = require('node:assert/strict');
      const gate = () => { let release; const promise = new Promise(r => release = r); return { promise, release }; };
      const mode = process.argv[2];
      const old = gate(), fresh = gate(), started = gate();
      let view = 'action', processed = false, freshReleased = false;
      async function handleOld() {
        await old.promise;
        if (mode === 'guard-removed') view = 'stale';
        processed = true;
      }
      async function handleFresh() {
        started.release();
        await fresh.promise;
        freshReleased = true;
        view = 'fresh';
      }
      async function main() {
        const pendingOld = handleOld();
        const pending = mode === 'concurrent'
          ? Promise.all([pendingOld, handleFresh()])
          : pendingOld.then(handleFresh);
        if (mode !== 'concurrent') old.release();
        await started.promise;
        try {
          assert.equal(processed, true, 'later request must follow old handler completion');
          assert.equal(freshReleased, false, 'fresh response must still be gated');
          assert.equal(view, 'action', 'stale response must not overwrite action');
          console.log('OLD_PROCESSED_FRESH_BLOCKED');
        } finally {
          old.release(); fresh.release(); await pending;
        }
        assert.equal(view, 'fresh');
      }
      main().catch(error => { console.error(error.message); process.exitCode = 1; });
    `);
    try {
      ctx.llm.enqueue(async request => {
        const outcome = await observed(request, 'record_probe', { cmd: `node temporal.cjs ${mode}` }) as { exitCode: number; stdout: string; stderr: string };
        expect(outcome.exitCode).toBe(mode === 'guarded' ? 0 : 1);
        if (mode === 'guarded') expect(outcome.stdout).toContain('OLD_PROCESSED_FRESH_BLOCKED');
        else expect(outcome.stderr).toContain(mode === 'concurrent'
          ? 'later request must follow old handler completion' : 'stale response must not overwrite action');
        return response('Report the actual temporal boundary outcome.');
      });
      const result = await molecule.execute({ description: 'Verify temporal preservation before fresh release.' }, makePlan(), scoped);
      expect(renderTransportEvidence(result.evidence).lines.join('\n')).toContain(`observed exitCode=${mode === 'guarded' ? 0 : 1}`);
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
