import { assertPlatformSettingValue, DEFAULT_PLATFORM_LIMITS, PLATFORM_SETTINGS } from '../contracts/platformSettings.js';
/**
 * Cross-process lease for the MCP run slot.
 *
 * SQLite supplies the compare-and-delete primitive a lockfile cannot: stale
 * recovery and successor acquisition happen under BEGIN IMMEDIATE, and every
 * update/delete is conditioned on a random token. Two recoverers can never
 * delete each other's freshly-acquired lease (the lockfile ABA race).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { organisationIdSchema } from '../contracts/projects.js';
import {
  RUN_KILL_CONFIRM_MS,
  RUN_KILL_GRACE_MS,
  runProcessGroupExists,
  terminateRunProcessGroup,
} from '../cli/burnin.js';

export interface RunLockOwner {
  readonly token: string;
  readonly runId: string;
  readonly ownerPid: number;
  readonly acquiredAt: string;
  readonly childPgid?: number;
}

/** A run the recovery path destroyed to free the slot — see `acquireRunLease`. */
export interface ReapedRun {
  readonly runId: string;
  readonly childPgid: number;
}

export interface RunLease {
  readonly path: string;
  /**
   * Present when acquiring meant REAPING a previous server's surviving run:
   * the dead owner's live process group was terminated as a side effect of
   * this acquisition. The 2026-08-14 review flagged that the reap was SILENT —
   * the caller got a lease as if nothing had happened, so a host that had just
   * destroyed a run could not explain the missing deliverable. startRun
   * publishes this on its payload.
   */
  readonly recovered?: ReapedRun;
  /** All recoveries when exclusive admission reaped several abandoned runs. */
  readonly recoveredRuns?: readonly ReapedRun[];
  /**
   * Present when the slot was held by a row whose owner is gone and which had
   * nothing left behind it — a killed analysis, mend or deployment, or a run
   * whose group died with its unit — and this acquisition took it over.
   * Nothing was reaped; the caller says so.
   */
  readonly reclaimed?: RunLockOwner;
  /** Persist the detached process-group id. Throws if ownership was lost. */
  attachChild(pgid: number): void;
  /** Conditional by token and safe to call twice. */
  release(): void;
}

/** Omitted organisation means exclusive work (operator, maintenance, publication). */
export interface RunLeaseOptions { readonly orgId?: string; readonly maxConcurrent?: () => number }
export type RunLeaseAcquirer = (runId: string, options?: RunLeaseOptions) => Promise<RunLease>;

export class RunLockBusyError extends Error {
  constructor(
    message: string,
    readonly owner?: RunLockOwner,
    /**
     * `wedged`: the holder's server died and its run cannot be verified or
     * reaped — the slot will not free itself without an operator.
     * `pending`: a deployment waits for the slot; `owner` is that deployment,
     * and the slot opens again once it has run.
     */
    readonly condition: 'held' | 'wedged' | 'pending' | 'capacity' = 'held',
    /** A dead server's surviving run this acquisition destroyed before it was refused. */
    readonly recovered?: ReapedRun,
    readonly recoveredRuns?: readonly ReapedRun[]
  ) {
    super(message);
    this.name = 'RunLockBusyError';
  }
}

export function mcpRunLockPath(): string {
  return resolve(
    process.env['ATOMA_MCP_RUN_LOCK'] ?? join(homedir(), '.atoma', 'mcp-run-lock.db')
  );
}

interface LeaseRow {
  singleton: number;
  org_id: string | null;
  token: string;
  run_id: string;
  owner_pid: number;
  child_pgid: number | null;
  acquired_at: string;
  owner_fingerprint: string | null;
  child_fingerprint: string | null;
}

