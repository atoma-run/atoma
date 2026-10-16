import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockOtherProofReview } from './helpers/delegationReview.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { DEPENDENCY_LANDING_GUIDANCE, LANDED_RESULT_GUIDANCE } from '../src/atoms/prompts.js';
import { createAttestationLog } from '../src/core/attestation.js';
import { POST_APPROVAL_LLM_TIMEOUT_MS } from '../src/atoms/cost.js';
import { PHASE_BUDGET_SPENT_PREFIX } from '../src/core/phaseBudget.js';
import { parentTestSuiteDigest, type HeldParentTestObservation, type ParentTestSuite } from '../src/contracts/parentTests.js';
import { isLanded, landingReasons } from '../src/contracts/runLanding.js';
import type { AcceptanceInfo } from '../src/contracts/depthRouting.js';
import type { ApprovedLesson } from '../src/contracts/skillLearning.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { ValidationError } from '../src/core/errors.js';
import { LearningQueue } from '../src/skills/learningQueue.js';
import { DEPENDENCY_LANDING_INPUT, remediationTask, runDepthTask } from '../src/run/depth.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { Atom, type Supervisor } from '../src/core/atom.js';
import type { LlmCompletionRequest, Plan, Result, RunContext, Task, ToolExecutor, Verdict } from '../src/core/types.js';
import { jsonText, jsonTextPair, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

/**
 * A REFUSED DEPENDENCY LANDS INSTEAD OF FAILING THE RUN (review 2026-10-16,
 * group B), through the real tissue, cell and molecules over a mocked model.
 *
 * Until then a dependent whose producer failed its typed checks threw, and the
 * throw escaped every supervise loop (they catch only escalations): the run
 * recorded `failed`, discarded the branches that had completed and seeded
 * nothing — `6ab0ae3b`'s loss again. Now the producer is kept and judged, its
 * dependents are named unfinished, and a cell whose own fallback held them
 * back hands its whole phase up once instead of running its ladder again.
 */

const ADD_SUITE: ParentTestSuite = {
  requirement: 'add returns the sum of its arguments',
  cwd: '.',
  source: "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});",
};

const ROOT_SUITE: ParentTestSuite = {
  requirement: 'the CLI prints sums',
  cwd: '.',
  source: "import { test, expect } from 'vitest';\nimport { run } from './cli.ts';\ntest('prints', () => {\n  expect(run(['2', '3'])).toBe('5');\n});",
};

const FAILED_DETAILS = JSON.stringify(['', { name: 'adds', status: 'failed', failures: ['AssertionError: expected 6 to be 5'] }]);

/** The fixed runner's shell, answering every suite it is handed with a failure. */
function failingSuites(): ToolExecutor & { readonly suites: string[] } {
  const suites: string[] = [];
  return {
    suites,
    has: (name) => name === 'run_shell',
    execute: async (name, args) => {
      if (name !== 'run_shell' || args['command'] !== 'atoma-verify') return {};
      const suite = JSON.parse((args['args'] as string[])[0]!) as ParentTestSuite;
      suites.push(suite.requirement);
      return {
        suiteDigest: parentTestSuiteDigest(suite), workspaceDigest: 'w'.repeat(64), status: 'failed', cause: 'ran',
        passed: 0, failed: 1, skipped: 0, details: FAILED_DETAILS,
      };
    },
  };
}

const ok = (text: string) => ({ text, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });
const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };

/**
 * One model for every tier. The root plan and each cell plan are the test's;
 * every molecule and fallback writes nothing and reports; every plan is
 * approved, and every result a model is asked about is approved too, so any
 * refusal below is the host's typed gate, never a model's.
 */
function model(options: { rootPlan: Plan; cellPlans: Record<string, Plan> }) {
  const executions: string[] = [];
  const respond = (req: LlmCompletionRequest) => {
    const tier = req.actor?.tier;
    if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
    if (req.role === 'plan' && tier === 3) {
      return ok(jsonTextPair({ strategy: 'reuse', target: 'Tracheid', reasoning: 'r' }, options.rootPlan));
    }
    if (req.role === 'plan' && tier === 2) {
      const phase = Object.keys(options.cellPlans).find((description) => req.userContent.includes(description));
      if (!phase) throw new Error('the fixture has no cell plan for this phase');
      return ok(jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'r' }, options.cellPlans[phase]));
    }
    if (req.role === 'plan' || req.role === 'fallback-plan') {
      return ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'files' }));
    }
    if (req.role === 'execute' || req.role === 'fallback-execute') {
      executions.push(req.userContent);
      return ok(jsonText({ output: { done: true }, summary: `execution ${executions.length}` }));
    }
    if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) }));
    return ok(jsonText({ approved: true, reasoning: 'reviewed and approved' }));
  };
  return { respond, executions };
}

