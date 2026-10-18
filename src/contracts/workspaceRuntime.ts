import type { ReadOnlyExecutionRecord, ReadOnlyPhaseGuard, ReadOnlyPhases, ReadOnlyRestoration } from './readOnlyPhase.js';
import type { ReadRunCopyCheck, ReadRunFileComparisons } from './readRuns.js';
import type { DeliveredSnapshot, StartingSnapshot } from './startingWorkspace.js';
import type { RoutingRepository } from './tissueRouting.js';
import { z } from 'zod';

export const inheritedWorkspaceStateSchema = z.object({
  manifest: z.string(), classification: z.string(), regularFiles: z.array(z.string()).readonly(),
}).strict().readonly();
export type InheritedWorkspaceState = z.infer<typeof inheritedWorkspaceStateSchema>;

/** Private runtime capability. Never an element or a model-facing tool registry. */
export interface AsyncReadOnlyPhases {
  begin(phase: string, attempt: number): Promise<{
    end(record?: ReadOnlyExecutionRecord): Promise<ReadOnlyRestoration>;
  }>;
  restorations(): readonly ReadOnlyRestoration[];
}

/** Synchronous library implementations remain source-compatible. */
export type RuntimeReadOnlyPhases = ReadOnlyPhases | AsyncReadOnlyPhases;
export type RuntimePhaseGuard = ReadOnlyPhaseGuard | Awaited<ReturnType<AsyncReadOnlyPhases['begin']>>;

/** All identities and photographs stay on the filesystem's execution host. */
export interface WorkspaceRuntime {
  checkpointDigest(): Promise<string>;
  checkpointExport(): Promise<import('./checkpointTransfer.js').CheckpointExport>;
  routingRepository(): Promise<RoutingRepository>;
  deliveredSnapshot(start: StartingSnapshot): Promise<DeliveredSnapshot>;
  captureReadRuns(): Promise<void>;
  checkReadRuns(): Promise<readonly ReadRunCopyCheck[]>;
  compareReadRuns(criteria: readonly string[]): Promise<ReadRunFileComparisons>;
  inheritedState(): Promise<InheritedWorkspaceState | null>;
  replaceManifest(text: string, expected?: string): Promise<boolean>;
  readonly readOnlyPhases: AsyncReadOnlyPhases;
}
