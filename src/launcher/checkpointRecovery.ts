import { SocketLauncher } from './client.js';
import { checkpointWorkerAbsent } from './docker.js';
import type { RunCheckpoint } from '../contracts/runCheckpoint.js';

/** The caller already checked the dead run owner and its scoped receipt. This
 * only asks about absence; it never removes a worker owned by another caller.
 */
export async function assertCheckpointWorkerAbsent(worker: NonNullable<RunCheckpoint['worker']>): Promise<void> {
  if (worker.endpoint !== process.env['ATOMA_LAUNCHER_SOCKET']) throw new Error('Checkpoint launcher configuration changed');
  const ids = [worker.id, ...worker.previousIds ?? []];
  let absent = true;
  if (worker.endpoint) {
    const client = await SocketLauncher.connect(worker.endpoint);
    try { for (const id of ids) if (!await client.checkpointWorkerAbsent(id)) absent = false; }
    finally { client.close(); }
  } else { for (const id of ids) if (!await checkpointWorkerAbsent(id)) absent = false; }
  if (!absent) throw new Error('Checkpoint worker still exists; wait for launcher cleanup before recovery');
}