/**
 * A deployment waiting for the slot: ONE row beside the lease, written only by
 * the deployment guard and alive exactly as long as the guard that wrote it.
 * While it lives, nothing else may TAKE the slot; whatever already holds it
 * finishes normally. It lives here, not in a marker file, because this file is
 * already what every taker reads under BEGIN IMMEDIATE — the refusal is atomic
 * with the acquisition — and because a dead owner voids it by construction.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_run_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton >= 1),
    org_id TEXT UNIQUE,
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    child_pgid INTEGER,
    acquired_at TEXT NOT NULL,
    owner_fingerprint TEXT,
    child_fingerprint TEXT
  );
  CREATE TABLE IF NOT EXISTS mcp_deployment_pending (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_fingerprint TEXT,
    registered_at TEXT NOT NULL
  );
`;

const FINGERPRINT_COLUMNS = [
  ['owner_fingerprint', 'TEXT'],
  ['child_fingerprint', 'TEXT'],
] as const;

function openLockDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  // Concurrent first openers can race the journal-mode transition itself;
  // SQLite does not always run the busy handler for that PRAGMA.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'SQLITE_BUSY' || Date.now() >= deadline) {
        db.close();
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  db.exec(SCHEMA);
  const columns = new Set(
    (db.pragma('table_info(mcp_run_lease)') as Array<{ name: string }>).map((column) =>
      column.name
    )
  );
  for (const [name, type] of FINGERPRINT_COLUMNS) {
    if (columns.has(name)) continue;
    try {
      db.exec(`ALTER TABLE mcp_run_lease ADD COLUMN ${name} ${type}`);
    } catch (err) {
      // Two MCP processes can open an old store together. One may complete
      // the additive migration after the other's PRAGMA snapshot.
      if (!/duplicate column name/i.test((err as Error).message)) throw err;
    }
  }
  // Upgrade the singleton without losing a live owner's token or fingerprints.
  // Activation is drained: old binaries must not run beside the new allocator.
  db.transaction(() => {
    const current = db.pragma('table_info(mcp_run_lease)') as Array<{ name: string }>;
    const hasOrg = current.some((column) => column.name === 'org_id');
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mcp_run_lease'").get() as { sql: string };
    if (hasOrg && definition.sql.includes('CHECK (singleton >= 1)')) return;
    db.exec(`ALTER TABLE mcp_run_lease RENAME TO mcp_run_lease_legacy`);
    db.exec(SCHEMA);
    db.exec(`INSERT INTO mcp_run_lease
      (singleton, org_id, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint, child_fingerprint)
      SELECT singleton, ${hasOrg ? 'org_id' : 'NULL'}, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint, child_fingerprint
      FROM mcp_run_lease_legacy`);
    db.exec('DROP TABLE mcp_run_lease_legacy');
  }).immediate();
  return db;
}

/**
 * Is this pid a live process? Exported because the sentinel's watch lease asks
 * the same question of the same kind of row, and two definitions of "is the
 * owner still there" is how one of them ends up trusting a recycled pid.
 */
export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'EPERM'
    );
  }
}

/**
 * Stable process birth identity, not merely a recyclable PID.
 *
 * Linux exposes boot id + start ticks directly. BSD/macOS `ps lstart` is the
 * portable fallback. A missing fingerprint is treated as unverifiable, never
 * as permission to signal a process group.
 */
export function processFingerprint(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = afterName[19]; // field 22; array starts at field 3
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (startTicks && bootId) return `linux:${bootId}:${startTicks}`;
  } catch {
    // Non-Linux platform or the process disappeared between probes.
  }
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

function leasePredatesCurrentBoot(acquiredAt: string): boolean {
  const acquiredMs = Date.parse(acquiredAt);
  if (!Number.isFinite(acquiredMs)) return false;
  // Leave two seconds for wall-clock/uptime sampling skew at boot.
  return acquiredMs < Date.now() - uptime() * 1000 - 2000;
}

type RecordedIdentity = 'match' | 'mismatch' | 'unverifiable' | 'gone';

function recordedIdentity(
  pid: number,
  expectedFingerprint: string | null,
  acquiredAt: string
): RecordedIdentity {
  if (!processExists(pid)) return 'gone';
  if (!expectedFingerprint) {
    return leasePredatesCurrentBoot(acquiredAt) ? 'mismatch' : 'unverifiable';
  }
  const actual = processFingerprint(pid);
  if (!actual) return 'unverifiable';
  return actual === expectedFingerprint ? 'match' : 'mismatch';
}

