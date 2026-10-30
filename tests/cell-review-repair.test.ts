import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { MockLlmClient } from '../src/core/llm.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { LlmCompletionRequest, LlmCompletionResponse, Plan, Result, SubtaskSpec, Task, ToolExecutor } from '../src/core/types.js';
import { makeCtx } from './helpers.js';

// Design M5 (records/designs/replan-loop-2026-10-23.md): behind
// ATOMA_REVIEW_REPAIR the CELL review repairs what it can state without writing
// a suite, as the root review does (M4 stage A), and the repaired plan is the
// one the cell dispatches. Production path: superviseLoop -> L3.validatePlan ->
// L2.execute, with mocked LLMs and the cell's molecule dispatch observed.

const databases: ReturnType<typeof openDb>[] = [];
const savedFlag = process.env['ATOMA_REVIEW_REPAIR'];

beforeEach(() => {
  process.env['ATOMA_REVIEW_REPAIR'] = '1';
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['ATOMA_REVIEW_REPAIR'];
  else process.env['ATOMA_REVIEW_REPAIR'] = savedFlag;
  for (const db of databases.splice(0)) db.close();
  closeStoreHandles();
  vi.restoreAllMocks();
});

const ADD = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('adds', () => {\n  expect(add(2, 3)).toBe(5);\n  expect(add(-2, 1)).toBe(-1);\n});";
const SUB = "import { test, expect } from 'vitest';\nimport { sub } from './sub.ts';\ntest('subtracts', () => {\n  expect(sub(5, 3)).toBe(2);\n  expect(sub(1, 2)).toBe(-1);\n});";
/** Subtraction built on addition: its suite imports both modules, so it must wait for the addition. */
const SUB_ON_ADD = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\nimport { sub } from './sub.ts';\ntest('subtracts', () => {\n  expect(sub(5, 3)).toBe(2);\n  expect(sub(add(1, 1), 2)).toBe(0);\n});";

/** Two modules the planner fanned out; the review finds the second must wait for the first. */
const cellPlan = {
  reasoning: 'Two modules',
  delivery: 'files',
  subtasks: [
    { description: 'Implement signed addition', preferredChild: 'Urea', outputs: ['add.ts'], acceptanceTests: { requirement: 'signed addition', cwd: '.', source: ADD } },
    { description: 'Implement signed subtraction on top of add', preferredChild: 'Urea', outputs: ['sub.ts'], acceptanceTests: { requirement: 'signed subtraction', cwd: '.', source: SUB } },
  ],
  aggregation: { mode: 'concat' },
  expectedOutput: 'add.ts and sub.ts',
};
const reply = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, cellPlan]);
const chain = [{ kind: 'dependsOn.set', target: 1, dependsOn: [0] }];
const approve = (count: number, deltas?: unknown[]): string => JSON.stringify({
  approved: true,
  reasoning: 'scope reviewed',
  delegationReview: {
    subtasks: Array.from({ length: count }, (_, index) => ({ index, kind: 'vitest', reason: 'actual assigned scope' })),
    integration: { kind: 'other', reason: 'no interacting modules' },
    independentWork: false,
    parallelReason: 'subtraction is built on addition',
  },
  ...(deltas ? { planRepair: { deltas } } : {}),
});
const respond = (text: string): LlmCompletionResponse => ({ text, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } });

/** The cell's plan calls and the tissue's reviews, by role. */
function routed(plans: (string | ((prompt: string) => string))[], reviews: string[]): MockLlmClient {
  const llm = new MockLlmClient();
  const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
    const next = req.role === 'plan' ? plans.shift() : req.role === 'validate-plan' ? reviews.shift() : undefined;
    if (next === undefined) throw new Error(`Unexpected ${req.role} call`);
    return respond(typeof next === 'string' ? next : next(req.userContent));
  };
  for (let i = 0; i < 20; i++) llm.enqueue(route);
  return llm;
}

/** A workspace that holds nothing yet: every suite import resolves only through a declared output. */
const emptyWorkspace: ToolExecutor = {
  has: (name) => name === 'list_files',
  execute: async (name) => name === 'list_files' ? { entries: [] } : {},
};

const hooks: SupervisionHooks<L2Atom> = { applyByScope: child => Promise.resolve(child), branchOnEscalation: () => Promise.resolve() };
const task: Task = { description: 'Implement signed addition and subtraction' };

