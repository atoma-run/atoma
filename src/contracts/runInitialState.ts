import { acceptanceChecklistSchema } from './acceptanceChecklist.js';
import { z } from 'zod';
import { startingSnapshotSchema } from './startingWorkspace.js';
import { runCheckpointSchema } from './runCheckpoint.js';
import { readRunsIndexSchema } from './readRuns.js';

/** Data-only launch context. Credentials, model pins and external connector grants are never retained. */
export const INITIAL_CONTEXT_KEYS = [
  'ATOMA_PREVIOUS_RUN_RESULTS', 'ATOMA_PREVIOUS_RUN_LANDING', 'ATOMA_STANDING_HTTP_EVIDENCE',
  'ATOMA_PROJECT_CONTEXT', 'ATOMA_REPOSITORY_PREPARATION',
  'ATOMA_ACCEPTANCE_SPEC', 'ATOMA_ACCEPTANCE_SOURCE',
] as const;
export const runInitialStateSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(), orgId: z.string().uuid(), projectId: z.string().uuid(),
  principalId: z.string().min(1), goal: z.string().min(1),
  snapshot: z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  environment: z.record(z.string(), z.string()).refine(value => Object.keys(value).every(key =>
    (INITIAL_CONTEXT_KEYS as readonly string[]).includes(key)), 'Initial context contains a privileged environment key'),
  inputs: z.record(z.string(), z.unknown()).optional(),
  startingSnapshot: startingSnapshotSchema.optional(),
  readRuns: readRunsIndexSchema.optional(),
  continuation: runCheckpointSchema.pick({ actor: true, checklist: true, root: true, completed: true })
    .extend({ replanAfterAnswer: z.boolean().optional() }).optional(),
  checklist: acceptanceChecklistSchema.optional(),
  externalConnectors: z.boolean(),
}).strict();
export type RunInitialState = z.infer<typeof runInitialStateSchema>;
