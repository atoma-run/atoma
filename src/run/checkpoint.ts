import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { setRecoveryEffectHandler } from '../core/recoveryEffects.js';
import { checkpointToolIsRestorable } from '../tools/recoveryPolicy.js';
import type { LlmClient, ToolExecutor } from '../core/types.js';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import type { Result } from '../core/types.js';
import { isLanded } from '../contracts/runLanding.js';
import { outOfPhaseBudget } from '../core/limits.js';
import { checkpointWorkspaceDigest, saveCheckpointWorkspace, restoreCheckpointWorkspace, initializeCheckpointWorkspaces } from './checkpointWorkspace.js';
export { checkpointWorkspaceDigest } from './checkpointWorkspace.js';
import { PhaseBoundaryPause, runCheckpointSchema, type RootPhaseCheckpoint, type RunCheckpoint, type ProjectCheckpointStatus } from '../contracts/runCheckpoint.js';

const DDL = `CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT NOT NULL,
  pid INTEGER NOT NULL, host TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
)`;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
type Row = { state: string; owner: string; pid: number; host: string; released: number; payload: string };
type RecoveryRow = { boundary_seq: number; blocked: string | null; consumed: string; deadline: number };

/** Resolve symlinked parents before launch, including a not-yet-created workspace. */
export function canonicalCheckpointWorkspacePath(workspace: string): string {
  let ancestor = resolve(workspace);
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...tail);
}
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