function actors() {
  const db = openDb(':memory:');
  databases.push(db);
  const registry = new AtomRegistry(db);
  const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
  const tissue = L3Atom.buildWithModel(registry.create(3, seed), registry, 'mock');
  const cell = L2Atom.fromType(registry.create(2, seed), registry);
  // The molecule dispatch, observed: what the cell hands each molecule, with its dependencies' results.
  const dispatched: SubtaskSpec[] = [];
  vi.spyOn(cell as unknown as { runSubtask: (args: { subtask: SubtaskSpec }) => Promise<Result> }, 'runSubtask')
    .mockImplementation(async ({ subtask }) => {
      dispatched.push(subtask);
      return { output: { wrote: subtask.outputs }, summary: `done: ${subtask.description}`, trace: [], producedBy: { name: 'Urea', tier: 1, viaFallback: false } };
    });
  vi.spyOn(tissue, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'the phase holds' });
  return { tissue, cell, dispatched };
}

/** Subtraction built on addition, in sequence: two implementation subtasks interacting, so the plan needs an integration suite. */
const chained = { ...cellPlan, aggregation: { mode: 'sequential' }, subtasks: [cellPlan.subtasks[0]!, { ...cellPlan.subtasks[1]!, dependsOn: [0],
  acceptanceTests: { ...cellPlan.subtasks[1]!.acceptanceTests, source: SUB_ON_ADD } }] };
const chainedReply = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, chained]);
const JOIN = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\nimport { sub } from './sub.ts';\ntest('joins', () => {\n  expect(sub(add(2, 3), 3)).toBe(2);\n  expect(add(sub(1, 2), 1)).toBe(0);\n});";
const integrating = JSON.stringify({ ...JSON.parse(approve(2)),
  delegationReview: { ...JSON.parse(approve(2)).delegationReview, integration: { kind: 'vitest', reason: 'subtraction calls addition' } } });