interface PendingRow {
  token: string;
  run_id: string;
  owner_pid: number;
  owner_fingerprint: string | null;
  registered_at: string;
}

/** A deployment waiting for the run slot (see `registerDeploymentPending`). */
export interface DeploymentPending {
  readonly token: string;
  readonly runId: string;
  readonly ownerPid: number;
  readonly registeredAt: string;
}

/**
 * Same identity rule as the lease owner — an unverifiable guard is kept, a
 * gone one is void — plus one a lease does not need: no guard outlives a boot.
 * Without it, a row whose pid was reused by a process whose identity cannot
 * be read (another user's, behind `hidepid`) would keep every taker out.
 */
function pendingIsLive(row: PendingRow): boolean {
  if (leasePredatesCurrentBoot(row.registered_at)) return false;
  const identity = recordedIdentity(row.owner_pid, row.owner_fingerprint, row.registered_at);
  return identity === 'match' || identity === 'unverifiable';
}

/**
 * The waiting deployment that refuses this acquisition, if any, read inside
 * the caller's IMMEDIATE transaction. A row whose guard is gone is deleted by
 * token on the way: a deployment that crashed while waiting must never leave
 * the slot closed behind it.
 */
function blockingDeployment(db: Database.Database, exemptToken?: string): RunLockOwner | undefined {
  const row = db.prepare('SELECT * FROM mcp_deployment_pending WHERE singleton = 1').get() as
    | PendingRow
    | undefined;
  if (!row || row.token === exemptToken) return undefined;
  if (!pendingIsLive(row)) {
    db.prepare('DELETE FROM mcp_deployment_pending WHERE singleton = 1 AND token = ?').run(row.token);
    return undefined;
  }
  return { token: row.token, runId: row.run_id, ownerPid: row.owner_pid, acquiredAt: row.registered_at };
}

function deploymentWaitingError(waiting: RunLockOwner, recovered?: ReapedRun): RunLockBusyError {
  return new RunLockBusyError(
    `a deployment is waiting for the run slot (${waiting.runId}, pid ${waiting.ownerPid}, since ${waiting.acquiredAt}); nothing new may take it until the deployment has run` +
      (recovered ? `; the dead server's run ${recovered.runId} (group ${recovered.childPgid}) was already reaped` : ''),
    waiting,
    'pending',
    recovered
  );
}

function toOwner(row: LeaseRow): RunLockOwner {
  return {
    token: row.token,
    runId: row.run_id,
    ownerPid: row.owner_pid,
    acquiredAt: row.acquired_at,
    ...(row.child_pgid !== null ? { childPgid: row.child_pgid } : {}),
  };
}

/** The owner is dead, or its pid now belongs to another process. */
function ownerIsGone(row: LeaseRow): boolean {
  const identity = recordedIdentity(row.owner_pid, row.owner_fingerprint, row.acquired_at);
  return identity === 'gone' || identity === 'mismatch';
}

/**
 * Nothing is left to reap behind a gone owner's row: it recorded no process
 * group, or the group it recorded no longer exists (a unit stop killed it with
 * the owner). A group that still exists — or whose id another group now
 * carries — keeps the row for a run start's recovery, which alone may signal.
 */
function nothingBehind(row: LeaseRow): boolean {
  return row.child_pgid === null || !runProcessGroupExists(row.child_pgid);
}

function makeLease(
  db: Database.Database,
  path: string,
  owner: RunLockOwner,
  recovered?: ReapedRun,
  reclaimed?: RunLockOwner,
  recoveredRuns?: readonly ReapedRun[]
): RunLease {
  let released = false;
  return {
    path,
    ...(recovered ? { recovered } : {}),
    ...(recoveredRuns?.length ? { recoveredRuns } : {}),
    ...(reclaimed ? { reclaimed } : {}),
    attachChild(pgid) {
      if (released) throw new Error(`cannot attach child ${pgid}: run lease is already released`);
      const childFingerprint = processFingerprint(pgid);
      const changed = db
        .prepare(
          `UPDATE mcp_run_lease
           SET child_pgid = ?, child_fingerprint = ?
           WHERE token = ?`
        )
        .run(pgid, childFingerprint, owner.token).changes;
      if (changed !== 1) {
        throw new Error(`lost MCP run lease before child ${pgid} could be attached`);
      }
    },
    release() {
      if (released) return;
      released = true;
      try {
        db.prepare('DELETE FROM mcp_run_lease WHERE token = ?').run(
          owner.token
        );
      } finally {
        db.close();
      }
    },
  };
}

