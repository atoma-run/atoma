import { openStoreHandle } from '../core/stores.js';
import type { ComputeSession } from '../contracts/computeDevice.js';
import { processFingerprint, recordedProcessLive } from '../mcp/runLock.js';
import { basename, dirname, join } from 'node:path';

const DDL = `CREATE TABLE IF NOT EXISTS compute_session_executors (
 device_id TEXT PRIMARY KEY REFERENCES compute_devices(device_id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, socket TEXT NOT NULL, pid INTEGER NOT NULL, fingerprint TEXT NOT NULL
);`;
export function recordComputeExecutor(dbPath: string, session: ComputeSession, socket: string): void {
  const fingerprint = processFingerprint(process.pid);
  if (!fingerprint) throw new Error('Compute executor identity unavailable');
  openStoreHandle(dbPath, DDL).prepare('INSERT OR REPLACE INTO compute_session_executors VALUES (?,?,?,?,?)')
    .run(session.deviceId, session.sessionId, socket, process.pid, fingerprint);
}
export function computeExecutor(dbPath: string, session: ComputeSession): string | undefined {
  const row = openStoreHandle(dbPath, DDL).prepare('SELECT socket,pid,fingerprint FROM compute_session_executors WHERE device_id=? AND session_id=?')
    .get(session.deviceId, session.sessionId) as { socket: string; pid: number; fingerprint: string } | undefined;
  return row && recordedProcessLive(row.pid, row.fingerprint) ? row.socket : undefined;
}

/** Only a live host-recorded generation can select a sibling public gateway. */
export function computeResumeSocket(dbPath: string, session: ComputeSession, ownSocket: string, publicSocket: string | undefined): string | undefined {
  const owner = computeExecutor(dbPath, session);
  return owner && owner !== ownSocket && /^[a-f0-9]{40}\.sock$/.test(basename(owner)) && publicSocket
    ? join(dirname(publicSocket), basename(owner)) : undefined;
}