/** The run's root actor where the test supplies the result itself. */
class RootActor extends Atom implements Supervisor<RootActor> {
  readonly model = 'test';
  readonly tier = 3 as const;
  constructor() {
    super({ name: 'actor-3', ordinal: 1, systemPrompt: '', tools: makeTools(['read_file']), params: {} });
  }
  async plan(): Promise<Plan> {
    return makePlan();
  }
  async execute(): Promise<Result> {
    return { output: null, summary: 'root', trace: [], producedBy: { tier: 3, name: 'actor-3', viaFallback: false } };
  }
  async validatePlan(): Promise<Verdict> {
    return { approved: true, reasoning: 'fixture' };
  }
  async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'fixture' };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

function ran(executions: readonly string[], description: string): number {
  return executions.filter((content) => content.includes(description)).length;
}

describe('a cell whose own fallback failed its suite, under a root phase', () => {
  let reg: AtomRegistry;
  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
  });

  const phase = 'build the adder';
  const a = { description: 'write add.ts', preferredChild: 'Water', acceptanceTests: ADD_SUITE };
  const b = { description: 'wire add into the CLI', preferredChild: 'Water', dependsOn: [0] };
  const c = { description: 'write the changelog', preferredChild: 'Water' };

  it.each([
    ['[A, B dependsOn A]', [a, b]],
    ['[A, C, B dependsOn A]', [a, c, { ...b, dependsOn: [0] }]],
  ] as const)('%s: B never runs, the cell ladder runs once, and the whole phase goes up spent', async (_shape, subtasks) => {
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const tools = failingSuites();
    const ctx = { ...makeCtx(), tools, rootAcceptance: true as const };
    const fixture = model({
      rootPlan: { reasoning: 'one phase', subtasks: [{ description: phase, preferredChild: 'Tracheid' }], aggregation: { mode: 'sequential' }, expectedOutput: 'adder' },
      cellPlans: { [phase]: { reasoning: 'branches', subtasks: [...subtasks], aggregation: { mode: 'concat' }, expectedOutput: 'adder' } },
    });
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(fixture.respond);

    const result = await tissue.handle({ description: phase }, ctx);

    const llm = ctx.llm;
    expect(ran(fixture.executions, b.description)).toBe(0);
    expect(llm.calls.filter((req) => req.role === 'plan' && req.actor?.tier === 2)).toHaveLength(1);
    expect(llm.calls.filter((req) => req.role === 'fallback-plan' && req.actor?.tier === 2)).toHaveLength(1);
    expect(result.phaseBudgetSpent).toBe(true);
    expect(result.summary).toContain(PHASE_BUDGET_SPENT_PREFIX);
    expect(result.blockedPhases).toHaveLength(1);
    expect(result.blockedPhases![0]).toMatch(/^wire add into the CLI \(not started: its prerequisite "write add\.ts" failed its parent-owned acceptance suite\)$/);
    expect(result.unfinishedPhases).toEqual(result.blockedPhases);
    // The tissue refused the phase with its typed gate, never a model call.
    expect(llm.calls.filter((req) => req.role === 'validate-result' && req.actor?.tier === 3)).toHaveLength(0);
    expect(isLanded(result)).toBe(true);
  });
});

