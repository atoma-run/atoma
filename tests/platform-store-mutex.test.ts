import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { withStoreMutex } from '../src/platform/storeMutex.js';

it('serializes separate database clients and releases a failed exchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-mutex-'));
  const a = new Database(join(dir, 'store.db')), b = new Database(join(dir, 'store.db'));
  try {
    a.exec('CREATE TABLE rotations (value INTEGER); INSERT INTO rotations VALUES (0)');
    const rotate = (db: Database.Database) => withStoreMutex(db, 'credential', async () => {
      const row = db.prepare('SELECT value FROM rotations').get() as { value: number };
      await new Promise(resolve => setTimeout(resolve, 30));
      db.prepare('UPDATE rotations SET value=?').run(row.value + 1);
    });
    await Promise.all([rotate(a), rotate(b)]);
    expect(a.prepare('SELECT value FROM rotations').get()).toEqual({ value: 2 });
    await expect(withStoreMutex(a, 'credential', () => Promise.reject(new Error('exchange failed')))).rejects.toThrow('exchange failed');
    await rotate(b);
    expect(a.prepare('SELECT value FROM rotations').get()).toEqual({ value: 3 });
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('waits for a live process and reclaims its credential mutex only after its death', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-mutex-'));
  const file = join(dir, 'store.db');
  const db = new Database(file);
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      import { withStoreMutex } from './src/platform/storeMutex.ts';
      await withStoreMutex(new Database(process.argv[1]), 'credential', async () => {
        console.log('owned');
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const [chunk] = await once(child.stdout!, 'data');
    expect(String(chunk)).toContain('owned');
    let entered = false;
    const next = withStoreMutex(db, 'credential', async () => { entered = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(entered).toBe(false);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await next;
    expect(entered).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM platform_mutation_leases').get()).toEqual({ n: 0 });
  } finally { child?.kill('SIGKILL'); db.close(); rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

it('finishes an owned credential exchange during graceful shutdown and refuses new ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoma-mutex-'));
  const file = join(dir, 'store.db');
  const db = new Database(file);
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      import { withStoreMutex, quiesceStoreMutexes } from './src/platform/storeMutex.ts';
      const db = new Database(process.argv[1]);
      db.exec('CREATE TABLE result (value TEXT)');
      process.once('SIGTERM', async () => {
        const drained = quiesceStoreMutexes();
        try { await withStoreMutex(db, 'new', async () => {}); process.exit(2); }
        catch { /* Refused during shutdown. */ }
        await drained;
        process.exit(0);
      });
      await withStoreMutex(db, 'credential', async () => {
        console.log('owned');
        await new Promise(resolve => setTimeout(resolve, 250));
        db.prepare('INSERT INTO result VALUES (?)').run('rotated and committed');
      });
    `, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const [chunk] = await once(child.stdout!, 'data');
    expect(String(chunk)).toContain('owned');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
    expect(db.prepare('SELECT value FROM result').get()).toEqual({ value: 'rotated and committed' });
    expect(db.prepare('SELECT count(*) AS n FROM platform_mutation_leases').get()).toEqual({ n: 0 });
  } finally { child?.kill('SIGKILL'); db.close(); rmSync(dir, { recursive: true, force: true }); }
}, 10_000);
