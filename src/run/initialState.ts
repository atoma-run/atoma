import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CheckpointExport } from '../contracts/checkpointTransfer.js';
import { INITIAL_CONTEXT_KEYS, runInitialStateSchema, type RunInitialState } from '../contracts/runInitialState.js';
import { attestationRecordSchema, type AttestationRecord } from '../contracts/attestation.js';
import { CheckpointReceiver } from './checkpointTransfer.js';
import { initializeCheckpointWorkspaces, restoreCheckpointWorkspace, pruneCheckpointWorkspaceSnapshots } from './checkpointWorkspace.js';
import { storedCheckpointExport } from './checkpointExport.js';

export function initializeRunInitialStates(db: Database.Database): void {
  initializeCheckpointWorkspaces(db);
  db.exec(`CREATE TABLE IF NOT EXISTS run_initial_states (
    run_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS run_initial_evidence (
    run_id TEXT NOT NULL, event_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(run_id,event_id)
  )`);
}

/** Reuses the sealed, streamed checkpoint boundary; no publication filtering or transaction over network input. */
export async function retainInitialWorkspace(db: Database.Database, exporting: CheckpointExport, signal?: AbortSignal): Promise<{ id: string; digest: string }> {
  const receiver = new CheckpointReceiver(db, exporting.header);
  try {
    for await (const frame of exporting.frames()) {
      signal?.throwIfAborted();
      if (frame.kind === 'entry') receiver.begin(frame.entry);
      else receiver.append(frame.offset, frame.bytes);
    }
    return receiver.finish();
  } catch (error) { receiver.abort(); throw error; }
  finally { await exporting.close(); }
}

export function initialContextEnvironment(env: NodeJS.ProcessEnv): RunInitialState['environment'] {
  return Object.fromEntries(INITIAL_CONTEXT_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
}

/** First complete capture wins. A restart may never replace initial bytes with the run's own output. */
export class RunInitialStateStore {
  constructor(readonly db: Database.Database) { initializeRunInitialStates(db); }
  publish(input: RunInitialState, evidence: readonly AttestationRecord[] = []): void {
    const state = runInitialStateSchema.parse(input);
    const payload = JSON.stringify(state);
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('Initial launch context exceeds its storage bound');
    this.db.transaction(() => {
      const snapshot = this.db.prepare('SELECT digest FROM run_checkpoint_snapshots WHERE id=?').get(state.snapshot.id) as { digest: string } | undefined;
      if (snapshot?.digest !== state.snapshot.digest) throw new Error('Initial workspace snapshot is unavailable');
      if (this.db.prepare('SELECT 1 FROM run_initial_states WHERE run_id=?').get(state.runId)) throw new Error('Initial state is immutable');
      this.db.prepare('INSERT INTO run_initial_states VALUES (?,?,?)').run(state.runId, state.snapshot.id, payload);
      for (const record of evidence) this.db.prepare('INSERT INTO run_initial_evidence VALUES (?,?,?)')
        .run(state.runId, record.eventId, JSON.stringify(attestationRecordSchema.parse(record)));
      this.db.prepare('DELETE FROM run_checkpoint_transfers WHERE snapshot=?').run(state.snapshot.id);
    }).immediate();
  }
  read(scope: { sourceRunId: string; orgId: string; projectId: string }): RunInitialState | null {
    const row = this.db.prepare('SELECT payload FROM run_initial_states WHERE run_id=?').get(scope.sourceRunId) as { payload: string } | undefined;
    if (!row) return null;
    const state = runInitialStateSchema.parse(JSON.parse(row.payload));
    if (state.runId !== scope.sourceRunId || state.orgId !== scope.orgId || state.projectId !== scope.projectId) throw new Error('Initial state scope does not match the source run');
    return state;
  }
  evidence(runId: string): AttestationRecord[] {
    return (this.db.prepare('SELECT record FROM run_initial_evidence WHERE run_id=?').all(runId) as { record: string }[])
      .map(row => ({ ...attestationRecordSchema.parse(JSON.parse(row.record)), historical: true }));
  }
  export(state: RunInitialState): CheckpointExport { return storedCheckpointExport(this.db, state.snapshot.id, state.snapshot.digest); }
  materialize(state: RunInitialState, target: string): void {
    restoreCheckpointWorkspace(this.db, state.snapshot.id, state.snapshot.digest, target, false);
  }
  expireReferences(runId: string): void {
    const rows = this.db.prepare(`SELECT DISTINCT s.run_id FROM run_initial_states s,
      json_each(s.payload,'$.readRuns.readRuns') r WHERE json_extract(r.value,'$.runId')=?`).all(runId) as { run_id: string }[];
    for (const row of rows) this.expire(row.run_id);
  }
  expire(runId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM run_initial_evidence WHERE run_id=?').run(runId);
      this.db.prepare('DELETE FROM run_initial_states WHERE run_id=?').run(runId);
      pruneCheckpointWorkspaceSnapshots(this.db);
    }).immediate();
  }
}

/** Full prepared bytes must survive both initial launch and later depth routing. */
export function initialStateRuntime(runtime: import('../contracts/workspaceRuntime.js').WorkspaceRuntime,
  store: RunInitialStateStore, state: RunInitialState): import('../contracts/workspaceRuntime.js').WorkspaceRuntime {
  const restore = async () => {
    const { restoreWorkspaceExport } = await import('./workspaceImport.js');
    await restoreWorkspaceExport(runtime, store.export(state), true);
  };
  return { ...runtime,
    prepare: async clean => { await runtime.prepare(clean); await restore(); },
    restart: async () => { await runtime.restart(); await restore(); },
    startingSnapshot: async () => state.startingSnapshot ?? null,
  };
}

/** Captures preserve directory modes. Make only this private tree removable, never following links. */
export function removeInitialStateWorkspace(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
  rmSync(root, { recursive: true, force: true });
}
