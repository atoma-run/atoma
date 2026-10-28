import { z } from 'zod';
import { idempotencyKeySchema, projectIdSchema, projectRunIdSchema } from './projects.js';

/** Host policy, never supplied by a device, task, or model. */
export const COMPUTE_VALIDATION = Object.freeze({
  // Full proof contexts are read repeatedly, including billed cache reads.
  // 60k stopped Attica at 162,966 tokens for $0.0137 before acceptance.
  // Attica continuation spent 177s executing before its result review; four minutes cut that review.
  timeoutMs: 15 * 60_000, tokens: 1_000_000, costUsd: 0.25,
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
