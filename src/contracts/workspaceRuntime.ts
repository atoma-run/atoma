import type { ReadOnlyExecutionRecord, ReadOnlyPhaseGuard, ReadOnlyPhases, ReadOnlyRestoration } from './readOnlyPhase.js';
import type { ReadRunCopyCheck, ReadRunFileComparisons } from './readRuns.js';
import type { DeliveredSnapshot, StartingSnapshot } from './startingWorkspace.js';
import type { RoutingRepository } from './tissueRouting.js';
import { z } from 'zod';
import type { CheckpointTransferEntry, CheckpointTransferHeader } from './checkpointTransfer.js';

export interface WorkspaceRestoration {
  begin(entry: CheckpointTransferEntry): void | Promise<void>;
  append(offset: number, bytes: Uint8Array): void | Promise<void>;
  finish(): void | Promise<void>;
  abort(): void | Promise<void>;
}

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
  importWorkspace(header: CheckpointTransferHeader, archive: boolean): Promise<WorkspaceRestoration>;
  /** Sources are bound by the launcher, never supplied by a model command. */
  validateSources(): Promise<void>;
  prepare(clean: boolean): Promise<void>;
  restart(): Promise<void>;
  startingSnapshot(): Promise<StartingSnapshot | null>;
  /** Refuse legacy read-run layout before creating the read-only mount source. */
  ensureReadRuns(): Promise<string | null>;
  canonicalPath(): Promise<string>;
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
