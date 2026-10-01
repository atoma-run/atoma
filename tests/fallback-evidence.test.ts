import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { LlmCompletionRequest, LlmCompletionResponse, Result, RunContext, Tool, ToolExecutor } from '../src/core/types.js';

/**
 * A FALLBACK'S RESULT CARRIES WHAT THE TRANSPORT SAW IT DO, AND READS AS DIRECT.
 *
 * Run ff102525 (2026-10-01): a cell's fallback edited the page, deleted a
 * file and ran five browser checks. The tissue's validator was handed its
 * summary, a load-only probe and "Plan kind: DELEGATION", and refused the
 * correct result as unsupported narration; the phase went back to a
 * molecule that spent 999 s adding and removing test fields.
 */

/** What the molecule saw before the cell gave up on it: a stopped timer. */
const MOLECULE_CHECK = {
  ok: true, url: 'http://localhost:5100/', title: 'Focus Timer', errors: [], warnings: [], failedRequests: [],
  interactionLog: ['click #start'], requestedInteractions: 1, ignoredInteractions: 0,
  smokeResult: { ok: true, status: 'Idle' },
};
/** What the fallback saw: P pausing a running countdown. */
const FALLBACK_CHECK = {
  ok: true, url: 'http://localhost:5200/', title: 'Focus Timer', errors: [], warnings: [], failedRequests: [],
  interactionLog: ['click #start', 'press p'], requestedInteractions: 2, ignoredInteractions: 0,
  smokeResult: { ok: true, status: 'Paused' },
};

function tool(name: string): Tool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

/** Answers validate_html by the URL asked for, and the file tools with the page. */
class PageExecutor implements ToolExecutor {
  has(name: string): boolean {
    return ['validate_html', 'read_file', 'list_files', 'edit_file', 'run_shell'].includes(name);
  }
  execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'validate_html') return Promise.resolve(args['url'] === FALLBACK_CHECK.url ? FALLBACK_CHECK : MOLECULE_CHECK);
    if (name === 'run_shell') return Promise.resolve({ exitCode: 0, stdout: 'compiled recipe ran', stderr: '' });
    if (name === 'read_file') return Promise.resolve({ path: String(args['path']), content: '<p class="hint">P pause</p>' });
    if (name === 'list_files') return Promise.resolve({ path: '.', entries: [{ name: 'index.html', kind: 'file', size: 26 }] });
    return Promise.resolve({ ok: true });
  }
}

const TASK = { description: 'Add a P shortcut to index.html and verify it with real keys' };
const WEB_TOOLS = ['write_file', 'edit_file', 'read_file', 'list_files', 'validate_html'].map(tool);
const seed = (description: string) => ({ description, systemPrompt: 's', params: {}, createdBy: 'test', tools: WEB_TOOLS });
const PLAN = makePlan({ reasoning: 'r', proposedAction: 'edit the page, then press the keys', expectedOutput: 'page' });
const LIMITS = { maxPlanIterations: 1, maxExecIterations: 1 };