/** The run's root: its plan has its own integration suite, and its second phase depends on the first. */
describe('a root plan whose first phase failed its typed checks', () => {
  let reg: AtomRegistry;
  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
  });

  const p1 = 'build the adder';
  const p2 = 'build the CLI on the adder';
  const rootPlan: Plan = {
    reasoning: 'two phases', aggregation: { mode: 'concat' }, expectedOutput: 'cli', acceptanceTests: ROOT_SUITE,
    subtasks: [
      { description: p1, preferredChild: 'Tracheid', outputs: ['add.ts'] },
      { description: p2, preferredChild: 'Tracheid', outputs: ['cli.ts'], dependsOn: [0] },
    ],
  };
  const cellPlans = {
    [p1]: { reasoning: 'one file', subtasks: [{ description: 'write add.ts', preferredChild: 'Water', acceptanceTests: ADD_SUITE }], aggregation: { mode: 'concat' as const }, expectedOutput: 'add.ts' },
    [p2]: { reasoning: 'one file', subtasks: [{ description: 'write cli.ts', preferredChild: 'Water' }], aggregation: { mode: 'concat' as const }, expectedOutput: 'cli.ts' },
  };

  it('keeps the phase, never starts its dependent, and does not run the root suite', async () => {
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const tools = failingSuites();
    const ctx = { ...makeCtx(), tools, rootAcceptance: true as const };
    const fixture = model({ rootPlan, cellPlans });
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(fixture.respond);

    const result = await tissue.handle({ description: 'Build a CLI that adds' }, ctx);

    expect(ran(fixture.executions, 'write cli.ts')).toBe(0);
    expect(result.blockedPhases).toEqual([
      `${p2} (not started: its prerequisite "${p1}" failed its parent-owned acceptance suite)`,
    ]);
    expect(tools.suites).not.toContain(ROOT_SUITE.requirement);
    const root = result.parentTests?.find((observation) => observation.suite?.requirement === ROOT_SUITE.requirement);
    expect(root).toMatchObject({ status: 'unavailable', cause: 'landing' });
    expect(result.summary).toMatch(/^INCOMPLETE — 1 phase\(s\) were not started because a phase they depend on failed its typed checks/);
  });

  it('is refused mechanically at the root, gets one remediation pass with the typed facts, then lands partial', async () => {
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const tools = failingSuites();
    const ctx = { ...makeCtx(), tools };
    const fixture = model({ rootPlan, cellPlans });
    for (let i = 0; i < 800; i++) ctx.llm.enqueue(fixture.respond);
    const tasks: Task[] = [];
    const acceptances: { approved: boolean; basis: string }[] = [];

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onApproved: vi.fn(),
      onAcceptance: (acceptance) => { acceptances.push(acceptance); },
      createExecutor: () => ({
        actor: tissue,
        handle: async (task: Task, passCtx: RunContext) => {
          tasks.push(task);
          return tissue.handle(task, passCtx);
        },
      }),
    });

    expect(acceptances.map((acceptance) => [acceptance.approved, acceptance.basis])).toEqual([[false, 'mechanical'], [false, 'mechanical']]);
    const llm = ctx.llm;
    expect(llm.calls.some((req) => req.actor?.name === 'run-root')).toBe(false);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.inputs?.[DEPENDENCY_LANDING_INPUT]).toBeUndefined();
    const landing = tasks[1]!.inputs?.[DEPENDENCY_LANDING_INPUT] as { notStarted: string[]; checks: { status: string; requirement?: string; details: string }[]; instruction: string };
    expect(landing.notStarted).toEqual([`${p2} (not started: its prerequisite "${p1}" failed its parent-owned acceptance suite)`]);
    expect(landing.checks).toContainEqual(expect.objectContaining({ status: 'failed', requirement: ADD_SUITE.requirement }));
    expect(landing.checks.find((entry) => entry.status === 'failed')!.details).toContain('expected 6 to be 5');
    expect(landing.instruction).toContain('Do not edit or bypass the suites');
    expect(ran(fixture.executions, 'write cli.ts')).toBe(0);
    expect(outcome.refusal).toBeDefined();
    expect(outcome.blockedPhases).toHaveLength(1);
    expect(isLanded(outcome)).toBe(true);
  });
});