/** One table in the product store. A CAS claim consumes a boundary exactly once. */
export class RunCheckpointStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = openStoreHandle(path, DDL);
    this.db.exec('CREATE TABLE IF NOT EXISTS run_checkpoint_pauses (id TEXT PRIMARY KEY)');
    initializeCheckpointWorkspaces(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_checkpoint_recovery (
      id TEXT PRIMARY KEY, boundary_seq INTEGER NOT NULL, blocked TEXT, consumed TEXT NOT NULL, deadline REAL NOT NULL
    ); CREATE TABLE IF NOT EXISTS run_checkpoint_actions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, phase INTEGER NOT NULL,
      kind TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, request_digest TEXT NOT NULL,
      result_digest TEXT, result TEXT
    ); CREATE INDEX IF NOT EXISTS checkpoint_actions_by_run ON run_checkpoint_actions(id,seq)`);
  }

  private recovery(id: string): RecoveryRow | undefined {
    return this.db.prepare('SELECT * FROM run_checkpoint_recovery WHERE id=?').get(id) as RecoveryRow | undefined;
  }

  private recoveryReason(id: string, data: RunCheckpoint, released = false): ProjectCheckpointStatus['reason'] {
    const r = this.recovery(id);
    if (!r || !data.snapshotId || !data.completed.length) return 'incomplete';
    if (r.blocked) return r.blocked as ProjectCheckpointStatus['reason'];
    if (this.db.prepare("SELECT 1 FROM run_checkpoint_actions WHERE id=? AND seq>? AND kind='model' AND state<>'done' LIMIT 1").get(id, r.boundary_seq)) return 'model_pending';
    if (this.db.prepare("SELECT 1 FROM run_checkpoint_actions WHERE id=? AND seq>? AND kind='tool' AND state='pending' LIMIT 1").get(id, r.boundary_seq)) return 'tool_pending';
    if (!released && r.deadline <= Date.now()) return 'budget_exhausted';
    if (!released && data.processes === null && !data.worker) return 'backend_unknown';
    return undefined;
  }

  projectStatus(id: string, orgId: string): ProjectCheckpointStatus | undefined {
    const row = this.db.prepare(`SELECT state, released, pid, host,
      json_extract(payload, '$.scope.orgId') AS org,
      json_array_length(payload, '$.completed') AS completed,
      json_array_length(payload, '$.root.plan.subtasks') AS total
      FROM run_checkpoints WHERE id = ?`).get(id) as
      { state: string; released: number; pid: number; host: string; org: string; completed: number; total: number | null } | undefined;
    if (!row || row.org !== orgId) return undefined;
    if (row.state !== 'finished' && !row.released && row.host === hostname() && !ownerAlive(row)) {
      const payload = this.db.prepare('SELECT payload FROM run_checkpoints WHERE id=?').get(id) as { payload: string };
      const parsed = runCheckpointSchema.safeParse(JSON.parse(payload.payload));
      const reason = parsed.success ? this.recoveryReason(id, parsed.data) : 'incomplete';
      return { state: reason ? 'blocked' : 'recoverable', ...(reason ? { reason } : {}), completed: row.completed, total: row.total ?? 0 };
    }
    return { state: row.state === 'finished' ? 'unavailable'
      : row.state === 'ready' && row.released ? 'paused'
      : this.pauseRequested(id) ? 'pause_requested' : 'running', completed: row.completed, total: row.total ?? 0 };
  }

  requestPause(id: string, orgId: string): void {
    const state = this.projectStatus(id, orgId);
    if (!state || !['running', 'pause_requested'].includes(state.state) || !state.total) throw new Error('No sequential phase is available to pause');
    this.db.prepare('INSERT OR IGNORE INTO run_checkpoint_pauses (id) VALUES (?)').run(id);
  }
  pauseRequested(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM run_checkpoint_pauses WHERE id = ?').get(id);
  }

  /** Consume the source and claim a separate segment in one transaction. */
  continueProject(source: RunCheckpoint, next: RunCheckpoint): string {
    return this.db.transaction(() => {
      if (encoded(this.read(source.id)) !== encoded(source)) throw new Error('Checkpoint changed before continuation');
      this.db.prepare("UPDATE run_checkpoints SET state='finished' WHERE id=?").run(source.id);
      return this.claim(next, true);
    }).immediate();
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
    if (data.id !== id || !data.root || !data.actor || data.checklist === null || data.completed.length === 0 ||
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
    return data;
  }

  materialize(data: RunCheckpoint, target: string, archive: boolean): void {
    if (!data.snapshotId || !data.workspaceDigest) throw new Error('Checkpoint snapshot is unavailable');
    restoreCheckpointWorkspace(this.db, data.snapshotId, data.workspaceDigest, target, archive);
  }

  boundary(data: RunCheckpoint, owner: string): void {
    this.db.transaction(() => {
      const snapshot = saveCheckpointWorkspace(this.db, data.workspace);
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
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM run_checkpoint_files WHERE snapshot IN (SELECT id FROM run_checkpoint_snapshots
        WHERE id NOT IN (SELECT json_extract(payload,'$.snapshotId') FROM run_checkpoints WHERE state<>'finished' AND json_extract(payload,'$.snapshotId') IS NOT NULL));
        DELETE FROM run_checkpoint_snapshots WHERE id NOT IN (SELECT json_extract(payload,'$.snapshotId') FROM run_checkpoints
          WHERE state<>'finished' AND json_extract(payload,'$.snapshotId') IS NOT NULL)`);
    }).immediate();
  }

  /** Offline retention expires byte-bearing records along with the workspace. */
  expire(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE run_checkpoints SET state='finished' WHERE id=?").run(id);
      this.db.prepare('DELETE FROM run_checkpoint_actions WHERE id=?').run(id);
      this.db.prepare('DELETE FROM run_checkpoint_recovery WHERE id=?').run(id);
      this.db.prepare('DELETE FROM run_checkpoint_pauses WHERE id=?').run(id);
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
  private readonly owner: string;
  private restored = false;
  private active = true;
  private phaseCount = 0;
  private state: 'running' | 'ready' | 'finished' = 'running';
  paused = false;
  private readonly prior: Result[];

  constructor(readonly data: RunCheckpoint, private readonly store: RunCheckpointStore, private readonly options: {
    fresh: boolean; source?: RunCheckpoint; automatic?: boolean; pauseAfter?: number; account: () => RunCheckpoint['consumed']; deadlineAt: number;
    settle: () => Promise<void>; warn?: (message: string) => void;
    processes: () => RunCheckpoint['processes'];
    worker?: () => RunCheckpoint['worker'];
    restoreWorkspace?: () => void;
  }) {
    this.owner = options.source ? store.continueProject(options.source, data) : store.claim(data, options.fresh);
    store.beginSegment(data, options.deadlineAt);
    options.restoreWorkspace?.();
    delete data.interrupted;
    delete data.recoveryDeadlineAt;
    store.write(data, this.owner, 'running');
    setRecoveryEffectHandler(db => { if (this.active) store.blockMutation(data.id, this.owner, db); });
    this.prior = data.completed.map(result => ({ ...result, trace: [],
      summary: `[COMPLETED BEFORE RESTART — historical context; recheck runtime endpoints and evidence] ${result.summary}` }));
  }
  get completed(): readonly Result[] { return this.active ? this.prior : []; }
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
  planned(task: Parameters<RootPhaseCheckpoint['planned']>[0], plan: Parameters<RootPhaseCheckpoint['planned']>[1],
    strategy: unknown, plannedPhases: number): void {
    if (!this.active) return;
    if (plan.aggregation.mode !== 'sequential') {
      if (this.options.automatic) { this.finalizing(); return; }
      throw new Error('Durable checkpoints require a sequential root plan');
    }
    this.phaseCount = plan.subtasks.length;
    if (this.options.pauseAfter !== undefined && this.options.pauseAfter > plan.subtasks.length) {
      throw new Error('--pause-after-phase exceeds the number of root phases');
    }
    this.data.root = { plan, strategy, plannedPhases, inputs: task.inputs };
    this.store.write(this.data, this.owner, 'running');
  }
  beforePhase(index: number): void {
    if (!this.active) return;
    if (index !== this.data.completed.length) throw new Error('Checkpoint phase order mismatch');
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
    if (isLanded(result) || !approved || result.readOnlyRestoration || result.toolBudgetExhausted ||
        result.proofCoverage?.some(item => !item.covered)) {
      this.options.warn?.('Durable continuation disabled: this phase did not close with a complete approved result');
      this.finalizing();
      return;
    }
    await this.options.settle(); // Account deferred audit calls before publishing a resumable boundary.
    this.data.completed.push({ output: result.output, summary: result.summary, producedBy: result.producedBy });
    this.data.processes = this.options.processes();
    this.data.worker = this.options.worker?.();
    this.data.consumed = this.options.account();
    this.data.remainingMs = Math.max(0, this.options.deadlineAt - Date.now());
    this.state = 'ready';
    try { this.store.boundary(this.data, this.owner); }
    catch (error) {
      this.finalizing();
      if (!this.options.automatic) throw error;
      this.options.warn?.('Durable continuation unavailable: workspace snapshot could not be committed');
      return;
    }
    if (this.store.pauseRequested(this.data.id) || this.options.pauseAfter === index + 1 || (index + 1 < this.phaseCount && outOfPhaseBudget(this.options.deadlineAt))) {
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
  }
  release(): void {
    if (this.state === 'ready') {
      if (checkpointWorkspaceDigest(this.data.workspace) !== this.data.workspaceDigest) {
        this.finalizing();
        throw new Error('Workspace changed during shutdown; checkpoint cannot be resumed');
      }
      this.store.write(this.data, this.owner, 'ready', true);
    }
  }
}