describe('the cell review repairs the plan it approves (ATOMA_REVIEW_REPAIR, design M5)', () => {
  it('dispatches the amended dependsOn after plan-repaired, and a memo hit on the proposed bytes returns the repair without a call', async () => {
    const { tissue, cell, dispatched } = actors();
    const ctx = { ...makeCtx({ llm: routed([reply], [approve(2, chain)]) }), tools: emptyWorkspace };
    const plan = vi.spyOn(cell, 'plan');

    const result = await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(1);
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.userContent).toContain('"planRepair"');
    // The molecule of subtask 1 waited for subtask 0 and received its result: the amended plan ran.
    expect(dispatched.map(subtask => subtask.dependsOn)).toEqual([undefined, [0]]);
    expect((dispatched[1]?.inputs?.['dependencyResults'] as { index: number }[] | undefined)?.map(entry => entry.index)).toEqual([0]);
    expect(dispatched.map(subtask => subtask.acceptanceTests?.source)).toEqual([ADD, SUB]);
    expect(result.producedBy.viaFallback).toBe(false);
    const kinds = result.trace.map(entry => entry.kind);
    expect(kinds.slice(0, 5)).toEqual(['plan', 'verdict-plan', 'plan-repaired', 'plan', 'execute']);
    expect(result.trace[2]?.payload).toEqual({ deltas: chain });
    const repaired = result.trace[3]?.payload as { repaired: boolean; plan: Plan };
    expect(repaired.repaired).toBe(true);
    expect(repaired.plan.subtasks[1]?.dependsOn).toEqual([0]);

    // The same proposed plan again: the memo returns the amended verdict, with no review call.
    const proposed = await plan.mock.results[0]!.value as Plan;
    expect(proposed.subtasks[1]?.dependsOn).toBeUndefined();
    const before = ctx.llm.calls.length;
    const again = await tissue.validatePlan(cell, proposed, task, ctx);
    expect(ctx.llm.calls).toHaveLength(before);
    expect(again.approved && again.amendedPlan).toEqual(repaired.plan);
  });

  it('refuses a repair that leaves a suite import unresolved: the cell replans, hearing why', async () => {
    const { tissue, cell, dispatched } = actors();
    // The subtraction suite imports add.ts too; the review drops the dependency that orders it.
    const chained = { ...cellPlan, subtasks: [cellPlan.subtasks[0], { ...cellPlan.subtasks[1], dependsOn: [0],
      acceptanceTests: { ...cellPlan.subtasks[1]!.acceptanceTests, source: SUB_ON_ADD } }] };
    const proposed = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, chained]);
    const unchain = [{ kind: 'dependsOn.set', target: 1, dependsOn: [] }];
    const ctx = { ...makeCtx({ llm: routed([proposed, proposed], [approve(2, unchain), approve(2)]) }), tools: emptyWorkspace };
    // The refusal reaches the cell planner as coaching, through the parent's hooks.
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));

    const result = await superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached });

    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(2);
    const refusal = coached.mock.calls[0]?.[1];
    expect(refusal).toMatchObject({ approved: false, delegationRefusal: 'plan', refusedRepair: 'host' });
    expect(refusal?.reasoning).toContain("The host refused the review's planRepair: a suite import of the repaired plan does not resolve");
    expect(refusal?.reasoning).toContain('./add.ts: declared only by a subtask this suite does not wait for');
    expect(refusal?.reasoning).toContain('"kind":"dependsOn.set"');
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(2);
    expect(reviews[1]?.userContent).toContain("The host refused the review's planRepair");
    // The second plan was approved as proposed and runs unrepaired.
    expect(dispatched.map(subtask => subtask.dependsOn)).toEqual([undefined, [0]]);
    expect(result.trace.map(entry => entry.kind)).not.toContain('plan-repaired');
  });

  it('accepts a repair on a plan whose untouched suite imports what is absent: the review already read that fact', async () => {
    const { tissue, cell, dispatched } = actors();
    const ABSENT = ADD.replace("import { add } from './add.ts';", "import { add } from './add.ts';\nimport { fixture } from './fixtures/absent.ts';");
    const absent = { ...cellPlan, subtasks: [{ ...cellPlan.subtasks[0]!, acceptanceTests: { ...cellPlan.subtasks[0]!.acceptanceTests, source: ABSENT } }, cellPlan.subtasks[1]] };
    const proposed = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, absent]);
    const ctx = { ...makeCtx({ llm: routed([proposed], [approve(2, chain)]) }), tools: emptyWorkspace };

    await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')[0]?.userContent).toContain('./fixtures/absent.ts → not present now');
    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(1);
    expect(dispatched.map(subtask => subtask.dependsOn)).toEqual([undefined, [0]]);
  });

  it('refuses a repair that introduces a parallel output collision, quoting the deltas', async () => {
    const { tissue, cell, dispatched } = actors();
    const shared = { ...cellPlan, subtasks: cellPlan.subtasks.map((subtask, index) => ({
      ...subtask, outputs: [...subtask.outputs, 'index.ts'], ...(index === 1 ? { dependsOn: [0] } : {}),
    })) };
    const proposed = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, shared]);
    const unchain = [{ kind: 'dependsOn.set', target: 1, dependsOn: [] }];
    const ctx = { ...makeCtx({ llm: routed([proposed, proposed], [approve(2, unchain), approve(2)]) }), tools: emptyWorkspace };
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));

    await superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached });

    const refusal = coached.mock.calls[0]?.[1];
    expect(refusal).toMatchObject({ approved: false, delegationRefusal: 'plan', refusedRepair: 'host' });
    expect(refusal?.reasoning).toContain("The host refused the review's planRepair: the repaired plan runs parallel subtasks that declare the same outputs: index.ts.");
    expect(refusal?.reasoning).toContain(JSON.stringify(unchain));
    expect(dispatched.map(subtask => subtask.dependsOn)).toEqual([undefined, [0]]);
  });

  it('never bounds into execution a repair the host refused inside the review, after MAX_CELL_PLAN_REFUSALS model refusals', async () => {
    const { tissue, cell, dispatched } = actors();
    const JOIN = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\nimport { sub } from './sub.ts';\ntest('joins', () => {\n  expect(sub(add(2, 3), 3)).toBe(2);\n  expect(add(sub(1, 2), 1)).toBe(0);\n});";
    // The join carries the integration suite only while it comes after both modules.
    const joined = { ...cellPlan, subtasks: [...cellPlan.subtasks,
      { description: 'Join both modules', preferredChild: 'Urea', outputs: ['index.ts'], dependsOn: [0, 1], acceptanceTests: { requirement: 'joined', cwd: '.', source: JOIN } }] };
    const proposed = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, joined]);
    const refuse = (gap: string) => JSON.stringify({ approved: false, reasoning: `GAP: ${gap}`, scope: 'ephemeral', modifications: { additionalContext: gap } });
    const integrated = JSON.stringify({ ...JSON.parse(approve(3, [{ kind: 'dependsOn.set', target: 2, dependsOn: [0] }])),
      delegationReview: { ...JSON.parse(approve(3)).delegationReview, integration: { kind: 'vitest', reason: 'the join is the integration' } } });
    expect(L3Atom.MAX_CELL_PLAN_REFUSALS).toBe(2);
    const ctx = { ...makeCtx({ llm: routed([proposed, proposed, proposed], [refuse('no negative addition case'), refuse('no zero subtraction case'), integrated]) }),
      tools: emptyWorkspace };
    const stats: string[] = [];
    ctx.recordRunStat = (signal) => { stats.push(signal); };
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));

    // The plan budget runs out on the third refusal: the escalation is observed, nothing runs after it.
    await expect(superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached,
      onFailed: () => Promise.reject(new Error('escalated')) })).rejects.toThrow('escalated');

    expect(coached).toHaveBeenCalledTimes(3);
    const third = coached.mock.calls[2]?.[1];
    expect(third).toMatchObject({ approved: false, delegationRefusal: 'plan', refusedRepair: 'host' });
    expect(third?.reasoning).toContain('plan integration');
    expect(stats).not.toContain('cell-bound-applied');
    expect(dispatched).toEqual([]);
  });

  it('reviews the same plan again, naming why, when the host cannot apply the review\'s repair', async () => {
    const { tissue, cell, dispatched } = actors();
    // The cell's task carries no criteria: an id the review assigns cannot be one of them.
    const byText = [{ kind: 'criteria.assign', target: 0, criteria: ['signed sums are correct'] }];
    const ctx = { ...makeCtx({ llm: routed([reply], [approve(2, byText), approve(2)]) }), tools: emptyWorkspace };

    await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(1);
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.userContent).not.toContain('YOUR EARLIER planRepair');
    expect(reviews[1]?.userContent).toContain('YOUR EARLIER planRepair OF THIS SAME PLAN COULD NOT BE APPLIED');
    expect(reviews[1]?.userContent).toContain('"signed sums are correct", not an id of this task\'s acceptance criteria (none)');
    expect(dispatched.map(subtask => subtask.criteria)).toEqual([undefined, undefined]);
  });

  // Run 6fe2d326 (3b42a7fe): a cell review approved a single-subtask plan with
  // independentWork true while its parallelReason called the branch deliberately
  // single; the host's fan-out refusal cost the planner a replan (a4645ab9).
  const single = { ...cellPlan, subtasks: [cellPlan.subtasks[0]!], aggregation: { mode: 'sequential' }, expectedOutput: 'add.ts' };
  const singleReply = JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, single]);
  const contradicting = JSON.stringify({ ...JSON.parse(approve(1)), delegationReview: { ...JSON.parse(approve(1)).delegationReview,
    independentWork: true, parallelReason: 'the branch is deliberately single: one module, one suite' } });
  const CHALLENGE = 'YOUR EARLIER APPROVAL OF THIS SAME PLAN SET independentWork true, BUT THE PLAN HAS NO PARALLEL BRANCHES';

  it('sends an approval\'s own fan-out contradiction back to the reviewer, and dispatches the plan it reclassifies without a replan', async () => {
    const { tissue, cell, dispatched } = actors();
    const ctx = { ...makeCtx({ llm: routed([singleReply], [contradicting, approve(1)]) }), tools: emptyWorkspace };

    const result = await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(1);
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.userContent).not.toContain(CHALLENGE);
    expect(reviews[1]?.userContent).toContain(`${CHALLENGE}; the host found: Independent work must have parallel child branches with real dependencies: the branch is deliberately single`);
    expect(dispatched.map(subtask => subtask.description)).toEqual(['Implement signed addition']);
    // Neither a plan refusal nor a review fault reached the loop.
    expect(result.trace.map(entry => entry.kind).slice(0, 3)).toEqual(['plan', 'verdict-plan', 'execute']);
  });

  it('refuses a fan-out the re-review confirms as the plan\'s, and refuses the same plan again without a second challenge', async () => {
    const { tissue, cell, dispatched } = actors();
    const ctx = { ...makeCtx({ llm: routed([singleReply, singleReply, singleReply], [contradicting, contradicting, contradicting, approve(1)]) }),
      tools: emptyWorkspace };
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));

    await superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached });

    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(3);
    expect(coached).toHaveBeenCalledTimes(2);
    for (const [, verdict] of coached.mock.calls) expect(verdict).toMatchObject({ approved: false, delegationRefusal: 'fan-out' });
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews.map(call => call.userContent.includes(CHALLENGE))).toEqual([false, true, false, false]);
    expect(dispatched.map(subtask => subtask.description)).toEqual(['Implement signed addition']);
  });

  it('names the plan\'s own suite field and the delta when the host refuses an approval for its integration suite (run 6fe2d326, 33167417)', async () => {
    const { tissue, cell, dispatched } = actors();
    const delta = (prompt: string) => JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' }, { planDeltas: {
      base: /PREVIOUS PLAN \(digest ([0-9a-f]{64});/.exec(prompt)?.[1], deltas: [{ kind: 'suite.replace', target: 'plan', requirement: 'joined', source: JOIN }] } }]);
    const ctx = { ...makeCtx({ llm: routed([chainedReply, delta], [integrating, integrating]) }), tools: emptyWorkspace };
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));
    const plan = vi.spyOn(cell, 'plan');

    await superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached });

    const refusal = coached.mock.calls[0]?.[1];
    expect(refusal).toMatchObject({ approved: false, delegationRefusal: 'plan' });
    expect(refusal?.reasoning).toContain('Missing parent-owned acceptanceTests on plan integration (the plan\'s own top-level "acceptanceTests" field, ' +
      'beside "subtasks", not a subtask\'s: the last subtask\'s suite is no join, with fewer than two implementation subtasks before it; ' +
      'with planDeltas, {"kind": "suite.replace", "target": "plan", "requirement": "...", "source": "<the whole suite>"} adds it)');
    // The delta it names is one the host applies: the plan's suite, the subtasks' own kept.
    expect((await plan.mock.results[1]!.value as Plan).acceptanceTests).toEqual({ requirement: 'joined', cwd: '.', source: JOIN });
    expect(dispatched.map(subtask => subtask.acceptanceTests?.source)).toEqual([ADD, SUB_ON_ADD]);
    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(2);
  });

  it('self-executes a plan with no planned strategy, as before the flag: a shared peer may have consumed it', async () => {
    const { cell } = actors();
    const selfExecute = vi.spyOn(cell as unknown as { selfExecute: L2Atom['execute'] }, 'selfExecute')
      .mockResolvedValue({ output: {}, summary: 'self', trace: [], producedBy: { name: cell.name, tier: 2, viaFallback: false } });
    await expect(cell.execute(task, { ...cellPlan, subtasks: [] } as unknown as Plan, makeCtx())).resolves.toMatchObject({ summary: 'self' });
    expect(selfExecute).toHaveBeenCalledOnce();
  });
});