describe('root acceptance of a dependency landing', () => {
  const rootCtx = () => ({ ...makeCtx(), tools: { has: () => false, execute: async () => ({}) } as ToolExecutor, attempt: 1, attestations: createAttestationLog() });
  const entry = 'wire add (not started: its prerequisite "write add.ts" was not approved and its parent-owned suite did not pass)';
  const judgedUnavailable: HeldParentTestObservation = {
    suiteDigest: parentTestSuiteDigest(ADD_SUITE), suite: ADD_SUITE, workspaceDigest: 'w', status: 'unavailable', cause: 'runner-error',
    passed: 0, failed: 0, skipped: 0, details: 'worker crashed', judged: true,
  };
  const landed = (extra: Partial<Result>): Result => ({
    output: { files: ['add.ts'] }, summary: 'INCOMPLETE — …', trace: [], producedBy: { tier: 3, name: 'actor-3', viaFallback: false }, ...extra,
  });
  const accept = (ctx: ReturnType<typeof rootCtx>, result: Result) => acceptRootResult({
    actor: new RootActor(), task: { description: 'Build the adder' }, result, ctx,
    floor: [], phaseCoverage: [],
  });

  it('is never approved mechanically, and its judge hears what a dependency landing is', async () => {
    const ctx = rootCtx();
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'the adder phase is unproven' }));

    const accepted = await accept(ctx, landed({ unfinishedPhases: [entry], blockedPhases: [entry], parentTests: [judgedUnavailable] }));

    expect(accepted.basis).toBe('validation-call');
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).toContain(DEPENDENCY_LANDING_GUIDANCE);
    expect(ctx.llm.calls[0]!.userContent).not.toContain('== THIS RESULT LANDED ON THE RUN BUDGET ==');
  });

  it('carries both blocks for a landing that is both', async () => {
    const mixed = rootCtx();
    mixed.llm.enqueueText(jsonText({ approved: false, reasoning: 'incomplete' }));

    await accept(mixed, landed({ unfinishedPhases: ['package', entry], blockedPhases: [entry] }));

    expect(mixed.llm.calls[0]!.userContent).toContain(DEPENDENCY_LANDING_GUIDANCE);
    expect(mixed.llm.calls[0]!.userContent).toContain(LANDED_RESULT_GUIDANCE);
  });
});

describe('a dependency landing without a run deadline', () => {
  it('is judged like a complete result: the landing window does not bound its acceptance', async () => {
    // Every landing window is an `AbortSignal.timeout` of the post-approval
    // cap; here each one is already spent, so only a judge it does not bound
    // can answer.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
      ms === POST_APPROVAL_LLM_TIMEOUT_MS ? AbortSignal.abort(new DOMException('landing window', 'TimeoutError')) : timeout(ms));
    const entry = 'wire add (not started: …)';
    const landed: Result = {
      output: { files: ['add.ts'] }, summary: 'INCOMPLETE — …', trace: [], producedBy: { tier: 3, name: 'actor-3', viaFallback: false },
      unfinishedPhases: [entry], blockedPhases: [entry],
    };
    const ctx = { ...makeCtx(), tools: { has: () => false, execute: async () => ({}) } as ToolExecutor };
    // The approval opens the one extra pass (G1); its pass lands the same way
    // and is approved again, with the same unbounded judge.
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the adder phase stands on its own evidence' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'still stands; the CLI is still blocked' }));
    const handle = vi.fn(async () => landed);

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build the adder' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(), onApproved: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle }),
    });

    expect(handle).toHaveBeenCalledTimes(2);
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.blockedPhases).toEqual([entry]);

    // A BUDGET landing keeps the cap: the same spent window refuses it.
    const budgetCtx = { ...makeCtx(), tools: { has: () => false, execute: async () => ({}) } as ToolExecutor };
    budgetCtx.llm.enqueueText(jsonText({ approved: true, reasoning: 'unreachable' }));
    const budget = await runDepthTask({
      mode: 'deep', task: { description: 'Build the adder' }, ctx: budgetCtx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(), onApproved: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: async () => ({ ...landed, unfinishedPhases: ['package'], blockedPhases: [] }) }),
    });
    expect(budget.refusal).toContain('could not finish within the landing budget');
  });
});

/**
 * AN APPROVED DEPENDENCY LANDING WITH BUDGET LEFT OPENS THE EXTRA PASS (G1,
 * 2026-10-16, reversing group B's choice (b)), through the real depth runner
 * and root acceptance over a mocked model: the run's one extra root pass runs
 * the phases that never started, and every way that pass can end without a
 * verdict lands on the approved pass instead of failing the run.
 */
