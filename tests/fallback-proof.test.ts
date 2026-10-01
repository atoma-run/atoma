import { describe, it, expect } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { keptWithoutSynthesis } from '../src/atoms/dispatch.js';
import { FALLBACK_PROOF_TURN_MIN_MS } from '../src/atoms/fallbackProof.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { PhaseCoverageRecord } from '../src/contracts/depthRouting.js';
import type { JevDecider, LlmCompletionRequest, LlmCompletionResponse, Result, RunContext, Tool, ToolExecutor } from '../src/core/types.js';
import type { SupervisionHooks } from '../src/core/supervisor.js';

/**
 * A FALLBACK HEARS ITS PHASE'S PROOF OBLIGATION, PROVES IT, OR EARNS NOTHING
 * (owner decision 2026-10-01). Until then a cell or tissue that executed a
 * phase itself never read the phase's `dom-interaction` obligation, nobody
 * checked its calls against it, and the tissue credited the cell anyway.
 */

/** A browser check: real interactions when the call sent some, none otherwise. */
function browserCheck(args: Record<string, unknown>) {
  const interactions = Array.isArray(args['interactions']) ? (args['interactions'] as unknown[]) : [];
  return {
    ok: true, url: String(args['url']), title: 'Focus Timer', errors: [], warnings: [], failedRequests: [],
    interactionLog: interactions.map((_, index) => `click #control-${index}`),
    requestedInteractions: interactions.length, ignoredInteractions: 0,
    smokeResult: { ok: true, status: interactions.length > 0 ? 'Paused' : 'Ready' },
  };
}

