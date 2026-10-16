import type Database from 'better-sqlite3';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * STORE CONTENTION, MEASURED WHERE IT HAPPENS.
 * ============================================
 *
 * Gate 0 (docs/saas-architecture.md) keeps the product store on SQLite and
 * names what reopens PostgreSQL: a `SQLITE_BUSY` after the busy timeout with
 * every writer `.immediate()`, or a second host. Until 2026-10-16 the first
 * criterion was read off `journalctl` by hand, and only for the server: a run
 * child, the learning worker, the mender and the CLIs log elsewhere or
 * nowhere. This module turns it into a record every writer leaves.
 *
 * WHAT IS RECORDED. Two events, on the product store's WRITER handles only
 * (`openStoreHandle`, the registry's `openDb`):
 *   - `busy`: a statement or transaction failed with `SQLITE_BUSY*`. On these
 *     handles that means the 5 s `STORE_BUSY_TIMEOUT_MS` ran out.
 *   - `slow`: an outermost transaction, or a statement outside one, took
 *     `STORE_SLOW_TRANSACTION_MS` or longer, split into the time spent
 *     WAITING for the write lock and the time spent HOLDING it. The holder is
 *     the culprit and the waiter its victim, and one number cannot say which.
 * The handles that set `busy_timeout = 0` on purpose (the embedding cache,
 * the lease probes) are not instrumented: a busy answer is their contract.
 *
 * WHERE IT GOES. A sidecar JSONL file beside the store, appended with
 * O_APPEND, never the store itself. Writing a contention record INTO the
 * contended database would add a writer at the one moment there are too
 * many, and would lose exactly the record that matters when the lock cannot
 * be taken. Every writer runs on this machine (the gate's own premise), so a
 * file beside the store is visible to all of them; the server reads it and
 * journals (`src/platform/hostPressure.ts`).
 *
 * FAIL-OPEN AND BOUNDED. A record that cannot be written is dropped: this is
 * telemetry, and a store call must never fail because its observer did. The
 * file rotates once at `PRESSURE_FILE_MAX_BYTES` into `.1`; two processes
 * rotating at once can lose the older half, which only costs history.
 */

/** A transaction or lone statement at least this long is recorded. */
export const STORE_SLOW_TRANSACTION_MS = 1_000;
export const PRESSURE_FILE_MAX_BYTES = 256 * 1024;
const MAX_WHERE_CHARS = 300;

export type StorePressureKind = 'busy' | 'slow';

export interface StorePressureRecord {
  readonly at: string;
  readonly kind: StorePressureKind;
  readonly pid: number;
  /** `statement` outside a transaction, else the transaction mode. */
  readonly mode: 'statement' | 'exec' | 'default' | 'deferred' | 'immediate' | 'exclusive';
  /** Time before the transaction body ran: waiting for the write lock. */
  readonly waitMs: number;
  /** Time with the lock held. A lone statement cannot be split: all of it is here. */
  readonly holdMs: number;
  /** The first application frames, repository-relative. Never SQL or values. */
  readonly where: string;
}

export function storePressurePath(storePath: string): string | null {
  if (storePath === '' || storePath === ':memory:') return null;
  return `${resolve(storePath)}.pressure.jsonl`;
}

/** better-sqlite3 surfaces the extended code (`SQLITE_BUSY_SNAPSHOT`, ...). */
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1)
    .map(line => line.trim().replace(/^at\s+/, ''))
    .filter(line => !line.includes('storePressure') && !line.includes(`node_modules${sep}`) && !line.includes('node:'));
  // Repository-relative: strip the working directory, and a release
  // directory up to `src/` or `dist/` (it names a commit, not a place).
  const root = resolve(process.cwd()) + sep;
  return frames.slice(0, 3)
    .map(line => line.split(root).join('').replace(/(^|[\s(])[^\s(]*?[\\/]((?:src|dist)[\\/])/, '$1$2'))
    .join(' < ').slice(0, MAX_WHERE_CHARS);
}

export function recordStorePressure(storePath: string, record: Omit<StorePressureRecord, 'at' | 'pid' | 'where'>): void {
  const file = storePressurePath(storePath);
  if (!file) return;
  try {
    if (existsSync(file) && statSync(file).size >= PRESSURE_FILE_MAX_BYTES) renameSync(file, `${file}.1`);
    const line: StorePressureRecord = {
      at: new Date().toISOString(), pid: process.pid, where: callSite(), ...record,
      waitMs: Math.round(record.waitMs), holdMs: Math.round(record.holdMs),
    };
    appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch {
    /* telemetry: a lost record must never fail the store call it describes */
  }
}

const instrumented = new WeakSet<Database.Database>();
type Mode = StorePressureRecord['mode'];
const TRANSACTION_MODES = ['default', 'deferred', 'immediate', 'exclusive'] as const;

/**
 * Instrument one WRITER handle in place. Idempotent. Nested transactions are
 * savepoints inside a measured outer one, and statements inside a
 * transaction are covered by it, so only the outermost call is timed; a busy
 * failure is recorded wherever it surfaces.
 */
export function instrumentStoreHandle(db: Database.Database): void {
  const storePath = db.name;
  if (instrumented.has(db) || !storePressurePath(storePath)) return;
  instrumented.add(db);

  let observedBusy = new Set<unknown>();
  const observe = <R>(mode: Mode, run: () => R, entered?: () => number | undefined): R => {
    if (db.inTransaction) {
      try { return run(); }
      catch (error) {
        if (isSqliteBusy(error) && !observedBusy.has(error)) {
          observedBusy.add(error);
          recordStorePressure(storePath, { kind: 'busy', mode, waitMs: 0, holdMs: 0 });
        }
        throw error;
      }
    }
    observedBusy = new Set();
    const started = performance.now();
    let failed: unknown;
    try { return run(); }
    catch (error) { failed = error; throw error; }
    finally {
      const ended = performance.now();
      const inside = entered?.();
      const waitMs = inside === undefined ? 0 : inside - started;
      const holdMs = ended - (inside ?? started);
      if (isSqliteBusy(failed)) {
        if (!observedBusy.has(failed)) recordStorePressure(storePath, { kind: 'busy', mode, waitMs: ended - started, holdMs: 0 });
      }
      else if (ended - started >= STORE_SLOW_TRANSACTION_MS) recordStorePressure(storePath, { kind: 'slow', mode, waitMs, holdMs });
    }
  };

  const transaction = db.transaction.bind(db);
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    // The body starts once BEGIN holds the lock it asked for: the gap before
    // it is the wait, the rest is the hold.
    let depth = 0;
    let enteredAt: number | undefined;
    const tx = transaction(function (this: unknown, ...args: unknown[]) {
      if (depth++ === 0) enteredAt = performance.now();
      try { return fn.apply(this, args); } finally { depth--; }
    });
    const variant = (call: (...args: unknown[]) => unknown, mode: Mode) =>
      function (this: unknown, ...args: unknown[]) {
        const outer = !db.inTransaction;
        if (outer) enteredAt = undefined;
        return observe(mode, () => call.apply(this, args), () => (outer ? enteredAt : undefined));
      };
    const wrapped = variant(tx, 'default') as unknown as Record<string, unknown>;
    for (const mode of TRANSACTION_MODES) {
      Object.defineProperty(wrapped, mode, { value: variant((tx as unknown as Record<string, (...a: unknown[]) => unknown>)[mode]!, mode) });
    }
    Object.defineProperty(wrapped, 'database', { value: db });
    return wrapped;
  }) as unknown as Database.Database['transaction'];

  const prepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    const statement = prepare(source);
    if (statement.readonly) return statement;
    const run = statement.run.bind(statement);
    statement.run = function (this: unknown, ...args: unknown[]) {
      return observe('statement', () => run(...args));
    };
    if (statement.reader) {
      const get = statement.get.bind(statement);
      const all = statement.all.bind(statement);
      statement.get = (...args: unknown[]) => observe('statement', () => get(...args));
      statement.all = (...args: unknown[]) => observe('statement', () => all(...args));
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...args: unknown[]) {
        const iterator = iterate(...args);
        try {
          for (;;) {
            const next = observe('statement', () => iterator.next());
            if (next.done) return;
            yield next.value;
          }
        } finally { iterator.return?.(); }
      };
    }
    return statement;
  }) as Database.Database['prepare'];

  const exec = db.exec.bind(db);
  db.exec = (source: string) => observe('exec', () => exec(source));
}

