import { z } from 'zod';
import { idempotencyKeySchema, projectIdSchema, projectRunIdSchema } from './projects.js';

/** Host policy, never supplied by a device, task, or model. */
export const COMPUTE_VALIDATION = Object.freeze({
  // Full proof contexts are read repeatedly, including billed cache reads.
  // Attica d79d05f0 stopped at 1,500,997 tokens / $0.0775 after four calls,
  // before result review; its source consumed 4,242,909. Leave room for both
  // execution and independent review without changing token accounting.
  // 03f5cf43 also reached $0.2527 before final review. Keep a finite cost
  // fence with room for execution and independent acceptance, not just tokens.
  timeoutMs: 30 * 60_000, tokens: 8_000_000, costUsd: 1,
});
export const COMPUTE_VALIDATION_ENV = 'ATOMA_ASSAYER_COMPUTE_VALIDATION';
export const computeValidationStatusSchema = z.enum([
  'queued', 'budget-wait', 'running', 'completed', 'inconclusive', 'blocked', 'interrupted',
]);
export type ComputeValidationStatus = z.infer<typeof computeValidationStatusSchema>;
export const computeValidationLaunchSchema = z.object({
  sourceRunId: z.string().uuid(), orgId: z.string().uuid(), projectId: z.string().uuid(),
  attemptId: z.string().uuid().optional(),
}).strict();
export type ComputeValidationLaunch = z.infer<typeof computeValidationLaunchSchema>;

/** Does not grant authority or inherit attestations; only narrows the ordinary runner's budgets. */
export function computeValidationLaunch(env: NodeJS.ProcessEnv): ComputeValidationLaunch | null {
  const raw = env[COMPUTE_VALIDATION_ENV];
  return raw === undefined ? null : computeValidationLaunchSchema.parse(JSON.parse(raw));
}

/** Explicit operator retry; the source and its immutable initial state cannot be replaced. */
export const computeValidationRetryInputSchema = z.object({
  projectId: projectIdSchema, runId: projectRunIdSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export type ComputeValidationRetryInput = z.infer<typeof computeValidationRetryInputSchema>;
export const computeValidationRetryReceiptSchema = z.object({
  sourceRunId: projectRunIdSchema, projectId: projectIdSchema, attemptId: z.string().uuid(),
  status: computeValidationStatusSchema, createdAt: z.string(), startedAt: z.string().nullable(), endedAt: z.string().nullable(),
  initialSnapshot: z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  result: z.object({
    validationRunId: z.string().uuid().optional(), costUsd: z.number().nonnegative().nullable().optional(),
    countersChanged: z.boolean().optional(), recipesChanged: z.boolean().optional(),
  }).strict(),
}).strict();
export type ComputeValidationRetryReceipt = z.infer<typeof computeValidationRetryReceiptSchema>;
