import { describe, expect, it } from 'vitest';
import {
  accountPlan,
  accountPlanSchema,
  BETA_PLAN,
  PLAN_IDS,
  planShowsAttribution,
} from '../src/contracts/accountPlan.js';
import Database from 'better-sqlite3';
import { AuthStore } from '../src/auth/store.js';
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

  it('reports the stored plan, still in beta since nobody can choose one', () => {
    const plan = accountPlan(DEFAULT_PLATFORM_LIMITS, 1, 'team');
    expect(plan.current).toBe('team');
    expect(plan.beta).toBe(true);
  });

  it('carries the Atoma mark on Free only', () => {
    expect(PLAN_IDS.filter(planShowsAttribution)).toEqual(['free']);
  });

  it('stores only paid plans: an organisation with no row, or an older store, is Free', () => {
    const store = new AuthStore(new Database(':memory:'));
    const orgId = store.completeLogin(
      { provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false }, null
    )!.viewer.orgId;
    expect(store.organisationPlan(orgId)).toBe('free');
    expect(store.setOrganisationPlan(orgId, 'pro')).toMatchObject({ orgId, previous: 'free', plan: 'pro' });
    expect(store.organisationPlan(orgId)).toBe('pro');
    expect(() => store.setOrganisationPlan('missing', 'pro')).toThrow(/organisation not found/);
    expect(store.setOrganisationPlan(orgId, 'free')).toMatchObject({ previous: 'pro', plan: 'free' });
    expect(store.organisationPlan(orgId)).toBe('free');

    const legacy = new Database(':memory:');
    const older = new AuthStore(legacy);
    legacy.exec('DROP TABLE auth_org_plans');
    expect(older.organisationPlan(orgId)).toBe('free');
  });

  it('lists Free first: the catalogue order is the screen order', () => {
    expect(PLAN_IDS[0]).toBe('free');
    expect(PLAN_IDS).toContain(BETA_PLAN);
  });
});
