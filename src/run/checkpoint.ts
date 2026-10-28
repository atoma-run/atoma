import { initializeRunInitialStates, RunInitialStateStore } from './initialState.js';
import { attestationRecordSchema, type AttestationLog, type AttestationRecord } from '../contracts/attestation.js';
import { transportWitnesses } from '../contracts/witness.js';
import { initializeClientQuestions, readClientQuestion, recordClientQuestion, answerClientQuestion, applyClientAnswer } from './clientQuestions.js';
import { clientAnswerHistoryHasRoom, type AnswerClientQuestion, type ClientQuestion } from '../contracts/clientQuestion.js';
import type { Task, SubtaskSpec } from '../core/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { setRecoveryEffectHandler } from '../core/recoveryEffects.js';
import { checkpointToolIsRestorable } from '../tools/recoveryPolicy.js';
import type { LlmClient, ToolExecutor } from '../core/types.js';
import { isAbsolute, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import type { Result } from '../core/types.js';
import { isLanded } from '../contracts/runLanding.js';
import { parentTestsGrantNothing } from '../core/parentTests.js';
import type { AtomRegistry, AtomType } from '../registry/atomRegistry.js';
import { outOfPhaseBudget } from '../core/limits.js';
import { canonicalCheckpointWorkspacePath, checkpointWorkspaceDigest, readCheckpointWorkspace, saveCheckpointWorkspace, restoreCheckpointWorkspace, initializeCheckpointWorkspaces, pruneCheckpointWorkspaceSnapshots } from './checkpointWorkspace.js';
import { CheckpointReceiver } from './checkpointTransfer.js';
import type { CheckpointTransferHeader } from '../contracts/checkpointTransfer.js';
import { storedCheckpointExport } from './checkpointExport.js';
export { canonicalCheckpointWorkspacePath, checkpointWorkspaceDigest } from './checkpointWorkspace.js';
import { PhaseBoundaryPause, runCheckpointSchema, type RootDelegationApproval, type RootPhaseCheckpoint, type RunCheckpoint, type ProjectCheckpointStatus } from '../contracts/runCheckpoint.js';
import { READ_RUNS_DIRECTORY } from '../contracts/readRuns.js';

const DDL = `CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT NOT NULL,
  pid INTEGER NOT NULL, host TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
)`;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
type Row = { state: string; owner: string; pid: number; host: string; released: number; payload: string };
type RecoveryRow = { boundary_seq: number; blocked: string | null; consumed: string; deadline: number };

export function assertCheckpointStoreOutsideWorkspace(store: string, workspace: string): void {
  const canonicalWorkspace = canonicalCheckpointWorkspacePath(workspace);
  const rel = relative(canonicalWorkspace, realpathSync(store));
  if (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) {
    throw new Error('The checkpoint store must be outside the tool workspace');
  }
}


function encoded(data: RunCheckpoint): string {
  const payload = JSON.stringify(runCheckpointSchema.parse(data));
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new Error('Checkpoint state exceeds its size limit');
  return payload;
}

function ownerAlive(row: Pick<Row, 'host' | 'pid' | 'released'>): boolean {
  if (row.host !== hostname()) throw new Error('Checkpoint belongs to another host');
  if (row.released) return false;
  try { process.kill(row.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/**
 * A project run's checkpoint as every reader presents it: the run's own status
 * decides which states it can be in. A boundary is offered only once the
 * project finalizer has settled the run, and a live state only while it runs.
 */
export function projectedCheckpointStatus(status: ProjectCheckpointStatus | undefined, runStatus: string): ProjectCheckpointStatus | undefined {
  if (!status) return undefined;
  if (['recoverable', 'blocked'].includes(status.state) && !['failed', 'partial'].includes(runStatus)) return { ...status, state: 'unavailable' as const };
  if (status.state === 'paused' && runStatus !== 'partial') return { ...status, state: 'unavailable' as const };
  if (['running', 'pause_requested'].includes(status.state) && runStatus !== 'running') return { ...status, state: 'unavailable' as const };
  return status;
}

/**
 * THE ONE DEFINITION of "this project run can still be continued": paused at
 * a boundary, or interrupted and recoverable. A cancelled or crashed run whose
 * row stayed 'running', and a blocked one, cannot. The read-run copies' removal
 * and the retention hold on the runs they copy both ask this, so neither keeps
 * what the other lets go (second review 2026-10-17).
 */
export function checkpointContinuable(status: ProjectCheckpointStatus | undefined): boolean {
  return status?.state === 'paused' || status?.state === 'recoverable';
}

function recoveryRow(db: Database.Database, id: string): RecoveryRow | undefined {
  return db.prepare('SELECT * FROM run_checkpoint_recovery WHERE id=?').get(id) as RecoveryRow | undefined;
}

function recoveryReasonOf(db: Database.Database, id: string, data: RunCheckpoint, released = false): ProjectCheckpointStatus['reason'] {
  const r = recoveryRow(db, id);
  if (!r || !data.snapshotId || (!data.completed.length && !data.clientQuestionId)) return 'incomplete';
  if (r.blocked) return r.blocked as ProjectCheckpointStatus['reason'];
  if (db.prepare("SELECT 1 FROM run_checkpoint_actions WHERE id=? AND seq>? AND kind='model' AND state<>'done' LIMIT 1").get(id, r.boundary_seq)) return 'model_pending';
  if (db.prepare("SELECT 1 FROM run_checkpoint_actions WHERE id=? AND seq>? AND kind='tool' AND state='pending' LIMIT 1").get(id, r.boundary_seq)) return 'tool_pending';
  if (!released && r.deadline <= Date.now()) return 'budget_exhausted';
  if (!released && data.processes === null && !data.worker) return 'backend_unknown';
  return undefined;
}

function pauseRequestedOf(db: Database.Database, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM run_checkpoint_pauses WHERE id = ?').get(id);
}

/**
 * A project run's checkpoint state, by reads alone, on any handle of the
 * product store: offline retention plans on a read-only one, where a
 * `RunCheckpointStore` (which creates its tables) must never open.
 */
export function readProjectCheckpointStatus(db: Database.Database, id: string, orgId: string): ProjectCheckpointStatus | undefined {
  const row = db.prepare(`SELECT state, released, pid, host,
    json_extract(payload, '$.scope.orgId') AS org,
    json_array_length(payload, '$.completed') AS completed,
    json_array_length(payload, '$.root.plan.subtasks') AS total
    FROM run_checkpoints WHERE id = ?`).get(id) as
    { state: string; released: number; pid: number; host: string; org: string; completed: number; total: number | null } | undefined;
  if (!row || row.org !== orgId) return undefined;
  if (row.state !== 'finished' && !row.released && row.host === hostname() && !ownerAlive(row)) {
    const payload = db.prepare('SELECT payload FROM run_checkpoints WHERE id=?').get(id) as { payload: string };
    const parsed = runCheckpointSchema.safeParse(JSON.parse(payload.payload));
    const reason = parsed.success ? recoveryReasonOf(db, id, parsed.data) : 'incomplete';
    return { state: reason ? 'blocked' : 'recoverable', ...(reason ? { reason } : {}), completed: row.completed, total: row.total ?? 0 };
  }
  return { state: row.state === 'finished' ? 'unavailable'
    : row.state === 'ready' && row.released ? 'paused'
    : pauseRequestedOf(db, id) ? 'pause_requested' : 'running', completed: row.completed, total: row.total ?? 0 };
}

/** `checkpointContinuable` for one project run, read from its checkpoint row and its status. */
export function projectRunContinuable(db: Database.Database, id: string, orgId: string, runStatus: string): boolean {
  return checkpointContinuable(projectedCheckpointStatus(readProjectCheckpointStatus(db, id, orgId), runStatus));
}

/** One table in the product store. A CAS claim consumes a boundary exactly once. */
export class RunCheckpointStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = openStoreHandle(path, DDL);
    initializeClientQuestions(this.db);
    this.db.exec('CREATE TABLE IF NOT EXISTS run_checkpoint_pauses (id TEXT PRIMARY KEY)');
    this.db.exec('CREATE TABLE IF NOT EXISTS run_checkpoint_evidence (id TEXT NOT NULL, event_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(id,event_id))');
    initializeCheckpointWorkspaces(this.db);
    initializeRunInitialStates(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_checkpoint_recovery (
      id TEXT PRIMARY KEY, boundary_seq INTEGER NOT NULL, blocked TEXT, consumed TEXT NOT NULL, deadline REAL NOT NULL
    ); CREATE TABLE IF NOT EXISTS run_checkpoint_actions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, phase INTEGER NOT NULL,
      kind TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, request_digest TEXT NOT NULL,
      result_digest TEXT, result TEXT
    ); CREATE INDEX IF NOT EXISTS checkpoint_actions_by_run ON run_checkpoint_actions(id,seq)`);
  }

  private recovery(id: string): RecoveryRow | undefined {
    return recoveryRow(this.db, id);
  }

  private recoveryReason(id: string, data: RunCheckpoint, released = false): ProjectCheckpointStatus['reason'] {
    return recoveryReasonOf(this.db, id, data, released);
  }

  projectStatus(id: string, orgId: string): ProjectCheckpointStatus | undefined {
    return readProjectCheckpointStatus(this.db, id, orgId);
  }

  /** `checkpointContinuable` for one project run, read from its row and status. */
  continuable(id: string, orgId: string, runStatus: string): boolean {
    return projectRunContinuable(this.db, id, orgId, runStatus);
  }

  /**
   * Delete the read-run copies (`.atoma-runs`, src/contracts/readRuns.ts) that
   * a run's checkpoint snapshot sealed with the rest of its workspace, once
   * the run can no longer be continued: the snapshot outlived the read run's
   * own retention in the product store (third check 2026-10-17). A snapshot
   * another checkpoint may still restore from (a continuation shares its
   * source's until its first boundary) stays whole while `keep` says so of
   * that holder. The snapshot then no longer matches its digest, so a restore
   * of it fails closed; nothing may restore it. Returns the entries deleted.
   */
  forgetReadRunCopies(id: string, keep: (holder: string) => boolean): number {
    const row = this.db.prepare("SELECT json_extract(payload,'$.snapshotId') AS snapshot FROM run_checkpoints WHERE id=?").get(id) as
      { snapshot: string | null } | undefined;
    if (!row?.snapshot) return 0;
    const holders = this.db.prepare("SELECT id FROM run_checkpoints WHERE id<>? AND state<>'finished' AND json_extract(payload,'$.snapshotId')=?")
      .pluck().all(id, row.snapshot) as string[];
    if (holders.some(keep)) return 0;
    return this.db.prepare('DELETE FROM run_checkpoint_files WHERE snapshot=? AND (path=? OR substr(path,1,?)=?)')
      .run(row.snapshot, READ_RUNS_DIRECTORY, READ_RUNS_DIRECTORY.length + 1, `${READ_RUNS_DIRECTORY}/`).changes;
  }

  requestPause(id: string, orgId: string): void {
    const state = this.projectStatus(id, orgId);
    if (!state || !['running', 'pause_requested'].includes(state.state) || !state.total) throw new Error('No sequential phase is available to pause');
    this.db.prepare('INSERT OR IGNORE INTO run_checkpoint_pauses (id) VALUES (?)').run(id);
  }
  pauseRequested(id: string): boolean {
    return pauseRequestedOf(this.db, id);
  }

  /** Consume the source and claim a separate segment in one transaction.
   * Returns the source's prior state, which `restoreContinuation` puts back. */
  continueProject(source: RunCheckpoint, next: RunCheckpoint): { owner: string; sourceState: string } {
    return this.db.transaction(() => {
      if (encoded(this.read(source.id)) !== encoded(source)) throw new Error('Checkpoint changed before continuation');
      const { state: sourceState } = this.db.prepare('SELECT state FROM run_checkpoints WHERE id=?').get(source.id) as { state: string };
      this.db.prepare("UPDATE run_checkpoints SET state='finished' WHERE id=?").run(source.id);
      this.db.prepare('INSERT INTO run_checkpoint_evidence SELECT ?, event_id, record FROM run_checkpoint_evidence WHERE id=?').run(next.id, source.id);
      return { owner: this.claim(next, true), sourceState };
    }).immediate();
  }

  /** Undo a continuation refused before any work (code review 2026-10-09,
   * 1.4): the untouched source is resumable again, the successor finished. */
  restoreContinuation(sourceId: string, sourceState: string, nextId: string, owner: string): void {
    this.db.transaction(() => {
      const next = this.db.prepare('SELECT owner, state FROM run_checkpoints WHERE id=?').get(nextId) as Pick<Row, 'owner' | 'state'> | undefined;
      if (next?.owner !== owner || next.state === 'finished') throw new Error('Checkpoint ownership lost');
      if (this.db.prepare("UPDATE run_checkpoints SET state=? WHERE id=? AND state='finished'").run(sourceState, sourceId).changes !== 1) {
        throw new Error('Continuation source changed');
      }
      this.db.prepare("UPDATE run_checkpoints SET state='finished' WHERE id=?").run(nextId);
    }).immediate();
  }

  /** Archive rows are independent of the bounded checkpoint plan payload. */
  saveEvidence(id: string, owner: string, records: readonly AttestationRecord[]): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM run_checkpoints WHERE id=? AND owner=? AND state<>'finished'").get(id, owner)) throw new Error('Checkpoint ownership lost');
      const insert = this.db.prepare('INSERT OR IGNORE INTO run_checkpoint_evidence(id,event_id,record) VALUES (?,?,?)');
      for (const record of records) insert.run(id, record.eventId, JSON.stringify(attestationRecordSchema.parse(record)));
    }).immediate();
  }
  historicalEvidence(data: RunCheckpoint): AttestationRecord[] {
    const read = this.db.prepare('SELECT record FROM run_checkpoint_evidence WHERE id=? AND event_id=?');
    return [...new Set(data.completed.flatMap(phase => phase.historicalEvidenceIds ?? []))].flatMap(eventId => {
      const row = read.get(data.id, eventId) as { record: string } | undefined;
      if (!row) return []; // Legacy or unavailable archive is unknown, never freshly observed.
      return [{ ...attestationRecordSchema.parse(JSON.parse(row.record)), historical: true as const }];
    });
  }

  read(id: string): RunCheckpoint {
    const row = this.db.prepare('SELECT * FROM run_checkpoints WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('Unknown checkpoint');
    if (row.state !== 'ready' && row.state !== 'running') throw new Error('Checkpoint is not at a resumable phase boundary (in-flight or finished)');
    if (ownerAlive(row)) throw new Error('Checkpoint is still owned by a running process');
    if (Buffer.byteLength(row.payload) > MAX_PAYLOAD_BYTES) throw new Error('Checkpoint state exceeds its size limit');
    const data = runCheckpointSchema.parse(JSON.parse(row.payload));
    if (row.released && this.recovery(id)) {
      const reason = this.recoveryReason(id, data, true);
      if (reason) throw new Error(`Checkpoint cannot be resumed: ${reason}`);
    }
    if (row.state === 'running' || (!row.released && data.snapshotId)) {
      const reason = this.recoveryReason(id, data);
      if (reason) throw new Error(`Checkpoint is not at a resumable phase boundary: ${reason}`);
      const r = this.recovery(id)!;
      data.interrupted = true;
      data.recoveryDeadlineAt = r.deadline;
      data.consumed = runCheckpointSchema.shape.consumed.parse(JSON.parse(r.consumed));
    }
    if (data.id !== id || !data.root || !data.actor || data.checklist === null || (data.completed.length === 0 && !data.clientQuestionId) ||
        !data.workspaceDigest || !/^[0-9a-f]{64}$/.test(data.workspaceDigest)) {
      throw new Error('Checkpoint is incomplete or corrupt');
    }
    if (!row.released) {
      if (data.processes === null && !data.worker) throw new Error('Checkpoint backend was not drained; crash resume is unavailable');
      for (const child of data.processes ?? []) {
        let alive = true;
        try { process.kill(child.group ? -child.pid : child.pid, 0); }
        catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error('Checkpoint still has sandbox processes; resume refused');
      }
    }
    applyClientAnswer(this.db, data);
    return data;
  }

  clientQuestion(orgId: string, runId: string) { return readClientQuestion(this.db, orgId, runId); }

  answerClientQuestion(orgId: string, runId: string, principalId: string, input: AnswerClientQuestion) {
    return answerClientQuestion(this.db, orgId, runId, principalId, input);
  }

  materialize(data: RunCheckpoint, target: string, archive: boolean): void {
    if (!data.snapshotId || !data.workspaceDigest) throw new Error('Checkpoint snapshot is unavailable');
    restoreCheckpointWorkspace(this.db, data.snapshotId, data.workspaceDigest, target, archive);
  }

  exportWorkspace(data: RunCheckpoint) {
    if (!data.snapshotId || !data.workspaceDigest) throw new Error('Checkpoint snapshot is unavailable');
    return storedCheckpointExport(this.db, data.snapshotId, data.workspaceDigest);
  }

  boundary(data: RunCheckpoint, owner: string, question?: ClientQuestion): void {
    const before = readCheckpointWorkspace(data.workspace);
    this.commitBoundary(data, owner, () => saveCheckpointWorkspace(this.db, data.workspace, before), question);
  }

  /** Attach a fully received snapshot; incomplete transfer rows have no authority. */
  boundaryFromSnapshot(data: RunCheckpoint, owner: string, snapshot: { id: string; digest: string }, question?: ClientQuestion): void {
    this.commitBoundary(data, owner, () => {
      const transfer = this.db.prepare('SELECT 1 FROM run_checkpoint_transfers WHERE snapshot=? AND checkpoint_id=? AND owner=? AND expires_at>?')
        .get(snapshot.id, data.id, owner, Date.now());
      const row = this.db.prepare('SELECT digest FROM run_checkpoint_snapshots WHERE id=?').get(snapshot.id) as { digest: string } | undefined;
      if (!transfer || !row || row.digest !== snapshot.digest) throw new Error('Checkpoint snapshot is unavailable');
      this.db.prepare('DELETE FROM run_checkpoint_transfers WHERE snapshot=?').run(snapshot.id);
      return snapshot;
    }, question);
  }

  receiveWorkspace(data: RunCheckpoint, owner: string, header: CheckpointTransferHeader): CheckpointReceiver {
    if (!this.db.prepare("SELECT 1 FROM run_checkpoints WHERE id=? AND owner=? AND state='running'").get(data.id, owner)) {
      throw new Error('Checkpoint is not owned by this run');
    }
    return new CheckpointReceiver(this.db, header, { checkpointId: data.id, owner });
  }

  private commitBoundary(data: RunCheckpoint, owner: string, capture: () => { id: string; digest: string }, question?: ClientQuestion): void {
    this.db.transaction(() => {
      const snapshot = capture();
      if (question) recordClientQuestion(this.db, data, question);
      data.snapshotId = snapshot.id;
      data.workspaceDigest = snapshot.digest;
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM run_checkpoint_actions WHERE id=?').get(data.id) as { n: number }).n;
      this.db.prepare('UPDATE run_checkpoint_recovery SET boundary_seq=?,blocked=NULL,consumed=? WHERE id=?')
        .run(seq, JSON.stringify(data.consumed), data.id);
      this.write(data, owner, 'ready');
    }).immediate();
    this.pruneSnapshots();
  }

  beginSegment(data: RunCheckpoint, deadline: number): void {
    this.db.prepare(`INSERT INTO run_checkpoint_recovery VALUES (?,0,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET boundary_seq=(SELECT COALESCE(MAX(seq),0) FROM run_checkpoint_actions WHERE id=excluded.id),
      blocked=NULL,consumed=excluded.consumed,deadline=excluded.deadline`).run(data.id, JSON.stringify(data.consumed), deadline);
  }

  blockMutation(id: string, owner: string, db: Database.Database): void {
    if (resolve(db.name) !== resolve(this.db.name)) throw new Error('Recovery cannot journal a mutation in another store');
    // Use the mutation's connection: an existing transaction commits or rolls
    // back the barrier WITH the counters. File writers call this before bytes.
    db.prepare(`UPDATE run_checkpoint_recovery SET blocked='host_mutation'
      WHERE id=? AND EXISTS (SELECT 1 FROM run_checkpoints WHERE id=? AND owner=? AND state<>'finished')`).run(id, id, owner);
  }

  beginAction(data: RunCheckpoint, owner: string, kind: 'tool' | 'model', name: string, request: unknown): number {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT owner FROM run_checkpoints WHERE id=?').get(data.id) as { owner: string } | undefined;
      if (current?.owner !== owner) throw new Error('Checkpoint ownership lost');
      if (kind === 'tool' && !checkpointToolIsRestorable(name)) {
        this.db.prepare("UPDATE run_checkpoint_recovery SET blocked='external_effect' WHERE id=?").run(data.id);
      }
      return Number(this.db.prepare("INSERT INTO run_checkpoint_actions(id,phase,kind,name,state,request_digest) VALUES (?,?,?,?,'pending',?)")
        .run(data.id, data.completed.length, kind, name, createHash('sha256').update(JSON.stringify(request) ?? 'null').digest('hex')).lastInsertRowid);
    }).immediate();
  }

  endAction(data: RunCheckpoint, seq: number, result: unknown, failed: boolean): void {
    const bytes = JSON.stringify(result) ?? 'null';
    this.db.transaction(() => {
      this.db.prepare('UPDATE run_checkpoint_actions SET state=?,result_digest=?,result=? WHERE seq=? AND id=?')
        .run(failed ? 'error' : 'done', createHash('sha256').update(bytes).digest('hex'), Buffer.byteLength(bytes) <= 65536 ? bytes : null, seq, data.id);
      this.db.prepare('UPDATE run_checkpoint_recovery SET consumed=? WHERE id=?').run(JSON.stringify(data.consumed), data.id);
    }).immediate();
  }

  pruneSnapshots(): void {
    pruneCheckpointWorkspaceSnapshots(this.db);
  }

  /**
   * Drop the recovery journal of every FINISHED checkpoint (2026-10-16).
   * Those rows answer one question — may this boundary be resumed — and a
   * finished checkpoint can no longer be read, claimed or resumed. Kept, they
   * were 54 of the production store's 143 MB, each tool and model call
   * holding up to 64 KiB of result until the 90-day offline retention.
   *
   * ONE EXCEPTION: the source of a project continuation in flight. The
   * successor marks its source finished when it claims it
   * (`continueProject`), and may still hand it back untouched
   * (`restoreContinuation`) with the journal its resumability is judged on.
   * Its run row names that source in `resume_of_run_id` while it is queued or
   * running, so the source is kept until the successor ends.
   *
   * Bounded batches per checkpoint, never one sweep: the first pass on
   * an existing store deletes thousands of rows and must not hold the shared
   * write lock while it does.
   */
  pruneFinished(): number {
    const continuing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_runs'").get()
      ? "AND c.id NOT IN (SELECT resume_of_run_id FROM project_runs WHERE resume_of_run_id IS NOT NULL AND status IN ('queued','running'))"
      : '';
    const ids = this.db.prepare(`SELECT c.id FROM run_checkpoints c WHERE c.state='finished' ${continuing}
      AND (EXISTS (SELECT 1 FROM run_checkpoint_actions a WHERE a.id=c.id)
        OR EXISTS (SELECT 1 FROM run_checkpoint_recovery r WHERE r.id=c.id)
        OR EXISTS (SELECT 1 FROM run_checkpoint_pauses p WHERE p.id=c.id))`).pluck().all() as string[];
    const prune = this.db.transaction((id: string) => {
      // Re-read under the lock: a restored continuation source is no longer finished.
      if (!this.db.prepare(`SELECT 1 FROM run_checkpoints c WHERE c.id=? AND c.state='finished' ${continuing}`).get(id)) return 'protected';
      const removed = this.db.prepare('DELETE FROM run_checkpoint_actions WHERE seq IN (SELECT seq FROM run_checkpoint_actions WHERE id=? LIMIT 128)').run(id);
      if (removed.changes === 128) return 'more';
      this.db.prepare('DELETE FROM run_checkpoint_recovery WHERE id=?').run(id);
      this.db.prepare('DELETE FROM run_checkpoint_pauses WHERE id=?').run(id);
      return 'done';
    });
    let pruned = 0;
    for (const id of ids) {
      let result: string;
      do { result = prune.immediate(id); } while (result === 'more');
      if (result === 'done') pruned++;
    }
    return pruned;
  }

  /** Offline retention expires byte-bearing records along with the workspace. */
  expire(id: string): void {
    this.db.transaction(() => {
      new RunInitialStateStore(this.db).expire(id);
      this.db.prepare("UPDATE run_checkpoints SET state='finished' WHERE id=?").run(id);
      this.db.prepare('DELETE FROM run_checkpoint_actions WHERE id=?').run(id);
      this.db.prepare('DELETE FROM run_checkpoint_recovery WHERE id=?').run(id);
      this.db.prepare('DELETE FROM run_checkpoint_pauses WHERE id=?').run(id);
      this.db.prepare('DELETE FROM run_checkpoint_evidence WHERE id=?').run(id);
      this.pruneSnapshots();
    }).immediate();
  }

  claim(data: RunCheckpoint, fresh: boolean): string {
    const owner = randomUUID();
    this.db.transaction(() => {
      if (fresh) this.db.prepare('INSERT INTO run_checkpoints (id,state,owner,pid,host,payload) VALUES (?,\'running\',?,?,?,?)')
        .run(data.id, owner, process.pid, hostname(), encoded(data));
      else {
        const current = this.read(data.id);
        if (encoded(current) !== encoded(data)) throw new Error('Checkpoint changed before it could be claimed');
        this.db.prepare('UPDATE run_checkpoints SET state=\'running\',owner=?,pid=?,host=?,released=0 WHERE id=?')
          .run(owner, process.pid, hostname(), data.id);
      }
    }).immediate();
    return owner;
  }

  write(data: RunCheckpoint, owner: string, state: 'running' | 'ready' | 'finished', released = false): void {
    const result = this.db.prepare('UPDATE run_checkpoints SET state=?,payload=?,released=? WHERE id=? AND owner=?')
      .run(state, encoded(data), Number(released), data.id, owner);
    if (result.changes !== 1) throw new Error('Checkpoint ownership lost');
  }
}

/** Restore only a sealed boundary whose interrupted suffix has no irreversible
 * effects, unsettled model spend, or live processes. Proof is always fresh. */
export class SequentialCheckpoint implements RootPhaseCheckpoint {
  readonly ready: Promise<void>;
  private readonly owner: string;
  private readonly sourceState?: string;
  private restored = false;
  private active = true;
  private phaseCount = 0;
  private state: 'running' | 'ready' | 'finished' = 'running';
  paused = false;
  private readonly prior: Result[];
  private drained?: Promise<void>;

  constructor(readonly data: RunCheckpoint, private readonly store: RunCheckpointStore, private readonly options: {
    fresh: boolean; source?: RunCheckpoint; automatic?: boolean; pauseAfter?: number; account: () => RunCheckpoint['consumed']; deadlineAt: number;
    settle: () => Promise<void>; warn?: (message: string) => void;
    /** Stop every run process and confirm its exit. A pausing boundary seals only after it. */
    drain?: () => Promise<void>;
    processes: () => RunCheckpoint['processes'];
    evidence?: () => AttestationLog | undefined;
    historicalEvidence?: readonly AttestationRecord[];
    replanAfterAnswer?: boolean;
    worker?: () => RunCheckpoint['worker'];
    restoreWorkspace?: () => void | Promise<void>;
    workspace?: Pick<import('../contracts/workspaceRuntime.js').WorkspaceRuntime, 'checkpointDigest' | 'checkpointExport' | 'confirmCheckpoint'>;
    assessClientQuestion?: (task: Task, next: SubtaskSpec, completed: readonly Result[]) => Promise<ClientQuestion | null>;
  }) {
    if (options.source) ({ owner: this.owner, sourceState: this.sourceState } = store.continueProject(options.source, data));
    else this.owner = store.claim(data, options.fresh);
    store.beginSegment(data, options.deadlineAt);
    const restored = options.restoreWorkspace?.();
    const completeRestore = () => {
      delete data.interrupted;
      delete data.recoveryDeadlineAt;
      store.write(data, this.owner, 'running');
    };
    if (restored) this.ready = restored.then(completeRestore);
    else { completeRestore(); this.ready = Promise.resolve(); }
    setRecoveryEffectHandler(db => { if (this.active) store.blockMutation(data.id, this.owner, db); });
    if (options.historicalEvidence) store.saveEvidence(data.id, this.owner, options.historicalEvidence);
    const historical = new Map(store.historicalEvidence(data).map(record => [record.eventId, record]));
    this.prior = data.completed.map(result => ({ ...result, trace: [],
      evidence: (result.historicalEvidenceIds ?? []).flatMap(id => {
        const record = historical.get(id);
        return record ? [{ source: 'transport-observed' as const, eventId: id, tool: record.tool,
          observed: `[RECORDED BEFORE RESTART; not current execution or current source] ${record.tool} event=${record.eventId}; full archive available by id` }] : [];
      }),
      summary: `[COMPLETED BEFORE RESTART — historical context; recheck runtime endpoints and evidence] ${result.summary}` }));
  }
  get completed(): readonly Result[] { return this.active ? this.prior : []; }
  /** Once per run: a paused boundary seals a tree no run process can still
   * write. Shutdown handlers (JSON persistence, a WAL checkpoint) run here,
   * before the seal, never between the seal and `release()`. */
  quiesce(): Promise<void> {
    return this.drained ??= this.options.drain?.() ?? Promise.resolve();
  }
  backendReady(): void {
    this.data.processes = this.options.processes();
    this.data.worker = this.options.worker?.();
    this.store.write(this.data, this.owner, this.state);
  }
  restore() {
    if (this.restored || !this.active) return null;
    this.restored = true;
    return this.data.root;
  }
  get replanAfterAnswer(): boolean {
    return this.options.replanAfterAnswer === true || (!!this.data.clientQuestionId && this.data.root?.reconciledQuestionId !== this.data.clientQuestionId);
  }
  planned(task: Parameters<RootPhaseCheckpoint['planned']>[0], plan: Parameters<RootPhaseCheckpoint['planned']>[1],
    strategy: unknown, plannedPhases: number, approval?: RootDelegationApproval): void {
    if (!this.active) return;
    if (plan.aggregation.mode !== 'sequential') {
      if (this.options.automatic) { this.finalizing(); return; }
      throw new Error('Durable checkpoints require a sequential root plan');
    }
    this.options.replanAfterAnswer = false;
    this.phaseCount = plan.subtasks.length;
    if (this.options.pauseAfter !== undefined && this.options.pauseAfter > plan.subtasks.length) {
      throw new Error('--pause-after-phase exceeds the number of root phases');
    }
    // The approval rides the same write as the plan it approved: continuations
    // copy `root`, so it can never describe a different plan.
    this.data.root = { plan, strategy, plannedPhases, inputs: task.inputs,
      ...(this.data.clientQuestionId ? { reconciledQuestionId: this.data.clientQuestionId } : {}),
      ...(approval ? { approval } : {}) };
    this.store.write(this.data, this.owner, 'running');
  }
  async beforePhase(index: number, next?: SubtaskSpec): Promise<void> {
    if (!this.active) return;
    if (index !== this.data.completed.length) throw new Error('Checkpoint phase order mismatch');
    // A response is applied by the host reader before claiming the continuation.
    // Skip this boundary's assessment once; never ask the answered question again.
    const answered = !!this.data.clientQuestionId;
    delete this.data.clientQuestionId;
    if (!answered && next && this.options.assessClientQuestion && this.data.scope) {
      const question = await this.options.assessClientQuestion({ description: this.data.goal, inputs: this.data.root?.inputs }, next,
        this.data.completed.map(result => ({ ...result, trace: [] })));
      if (question) {
        if (!clientAnswerHistoryHasRoom(this.data.root?.inputs?.['clientAnswers'], question)) {
          throw new Error('Client answer history is full; start a new scoped run');
        }
        await this.options.settle();
        // Same degradation as afterPhase (code review 2026-10-09, 1.6): content
        // the snapshot refuses (an oversized file, an escaping link) disables
        // the checkpoint and the run goes on unasked, its backend untouched.
        try { await this.workspaceDigest(); } catch (error) {
          this.finalizing();
          if (!this.options.automatic) throw error;
          this.options.warn?.('Durable continuation unavailable: workspace snapshot could not be committed; the client question was not asked');
          return;
        }
        await this.quiesce();
        this.data.processes = this.options.processes();
        this.data.worker = this.options.worker?.();
        this.data.consumed = this.options.account();
        this.data.remainingMs = Math.max(0, this.options.deadlineAt - Date.now());
        await this.sealBoundary(question);
        this.state = 'ready';
        this.paused = true;
        const last = this.data.completed.at(-1);
        throw new PhaseBoundaryPause({ output: last?.output ?? {}, trace: [],
          producedBy: last?.producedBy ?? { name: this.data.actor!.name, tier: 3, viaFallback: false },
          summary: `Waiting for a client decision before phase ${index + 1}: ${question.question}`,
          refusal: 'Client decision required; answer the recorded question through Atoma MCP, then resume' },
          'Waiting for a client answer at a safe phase boundary');
      }
    }
    this.state = 'running';
    this.data.processes = this.options.processes();
    this.data.worker = this.options.worker?.();
    this.store.write(this.data, this.owner, 'running');
  }

  tools(executor: ToolExecutor): ToolExecutor {
    return { has: name => executor.has(name), execute: async (name, args) => {
      if (!this.active) return executor.execute(name, args);
      const seq = this.store.beginAction(this.data, this.owner, 'tool', name, args);
      try {
        const result = await executor.execute(name, args);
        this.finishAction(seq, result, false);
        return result;
      } catch (error) { this.finishAction(seq, null, true); throw error; }
    } };
  }

  client(client: LlmClient): LlmClient {
    return { honoursEffort: model => client.honoursEffort?.(model) ?? false, complete: async req => {
      if (!this.active) return client.complete(req);
      // Store request identity, never credentials or function-valued executors.
      const seq = this.store.beginAction(this.data, this.owner, 'model', req.role ?? 'completion',
        { model: req.model, system: req.systemPrompt, input: req.userContent });
      try {
        const result = await client.complete(req);
        this.finishAction(seq, result, false);
        return result;
      } catch (error) { this.finishAction(seq, null, true); throw error; }
    } };
  }

  private finishAction(seq: number, result: unknown, failed: boolean): void {
    this.data.consumed = this.options.account();
    this.data.processes = this.options.processes();
    this.data.worker = this.options.worker?.();
    this.data.remainingMs = Math.max(0, this.options.deadlineAt - Date.now());
    this.store.endAction(this.data, seq, result, failed);
    this.store.write(this.data, this.owner, this.state);
  }
  async afterPhase(index: number, result: Result): Promise<void> {
    if (!this.active) return;
    // superviseLoop overwrites this trace with host protocol entries. Its
    // unvalidated parent fallback ends in 'execute', not an approving verdict.
    const terminal = result.trace.at(-1);
    const approved = terminal?.kind === 'verdict-result' && terminal.payload !== null &&
      typeof terminal.payload === 'object' && 'approved' in terminal.payload && terminal.payload.approved === true;
    // A parent-owned suite that did not pass, judged or not, proved nothing of
    // this phase: like an uncovered obligation, it cannot seed a resume.
    if (isLanded(result) || !approved || result.readOnlyRestoration || result.toolBudgetExhausted ||
        result.proofCoverage?.some(item => !item.covered) || parentTestsGrantNothing(result, 'all')) {
      this.options.warn?.('Durable continuation disabled: this phase did not close with a complete approved result');
      this.finalizing();
      return;
    }
    await this.options.settle(); // Account deferred audit calls before publishing a resumable boundary.
    const pausing = this.store.pauseRequested(this.data.id) || this.options.pauseAfter === index + 1 ||
      (index + 1 < this.phaseCount && outOfPhaseBudget(this.options.deadlineAt));
    const log = this.options.evidence?.();
    const records = transportWitnesses(result.evidence).flatMap(witness => {
      const record = log?.get(witness.eventId);
      return record ? [record] : [];
    });
    this.store.saveEvidence(this.data.id, this.owner, records);
    this.data.completed.push({ output: result.output, summary: result.summary, producedBy: result.producedBy,
      ...(records.length ? { historicalEvidenceIds: records.map(record => record.eventId) } : {}) });
    let stopping = false;
    try {
      if (pausing) {
        // Unsupported content keeps the run going on its live backend; only a
        // sealable tree is worth stopping the run's processes for.
        await this.workspaceDigest();
        stopping = true;
        await this.quiesce();
      }
      this.data.processes = this.options.processes();
      this.data.worker = this.options.worker?.();
      this.data.consumed = this.options.account();
      this.data.remainingMs = Math.max(0, this.options.deadlineAt - Date.now());
      this.state = 'ready';
      await this.sealBoundary();
    } catch (error) {
      this.finalizing();
      // A drained backend cannot carry the run further.
      if (!this.options.automatic || stopping) throw error;
      this.options.warn?.('Durable continuation unavailable: workspace snapshot could not be committed');
      return;
    }
    if (pausing) {
      this.paused = true;
      throw new PhaseBoundaryPause({ ...result, trace: [],
        summary: `Paused after ${index + 1} validated phase(s). ${result.summary}`,
        refusal: 'Paused before final acceptance; resume the saved plan to continue' });
    }
  }
  finalizing(): void {
    if (!this.active) return;
    this.state = 'finished';
    this.store.write(this.data, this.owner, 'finished');
    this.active = false; // A root remediation is fresh supervised work, never a checkpoint replay.
    this.store.pruneSnapshots();
    // Housekeeping for every finished checkpoint, this one included. A
    // failure costs only space, so it never fails the run that triggered it.
    try { this.store.pruneFinished(); }
    catch (error) { this.options.warn?.(`Checkpoint journal pruning skipped: ${(error as Error).message}`); }
  }
  /** A project continuation refused before any phase (its saved root actor
   * changed) hands the source back and leaves no successor running. */
  refuseContinuation(): void {
    if (!this.options.source || this.sourceState === undefined || !this.active || this.state !== 'running') return;
    this.store.restoreContinuation(this.options.source.id, this.sourceState, this.data.id, this.owner);
    this.state = 'finished';
    this.active = false;
  }
  private workspaceDigest(): Promise<string> {
    return this.options.workspace?.checkpointDigest() ?? Promise.resolve(checkpointWorkspaceDigest(this.data.workspace));
  }

  private async sealBoundary(question?: ClientQuestion): Promise<void> {
    if (!this.options.workspace) { this.store.boundary(this.data, this.owner, question); return; }
    const exporting = await this.options.workspace.checkpointExport();
    let receiver: CheckpointReceiver | undefined;
    let snapshot: { id: string; digest: string };
    try {
      receiver = this.store.receiveWorkspace(this.data, this.owner, exporting.header);
      for await (const frame of exporting.frames()) {
        if (frame.kind === 'entry') receiver.begin(frame.entry);
        else receiver.append(frame.offset, frame.bytes);
      }
      snapshot = receiver.finish();
    } catch (error) { receiver?.abort(); throw error; }
    finally { await exporting.close(); }
    this.store.boundaryFromSnapshot(this.data, this.owner, snapshot, question);
    // The device display is informational: losing this acknowledgement cannot
    // roll back the checkpoint already committed in the product store.
    try { await this.options.workspace.confirmCheckpoint?.({ snapshotId: snapshot.id, digest: snapshot.digest,
      completed: this.data.completed.length, confirmedAt: new Date().toISOString() }); }
    catch { this.options.warn?.('Checkpoint saved; client confirmation unavailable'); }
  }

  release(): void | Promise<void> {
    if (this.options.workspace) return this.releaseRemote();
    if (this.state === 'ready') {
      if (checkpointWorkspaceDigest(this.data.workspace) !== this.data.workspaceDigest) {
        this.finalizing();
        throw new Error('Workspace changed during shutdown; checkpoint cannot be resumed');
      }
      this.store.write(this.data, this.owner, 'ready', true);
    }
  }

  private async releaseRemote(): Promise<void> {
    if (this.state !== 'ready') return;
    if (await this.workspaceDigest() !== this.data.workspaceDigest) {
      this.finalizing();
      throw new Error('Workspace changed during shutdown; checkpoint cannot be resumed');
    }
    this.store.write(this.data, this.owner, 'ready', true);
  }
}

/** The same saved behavior, or a refusal that hands the claimed source back.
 * Catalogue refreshes can return to byte-identical behavior at a newer version.
 * Return the current version: the saved plan approval must be reviewed again. */
export function savedRootActor(registry: Pick<AtomRegistry, 'getByName' | 'listVersions'>, actor: NonNullable<RunCheckpoint['actor']>,
  checkpoint?: SequentialCheckpoint): AtomType {
  try {
    const stored = registry.getByName(actor.name);
    if (stored && stored.atomId === actor.atomId) {
      if (stored.version === actor.version) return stored;
      const saved = registry.listVersions(actor.name).find(row => row.version === actor.version);
      if (saved && saved.systemPrompt === stored.systemPrompt &&
          JSON.stringify(saved.tools) === JSON.stringify(stored.tools) &&
          JSON.stringify(saved.params) === JSON.stringify(stored.params)) return stored;
    }
  } catch { /* Unreadable history proves no equivalence; release the successor too. */ }
  checkpoint?.refuseContinuation();
  throw new Error('Saved root actor has changed; resume refused');
}
