import { z } from 'zod';

/** Host policy, never supplied by a device, task, or model. */
export const COMPUTE_VALIDATION = Object.freeze({
  // Full proof contexts are read repeatedly, including billed cache reads.
  // 60k stopped Attica at 162,966 tokens for $0.0137 before acceptance.
  timeoutMs: 240_000, tokens: 1_000_000, costUsd: 0.25, attemptsPerDay: 4,
});
export const COMPUTE_VALIDATION_ENV = 'ATOMA_ASSAYER_COMPUTE_VALIDATION';
export const computeValidationStatusSchema = z.enum([
  'queued', 'budget-wait', 'running', 'completed', 'inconclusive', 'blocked', 'interrupted',
]);
export type ComputeValidationStatus = z.infer<typeof computeValidationStatusSchema>;
export const computeValidationLaunchSchema = z.object({
  sourceRunId: z.string().uuid(), orgId: z.string().uuid(), projectId: z.string().uuid(),
}).strict();
export type ComputeValidationLaunch = z.infer<typeof computeValidationLaunchSchema>;

/** Does not grant authority or inherit attestations; only narrows the ordinary runner's budgets. */
export function computeValidationLaunch(env: NodeJS.ProcessEnv): ComputeValidationLaunch | null {
  const raw = env[COMPUTE_VALIDATION_ENV];
  return raw === undefined ? null : computeValidationLaunchSchema.parse(JSON.parse(raw));
}
