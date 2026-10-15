import { describe, expect, it } from 'vitest';
import {
  accountPlan,
  accountPlanSchema,
  BETA_PLAN,
  PLAN_IDS,
} from '../src/contracts/accountPlan.js';
import { DEFAULT_PLATFORM_LIMITS, resolvePlatformLimits } from '../src/contracts/platformSettings.js';

describe('account plan', () => {
  it('is Free for every organisation during the beta, with the instance limits', () => {
    const plan = accountPlan(DEFAULT_PLATFORM_LIMITS, 1);
    expect(accountPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.current).toBe(BETA_PLAN);
    expect(plan.beta).toBe(true);
    expect(plan.limits).toEqual({
      concurrentRuns: 1,
      runTimeoutMs: DEFAULT_PLATFORM_LIMITS['run.timeoutDefaultMs'],
      runCostMaxUsd: DEFAULT_PLATFORM_LIMITS['run.costMaxUsd'],
      runTokenMax: DEFAULT_PLATFORM_LIMITS['run.tokenMaxTotal'],
    });
  });

  it('follows an admin-stated limit rather than a brochure number', () => {
    const plan = accountPlan(resolvePlatformLimits({ 'run.costMaxUsd': 2.5, 'run.timeoutDefaultMs': 600_000 }), 0);
    expect(plan.limits.runCostMaxUsd).toBe(2.5);
    expect(plan.limits.runTimeoutMs).toBe(600_000);
    // Admission suspended is a fact the plan reports, not a value it hides.
    expect(plan.limits.concurrentRuns).toBe(0);
  });

  it('lists Free first: the catalogue order is the screen order', () => {
    expect(PLAN_IDS[0]).toBe('free');
    expect(PLAN_IDS).toContain(BETA_PLAN);
  });
});
