import { z } from 'zod';
import { parentTestSuiteSchema } from './parentTests.js';

/** The scorer stays outside the model workspace, including held-out cases. */
export const modelComparisonCorpusSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  goal: z.string().min(1).max(16000),
  seed: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*$/)
    .refine(value => !value.split('/').includes('..')),
  timeoutMs: z.number().int().min(1000).max(1800000),
  suite: parentTestSuiteSchema,
}).strict();
export type ModelComparisonCorpus = z.infer<typeof modelComparisonCorpusSchema>;
