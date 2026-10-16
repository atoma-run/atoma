import { afterEach, describe, expect, it, vi } from 'vitest';
import { Atom } from '../src/core/atom.js';
import { MAX_PLAN_REVIEW_FAULTS, superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { Result, Tier, Verdict } from '../src/core/types.js';
import { delegationRefusal } from '../src/atoms/delegationReview.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * A plan review that failed AS THE REVIEWER is no judgement of the child
 * (follow-up and third review, 2026-10-16). Every test runs under the
 * production limits: the shipped test of the follow-up raised the plan budget
 * to 5, which hid that three faults spent the default budget of three and
 * escalated, recorded a trust failure and branched the child's type.
 */

const delivered: Result = {
  output: 'done',
  summary: 'done',
  producedBy: { tier: 1, name: 'child', viaFallback: false },
  trace: [],
};

class Child extends Atom {
  readonly model = 'mock';
  readonly plans = vi.fn(async () => makePlan());

  constructor(readonly tier: Tier, name = 'child') {
    super({ name, ordinal: 0, systemPrompt: '', tools: [], params: {} });
  }

  async plan() {
    return this.plans();
  }

  async execute() {
    return delivered;
  }

  async validatePlan(): Promise<Verdict> {
    return { approved: true, reasoning: 'unused' };
  }

  async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'unused' };
  }
}

class Parent extends Child {
  constructor(private readonly reviews: Verdict[]) {
    super(2, 'parent');
  }

  override async validatePlan(): Promise<Verdict> {
    return this.reviews.shift() ?? { approved: true, reasoning: 'plan reviewed' };
  }

  override async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'result reviewed' };
  }

  override async execute(): Promise<Result> {
    return { ...delivered, output: 'parent did it', producedBy: { tier: 2, name: 'parent', viaFallback: false } };
  }
}

const fault = () => delegationRefusal('Delegation review is incomplete: the reviewer did not finish.', 'reviewer');
const refusal = (reasoning: string): Verdict => ({ approved: false, reasoning, scope: 'ephemeral', modifications: {} });

function hooks() {
  return {
    applyByScope: vi.fn(async (current: Child) => current),
    branchOnEscalation: vi.fn(async () => undefined),
    onFailed: vi.fn(async () => undefined),
  } satisfies SupervisionHooks<Child>;
}

describe('a plan review that failed as the reviewer', () => {
  it('runs under the production plan budget', () => {
    expect(makeCtx().limits.maxPlanIterations).toBe(DEFAULT_LIMITS.maxPlanIterations);
    expect(DEFAULT_LIMITS.maxPlanIterations).toBe(3);
  });

  it('asks for the plan again without coaching, a repeat streak, blame or a branch', async () => {
    const parent = new Parent([fault()]);
    const child = new Child(1);
    const hook = hooks();

    const result = await superviseLoop(parent, child, { description: 'add' }, makeCtx(), hook);

    expect(result.output).toBe('done');
    expect(child.plans).toHaveBeenCalledTimes(2);
    expect(hook.applyByScope).not.toHaveBeenCalled();
    expect(hook.onFailed).not.toHaveBeenCalled();
    expect(hook.branchOnEscalation).not.toHaveBeenCalled();
    // Traced apart: the branch diagnostic and the fallback read refused
    // `verdict-plan` entries as validator feedback.
    expect(result.trace.filter(entry => entry.kind === 'plan-review-fault')).toHaveLength(1);
    expect(result.trace.some(entry => entry.kind === 'verdict-plan' && (entry.payload as Verdict).approved === false)).toBe(false);
  });

  it('spends no plan iteration: the child keeps its whole budget for judged refusals', async () => {
    // Refusal, fault, refusal, approval: four plan calls under a budget of
    // three. Counted, the fault spent the third iteration and escalated.
    const parent = new Parent([refusal('names no outputs'), fault(), refusal('misses the boundary case')]);
    const child = new Child(1);
    const hook = hooks();

    const result = await superviseLoop(parent, child, { description: 'add' }, makeCtx(), hook);

    expect(result.output).toBe('done');
    expect(result.producedBy.viaFallback).toBe(false);
    expect(child.plans).toHaveBeenCalledTimes(4);
    expect(hook.applyByScope).toHaveBeenCalledTimes(2);
    expect(hook.onFailed).not.toHaveBeenCalled();
  });

  it(`hands the task to the parent after ${MAX_PLAN_REVIEW_FAULTS} faults, blaming and branching nothing`, async () => {
    const parent = new Parent([refusal('names no outputs'), fault(), fault()]);
    const child = new Child(1);
    const execute = vi.spyOn(child, 'execute');
    const hook = hooks();

    const result = await superviseLoop(parent, child, { description: 'add' }, makeCtx(), hook);

    expect(result.output).toBe('parent did it');
    expect(result.producedBy.viaFallback).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(hook.onFailed).not.toHaveBeenCalled();
    expect(hook.branchOnEscalation).not.toHaveBeenCalled();
    expect(result.trace.find(entry => entry.kind === 'escalated')?.payload).toMatchObject({ phase: 'review', blameless: true });
  });

  it('still blames and branches a child whose plans were refused on their merits until the budget ran out', async () => {
    const parent = new Parent([refusal('names no outputs'), refusal('misses the boundary case'), refusal('tests nothing')]);
    const child = new Child(1);
    const hook = hooks();

    const result = await superviseLoop(parent, child, { description: 'add' }, makeCtx(), hook);

    expect(result.producedBy.viaFallback).toBe(true);
    expect(hook.onFailed).toHaveBeenCalledWith(child, 'escalation-plan', undefined);
    expect(hook.branchOnEscalation).toHaveBeenCalledOnce();
  });
});

