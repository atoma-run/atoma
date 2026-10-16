import { describe, expect, it, vi } from 'vitest';
import { Atom } from '../src/core/atom.js';
import { superviseLoop } from '../src/core/supervisor.js';
import type { Result, Tier, Verdict } from '../src/core/types.js';
import { delegationRefusal } from '../src/atoms/delegationReview.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const delivered: Result = {
  output: 'done',
  summary: 'done',
  producedBy: { tier: 1, name: 'child', viaFallback: false },
  trace: [],
};

class Child extends Atom {
  readonly model = 'mock';
  readonly plans = vi.fn(async () => makePlan());

  constructor(readonly tier: Tier) {
    super({ name: 'child', ordinal: 0, systemPrompt: '', tools: [], params: {} });
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
    super(2);
  }

  override async validatePlan(): Promise<Verdict> {
    return this.reviews.shift() ?? { approved: true, reasoning: 'plan reviewed' };
  }

  override async validateResult(): Promise<Verdict> {
    return { approved: true, reasoning: 'result reviewed' };
  }
}

describe('a plan review that failed as the reviewer', () => {
  it('asks for the plan again without coaching, repeat streaks or escalation', async () => {
    const fault = () => delegationRefusal('Delegation review is incomplete: the reviewer did not finish.', 'reviewer');
    // Three identical refusals would trip the same-reason escalation if counted.
    const parent = new Parent([fault(), fault(), fault()]);
    const child = new Child(1);
    const ctx = makeCtx();
    const limited = { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 5 } };
    const applyByScope = vi.fn(async (current: Child) => current);
    const branchOnEscalation = vi.fn(async () => undefined);

    const result = await superviseLoop(parent, child, { description: 'add' }, limited, { applyByScope, branchOnEscalation });

    expect(result.output).toBe('done');
    expect(child.plans).toHaveBeenCalledTimes(4);
    expect(applyByScope).not.toHaveBeenCalled();
    expect(branchOnEscalation).not.toHaveBeenCalled();
  });

  it('still escalates when the plan budget runs out, without running an unreviewed plan', async () => {
    const fault = () => delegationRefusal('Delegation review is incomplete: the reviewer did not finish.', 'reviewer');
    const parent = new Parent([fault(), fault()]);
    const child = new Child(1);
    const execute = vi.spyOn(child, 'execute');
    const ctx = makeCtx();
    const limited = { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 2 } };
    const branchOnEscalation = vi.fn(async () => undefined);

    await superviseLoop(parent, child, { description: 'add' }, limited, {
      applyByScope: async (current: Child) => current,
      branchOnEscalation,
    }).catch(() => undefined);

    expect(child.plans).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });
});
