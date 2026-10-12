import { z } from 'zod';
import { learningReceiptSchema } from './skillLearning.js';

export const projectLearningInputSchema = z.object({
  since: z.string().datetime().optional(), until: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(5).optional(), cursor: z.string().max(4096).optional(),
}).strict();
export type ProjectLearningInput = z.infer<typeof projectLearningInputSchema>;
export const projectLearningCursorSchema = z.object({
  query: z.string(), runCeiling: z.number().int().nonnegative(), ledgerCeiling: z.number().int().nonnegative(),
  before: z.number().int().positive(),
});
export type ProjectLearningCursor = z.infer<typeof projectLearningCursorSchema>;
export const learningEvidenceSchema = z.object({
  source: z.enum(['trace', 'ledger']), id: z.string(), kind: z.string(),
  atom: z.string().nullable(), tier: z.number().nullable(), version: z.number().nullable(),
  promptChanged: z.boolean().nullable(), detail: z.string(),
  ownerId: z.string().nullable(), skillId: z.string().nullable(), executor: z.string().nullable(),
});
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;
export const projectLearningResultSchema = z.object({
  projectId: z.string(), nextCursor: z.string().nullable(),
  snapshot: z.object({ runCeiling: z.number(), ledgerCeiling: z.number() }),
  coverage: z.object({ selectedRuns: z.number(), totalRuns: z.number(),
    note: z.string() }),
  runs: z.array(z.object({
    projectRunId: z.string(), traceId: z.string().nullable(), status: z.string(), createdAt: z.string(),
    trace: z.object({ status: z.enum(['complete', 'live', 'missing', 'invalid', 'overCeiling']),
      snapshot: z.string().nullable(), events: z.number(), omitted: z.number() }),
    ledger: z.object({ available: z.boolean(), events: z.number(), omitted: z.number() }),
    counts: z.record(z.string(), z.number()), evidence: z.array(learningEvidenceSchema),
    learning: learningReceiptSchema.nullable(),
  })),
});
export type ProjectLearningResult = z.infer<typeof projectLearningResultSchema>;