describe('the cell review with ATOMA_REVIEW_REPAIR off', () => {
  beforeEach(() => {
    delete process.env['ATOMA_REVIEW_REPAIR'];
  });

  it('asks for no repair and ignores one: the proposed plan executes, untraced', async () => {
    const { tissue, cell, dispatched } = actors();
    const ctx = { ...makeCtx({ llm: routed([reply], [approve(2, chain)]) }), tools: emptyWorkspace };

    const result = await superviseLoop(tissue, cell, task, ctx, hooks);

    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews[0]?.userContent).not.toContain('planRepair');
    expect(dispatched.map(subtask => subtask.dependsOn)).toEqual([undefined, undefined]);
    expect(result.trace.map(entry => entry.kind).slice(0, 3)).toEqual(['plan', 'verdict-plan', 'execute']);
  });

  it('names the plan\'s own suite field, without a delta, when the host refuses an approval for its integration suite', async () => {
    const { tissue, cell } = actors();
    const ctx = { ...makeCtx({ llm: routed([chainedReply, JSON.stringify([{ strategy: 'reuse', target: 'Urea', reasoning: 'Existing module author' },
      { ...chained, acceptanceTests: { requirement: 'joined', cwd: '.', source: JOIN } }])], [integrating, integrating]) }), tools: emptyWorkspace };
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));

    await superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached });

    expect(coached.mock.calls[0]?.[1].reasoning).toContain('Missing parent-owned acceptanceTests on plan integration (the plan\'s own top-level "acceptanceTests" field, ' +
      'beside "subtasks", not a subtask\'s: the last subtask\'s suite is no join, with fewer than two implementation subtasks before it). ');
  });
});