export interface StorePressureSummary {
  readonly since: string;
  readonly busy: number;
  readonly slow: number;
  readonly slowestMs: number;
  /** Newest last, at most `recentLimit`. */
  readonly recent: readonly StorePressureRecord[];
}

/** Read both generations of the sidecar. Unreadable or malformed lines are skipped. */
export function readStorePressure(storePath: string, sinceMs: number, recentLimit = 5): StorePressureSummary {
  const file = storePressurePath(storePath);
  const records: StorePressureRecord[] = [];
  for (const candidate of file ? [`${file}.1`, file] : []) {
    let text: string;
    try { text = readFileSync(candidate, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as StorePressureRecord;
        if ((parsed.kind === 'busy' || parsed.kind === 'slow') && Date.parse(parsed.at) >= sinceMs) records.push(parsed);
      } catch { /* a torn or foreign line */ }
    }
  }
  records.sort((a, b) => a.at.localeCompare(b.at));
  return {
    since: new Date(sinceMs).toISOString(),
    busy: records.filter(r => r.kind === 'busy').length,
    slow: records.filter(r => r.kind === 'slow').length,
    slowestMs: records.reduce((max, r) => Math.max(max, r.waitMs + r.holdMs), 0),
    recent: records.slice(-recentLimit),
  };
}