describe('an approved dependency landing with budget left', () => {
  const entry = 'wire add into the CLI (not started: its prerequisite "write add.ts" was not approved and its parent-owned suite did not pass)';
  const producedBy = { tier: 3 as const, name: 'actor-3', viaFallback: false };
  const unavailable: HeldParentTestObservation = {
    suiteDigest: parentTestSuiteDigest(ADD_SUITE), suite: ADD_SUITE, workspaceDigest: 'w', status: 'unavailable', cause: 'runner-error',
    passed: 0, failed: 0, skipped: 0, details: 'worker crashed', judged: true,
  };
  const approvedLanding: Result = {
    output: { files: ['add.ts'] }, summary: 'INCOMPLETE — the CLI was not started.', trace: [], producedBy,
    unfinishedPhases: [entry], blockedPhases: [entry], parentTests: [unavailable],
  };
  const complete: Result = { output: { files: ['add.ts', 'cli.ts'] }, summary: 'the adder and its CLI', trace: [], producedBy };
  const approve = (reasoning: string) => jsonText({ approved: true, reasoning });
  const refuse = (reasoning: string) => jsonText({ approved: false, reasoning });
  const model = 'api:ollama:fixture';
  const host = { name: 'prompt-consolidation', model, params: {}, systemPrompt: 'Author' };

  function atomLesson(owner: string, tier: 1 | 2 | 3, task: string, feedback: string[]): ApprovedLesson {
    return { kind: 'atom', owner, tier, name: owner, version: 1, prompt: 'Keep the protocol.', host, reviewerModel: model,
      task, summary: 'approved', feedback, observations: [] };
  }

  function taskLesson(owner: string, task: string, summary: string): ApprovedLesson {
    return { kind: 'task', owner, host, task, summary, childName: 'Water', childTools: ['read_file'],
      successfulToolAction: true, recordedCommandProbes: false };
  }

  function rootCtx(extra: Partial<Omit<RunContext, 'llm'>> = {}) {
    const stats: string[] = [];
    const ctx = { ...makeCtx(), tools: { has: () => false, execute: async () => ({}) } as ToolExecutor,
      recordRunStat: (signal: string) => { stats.push(signal); }, ...extra };
    return { ctx, stats };
  }

  const counted = (stats: readonly string[], signal: string) => stats.filter((entry) => entry === signal).length;

  /** A real learning queue on a temporary store, the one the runner writes. */
  const roots: string[] = [];
  afterEach(() => {
    closeStoreHandles();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function learningQueue() {
    const root = mkdtempSync(join(tmpdir(), 'atoma-landing-remediation-'));
    roots.push(root);
    const queue = new LearningQueue(join(root, 'store.db'));
    const enqueueApprovedLessons = (lessons: readonly ApprovedLesson[]) => {
      queue.enqueue({ version: 1, runId: 'run-g1', approvedAt: new Date().toISOString(),
        skillsPath: join(root, 'skills'), runsPath: join(root, 'runs'), model, policy: {},
        budget: { tokens: 0, costUsd: 0 }, lessons: [...lessons] });
    };
    return { queue, enqueueApprovedLessons };
  }

  /** Each pass returns its result after deferring its lessons, as phases do. */
  function passes(...steps: Array<(passCtx: RunContext) => Promise<Result> | Result>) {
    const tasks: Task[] = [];
    const handle = async (task: Task, passCtx: RunContext) => {
      tasks.push(task);
      const step = steps[tasks.length - 1];
      if (!step) throw new Error('the fixture has no pass left');
      return step(passCtx);
    };
    return { tasks, handle };
  }

  function defer(passCtx: RunContext, lesson: ApprovedLesson) {
    passCtx.deferredLearning!.defer(async () => {}, lesson.owner, lesson);
  }

  const criteria = [{ id: 'c1', behaviour: 'add returns the sum', source: 'user' as const }];

  it('opens the pass with the typed facts and saves both passes\' lessons in the one queue row', async () => {
    const { queue, enqueueApprovedLessons } = learningQueue();
    const { ctx, stats } = rootCtx({ enqueueApprovedLessons });
    ctx.llm.enqueueText(approve('the adder stands; the CLI was never started'));
    ctx.llm.enqueueText(approve('the CLI now prints sums'));
    const run = passes(
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', ['an earlier probe failed']));
        defer(passCtx, atomLesson('cell-y', 2, 'pass 1', []));
        defer(passCtx, taskLesson('molecule-x', 'write add.ts', 'pass 1 recipe'));
        return approvedLanding;
      },
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 2', ['a later probe failed']));
        defer(passCtx, taskLesson('molecule-x', 'write add.ts', 'pass 2 recipe'));
        return complete;
      },
    );
    const onApproved = vi.fn();

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds', criteria }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(), onApproved,
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(run.tasks).toHaveLength(2);
    const landing = run.tasks[1]!.inputs?.[DEPENDENCY_LANDING_INPUT] as { notStarted: string[]; checks: unknown[]; instruction: string };
    expect(landing.notStarted).toEqual([entry]);
    expect(landing.checks).toEqual([expect.objectContaining({ status: 'unavailable', requirement: ADD_SUITE.requirement })]);
    expect(landing.instruction).toContain('re-run it rather than rebuilding that work');
    expect(landing.instruction).not.toMatch(/approv|refus/i);
    expect(run.tasks[1]!.inputs).not.toHaveProperty('rootAcceptanceRefusal');
    expect(run.tasks[1]!.inputs).not.toHaveProperty('rootRemediationScope');
    expect(run.tasks[1]!.criteria).toEqual(criteria);
    expect(isLanded(outcome)).toBe(false);
    expect(outcome.summary).toBe(complete.summary);
    expect(counted(stats, 'landing-remediation')).toBe(1);
    expect(counted(stats, 'root-remediation')).toBe(0);
    expect(counted(stats, 'discarded-lesson')).toBe(0);
    expect(onApproved).toHaveBeenCalledTimes(2);
    expect(onApproved.mock.calls[1]![4]).toEqual([]);
    const saved = queue.get('run-g1')!.lessons;
    expect(saved.map((lesson) => [lesson.kind, lesson.owner, lesson.task, lesson.summary])).toEqual([
      ['atom', 'molecule-x', 'pass 2', 'approved'],
      ['task', 'molecule-x', 'write add.ts', 'pass 2 recipe'],
      ['atom', 'cell-y', 'pass 1', 'approved'],
    ]);
  });

  it('keeps the earlier pass\'s lesson of a rank when it carries more feedback', async () => {
    const { queue, enqueueApprovedLessons } = learningQueue();
    const { ctx } = rootCtx({ enqueueApprovedLessons });
    ctx.llm.enqueueText(approve('the adder stands'));
    ctx.llm.enqueueText(approve('the CLI now prints sums'));
    const run = passes(
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', ['a probe failed', 'then a fixture failed']));
        return approvedLanding;
      },
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 2', ['a probe failed']));
        return complete;
      },
    );

    await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(queue.get('run-g1')!.lessons.map((lesson) => lesson.task)).toEqual(['pass 1']);
  });

  it('after a refusal, an approved dependency landing is the result: no third pass', async () => {
    const { ctx, stats } = rootCtx();
    ctx.llm.enqueueText(refuse('the adder is unproven'));
    ctx.llm.enqueueText(approve('the adder stands; the CLI was never started'));
    const run = passes(() => approvedLanding, () => approvedLanding);

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(run.tasks).toHaveLength(2);
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.blockedPhases).toEqual([entry]);
    expect(counted(stats, 'root-remediation')).toBe(1);
    expect(counted(stats, 'landing-remediation')).toBe(0);
  });

  it.each([
    ['under a minute of the run deadline left', approvedLanding, { deadlineAt: Date.now() + 30_000 }],
    ['a landing the budget also cut', { ...approvedLanding, unfinishedPhases: ['package', entry] }, {}],
  ] as const)('opens no pass with %s, and ends partial as before', async (_case, landed, extra) => {
    const enqueue = vi.fn();
    const { ctx, stats } = rootCtx({ ...extra, enqueueApprovedLessons: enqueue });
    ctx.llm.enqueueText(approve('the adder stands'));
    const run = passes((passCtx) => {
      defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', []));
      return landed;
    });

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(run.tasks).toHaveLength(1);
    expect(outcome.refusal).toBeUndefined();
    expect(isLanded(outcome)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(counted(stats, 'landing-remediation')).toBe(0);
  });

  it('opens no pass in the short topology, whose deepening would archive the approved workspace', async () => {
    const { ctx, stats } = rootCtx();
    ctx.llm.enqueueText(approve('the adder stands'));
    const run = passes(() => approvedLanding);

    const outcome = await runDepthTask({
      mode: 'short', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(run.tasks).toHaveLength(1);
    expect(isLanded(outcome)).toBe(true);
    expect(counted(stats, 'landing-remediation')).toBe(0);
  });

  /** A run deadline ten minutes out, and the abort the run budget sends when it passes. */
  function deadline() {
    const controller = new AbortController();
    const cut = () => {
      const reason = new Error('run budget reached');
      reason.name = 'TimeoutError';
      controller.abort(reason);
      throw reason;
    };
    return { signal: controller.signal, deadlineAt: Date.now() + 600_000, cut };
  }

  it('lands on the approved pass when the deadline cuts the extra one, naming its phases unfinished', async () => {
    const { queue, enqueueApprovedLessons } = learningQueue();
    const clock = deadline();
    const { ctx, stats } = rootCtx({ signal: clock.signal, deadlineAt: clock.deadlineAt, enqueueApprovedLessons });
    ctx.llm.enqueueText(approve('the adder stands'));
    const run = passes(
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', []));
        return approvedLanding;
      },
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 2', []));
        passCtx.recordRootPlan!({ ...makePlan(), subtasks: [{ description: 'write cli.ts' }] });
        return clock.cut();
      },
    );

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(outcome.refusal).toBeUndefined();
    expect(outcome.unfinishedPhases).toEqual([entry, 'write cli.ts']);
    expect(outcome.blockedPhases).toEqual([entry]);
    expect(outcome.summary).toContain('was cut by the run deadline before it completed');
    expect(landingReasons(outcome)[0]).toContain('1 unfinished phase(s) that did not complete with an accepted result: write cli.ts');
    expect(queue.get('run-g1')!.lessons.map((lesson) => lesson.task)).toEqual(['pass 1']);
    expect(counted(stats, 'discarded-lesson')).toBe(1);
    expect(counted(stats, 'unjudged-remediation')).toBe(1);
  });

  it('lands on the approved pass unchanged when the deadline cuts the extra one before its plan', async () => {
    const clock = deadline();
    const { ctx } = rootCtx({ signal: clock.signal, deadlineAt: clock.deadlineAt });
    ctx.llm.enqueueText(approve('the adder stands'));
    const run = passes(() => approvedLanding, () => clock.cut());

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(outcome.unfinishedPhases).toEqual(approvedLanding.unfinishedPhases);
    expect(outcome.blockedPhases).toEqual(approvedLanding.blockedPhases);
    expect(outcome.summary).toContain('before its plan existed; no phase of it ran');
  });

  it('lands on the approved pass when the extra one fails on its own, naming only the error class', async () => {
    const { ctx, stats } = rootCtx();
    ctx.llm.enqueueText(approve('the adder stands'));
    const run = passes(() => approvedLanding, () => {
      throw new ValidationError('Delegation contract review did not finish: SECRET_DETAIL');
    });

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(outcome.refusal).toBeUndefined();
    expect(isLanded(outcome)).toBe(true);
    expect(outcome.summary).toContain('failed (ValidationError)');
    expect(outcome.summary).not.toContain('SECRET_DETAIL');
    expect(JSON.stringify(outcome.unfinishedPhases)).not.toContain('SECRET_DETAIL');
    expect(counted(stats, 'unjudged-remediation')).toBe(1);
  });

  it('lands refused on the refused pass when its remediation fails on its own', async () => {
    const { ctx } = rootCtx();
    ctx.llm.enqueueText(refuse('the adder is unproven'));
    const run = passes(() => approvedLanding, () => {
      throw new Error('boom');
    });

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(outcome.refusal).toBe('the adder is unproven — the remediation pass failed (Error) before it completed');
    expect(outcome.output).toEqual(approvedLanding.output);
  });

  it('keeps the extra pass\'s work refused when its acceptance fails, and saves no lesson', async () => {
    const enqueue = vi.fn();
    const { ctx, stats } = rootCtx({ enqueueApprovedLessons: enqueue });
    ctx.llm.enqueueText(approve('the adder stands'));
    ctx.llm.enqueue(() => {
      throw new TypeError('transport down');
    });
    const second: Result = { ...approvedLanding, summary: 'the second pass' };
    const run = passes(
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', []));
        return approvedLanding;
      },
      () => second,
    );

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(outcome.refusal).toBe('root acceptance of the follow-up pass did not finish (TypeError)');
    expect(outcome.summary).toContain('the second pass');
    expect(enqueue).not.toHaveBeenCalled();
    expect(counted(stats, 'discarded-lesson')).toBe(1);
  });

  it('drops both passes\' lessons when the extra pass is refused', async () => {
    const enqueue = vi.fn();
    const { ctx, stats } = rootCtx({ enqueueApprovedLessons: enqueue });
    ctx.llm.enqueueText(approve('the adder stands'));
    ctx.llm.enqueueText(refuse('the CLI prints nothing'));
    const run = passes(
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', []));
        return approvedLanding;
      },
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 2', []));
        return approvedLanding;
      },
    );

    const outcome = await runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    expect(outcome.refusal).toBe('the CLI prints nothing');
    expect(enqueue).not.toHaveBeenCalled();
    expect(counted(stats, 'discarded-lesson')).toBe(2);
  });

  it('still fails on an explicit cancellation during the extra pass', async () => {
    const controller = new AbortController();
    const { ctx, stats } = rootCtx({ signal: controller.signal });
    ctx.llm.enqueueText(approve('the adder stands'));
    const run = passes(
      (passCtx) => {
        defer(passCtx, atomLesson('molecule-x', 1, 'pass 1', []));
        return approvedLanding;
      },
      () => {
        controller.abort(new Error('cancelled by the operator'));
        throw controller.signal.reason;
      },
    );

    const outcome = runDepthTask({
      mode: 'deep', task: { description: 'Build a CLI that adds' }, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new RootActor(), handle: run.handle }),
    });

    await expect(outcome).rejects.toThrow('cancelled by the operator');
    expect(counted(stats, 'discarded-lesson')).toBe(1);
    expect(counted(stats, 'unjudged-remediation')).toBe(0);
  });
});