const reply = (value: unknown): LlmCompletionResponse =>
  ({ text: jsonText(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
const check = (url: string) => ({ url, interactions: [{ type: 'click', selector: '#start' }, { type: 'press', key: 'p' }] });

/**
 * The whole supervision path, answered by role: the cell routes to its
 * molecule, approves its plan, refuses its result, refuses the escalation
 * branch's plan, and falls back; the tissue then judges what came back.
 */
function supervisionLlm(molecule: string) {
  const calls: LlmCompletionRequest[] = [];
  let planVerdicts = 0;
  const llm: RunContext['llm'] = {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      calls.push(req);
      const tier = req.actor?.tier;
      switch (req.role) {
        case 'prefilter':
          return reply({ kind: 'reuse', target: molecule, confidence: 'high', decomposable: false, reasoning: 'a page edit' });
        case 'plan':
          return reply({ reasoning: 'r', proposedAction: 'edit index.html and check it', expectedOutput: 'page' });
        case 'validate-plan':
          return planVerdicts++ === 0
            ? reply({ approved: true, reasoning: 'ok' })
            : reply({ approved: false, reasoning: 'the plan cannot delete server.js', scope: 'ephemeral', modifications: { additionalContext: 'delete it' } });
        case 'execute':
          await req.executor!.execute('validate_html', check(MOLECULE_CHECK.url));
          return reply({ output: { files: ['index.html'] }, summary: 'P added' });
        case 'validate-result':
          return tier === 2
            ? reply({ approved: false, reasoning: 'server.js is still there', scope: 'ephemeral', modifications: { additionalContext: 'delete it' } })
            : reply({ approved: true, reasoning: 'the recorded keys show P pausing' });
        case 'fallback-plan':
          return reply({ reasoning: 'r', proposedAction: 'edit, delete, check', expectedOutput: 'page' });
        case 'fallback-execute':
          await req.executor!.execute('validate_html', check(FALLBACK_CHECK.url));
          return reply({ output: { files: ['index.html'] }, summary: 'P pauses a running countdown; server.js deleted' });
        default:
          throw new Error(`unexpected ${req.role} call`);
      }
    },
  };
  return { llm, calls };
}

function observedTools(result: Result): string[] {
  return (result.evidence ?? []).filter((witness) => witness.source === 'transport-observed').map((witness) => witness.tool);
}

describe('a fallback result at its validator (run ff102525)', () => {
  it("carries a cell fallback's own browser check through supervision, and the tissue reads it as DIRECT", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const molecule = reg.create(1, seed('single-file web builder'));
    const cell = L2Atom.fromType(reg.create(2, seed('web cell')), reg);
    const tissue = L3Atom.buildWithModel(reg.create(3, seed('tissue')), reg, FALLBACK_OPUS);
    const { llm, calls } = supervisionLlm(molecule.name);
    const root: RunContext = { ...makeCtx({ limits: LIMITS }), llm, tools: new PageExecutor() };
    // The tissue's phase branch; the cell forks its subtask's branch below it.
    const phase = forkBranch(root, 'phase');

    const plan = await cell.plan(TASK, phase);
    const result = await cell.execute(TASK, plan, phase);

    expect(calls.map((call) => `${call.actor?.tier}:${call.role}`)).toEqual([
      '2:prefilter', '1:plan', '2:validate-plan', '1:execute', '2:validate-result',
      '1:plan', '2:validate-plan', '2:fallback-plan', '2:fallback-execute',
    ]);
    expect(result.producedBy).toMatchObject({ name: cell.name, viaFallback: true });
    // The molecule's check ran in the same branch; only the fallback's is its evidence.
    expect(observedTools(result)).toEqual(['validate_html']);
    expect((result.evidence ?? []).map((witness) => 'observed' in witness ? witness.observed : '').join('\n'))
      .toContain('"status":"Paused"');

    const verdict = await tissue.validateResult(cell, result, TASK, phase);
    expect(verdict.approved).toBe(true);
    const prompt = calls.at(-1)!.userContent;
    expect(calls.at(-1)!.actor?.tier).toBe(3);
    expect(prompt).toContain('Plan kind: DIRECT');
    expect(prompt).toContain("Child's DECLARED TOOLS (its ONLY executable surface): write_file, edit_file");
    expect(prompt).toContain('== TRANSPORT-OBSERVED TOOL EVIDENCE ==');
    expect(prompt).toContain('smokeResult={"ok":true,"status":"Paused"}');
    expect(prompt).not.toContain('"status":"Idle"');
  });

  it("carries a tissue fallback's own calls, not a cell's earlier ones in its phase", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const tissue = L3Atom.buildWithModel(reg.create(3, seed('tissue')), reg, FALLBACK_OPUS);
    const root = { ...makeCtx(), tools: new PageExecutor() };
    const phase = forkBranch(root, 'phase');
    // A cell's compiled recipe runs on the phase's context before the tissue falls back.
    await phase.tools!.execute('run_shell', { command: 'node', args: ['_skill_x.mjs'] });
    root.llm.enqueue(async (req) => {
      await req.executor!.execute('validate_html', check(FALLBACK_CHECK.url));
      return reply({ output: { files: ['index.html'] }, summary: 'done' });
    });
    tissue.setFallbackMode(true);
    const result = await tissue.execute(TASK, PLAN, phase);
    tissue.setFallbackMode(false);

    expect(result.producedBy.viaFallback).toBe(true);
    expect(observedTools(result)).toEqual(['validate_html']);
  });

  it("keeps a peer's result DELEGATION at the tissue, and a delegating cell's", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const cell = L2Atom.fromType(reg.create(2, seed('web cell')), reg);
    const tissue = L3Atom.buildWithModel(reg.create(3, seed('tissue')), reg, FALLBACK_OPUS);
    const root = { ...makeCtx(), tools: new PageExecutor() };
    const results: Result[] = [
      // Mutualized: the peer's own fallback came back as the cell's result.
      { output: {}, summary: 'served and checked', trace: [], producedBy: { tier: 2, name: 'SomePeer', viaFallback: true } },
      { output: {}, summary: 'done', trace: [], producedBy: { tier: 2, name: cell.name, viaFallback: false } },
    ];
    for (const result of results) {
      root.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
      await tissue.validateResult(cell, result, TASK, root);
      expect(root.llm.calls.at(-1)!.userContent).toContain('Plan kind: DELEGATION');
    }
  });
});
