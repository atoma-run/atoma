import { startingSnapshotSchema } from './startingWorkspace.js';
import { z } from 'zod';
import { acceptanceChecklistSchema } from './acceptanceChecklist.js';
import type { Plan, Result, Task } from '../core/types.js';

/** Plan/strategy are opaque here; their existing parsers decode them at L3. */
export const rootPlanCheckpointSchema = z.object({
  plan: z.unknown(), strategy: z.unknown(), plannedPhases: z.number().int().positive(),
  inputs: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type RootPlanCheckpoint = z.infer<typeof rootPlanCheckpointSchema>;
export const checkpointProcessSchema = z.object({ pid: z.number().int().min(2), group: z.boolean() }).strict();
export type CheckpointProcess = z.infer<typeof checkpointProcessSchema>;

// Deliberately no attestations, trace, tool results or proof-coverage flags.
// A saved phase is historical context, never an execution in the new process.
export const completedPhaseSchema = z.object({
  output: z.unknown(), summary: z.string(),
  producedBy: z.object({ tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    name: z.string(), viaFallback: z.boolean() }).strict(),
}).strict();

export const runCheckpointSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), goal: z.string().min(1),
  scope: z.object({ orgId: z.string(), projectId: z.string(), principalId: z.string(), runId: z.string() }).strict().optional(),
  startingSnapshot: startingSnapshotSchema.optional(),
  workspace: z.string(), policy: z.string(),
  actor: z.object({ name: z.string(), atomId: z.string(), version: z.number().int() }).strict().nullable(),
  checklist: acceptanceChecklistSchema.nullable(),
  root: rootPlanCheckpointSchema.nullable(), completed: z.array(completedPhaseSchema),
  workspaceDigest: z.string().nullable(),
  processes: z.array(checkpointProcessSchema).max(8192).nullable(),
  consumed: z.object({ tokens: z.number().nonnegative(), costUsd: z.number().nonnegative() }).strict(),
  remainingMs: z.number().nonnegative(), lastRunId: z.string().nullable(),
}).strict();
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

/** Host-owned, root-only control hook. Never propagate into a child fork. */
export interface RootPhaseCheckpoint {
  restore(): RootPlanCheckpoint | null;
  planned(task: Task, plan: Plan, strategy: unknown, plannedPhases: number): void;
  readonly completed: readonly Result[];
  beforePhase(index: number): void;
  afterPhase(index: number, result: Result): Promise<void>;
  finalizing(): void;
}

/** A planned pause is a partial result, not an execution/validation failure. */
export class PhaseBoundaryPause extends Error {
  constructor(readonly result: Result) {
    super('Paused at a validated phase boundary; final acceptance is pending');
    this.name = 'PhaseBoundaryPause';
  }
}

export const projectCheckpointStatusSchema = z.object({
  state: z.enum(['running', 'pause_requested', 'paused', 'unavailable']),
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
}).strict();
export type ProjectCheckpointStatus = z.infer<typeof projectCheckpointStatusSchema>;