describe('through the real tissue and cell', () => {
  const databases: ReturnType<typeof openDb>[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  const suite = {
    requirement: 'signed addition',
    cwd: '.',
    source: "import {test,expect} from 'vitest';import {add} from './add.ts';test('signed sums',()=>{expect(add(2,3)).toBe(5)});",
  };

  it('records no trust failure and creates no branched cell when the child-plan reviewer keeps failing', async () => {
    const db = openDb(':memory:');
    databases.push(db);
    const registry = new AtomRegistry(db);
    const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
    const tissue = L3Atom.buildWithModel(registry.create(3, seed), registry, 'mock');
    const cellType = registry.create(2, seed);
    const cell = L2Atom.fromType(registry.getByName(cellType.name)!, registry);
    const plan = makePlan({ subtasks: [{ description: 'Implement signed addition', outputs: ['add.ts'], acceptanceTests: suite }] });
    const cellPlans = vi.spyOn(cell, 'plan').mockResolvedValue(plan);
    const cellExecute = vi.spyOn(cell, 'execute');
    vi.spyOn(tissue, 'plan').mockResolvedValue(makePlan());
    const fallback = vi.spyOn(tissue, 'execute').mockResolvedValue({
      output: 'tissue did it', summary: 'tissue did it', trace: [], producedBy: { tier: 3, name: tissue.name, viaFallback: false },
    });
    const ctx = makeCtx();
    // Each fault is two failed reviews: the validation model, then tier 2.
    for (let i = 0; i < 2 * MAX_PLAN_REVIEW_FAULTS; i++) {
      ctx.llm.enqueue({ text: '{"approved": true, "reasoning": "cut', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 } });
    }
    const cellsBefore = registry.listByTier(2).length;
    const hooksOfTissue = (tissue as unknown as { makeL2Hooks(c: typeof ctx, d: string): SupervisionHooks<L2Atom> }).makeL2Hooks(ctx, 'add');

    const result = await superviseLoop(tissue, cell, { description: 'add', acceptanceTests: suite }, ctx, hooksOfTissue);

    expect(result.producedBy.viaFallback).toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
    expect(cellExecute).not.toHaveBeenCalled();
    expect(cellPlans).toHaveBeenCalledTimes(MAX_PLAN_REVIEW_FAULTS);
    expect(registry.getByName(cellType.name)?.failures).toBe(0);
    expect(registry.listByTier(2)).toHaveLength(cellsBefore);
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(2 * MAX_PLAN_REVIEW_FAULTS);
  });
});
