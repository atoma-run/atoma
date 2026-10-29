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
function routed(plans: string[], reviews: string[]): MockLlmClient {
  const llm = new MockLlmClient();
  const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
    const next = req.role === 'plan' ? plans.shift() : req.role === 'validate-plan' ? reviews.shift() : undefined;
    if (next === undefined) throw new Error(`Unexpected ${req.role} call`);
    return respond(next);
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

  it('refuses a repair whose split part runs a suite importing what nothing before it writes: the cell replans, hearing why', async () => {
    const { tissue, cell, dispatched } = actors();
    // The second part runs the subtraction suite, but sub.ts is written by a parallel subtask.
    const split = [{ kind: 'suite.split', target: 0, into: [
      { description: 'Implement addition', suiteFrom: 0 },
      { description: 'Check subtraction early', suiteFrom: 1 },
    ] }];
    const ctx = { ...makeCtx({ llm: routed([reply, reply], [approve(3, split), approve(2)]) }), tools: emptyWorkspace };
    // The refusal reaches the cell planner as coaching, through the parent's hooks.
    const coached = vi.fn<SupervisionHooks<L2Atom>['applyByScope']>(child => Promise.resolve(child));

    const result = await superviseLoop(tissue, cell, task, ctx, { ...hooks, applyByScope: coached });

    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(2);
    const refusal = coached.mock.calls[0]?.[1];
    expect(refusal).toMatchObject({ approved: false, delegationRefusal: 'plan' });
    expect(refusal?.reasoning).toContain("The host refused the review's planRepair: a suite import of the repaired plan does not resolve");
    expect(refusal?.reasoning).toContain('"kind":"suite.split"');
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(2);
    expect(reviews[1]?.userContent).toContain("The host refused the review's planRepair");
    // The second plan was approved as proposed and runs unrepaired.
    expect(dispatched.map(subtask => subtask.description)).toEqual(cellPlan.subtasks.map(subtask => subtask.description));
    expect(result.trace.map(entry => entry.kind)).not.toContain('plan-repaired');
  });

  it('throws on an execute with no planned strategy, where the reviewed plan would be dropped', async () => {
    const { cell } = actors();
    await expect(cell.execute(task, { ...cellPlan, subtasks: [] } as unknown as Plan, makeCtx())).rejects.toThrow('execute without a planned strategy');
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
});
