import type { WorkspaceRuntime } from '../contracts/workspaceRuntime.js';
import { readRunCopyIntact } from '../contracts/readRuns.js';
import type { ToolBackend } from './toolBackend.js';

/** A refused full checkpoint need not invalidate the ordinary artifact export. */
export class DeepeningSnapshotUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The drained workspace checkpoint could not be sealed for deepening; retained work has no delivery approval.', { cause });
    this.name = 'DeepeningSnapshotUnavailableError';
  }
}

/** Change execution generation without reseeding over unfinished work. */
export async function deepenBackend(options: {
  backend: ToolBackend;
  workspace: WorkspaceRuntime;
  signal: AbortSignal;
  create: () => Promise<ToolBackend>;
}): Promise<ToolBackend> {
  const { backend, workspace, signal } = options;
  if (!backend.drain) throw new Error('Depth routing backend cannot confirm process exit');
  await backend.drain();
  signal.throwIfAborted();
  if ((await workspace.checkReadRuns()).some(check => !readRunCopyIntact(check))) {
    throw new Error('Read-run copies changed before deepening');
  }
  // The existing checkpoint capability seals two equal, bounded walks on the
  // execution host. Keep every byte, dependency and mode in place; never stream
  // the snapshot through the orchestrator or treat its contents as approval.
  const snapshot = await workspace.checkpointExport().catch((error: unknown) => {
    signal.throwIfAborted();
    throw new DeepeningSnapshotUnavailableError(error);
  });
  let replacement: ToolBackend | undefined;
  try {
    signal.throwIfAborted();
    replacement = await options.create();
    signal.throwIfAborted();
    if ((replacement.provenance ?? 'hosted') !== (backend.provenance ?? 'hosted')) {
      throw new Error('Execution provenance cannot change during a run');
    }
    if (await workspace.checkpointDigest() !== snapshot.header.digest) {
      throw new Error('Workspace changed while deepening');
    }
    await workspace.captureReadRuns();
    signal.throwIfAborted();
    return replacement;
  } catch (error) {
    try { await replacement?.cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Deepening refused and replacement cleanup failed');
    }
    throw error;
  } finally {
    await snapshot.close();
  }
}