export async function acquireRunLease(
  runId: string,
  path = mcpRunLockPath(),
  options: RunLeaseOptions = {}
): Promise<RunLease> {
  const orgId = options.orgId === undefined ? null : organisationIdSchema.parse(options.orgId);
  const capacity = () => assertPlatformSettingValue('run.concurrentMax', options.maxConcurrent?.() ?? DEFAULT_PLATFORM_LIMITS['run.concurrentMax']);
  const db = openLockDb(path);
  const owner: RunLockOwner = {
    token: randomUUID(),
    runId,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const ownerFingerprint = processFingerprint(owner.ownerPid);
  const read = db.prepare('SELECT * FROM mcp_run_lease ORDER BY singleton');
  const blocking = (): LeaseRow | undefined => {
    const rows = read.all() as LeaseRow[];
    // Exclusive work cannot enter beside any live owner. Refuse before reaping
    // abandoned neighbours that would not make admission possible anyway.
    if (orgId === null) return rows.find((row) => !ownerIsGone(row)) ?? rows[0];
    const conflict = rows.find((row) => row.org_id === null || row.org_id === orgId);
    if (conflict) return conflict;
    return rows.length >= capacity() ? rows.find(ownerIsGone) ?? rows[0] : undefined;
  };
  const insert = db.prepare(
    `INSERT INTO mcp_run_lease
      (singleton, org_id, token, run_id, owner_pid, child_pgid, acquired_at,
       owner_fingerprint, child_fingerprint)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
  );
  const claim = () => {
    const occupied = new Set((read.all() as LeaseRow[]).map((row) => row.singleton));
    let slot = 1;
    while (occupied.has(slot)) slot++;
    insert.run(slot, orgId, owner.token, owner.runId, owner.ownerPid, owner.acquiredAt, ownerFingerprint);
  };
  const deleteByToken = db.prepare(
    'DELETE FROM mcp_run_lease WHERE token = ?'
  );
  const recoveredRuns: ReapedRun[] = [];

  try {
    for (let attempt = 0; attempt < PLATFORM_SETTINGS['run.concurrentMax'].max + 5; attempt++) {
      // A waiting deployment refuses BEFORE any recovery: a start it turns away
      // must not first reap a dead server's surviving run on its behalf.
      const waiting = db.transaction(() => blockingDeployment(db)).immediate();
      if (waiting) throw deploymentWaitingError(waiting);
      const existing = blocking();
      if (!existing) {
        const claimed = db.transaction(() => {
          if (blocking() !== undefined) return false;
          const late = blockingDeployment(db);
          if (late) return late;
          claim();
          return true;
        }).immediate();
        if (claimed === true) return makeLease(db, path, owner, recoveredRuns[0], undefined, recoveredRuns);
        if (claimed) throw deploymentWaitingError(claimed);
        continue;
      }

      const stale = toOwner(existing);
      const ownerIdentity = recordedIdentity(
        stale.ownerPid,
        existing.owner_fingerprint,
        stale.acquiredAt
      );
      if (ownerIdentity === 'match' || ownerIdentity === 'unverifiable') {
        if (orgId !== null && existing.org_id !== null && existing.org_id !== orgId) {
          throw new RunLockBusyError(`all ${capacity()} run places are occupied`, undefined, 'capacity');
        }
        throw new RunLockBusyError(
          `another MCP server owns the run slot (${stale.runId}, pid ${stale.ownerPid}, since ${stale.acquiredAt}${ownerIdentity === 'unverifiable' ? ', process birth unverifiable' : ''})`,
          stale
        );
      }

      let reaped: ReapedRun | undefined;
      if (stale.childPgid !== undefined && runProcessGroupExists(stale.childPgid)) {
        const childIdentity = recordedIdentity(
          stale.childPgid,
          existing.child_fingerprint,
          stale.acquiredAt
        );
        if (childIdentity === 'unverifiable' || childIdentity === 'gone') {
          throw new RunLockBusyError(
            `the previous MCP server died while run ${stale.runId} left process group ${stale.childPgid}, but its birth identity cannot be verified; refusing to signal a possibly recycled group`,
            stale,
            'wedged'
          );
        }
        if (childIdentity === 'match') {
          const gone = await terminateRunProcessGroup(stale.childPgid);
          if (!gone) {
            throw new RunLockBusyError(
              `the previous MCP server died while run ${stale.runId} survived (process group ${stale.childPgid}); cleanup did not reach ESRCH after ${RUN_KILL_GRACE_MS + RUN_KILL_CONFIRM_MS}ms`,
              stale,
              'wedged'
            );
          }
          // A surviving run was just DESTROYED to free the slot. Carry the
          // identity of what was killed onto the lease so the caller can say
          // so — a silent reap leaves the host unable to explain why the
          // previous run's deliverable vanished (2026-08-14 review, MCP §).
          reaped = { runId: stale.runId, childPgid: stale.childPgid };
          recoveredRuns.push(reaped);
          process.stderr.write(`[atoma lease] recovered abandoned run ${stale.runId}: reaped group ${stale.childPgid}\n`);
        } else {
          // Same numeric PGID, different process birth: it belongs to someone
          // else now. Reclaim only the stale row and never send a signal.
        }
      }

      // Compare-and-swap under BEGIN IMMEDIATE. If another recoverer already
      // replaced the stale token, this transaction changes nothing and loops.
      // A deployment that began waiting during the reap above (it takes
      // seconds) still refuses this start — and the refusal says what was
      // reaped, because the recovery has already happened.
      const claimed = db.transaction(() => {
        const late = blockingDeployment(db);
        if (late) return late;
        if (deleteByToken.run(stale.token).changes !== 1) return false;
        if (blocking() !== undefined) return false;
        claim();
        return true;
      }).immediate();
      if (claimed === true) return makeLease(db, path, owner, recoveredRuns[0], undefined, recoveredRuns);
      if (claimed) throw deploymentWaitingError(claimed, reaped);
    }
    throw new RunLockBusyError(`could not acquire MCP run lease ${path} after recovery races`);
  } catch (err) {
    db.close();
    if (err instanceof RunLockBusyError && recoveredRuns.length) {
      throw new RunLockBusyError(err.message, err.owner, err.condition, recoveredRuns[0], recoveredRuns);
    }
    throw err;
  }
}

/**
 * Claim the run slot only when it is empty — or held by a row with nothing
 * behind it.
 *
 * This is the deployment drain primitive, not run-start recovery. A deploy
 * must never decide that an existing owner is stale and reap its process
 * group merely so new code can be activated: a row that recorded a child
 * process group is busy whatever its owner's state, and the normal run path
 * above remains the sole recovery path, with its fingerprint checks and
 * visible `recovered` result.
 *
 * A row whose owner is GONE and which has NOTHING BEHIND IT — it recorded no
 * process group, or the one it recorded no longer exists — is the one
 * exception, and any caller here reclaims it: there is nothing to reap, only
 * a row. That is every row an analysis, a mend, maintenance or a deployment
 * leaves when killed — on 2026-09-27 a mender killed with SIGKILL left one
 * that refused two deployments and every analysis for 2 h 10, until a person
 * deleted it by hand. The lease says so (`reclaimed`), and an unverifiable
 * owner is still busy.
 *
 * A waiting deployment refuses every caller here too — analysis, mend,
 * maintenance, campaigns — except the deployment that registered it, which
 * presents its token.
 */
export function acquireRunLeaseWithoutRecovery(
  runId: string,
  path = mcpRunLockPath(),
  options: { readonly pendingToken?: string } = {}
): RunLease {
  const db = openLockDb(path);
  const owner: RunLockOwner = {
    token: randomUUID(),
    runId,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  const ownerFingerprint = processFingerprint(owner.ownerPid);
  const read = db.prepare('SELECT * FROM mcp_run_lease ORDER BY singleton');
  const insert = db.prepare(
    `INSERT INTO mcp_run_lease
      (singleton, token, run_id, owner_pid, child_pgid, acquired_at,
       owner_fingerprint, child_fingerprint)
     VALUES (1, ?, ?, ?, NULL, ?, ?, NULL)`
  );

  const deleteByToken = db.prepare('DELETE FROM mcp_run_lease WHERE token = ?');

  try {
    const outcome = db.transaction(() => {
      const waiting = blockingDeployment(db, options.pendingToken);
      if (waiting) return { waiting };
      const rows = read.all() as LeaseRow[];
      const held = rows.find((row) => !ownerIsGone(row) || !nothingBehind(row));
      if (held) return { held };
      let reclaimed: RunLockOwner | undefined;
      for (const row of rows) {
        deleteByToken.run(row.token);
        reclaimed ??= toOwner(row);
      }
      insert.run(
        owner.token,
        owner.runId,
        owner.ownerPid,
        owner.acquiredAt,
        ownerFingerprint
      );
      return reclaimed ? { reclaimed } : undefined;
    }).immediate();
    if (outcome?.waiting) throw deploymentWaitingError(outcome.waiting);
    const existing = outcome?.held;
    if (existing) {
      const held = toOwner(existing);
      throw new RunLockBusyError(
        `the run slot is occupied (${held.runId}, pid ${held.ownerPid}, since ${held.acquiredAt}); deployment will not recover or interrupt it`,
        held
      );
    }
    return makeLease(db, path, owner, undefined, outcome?.reclaimed);
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * READ-ONLY view of the lease row, for status reporting.
 *
 * WHY IT EXISTS: run records are in-memory only, so after a server restart
 * `atoma_run_status` used to answer "no run with id" while the lease row still
 * named a possibly-LIVE run from the previous server — the surviving run was
 * invisible until the next `atoma_run_start` destructively recovered it
 * (2026-08-14 review, MCP §). This peek lets the status path report that
 * cross-process owner without becoming a second recovery path.
 *
 * THE CONTRACT IS "LOOK, NEVER TOUCH": the handle is readonly + fileMustExist
 * (the same shape the MCP readers use — `openLockDb` would mkdir, exec the
 * schema and flip journal_mode, i.e. WRITE), the query is one SELECT, and no
 * process is probed or signalled — reporting must never kill or mutate what it
 * reports on. Recovery stays exclusively in `acquireRunLease`, where it runs
 * under BEGIN IMMEDIATE with fingerprint checks. An absent/torn store is
 * "nothing to report", never a throw in a status poll.
 */
export function peekRunLeases(path = mcpRunLockPath()): RunLockOwner[] {
  if (!existsSync(path)) return [];
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare('SELECT * FROM mcp_run_lease ORDER BY singleton').all() as LeaseRow[];
    return rows.map(toOwner);
  } catch {
    // Missing table (a foreign file at this path) or a torn store: a status
    // reader has nothing to say about it.
    return [];
  } finally {
    db.close();
  }
}

/** Compatibility reader for consumers that only need to know whether ANY work exists. */
export function peekRunLease(path = mcpRunLockPath()): RunLockOwner | null {
  return peekRunLeases(path)[0] ?? null;
}

export interface DeploymentPendingRegistration {
  readonly token: string;
  /** Conditional by token and safe to call twice. */
  release(): void;
}

/**
 * Announce that a deployment is waiting for the run slot.
 *
 * From this moment nothing may TAKE the slot — no run, analysis, mend,
 * maintenance or campaign — except the deployment presenting this token,
 * while whatever already holds it finishes normally. Nothing is interrupted:
 * a deployment waits for work, it never ends it. The row dies with its owner
 * process, so a guard killed mid-wait reopens the slot by itself.
 */
export function registerDeploymentPending(
  runId: string,
  path = mcpRunLockPath()
): DeploymentPendingRegistration {
  // Without a birth identity the row could only be voided by pid, and a pid
  // recycled while it waits would keep every taker out behind a dead guard.
  const fingerprint = processFingerprint(process.pid);
  if (!fingerprint) {
    throw new Error('this process has no verifiable birth identity; a waiting deployment must die with its guard');
  }
  const db = openLockDb(path);
  const token = randomUUID();
  try {
    const other = db.transaction(() => {
      const waiting = blockingDeployment(db);
      if (waiting) return waiting;
      db.prepare(
        `INSERT INTO mcp_deployment_pending
          (singleton, token, run_id, owner_pid, owner_fingerprint, registered_at)
         VALUES (1, ?, ?, ?, ?, ?)`
      ).run(token, runId, process.pid, fingerprint, new Date().toISOString());
      return undefined;
    }).immediate();
    if (other) {
      throw new RunLockBusyError(
        `another deployment is already waiting for the run slot (${other.runId}, pid ${other.ownerPid}, since ${other.acquiredAt})`,
        other
      );
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return {
    token,
    release() {
      if (released) return;
      released = true;
      try {
        db.prepare('DELETE FROM mcp_deployment_pending WHERE singleton = 1 AND token = ?').run(token);
      } finally {
        db.close();
      }
    },
  };
}

/**
 * READ-ONLY view of the waiting deployment, for the idle predicate and the
 * preview admission. Same contract as `peekRunLease`: look, never touch. A
 * void row (its guard is gone) reads as nothing; the next writer deletes it.
 */
export function peekDeploymentPending(path = mcpRunLockPath()): DeploymentPending | null {
  if (!existsSync(path)) return null;
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare('SELECT * FROM mcp_deployment_pending WHERE singleton = 1')
      .get() as PendingRow | undefined;
    if (!row || !pendingIsLive(row)) return null;
    return {
      token: row.token,
      runId: row.run_id,
      ownerPid: row.owner_pid,
      registeredAt: row.registered_at,
    };
  } catch {
    // A store no deployment has waited on has no such table: nothing waits.
    return null;
  } finally {
    db.close();
  }
}

/**
 * Is the slot held by a row whose owner process is GONE (dead, or its pid
 * recycled) but whose recorded process group still exists? Such a row may
 * still have a run behind it, which only a run start's recovery may reap; a
 * gone owner with nothing behind is reclaimed by the next taker instead. A waiting deployment asks this after being
 * refused, so it refuses at once instead of holding everyone off until its
 * deadline for nothing — it never recovers such a row itself. Read-only;
 * unverifiable reads as not gone.
 */
export function runLeaseOwnerGone(path = mcpRunLockPath()): boolean {
  if (!existsSync(path)) return false;
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    const rows = db.prepare('SELECT * FROM mcp_run_lease').all() as LeaseRow[];
    // Only the row a non-recovery taker must leave: a gone owner with a live
    // group behind it. A gone owner with nothing behind is reclaimed instead.
    return rows.some((row) => ownerIsGone(row) && !nothingBehind(row));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Is `pid` still the process that recorded `fingerprint`? For a marker that
 * names its writer — the deployment's write freeze — so a marker left by a
 * killed guard or a reboot stops freezing writes. Same rule as a lease owner:
 * gone or recycled is false, an identity unreadable right now is true.
 */
export function recordedProcessLive(pid: number, fingerprint: string): boolean {
  const identity = recordedIdentity(pid, fingerprint, new Date().toISOString());
  return identity === 'match' || identity === 'unverifiable';
}

/**
 * Is the slot held by a LIVE owner? The idle predicate's question, answered by
 * birth identity rather than by pid: a dead owner's pid reused after a reboot
 * — by any process, the mender itself included — must not read as a run, or
 * the stages that would reclaim the row never try. Unverifiable reads as live.
 */
export function runLeaseOwnerLive(path = mcpRunLockPath()): boolean {
  if (!existsSync(path)) return false;
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    const rows = db.prepare('SELECT * FROM mcp_run_lease').all() as LeaseRow[];
    return rows.some((row) => !ownerIsGone(row));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** The one line every taker logs when its lease says `reclaimed`. */
export function reclaimedLine(from: RunLockOwner): string {
  return `reclaimed the run slot from ${from.runId} (its owner, pid ${from.ownerPid}, is gone or recycled, and nothing it started survives)`;
}