class PageExecutor implements ToolExecutor {
  has(name: string): boolean {
    return ['validate_html', 'read_file', 'list_files', 'edit_file', 'start_static_server'].includes(name);
  }
  execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'validate_html') return Promise.resolve(browserCheck(args));
    if (name === 'start_static_server') return Promise.resolve({ ok: true, url: 'http://localhost:4100/' });
    if (name === 'read_file') return Promise.resolve({ path: String(args['path']), content: '<p class="hint">P pause</p>' });
    if (name === 'list_files') return Promise.resolve({ path: '.', entries: [{ name: 'index.html', kind: 'file', size: 26 }] });
    return Promise.resolve({ ok: true });
  }
}

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const WEB_TOOLS = ['write_file', 'edit_file', 'read_file', 'list_files', 'start_static_server', 'validate_html'].map(tool);
const seed = (description: string) => ({ description, systemPrompt: 's', params: {}, createdBy: 'test', tools: WEB_TOOLS });
const TASK = { description: 'Add a P shortcut to index.html and prove it with real keys', proofObligations: ['dom-interaction' as const] };
const LIMITS = { maxPlanIterations: 1, maxExecIterations: 1 };
const reply = (value: unknown): LlmCompletionResponse => ({ text: jsonText(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
const REAL_KEYS = { url: 'http://localhost:4100/', interactions: [{ type: 'click', selector: '#start' }, { type: 'keypress', key: 'p' }] };
const SMOKE_ONLY = { url: 'http://localhost:4100/', smoke: '(() => ({ ok: true }))()' };

/** The cell routes to its molecule, refuses its result and the branch's plan, and falls back. */
function supervisionLlm(molecule: string, opts: { proofTurnKeys: boolean }) {
  const calls: LlmCompletionRequest[] = [];
  let planVerdicts = 0;
  const llm: RunContext['llm'] = {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      calls.push(req);
      switch (req.role) {
        case 'prefilter':
          return reply({ kind: 'reuse', target: molecule, confidence: 'high', decomposable: false, reasoning: 'a page edit' });
        case 'plan':
          return reply({ reasoning: 'r', proposedAction: 'edit index.html and check it', expectedOutput: 'page' });
        case 'validate-plan':
          return planVerdicts++ === 0
            ? reply({ approved: true, reasoning: 'ok' })
            : reply({ approved: false, reasoning: 'the plan repeats the failure', scope: 'ephemeral', modifications: { additionalContext: 'x' } });
        case 'execute':
          // The molecule pressed real keys before the cell gave up on it: that is not the fallback's proof.
          await req.executor!.execute('validate_html', REAL_KEYS);
          return reply({ output: { files: ['index.html'] }, summary: 'P added' });
        case 'validate-result':
          return reply({ approved: false, reasoning: 'the hint line is wrong', scope: 'ephemeral', modifications: { additionalContext: 'x' } });
        case 'fallback-plan':
          return reply({ reasoning: 'r', proposedAction: 'edit and check', expectedOutput: 'page' });
        case 'fallback-execute':
          if (req.userContent.startsWith('PROOF STILL MISSING')) {
            if (opts.proofTurnKeys) await req.executor!.execute('validate_html', REAL_KEYS);
            return reply({ output: { checked: 'P' }, summary: 'P pauses a running countdown, pressed for real' });
          }
          await req.executor!.execute('validate_html', SMOKE_ONLY);
          return reply({ output: { files: ['index.html'] }, summary: 'P added; the page loads' });
        default:
          throw new Error(`unexpected ${req.role} call`);
      }
    },
  };
  return { llm, calls };
}

function supervise(opts: { proofTurnKeys: boolean; deadlineAt?: number }) {
  const reg = new AtomRegistry(openDb(':memory:'));
  const molecule = reg.create(1, seed('single-file web builder'));
  const cell = L2Atom.fromType(reg.create(2, seed('web cell')), reg);
  const { llm, calls } = supervisionLlm(molecule.name, opts);
  const coverage: PhaseCoverageRecord[] = [];
  const root: RunContext = {
    ...makeCtx({ limits: LIMITS }), llm, tools: new PageExecutor(),
    recordPhaseCoverage: (record) => coverage.push(record),
    ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
  };
  return { reg, cell, calls, coverage, phase: forkBranch(root, 'phase') };
}

describe("a fallback's proof obligation", () => {
  it('is heard, checked on its own calls, and proven in one more turn when missing', async () => {
    const { cell, calls, coverage, phase } = supervise({ proofTurnKeys: true });
    const plan = await cell.plan(TASK, phase);
    const result = await cell.execute(TASK, plan, phase);

    const fallbackCalls = calls.filter((call) => call.role === 'fallback-execute');
    expect(fallbackCalls).toHaveLength(2);
    // Level 1: the fallback reads the obligation a molecule reads.
    expect(fallbackCalls[0]!.userContent).toContain('PROOF OBLIGATION "dom-interaction"');
    // Level 2: its smoke-only check proved nothing, the molecule's keys are not its own, so one proof turn ran.
    expect(fallbackCalls[1]!.userContent).toMatch(/^PROOF STILL MISSING/);
    expect(fallbackCalls[1]!.userContent).toContain('dom-interaction NOT covered');
    // The deliverable stays the first turn's; the proof turn's observation is added to its summary.
    expect(result.output).toEqual({ files: ['index.html'] });
    expect(result.summary).toBe('P added; the page loads\n[proof turn] P pauses a running countdown, pressed for real');
    expect(fallbackCalls[1]!.userContent).toContain('You served the page at http://localhost:4100/');
    expect(result.proofCoverage).toMatchObject([{ obligation: 'dom-interaction', covered: true }]);
    expect(coverage.at(-1)).toMatchObject({ executor: { name: cell.name, tier: 2 }, obligations: [{ covered: true }] });
  });

  it('stays uncovered when the proof turn presses nothing, and the result says so', async () => {
    const { cell, coverage, phase } = supervise({ proofTurnKeys: false });
    const result = await cell.execute(TASK, await cell.plan(TASK, phase), phase);
    expect(result.proofCoverage).toMatchObject([{ covered: false }]);
    expect(coverage.at(-1)).toMatchObject({ executor: { name: cell.name }, obligations: [{ covered: false }] });
  });

  it('gets no proof turn when the run deadline leaves no room for one', async () => {
    const { cell, calls, phase } = supervise({ proofTurnKeys: true, deadlineAt: Date.now() + FALLBACK_PROOF_TURN_MIN_MS - 30_000 });
    const result = await cell.execute(TASK, await cell.plan(TASK, phase), phase);
    expect(calls.filter((call) => call.role === 'fallback-execute')).toHaveLength(1);
    expect(result.proofCoverage).toMatchObject([{ covered: false }]);
  });

  it('withholds the cell its trust at the tissue, past the trust and Jev fast paths', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const cellType = reg.create(2, seed('web cell'));
    for (let i = 0; i < 3; i++) reg.recordSuccess(cellType.name, 'test', cellType.version);
    const cell = L2Atom.fromType(reg.getByName(cellType.name)!, reg);
    const tissue = L3Atom.buildWithModel(reg.create(3, seed('tissue')), reg, FALLBACK_OPUS);
    const root = { ...makeCtx(), tools: new PageExecutor() };
    const stats: string[] = [];
    const approvingJev: JevDecider = {
      choose: () => Promise.resolve(null),
      approve: () => Promise.resolve({ approved: true, probability: 0.99 }),
      twin: () => Promise.resolve(null),
    };
    const ctx: RunContext = { ...root, jev: approvingJev, recordRunStat: (name) => stats.push(name) };
    const uncovered: Result = {
      output: { files: ['index.html'] }, summary: 'P added', trace: [],
      producedBy: { tier: 2, name: cell.name, viaFallback: true },
      proofCoverage: [{ obligation: 'dom-interaction', covered: false, reason: 'dom-interaction NOT covered: no browser observation was attested for this phase.', eventIds: [] }],
    };
    root.llm.enqueueText(jsonText({ approved: true, reasoning: 'the page is right' }));
    const verdict = await tissue.validateResult(cell, uncovered, TASK, ctx);
    // A trusted cell would have skipped the model: an uncovered proof sends it there.
    expect(root.llm.calls).toHaveLength(1);
    expect(root.llm.calls[0]!.userContent).toContain('== DECLARED PROOF OBLIGATIONS (supervisor-held attestation) ==');
    expect(verdict).toMatchObject({ approved: true, proofUncovered: true });

    const before = reg.getByName(cell.name)!.successes;
    const hooks = (tissue as unknown as { makeL2Hooks(ctx: RunContext, description: string): SupervisionHooks<L2Atom> }).makeL2Hooks(ctx, 'phase');
    await hooks.onApproved!(cell, uncovered, verdict);
    expect(reg.getByName(cell.name)!.successes).toBe(before);
    expect(stats).toContain('uncovered-obligation');
  });

  it("is heard and proven by a tissue's fallback too", async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const tissue = L3Atom.buildWithModel(reg.create(3, seed('tissue')), reg, FALLBACK_OPUS);
    const root = { ...makeCtx(), tools: new PageExecutor() };
    root.llm.enqueue(async (req) => {
      expect(req.userContent).toContain('PROOF OBLIGATION "dom-interaction"');
      await req.executor!.execute('validate_html', SMOKE_ONLY);
      return reply({ output: { files: ['index.html'] }, summary: 'done' });
    });
    root.llm.enqueue(async (req) => {
      expect(req.userContent).toMatch(/^PROOF STILL MISSING/);
      await req.executor!.execute('validate_html', REAL_KEYS);
      return reply({ output: {}, summary: 'pressed' });
    });
    tissue.setFallbackMode(true);
    const result = await tissue.execute(TASK, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }), forkBranch(root, 'phase'));
    tissue.setFallbackMode(false);
    expect(result.proofCoverage).toMatchObject([{ covered: true }]);
    expect(result.output).toEqual({ files: ['index.html'] });
  });

  it('lets a cancellation during the proof turn through, and counts a tool-less fallback as unproven', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const cell = L2Atom.fromType(reg.create(2, seed('web cell')), reg);
    const controller = new AbortController();
    const root = { ...makeCtx(), signal: controller.signal, tools: new PageExecutor() };
    root.llm.enqueue(async (req) => {
      await req.executor!.execute('validate_html', SMOKE_ONLY);
      return reply({ output: {}, summary: 'done' });
    });
    root.llm.enqueue(() => {
      controller.abort(new Error('cancelled by the user'));
      return Promise.reject(new Error('cancelled by the user'));
    });
    cell.setFallbackMode(true);
    await expect(cell.execute(TASK, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }), forkBranch(root, 'phase'))).rejects.toThrow('cancelled');
    cell.setFallbackMode(false);

    const bare = L2Atom.fromType(reg.create(2, { ...seed('reasoning cell'), tools: [] }), reg);
    const plain = makeCtx();
    plain.llm.enqueueText(jsonText({ output: 'advice', summary: 'reasoned' }));
    bare.setFallbackMode(true);
    const unproven = await bare.execute(TASK, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }), plain);
    bare.setFallbackMode(false);
    expect(unproven.proofCoverage).toMatchObject([{ covered: false, reason: 'dom-interaction NOT covered: the fallback held no tools.' }]);
  });

  it('rides an aggregate up to the tier that judges it', () => {
    const covered = { obligation: 'dom-interaction' as const, covered: false, reason: 'r', eventIds: [] };
    const fallback: Result = { output: 1, summary: 'a', trace: [], producedBy: { tier: 2, name: 'Cell', viaFallback: true }, proofCoverage: [covered] };
    const molecule: Result = { output: 2, summary: 'b', trace: [], producedBy: { tier: 1, name: 'Water', viaFallback: false } };
    expect(keptWithoutSynthesis([fallback, molecule], { tier: 2, name: 'Cell', viaFallback: false }, 'cut').proofCoverage).toEqual([covered]);
  });

  it('asks nothing of a fallback whose phase declared none', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const cell = L2Atom.fromType(reg.create(2, seed('web cell')), reg);
    const root = { ...makeCtx(), tools: new PageExecutor() };
    root.llm.enqueue(async (req) => {
      await req.executor!.execute('validate_html', SMOKE_ONLY);
      return reply({ output: {}, summary: 'done' });
    });
    cell.setFallbackMode(true);
    const result = await cell.execute({ description: 'tidy the page' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }), forkBranch(root, 'phase'));
    cell.setFallbackMode(false);
    expect(root.llm.calls).toHaveLength(1);
    expect(root.llm.calls[0]!.userContent).not.toContain('PROOF OBLIGATION');
    expect(result.proofCoverage).toBeUndefined();
  });
});