describe('the extra pass a dependency landing opens', () => {
  const entry = 'wire add (not started: its prerequisite "write add.ts" failed its parent-owned acceptance suite)';
  const checklist = [
    { id: 'c1', behaviour: 'add returns the sum', source: 'user' as const },
    { id: 'c2', behaviour: 'the CLI prints sums', source: 'user' as const },
  ];
  const root: Task = { description: 'Build a CLI that adds', criteria: checklist };
  const failed: HeldParentTestObservation = {
    suiteDigest: parentTestSuiteDigest(ADD_SUITE), suite: ADD_SUITE, workspaceDigest: 'w', status: 'failed', cause: 'ran',
    passed: 0, failed: 1, skipped: 0, details: FAILED_DETAILS,
  };
  const landing = (parentTests: HeldParentTestObservation[]): Result => ({
    output: null, summary: 'INCOMPLETE', trace: [], producedBy: { tier: 3, name: 'actor-3', viaFallback: false },
    unfinishedPhases: [entry], blockedPhases: [entry], parentTests,
  });
  const judged = (approved: boolean): AcceptanceInfo => ({
    approved, reasoning: approved ? 'stands' : 'c2 is unmet', gates: [], floorCoverage: [], probe: {},
    checklist: [
      { id: 'c1', behaviour: 'add returns the sum', check: { kind: 'review' }, status: 'review', judgement: { met: true, reason: 'r' } },
      { id: 'c2', behaviour: 'the CLI prints sums', check: { kind: 'review' }, status: 'review', judgement: { met: false, reason: 'r' } },
    ],
  } as unknown as AcceptanceInfo);
  const input = (task: Task) => task.inputs?.[DEPENDENCY_LANDING_INPUT] as { instruction: string; checks: unknown[] };

  it('a refused landing with one unmet criterion repairs the failed phase and gets no single-criterion scope', () => {
    const next = remediationTask(root, judged(false), landing([failed]));

    expect(next.inputs).not.toHaveProperty('rootRemediationScope');
    expect(next.inputs?.['rootAcceptanceRefusal']).toBe('c2 is unmet');
    expect(input(next).instruction).toContain('Repair that phase against its parent-owned suite');
    expect(next.criteria?.map((item) => item.id)).toEqual(['c2']);
  });

  it('an approved landing keeps every criterion and hears no refusal', () => {
    const next = remediationTask(root, judged(true), landing([failed]));

    expect(next.inputs).not.toHaveProperty('rootAcceptanceRefusal');
    expect(next.inputs).not.toHaveProperty('rootRemediationScope');
    expect(next.criteria?.map((item) => item.id)).toEqual(['c1', 'c2']);
    expect(input(next).instruction).toContain('(listed in checks)');
  });

  it('an approved landing with no failing check says nothing of checks', () => {
    const next = remediationTask(root, judged(true), landing([]));

    expect(input(next).checks).toEqual([]);
    expect(input(next).instruction).not.toContain('check');
    expect(input(next).instruction).toContain('without rebuilding the work this run kept');
  });
});
