import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeStoreHandles, openStoreHandle } from '../src/core/stores.js';
import { openDb } from '../src/registry/db.js';
import {
  instrumentStoreHandle, PRESSURE_FILE_MAX_BYTES, readStorePressure, recordStorePressure, storePressurePath,
  STORE_SLOW_TRANSACTION_MS, type StorePressureRecord,
} from '../src/core/storePressure.js';

const roots: string[] = [];
afterEach(() => { closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function store(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-store-pressure-'));
  roots.push(root);
  return join(root, 'atoma.db');
}
const records = (path: string): StorePressureRecord[] => {
  const file = storePressurePath(path)!;
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as StorePressureRecord) : [];
};
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A second PROCESS holding the write lock: the topology the store actually runs. */
function holdLock(path: string, ms: number): Promise<void> {
  const child = spawn(process.execPath, ['-e', `
    const D = require(${JSON.stringify(resolve('node_modules/better-sqlite3'))});
    const db = new D(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('held\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));`, path, String(ms)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((done, fail) => {
    child.stdout.once('data', () => done());
    child.once('error', fail);
  });
}

describe('store pressure records', () => {
  it('splits a transaction that waited on another process from one that held the lock', async () => {
    const path = store();
    const db = openStoreHandle(path, 'CREATE TABLE IF NOT EXISTS t (v INTEGER)');
    await holdLock(path, 1_300);
    // Waits for the other process (busy_timeout 5 s), then holds briefly.
    expect(db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run().changes).immediate()).toBe(1);
    // Holds the lock itself for longer than the threshold.
    db.transaction(() => { db.prepare('INSERT INTO t VALUES (2)').run(); sleep(STORE_SLOW_TRANSACTION_MS + 100); }).immediate();
    const [waited, held] = records(path);
    expect(waited).toMatchObject({ kind: 'slow', mode: 'immediate', pid: process.pid });
    expect(waited!.waitMs).toBeGreaterThanOrEqual(900);
    expect(waited!.holdMs).toBeLessThan(500);
    expect(held).toMatchObject({ kind: 'slow', mode: 'immediate' });
    expect(held!.holdMs).toBeGreaterThanOrEqual(STORE_SLOW_TRANSACTION_MS);
    expect(held!.waitMs).toBeLessThan(500);
    expect(held!.where).toMatch(/store-pressure\.test\.ts/);
    expect(held!.where).not.toContain(resolve('.'));
  });

  it('records SQLITE_BUSY from a transaction and from a lone statement, and rethrows it', async () => {
    const path = store();
    const db = new Database(path);
    db.exec('CREATE TABLE t (v INTEGER)');
    db.pragma('busy_timeout = 50');
    instrumentStoreHandle(db);
    await holdLock(path, 3_000);
    expect(() => db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run()).immediate()).toThrow(/locked|busy/i);
    expect(() => db.prepare('INSERT INTO t VALUES (2)').run()).toThrow(/locked|busy/i);
    // Deferred BEGIN succeeds; the statement fails inside it. Count the
    // same failure once as it unwinds through both observation boundaries.
    expect(() => db.transaction(() => db.prepare('INSERT INTO t VALUES (3)').run()).deferred()).toThrow(/locked|busy/i);
    expect(() => db.prepare('INSERT INTO t VALUES (4) RETURNING v').get()).toThrow(/locked|busy/i);
    db.close();
    expect(records(path).map(r => [r.kind, r.mode])).toEqual([
      ['busy', 'immediate'], ['busy', 'statement'], ['busy', 'statement'], ['busy', 'statement'],
    ]);
  });

  it('keeps transaction semantics: return values, rollback, nesting and every mode', () => {
    const path = store();
    const db = openDb(path);
    db.exec('CREATE TABLE IF NOT EXISTS t (v INTEGER)');
    const insert = db.transaction((v: number) => db.prepare('INSERT INTO t VALUES (?)').run(v).changes);
    expect(insert(1)).toBe(1);
    expect(insert.immediate(2)).toBe(1);
    expect(insert.deferred(3)).toBe(1);
    expect(insert.exclusive(4)).toBe(1);
    const outer = db.transaction(() => { insert(5); insert.immediate(6); return 'nested'; });
    expect(outer.immediate()).toBe('nested');
    expect(() => db.transaction(() => { insert(7); throw new Error('roll back'); }).immediate()).toThrow('roll back');
    expect(db.prepare('SELECT v FROM t ORDER BY v').pluck().all()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(records(path)).toEqual([]);
  });

  it('leaves an in-memory store alone and reads both generations of the sidecar', () => {
    const memory = new Database(':memory:');
    instrumentStoreHandle(memory);
    expect(storePressurePath(':memory:')).toBeNull();
    const path = store();
    const file = storePressurePath(path)!;
    writeFileSync(file, 'x'.repeat(PRESSURE_FILE_MAX_BYTES));
    recordStorePressure(path, { kind: 'busy', mode: 'immediate', waitMs: 5000, holdMs: 0 });
    expect(statSync(`${file}.1`).size).toBe(PRESSURE_FILE_MAX_BYTES);
    recordStorePressure(path, { kind: 'slow', mode: 'default', waitMs: 10, holdMs: 1200 });
    writeFileSync(`${file}.1`, '{"kind":"busy","at":"2026-10-16T00:00:00.000Z","pid":1,"mode":"statement","waitMs":5000,"holdMs":0,"where":""}\nnot json\n');
    const all = readStorePressure(path, 0);
    expect(all).toMatchObject({ busy: 2, slow: 1, slowestMs: 5000 });
    expect(readStorePressure(path, Date.parse('2026-10-16T00:00:01.000Z'))).toMatchObject({ busy: 1, slow: 1 });
  });
});
