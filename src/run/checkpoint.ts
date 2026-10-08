import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openStoreHandle } from '../core/stores.js';
import type { Result } from '../core/types.js';
import { isLanded } from '../contracts/runLanding.js';
import { outOfPhaseBudget } from '../core/limits.js';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import { PhaseBoundaryPause, runCheckpointSchema, type RootPhaseCheckpoint, type RunCheckpoint, type ProjectCheckpointStatus } from '../contracts/runCheckpoint.js';

const DDL = `CREATE TABLE IF NOT EXISTS run_checkpoints (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, owner TEXT NOT NULL,
  pid INTEGER NOT NULL, host TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
)`;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
type Row = { state: string; owner: string; pid: number; host: string; released: number; payload: string };

/** Resolve symlinked parents before launch, including a not-yet-created workspace. */
export function assertCheckpointStoreOutsideWorkspace(store: string, workspace: string): void {
  let ancestor = resolve(workspace);
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const canonicalWorkspace = join(realpathSync(ancestor), ...tail);
  const rel = relative(canonicalWorkspace, realpathSync(store));
  if (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) {
    throw new Error('The checkpoint store must be outside the tool workspace');
  }
}

/** Seal every entry, including scratch and dependencies. No filtered publication inventory; relative internal links keep their identity. */
export function checkpointWorkspaceDigest(root: string): string {
  if (realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory()) {
    throw new Error('Checkpoint workspace must be a real directory');
  }
  const hash = createHash('sha256');
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const stat = lstatSync(path);
      if (++entries > WORKSPACE_LIMITS.maxEntries || rel.length > WORKSPACE_LIMITS.maxPathChars) {
        throw new Error('Checkpoint workspace exceeds entry/path limits');
      }
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', rel, stat.mode]));
        visit(path);
      } else if (stat.isFile() && stat.nlink === 1) {
        if (++files > WORKSPACE_LIMITS.maxFiles || stat.size > WORKSPACE_LIMITS.maxFileBytes ||
            (bytes += stat.size) > WORKSPACE_LIMITS.maxTotalBytes) throw new Error('Checkpoint workspace exceeds file limits');
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd);
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) {
            throw new Error('Checkpoint workspace changed while reading');
          }
          // Fixed allocation: a concurrent writer cannot grow readFileSync's
          // allocation past the host's limit after the initial stat.
          const data = Buffer.alloc(stat.size + 1);
          let length = 0;
          for (;;) {
            const read = readSync(fd, data, length, data.length - length, null);
            if (read === 0) break;
            length += read;
            if (length === data.length) throw new Error('Checkpoint workspace changed while reading');
          }
          const after = fstatSync(fd);
          if (length !== stat.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new Error('Checkpoint workspace changed while reading');
          }
          hash.update(JSON.stringify(['file', rel, stat.mode, length]));
          hash.update(data.subarray(0, length));
        } finally { closeSync(fd); }
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolved = relative(root, realpathSync(path));
        if (isAbsolute(target) || resolved === '..' || resolved.startsWith('../') || isAbsolute(resolved)) {
          throw new Error('Checkpoint workspace contains an escaping link or special file');
        }
        hash.update(JSON.stringify(['symlink', rel, target, stat.mode]));
      } else throw new Error('Checkpoint workspace contains a link or special file');
    }
  };
  visit(root);
  return hash.digest('hex');
}

function encoded(data: RunCheckpoint): string {
  const payload = JSON.stringify(runCheckpointSchema.parse(data));
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new Error('Checkpoint state exceeds its size limit');
  return payload;
}

function ownerAlive(row: Row): boolean {
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
  }

  projectStatus(id: string, orgId: string): ProjectCheckpointStatus | undefined {
    const row = this.db.prepare(`SELECT state, released,
      json_extract(payload, '$.scope.orgId') AS org,
      json_array_length(payload, '$.completed') AS completed,
      json_array_length(payload, '$.root.plan.subtasks') AS total
      FROM run_checkpoints WHERE id = ?`).get(id) as
      { state: string; released: number; org: string; completed: number; total: number | null } | undefined;
    if (!row || row.org !== orgId) return undefined;
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
    if (row.state !== 'ready') throw new Error('Checkpoint is not at a resumable phase boundary (in-flight or finished)');
    if (ownerAlive(row)) throw new Error('Checkpoint is still owned by a running process');
    if (Buffer.byteLength(row.payload) > MAX_PAYLOAD_BYTES) throw new Error('Checkpoint state exceeds its size limit');
    const data = runCheckpointSchema.parse(JSON.parse(row.payload));
    if (data.id !== id || !data.root || !data.actor || data.checklist === null || data.completed.length === 0 ||
        !data.workspaceDigest || !/^[0-9a-f]{64}$/.test(data.workspaceDigest)) {
      throw new Error('Checkpoint is incomplete or corrupt');
    }
    if (!row.released) {
      if (data.processes === null) throw new Error('Checkpoint backend was not drained; crash resume is unavailable');
      for (const child of data.processes) {
        let alive = true;
        try { process.kill(child.group ? -child.pid : child.pid, 0); }
        catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error('Checkpoint still has sandbox processes; resume refused');
      }
    }
    return data;
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

/** No rollback/replay of an interrupted phase: credits and external effects may already exist. */
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
  }) {
    this.owner = options.source ? store.continueProject(options.source, data) : store.claim(data, options.fresh);
    this.prior = data.completed.map(result => ({ ...result, trace: [],
      summary: `[COMPLETED BEFORE RESTART — historical context; recheck runtime endpoints and evidence] ${result.summary}` }));
  }
  get completed(): readonly Result[] { return this.active ? this.prior : []; }
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
    this.store.write(this.data, this.owner, 'running');
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
    let digest: string;
    try {
      digest = checkpointWorkspaceDigest(this.data.workspace);
      if (checkpointWorkspaceDigest(this.data.workspace) !== digest) throw new Error('Checkpoint workspace is still changing');
    } catch (error) {
      if (!this.options.automatic) throw error;
      this.options.warn?.(`Durable continuation unavailable: ${String(error)}`);
      this.finalizing();
      return;
    }
    this.data.completed.push({ output: result.output, summary: result.summary, producedBy: result.producedBy });
    this.data.workspaceDigest = digest;
    this.data.processes = this.options.processes();
    this.data.consumed = this.options.account();
    this.data.remainingMs = Math.max(0, this.options.deadlineAt - Date.now());
    this.state = 'ready';
    this.store.write(this.data, this.owner, 'ready');
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
