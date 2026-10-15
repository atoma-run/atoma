import { z } from 'zod';
import type { PlatformLimits } from './platformSettings.js';

/**
 * THE ACCOUNT PLAN — what an organisation is on, and what that gives it.
 *
 * ONE plan exists during the beta: every organisation is on `free`, and the
 * paid plans below are SHOWN, never chosen — the client greys them so a
 * person knows what is coming and where they stand today. Keeping the ids
 * here, not in the client, means the day a second plan becomes selectable
 * the server names it and the client already knows how to draw it.
 *
 * THE NUMBERS ARE THE INSTANCE'S, NEVER THE BROCHURE'S. The limits a plan
 * reports are read from the platform settings the operator actually
 * enforces (`run.concurrentMax` per organisation through the run lease, the
 * wall-clock default, the spend and token ceilings) — so the plan screen can
 * never promise a budget the run path refuses. A ceiling whose value is `0`
 * is "none set", and the client says so rather than printing a zero.
 */
export const PLAN_IDS = ['free', 'pro', 'team'] as const;
export const planIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof planIdSchema>;

/** The one plan every organisation is on while Atoma is in beta. */
export const BETA_PLAN: PlanId = 'free';

export const accountPlanLimitsSchema = z.object({
  /** Simultaneous runs this organisation may hold; 0 means admission is suspended. */
  concurrentRuns: z.number().int().nonnegative(),
  /** Wall clock a run gets when its launcher asks for none. */
  runTimeoutMs: z.number().int().positive(),
  /** Estimated-spend ceiling per run in USD; 0 means no ceiling is set. */
  runCostMaxUsd: z.number().nonnegative(),
  /** Billable-token ceiling per run; 0 means no ceiling is set. */
  runTokenMax: z.number().int().nonnegative(),
});
export type AccountPlanLimits = z.infer<typeof accountPlanLimitsSchema>;

export const accountPlanSchema = z.object({
  current: planIdSchema,
  /** True while the deployment offers one plan only and the others are previews. */
  beta: z.boolean(),
  limits: accountPlanLimitsSchema,
});
export type AccountPlan = z.infer<typeof accountPlanSchema>;

/**
 * Project the instance's enforced limits onto the viewer's plan. `orgConcurrent`
 * is the organisation's own admission limit (the run lease's per-organisation
 * slot), which is what a member experiences; the host-wide ceiling is an
 * operator fact and stays in the admin plane.
 */
export function accountPlan(limits: PlatformLimits, orgConcurrent: number): AccountPlan {
  return {
    current: BETA_PLAN,
    beta: true,
    limits: {
      concurrentRuns: orgConcurrent,
      runTimeoutMs: limits['run.timeoutDefaultMs'],
      runCostMaxUsd: limits['run.costMaxUsd'],
      runTokenMax: limits['run.tokenMaxTotal'],
    },
  };
}
