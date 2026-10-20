import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { processExists, processFingerprint, recordedProcessLive } from '../mcp/runLock.js';

const DDL = `CREATE TABLE IF NOT EXISTS platform_mutation_leases (
 resource TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, fingerprint TEXT, claimed_at TEXT NOT NULL
);`;
type Owner = { token: string; pid: number; fingerprint: string | null };
const pending = new Set<Promise<unknown>>();
const owned = new Set<string>();
let closing = false;

/** Serialize rotating credentials across generations without holding a SQLite
 * transaction during a network request. A live owner is never timed out/replaced. */
export function withStoreMutex<T>(db: Database.Database, resource: string, work: () => Promise<T>): Promise<T> {
  if (closing) return Promise.reject(new Error('Credential service is shutting down; retry the request'));
  const task = run(db, resource, work);
  pending.add(task);
  void task.finally(() => pending.delete(task)).catch(() => undefined);
  return task;
}

async function run<T>(db: Database.Database, resource: string, work: () => Promise<T>): Promise<T> {
  db.exec(DDL);
  const token = randomUUID(), fingerprint = processFingerprint(process.pid), deadline = Date.now() + 60_000;
  let checkedToken = '', checkedAt = 0;
  for (;;) {
    if (closing) throw new Error('Credential service is shutting down; retry the request');
    const owner = db.prepare('SELECT token,pid,fingerprint FROM platform_mutation_leases WHERE resource=?').get(resource) as Owner | undefined;
    if (!owner) {
      if (db.prepare('INSERT OR IGNORE INTO platform_mutation_leases VALUES (?,?,?,?,?)')
        .run(resource, token, process.pid, fingerprint, new Date().toISOString()).changes === 1) break;
    } else if (owner.token !== checkedToken || Date.now() - checkedAt >= 1000) {
      const orphanedHere = owner.pid === process.pid && owner.fingerprint === fingerprint && !owned.has(owner.token);
      const live = owner.fingerprint ? recordedProcessLive(owner.pid, owner.fingerprint) : processExists(owner.pid);
      if (orphanedHere || !live) {
        db.prepare('DELETE FROM platform_mutation_leases WHERE resource=? AND token=?').run(resource, owner.token);
      }
      checkedToken = owner.token; checkedAt = Date.now();
    }
    if (Date.now() >= deadline) throw new Error('Credential is being updated; retry the request');
    await delay(25);
  }
  owned.add(token);
  try { return await work(); }
  finally {
    owned.delete(token);
    db.prepare('DELETE FROM platform_mutation_leases WHERE resource=? AND token=?').run(resource, token);
  }
}

export function storeMutexesIdle(): boolean { return pending.size === 0; }
export async function quiesceStoreMutexes(): Promise<void> {
  closing = true;
  await Promise.allSettled([...pending]);
}
