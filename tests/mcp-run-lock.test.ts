import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  acquireRunLease,
  acquireRunLeaseWithoutRecovery,
  peekDeploymentPending,
  peekRunLease,
  peekRunLeases,
  processFingerprint,
  registerDeploymentPending,
  RunLockBusyError,
  runLeaseOwnerGone,
  runLeaseOwnerLive,
} from '../src/mcp/runLock.js';
import { forceKillTestProcessTree } from './helpers.js';

const posixIt = it.skipIf(process.platform === 'win32');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_run_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    child_pgid INTEGER,
    acquired_at TEXT NOT NULL,
    owner_fingerprint TEXT,
    child_fingerprint TEXT
  )
`;

const LEGACY_SCHEMA = `
  CREATE TABLE mcp_run_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    child_pgid INTEGER,
    acquired_at TEXT NOT NULL
  )
`;

describe('MCP cross-process run lease', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-lock-'));
    lockPath = join(dir, 'run-lock.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function inspect(): Database.Database {
    const db = new Database(lockPath);
    db.exec(SCHEMA);
    return db;
  }

  it('admits ten organisations, excludes duplicate organisations and drains every place', async () => {
    const organisations = Array.from({ length: 11 }, () => randomUUID());
    const leases = await Promise.all(organisations.slice(0, 10).map((orgId, index) =>
      acquireRunLease(`project:${index}`, lockPath, { orgId })));
    try {
      expect(peekRunLeases(lockPath)).toHaveLength(10);
      await expect(acquireRunLease('eleventh', lockPath, { orgId: organisations[10]! })).rejects.toThrow(RunLockBusyError);
      await expect(acquireRunLease('same-client', lockPath, { orgId: organisations[0]! })).rejects.toThrow(RunLockBusyError);
      await expect(acquireRunLease('operator', lockPath)).rejects.toThrow(RunLockBusyError);
      expect(() => acquireRunLeaseWithoutRecovery('analyst:test', lockPath)).toThrow(RunLockBusyError);
      // Releasing a non-first place must not release its neighbours.
      leases[5]!.release();
      expect(peekRunLeases(lockPath)).toHaveLength(9);
      const replacement = await acquireRunLease('replacement', lockPath, { orgId: organisations[10]! });
      leases.push(replacement);
      expect(peekRunLeases(lockPath)).toHaveLength(10);
      const pending = registerDeploymentPending('deployment:test', lockPath);
      try {
        for (const lease of leases.slice(0, -1)) lease.release();
        expect(runLeaseOwnerLive(lockPath)).toBe(true);
        expect(peekRunLease(lockPath)?.runId).toBe('replacement');
        expect(() => acquireRunLeaseWithoutRecovery('deployment:test', lockPath, { pendingToken: pending.token })).toThrow(RunLockBusyError);
        await expect(acquireRunLease('new', lockPath, { orgId: organisations[0]! })).rejects.toMatchObject({ condition: 'pending' });
        replacement.release();
        const deployment = acquireRunLeaseWithoutRecovery('deployment:test', lockPath, { pendingToken: pending.token });
        deployment.release();
      } finally { pending.release(); }
      expect(peekRunLeases(lockPath)).toEqual([]);
    } finally { for (const lease of leases) lease.release(); }
  });

  it('migrates the fixed ten-place schema without losing live ownership and admits above ten', async () => {
    const orgId = randomUUID();
    const seed = new Database(lockPath);
    seed.exec(SCHEMA.replace('CHECK (singleton = 1)', 'CHECK (singleton BETWEEN 1 AND 10), org_id TEXT UNIQUE'));
    seed.prepare(`INSERT INTO mcp_run_lease
      (singleton, org_id, token, run_id, owner_pid, acquired_at, owner_fingerprint)
      VALUES (1, ?, 'preserved-token', 'existing', ?, ?, ?)`).run(
      orgId, process.pid, new Date().toISOString(), processFingerprint(process.pid));
    seed.close();
    const leases: Awaited<ReturnType<typeof acquireRunLease>>[] = [];
    const maxConcurrent = () => 12;
    try {
      for (let index = 0; index < 11; index++) {
        leases.push(await acquireRunLease(`added-${index}`, lockPath, { orgId: randomUUID(), maxConcurrent }));
      }
      expect(peekRunLeases(lockPath)).toHaveLength(12);
      expect(peekRunLeases(lockPath)[0]).toMatchObject({ token: 'preserved-token', runId: 'existing' });
      await expect(acquireRunLease('same-client', lockPath, { orgId, maxConcurrent })).rejects.toThrow(RunLockBusyError);
      await expect(acquireRunLease('thirteenth', lockPath, { orgId: randomUUID(), maxConcurrent })).rejects.toMatchObject({ condition: 'capacity' });
    } finally { for (const lease of leases) lease.release(); }
  });

  it('keeps an organisation reserved before its project row exists and after another place is released', async () => {
    const orgId = randomUUID();
    const first = await acquireRunLease('first', lockPath, { orgId });
    const other = await acquireRunLease('other', lockPath, { orgId: randomUUID() });
    try {
      await expect(acquireRunLease('duplicate', lockPath, { orgId })).rejects.toThrow(/first/);
      first.release();
      expect(peekRunLeases(lockPath).map((row) => row.runId)).toEqual(['other']);
      expect(runLeaseOwnerLive(lockPath)).toBe(true);
      const successor = await acquireRunLease('successor', lockPath, { orgId });
      successor.release();
      expect(peekRunLeases(lockPath).map((row) => row.runId)).toEqual(['other']);
    } finally { first.release(); other.release(); }
  });

  it.each([false, true])('enforces capacity across competing processes (duplicate clients: %s)', async (duplicateClients) => {
    const children: ChildProcessWithoutNullStreams[] = [];
    const exits: Array<Promise<number | null>> = [];
    const orgIds = Array.from({ length: 12 }, () => randomUUID());
    const script = `
      import { acquireRunLease, RunLockBusyError } from './src/mcp/runLock.ts';
      (async () => {
        let lease;
        try {
          lease = await acquireRunLease(process.env.ORG_ID, process.env.LOCK_PATH, { orgId: process.env.ORG_ID });
        } catch (error) { if (!(error instanceof RunLockBusyError)) throw error; }
        process.stdout.write(lease ? 'LOCKED\\n' : 'REFUSED\\n');
        process.stdin.resume();
        process.stdin.on('end', () => { lease?.release(); process.exit(0); });
      })().catch(error => { console.error(error); process.exit(1); });`;
    try {
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
          cwd: process.cwd(), env: { ...process.env, LOCK_PATH: lockPath, ORG_ID: orgIds[duplicateClients ? index % 6 : index]! },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.push(child);
        exits.push(new Promise((resolve) => child.once('exit', resolve)));
        return new Promise<string>((resolve, reject) => {
          let stderr = '', stdout = '';
          const timer = setTimeout(() => reject(new Error(`admission timed out: ${stderr}`)), 30_000);
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            if (!stdout.includes('\n')) return;
            clearTimeout(timer);
            resolve(stdout.trim());
          });
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('exit', () => { clearTimeout(timer); reject(new Error(`child exited: ${stderr}`)); });
        });
      }));
      const admitted = duplicateClients ? 6 : 10;
      expect(results.filter((result) => result === 'LOCKED')).toHaveLength(admitted);
      expect(results.filter((result) => result === 'REFUSED')).toHaveLength(12 - admitted);
      expect(peekRunLeases(lockPath)).toHaveLength(admitted);
      expect(() => acquireRunLeaseWithoutRecovery('maintenance:test', lockPath)).toThrow(RunLockBusyError);
      for (const child of children) child.stdin.end();
      expect(await Promise.all(exits)).toEqual(Array.from({ length: 12 }, () => 0));
      expect(peekRunLeases(lockPath)).toEqual([]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      await Promise.all(exits);
    }
  }, 60_000);

  it('recovers a stale later place and attaches children without touching a live neighbour', async () => {
    const first = await acquireRunLease('live', lockPath, { orgId: randomUUID() });
    const orgId = randomUUID();
    const second = await acquireRunLease('stale', lockPath, { orgId });
    try {
      second.attachChild(process.pid);
      expect(peekRunLeases(lockPath).find((row) => row.runId === 'live')?.childPgid).toBeUndefined();
      expect(peekRunLeases(lockPath).find((row) => row.runId === 'stale')?.childPgid).toBe(process.pid);
      const db = new Database(lockPath);
      db.prepare("UPDATE mcp_run_lease SET owner_pid = 2147483647, child_pgid = NULL WHERE run_id = 'stale'").run();
      db.close();
      const successor = await acquireRunLease('successor', lockPath, { orgId });
      try {
        second.release(); // Old token must not delete the successor.
        expect(peekRunLeases(lockPath).map((row) => row.runId)).toEqual(['live', 'successor']);
        first.release();
        expect(runLeaseOwnerLive(lockPath)).toBe(true);
      } finally { successor.release(); }
    } finally { first.release(); second.release(); }
  });

  function seedStale(runId = 'stale-run'): void {
    const db = inspect();
    db.prepare(
      `INSERT OR REPLACE INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
       VALUES (1, 'dead-owner', ?, 99999999, NULL, '2026-01-01T00:00:00.000Z')`
    ).run(runId);
    db.close();
  }

  it('admits exactly one owner until that owner releases', async () => {
    const first = await acquireRunLease('run-one', lockPath);
    await expect(acquireRunLease('run-two', lockPath)).rejects.toThrow(RunLockBusyError);
    await expect(acquireRunLease('run-two', lockPath)).rejects.toThrow(/run-one/);

    first.release();
    const second = await acquireRunLease('run-two', lockPath);
    second.release();
    const db = inspect();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM mcp_run_lease').get() as { n: number }).n
    ).toBe(0);
    db.close();
  });

  it('excludes a genuinely separate MCP process', async () => {
    // The child holds the lease until its stdin closes. A fixed hold window
    // (1200ms originally) was a pure race under a fully parallel suite: by
    // the time the parent asserted, the child had already released, and the
    // exclusion this test exists to prove looked broken. The 30s LOCKED
    // budget is a watchdog for the same contention (a cold `npx tsx` boot
    // alone outran the old 5s there), not an expected duration.
    const script = [
      "import { acquireRunLease } from './src/mcp/runLock.ts';",
      '(async () => {',
      "const lease = await acquireRunLease('child-run', process.env['LOCK_PATH']);",
      "process.stdout.write('LOCKED\\n');",
      'process.stdin.resume();',
      "process.stdin.on('end', () => { lease.release(); process.exit(0); });",
      '})().catch((e) => { console.error(e); process.exit(1); });',
    ].join(' ');
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));

    try {
      await new Promise<void>((resolveLocked, rejectLocked) => {
        const timer = setTimeout(() => rejectLocked(new Error(`child did not lock: ${stderr}`)), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('LOCKED')) return;
          clearTimeout(timer);
          resolveLocked();
        });
        child.once('error', rejectLocked);
      });

      await expect(acquireRunLease('parent-run', lockPath)).rejects.toThrow(/child-run/);
      child.stdin.end();
      expect(await exited).toBe(0);
      const after = await acquireRunLease('parent-run', lockPath);
      after.release();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 60_000);

  it('recovers a lease whose owner process is dead', async () => {
    seedStale();
    const recovered = await acquireRunLease('new-run', lockPath);
    const db = inspect();
    const owner = db.prepare('SELECT run_id FROM mcp_run_lease').get() as { run_id: string };
    expect(owner.run_id).toBe('new-run');
    db.close();
    recovered.release();
  });

  posixIt('never lets a deployment recover a stale owner whose run may still be alive', async () => {
    // A recorded process group that still exists may be its dead server's
    // run: only a run start's recovery, with its fingerprint checks, may reap it.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    try {
      const seed = inspect();
      seed.prepare(
        `INSERT OR REPLACE INTO mcp_run_lease
         (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
         VALUES (1, 'dead-owner', 'unfinished-run', 99999999, ?, '2026-01-01T00:00:00.000Z')`
      ).run(child.pid);
      seed.close();

      expect(() => acquireRunLeaseWithoutRecovery('deployment:revision', lockPath)).toThrow(
        /will not recover or interrupt/
      );
      expect(peekRunLease(lockPath)?.runId).toBe('unfinished-run');
      expect(runLeaseOwnerGone(lockPath)).toBe(true);
    } finally {
      forceKillTestProcessTree(child.pid);
    }

    const db = inspect();
    db.prepare('DELETE FROM mcp_run_lease').run();
    db.close();
    const deployment = acquireRunLeaseWithoutRecovery('deployment:revision', lockPath);
    try {
      await expect(acquireRunLease('new-run', lockPath)).rejects.toThrow(/deployment:revision/);
    } finally {
      deployment.release();
    }
  });

  it('reclaims a gone owner whose recorded process group no longer exists', () => {
    // A unit stop kills the owner and its group together: the row it leaves
    // names a group that is gone, and nothing is left to reap.
    const seed = inspect();
    seed.prepare(
      `INSERT OR REPLACE INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
       VALUES (1, 'dead-owner', 'project:killed-with-its-unit', 99999999, 99999998, '2026-01-01T00:00:00.000Z')`
    ).run();
    seed.close();
    expect(runLeaseOwnerGone(lockPath)).toBe(false);
    const lease = acquireRunLeaseWithoutRecovery('analyst:next', lockPath);
    try {
      expect(lease.reclaimed?.runId).toBe('project:killed-with-its-unit');
    } finally {
      lease.release();
    }
  });

  it('reclaims a row whose pid now belongs to another process, and keeps one it cannot verify', () => {
    // After a reboot the dead owner's pid may be anyone's — this process's,
    // here. Its birth identity says it is not the owner.
    const seed = inspect();
    seed.prepare(
      `INSERT OR REPLACE INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint)
       VALUES (1, 'reused', 'mender:before-reboot', ?, NULL, ?, 'linux:another-boot:1')`
    ).run(process.pid, new Date().toISOString());
    seed.close();
    expect(runLeaseOwnerLive(lockPath)).toBe(false);
    const lease = acquireRunLeaseWithoutRecovery('mender:after-reboot', lockPath);
    try {
      expect(lease.reclaimed?.runId).toBe('mender:before-reboot');
      expect(runLeaseOwnerLive(lockPath)).toBe(true);
    } finally {
      lease.release();
    }
    // A live pid recorded this boot without an identity cannot be told apart
    // from its owner: it stays busy.
    const unverifiable = inspect();
    unverifiable.prepare(
      `INSERT OR REPLACE INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint)
       VALUES (1, 'unverifiable', 'analyst:live-maybe', ?, NULL, ?, NULL)`
    ).run(process.pid, new Date().toISOString());
    unverifiable.close();
    expect(() => acquireRunLeaseWithoutRecovery('mender:next', lockPath)).toThrow(/occupied \(analyst:live-maybe/);
    expect(runLeaseOwnerLive(lockPath)).toBe(true);
  });

  it('reclaims, and says so, a dead owner row that recorded no process group', () => {
    // A mender killed with SIGKILL left exactly this row, and it refused two
    // deployments and every analysis for 2 h 10 until a person deleted it
    // (2026-09-27). There is nothing behind it to reap, only a row.
    seedStale('mender:killed');
    const deployment = acquireRunLeaseWithoutRecovery('deployment:revision', lockPath);
    try {
      expect(deployment.reclaimed).toMatchObject({ runId: 'mender:killed', ownerPid: 99999999 });
      expect(deployment.recovered).toBeUndefined();
      expect(peekRunLease(lockPath)?.runId).toBe('deployment:revision');
    } finally {
      deployment.release();
    }
    // A live owner is never reclaimed, whatever its row recorded.
    const live = acquireRunLeaseWithoutRecovery('analyst:live', lockPath);
    try {
      expect(live.reclaimed).toBeUndefined();
      expect(() => acquireRunLeaseWithoutRecovery('mender:next', lockPath)).toThrow(/occupied \(analyst:live/);
    } finally {
      live.release();
    }
  });

  it('migrates an existing lease store before recording process fingerprints', async () => {
    const legacy = new Database(lockPath);
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();

    const lease = await acquireRunLease('migrated-run', lockPath);
    const db = new Database(lockPath);
    const columns = (db.pragma('table_info(mcp_run_lease)') as Array<{ name: string }>).map(
      (column) => column.name
    );
    expect(columns).toContain('owner_fingerprint');
    expect(columns).toContain('child_fingerprint');
    const ownerFingerprint = (
      db.prepare('SELECT owner_fingerprint FROM mcp_run_lease').get() as {
        owner_fingerprint: string | null;
      }
    ).owner_fingerprint;
    if (process.platform === 'win32') expect(ownerFingerprint).toBeNull();
    else expect(ownerFingerprint).toEqual(expect.any(String));
    db.close();
    lease.release();
  });

  it('does not confuse a recycled live PID with the recorded owner', async () => {
    const db = inspect();
    db.prepare(
      `INSERT INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint)
       VALUES (1, 'old-process', 'old-run', ?, NULL, ?, 'not-this-process')`
    ).run(process.pid, new Date().toISOString());
    db.close();

    if (process.platform === 'win32') {
      await expect(acquireRunLease('new-run', lockPath)).rejects.toThrow(/birth unverifiable/);
      return;
    }
    const recovered = await acquireRunLease('new-run', lockPath);
    const after = inspect();
    expect(
      (after.prepare('SELECT run_id FROM mcp_run_lease').get() as { run_id: string }).run_id
    ).toBe('new-run');
    after.close();
    recovered.release();
  });

  it('recognizes that a legacy lease predates the current boot', async () => {
    const db = inspect();
    db.prepare(
      `INSERT INTO mcp_run_lease
       (singleton, token, run_id, owner_pid, child_pgid, acquired_at,
        owner_fingerprint, child_fingerprint)
       VALUES (1, 'before-reboot', 'old-run', ?, NULL,
               '1970-01-01T00:00:00.000Z', NULL, NULL)`
    ).run(process.pid);
    db.close();

    const recovered = await acquireRunLease('after-reboot', lockPath);
    recovered.release();
  });

  it('never signals a live process group whose numeric id was recycled', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!child.pid) throw new Error('child pid unavailable');
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    try {
      const db = inspect();
      db.prepare(
        `INSERT INTO mcp_run_lease
         (singleton, token, run_id, owner_pid, child_pgid, acquired_at,
          owner_fingerprint, child_fingerprint)
         VALUES (1, 'dead-with-reused-group', 'old-run', 99999999, ?, ?,
                 NULL, 'not-this-child')`
      ).run(child.pid, new Date().toISOString());
      db.close();

      const recovered = await acquireRunLease('safe-run', lockPath);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      recovered.release();
    } finally {
      forceKillTestProcessTree(child.pid);
    }
  });

  it.skipIf(process.platform === 'win32')('marks a slot whose dead holder left an unverifiable run as wedged, not merely held', async () => {
    // The caller tells a tenant "an operator has to release it" rather than
    // "start again when it finishes": this slot never frees itself.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    if (!child.pid) throw new Error('child pid unavailable');
    await new Promise<void>((resolveSpawn, rejectSpawn) => { child.once('spawn', resolveSpawn); child.once('error', rejectSpawn); });
    try {
      const db = inspect();
      db.prepare(
        `INSERT INTO mcp_run_lease
         (singleton, token, run_id, owner_pid, child_pgid, acquired_at, owner_fingerprint, child_fingerprint)
         VALUES (1, 'dead-owner', 'project:orphan', 99999999, ?, ?, NULL, NULL)`
      ).run(child.pid, new Date().toISOString());
      db.close();
      await expect(acquireRunLease('next-run', lockPath)).rejects.toMatchObject({ condition: 'wedged' });
      let plain: unknown;
      try { acquireRunLeaseWithoutRecovery('maintenance:check', lockPath).release(); } catch (error) { plain = error; }
      expect(plain).toMatchObject({ condition: 'held' });
    } finally {
      forceKillTestProcessTree(child.pid);
    }
  });

  it('records the detached child and never deletes a successor lease', async () => {
    const lease = await acquireRunLease('run-one', lockPath);
    lease.attachChild(4242);
    const db = inspect();
    const attached = db.prepare('SELECT child_pgid FROM mcp_run_lease').get() as {
      child_pgid: number | null;
    };
    expect(attached.child_pgid).toBe(4242);
    db.prepare(
      `UPDATE mcp_run_lease
       SET token = 'successor', run_id = 'run-two', owner_pid = ?, child_pgid = NULL`
    ).run(process.pid);
    db.close();

    lease.release();
    const after = inspect();
    expect((after.prepare('SELECT run_id FROM mcp_run_lease').get() as { run_id: string }).run_id).toBe(
      'run-two'
    );
    after.close();
  });

  /**
   * The reap used to be SILENT: a dead owner's LIVE group was terminated and
   * the acquirer got a lease as if nothing had happened, so a host that had
   * just destroyed a run could not explain the missing deliverable
   * (2026-08-14 review, MCP §). The lease must name what it killed.
   */
  posixIt('recovering a dead owner with a LIVE group reaps it AND reports what was reaped', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!child.pid) throw new Error('child pid unavailable');
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    try {
      // The recorded fingerprint must MATCH the live group for the reap branch
      // to fire (a mismatch means a recycled pgid and is never signalled).
      const fingerprint = processFingerprint(child.pid);
      expect(fingerprint).toBeTruthy();
      const db = inspect();
      db.prepare(
        `INSERT INTO mcp_run_lease
         (singleton, token, run_id, owner_pid, child_pgid, acquired_at,
          owner_fingerprint, child_fingerprint)
         VALUES (1, 'dead-owner', 'orphaned-run', 99999999, ?, ?, NULL, ?)`
      ).run(child.pid, new Date().toISOString(), fingerprint);
      db.close();

      const lease = await acquireRunLease('new-run', lockPath);
      expect(lease.recovered).toEqual({ runId: 'orphaned-run', childPgid: child.pid });
      // And the group is really gone — the report describes a real reap.
      expect(() => process.kill(-child.pid!, 0)).toThrow();
      lease.release();
    } finally {
      forceKillTestProcessTree(child.pid);
    }
  }, 15_000);

  it('a first-claim lease carries no recovered field', async () => {
    const lease = await acquireRunLease('fresh-run', lockPath);
    expect(lease.recovered).toBeUndefined();
    lease.release();
  });

  posixIt('reports every abandoned child reaped before exclusive admission', async () => {
    const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    }));
    const leases = [];
    try {
      await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve); child.once('error', reject);
      })));
      for (const [index, child] of children.entries()) {
        const lease = await acquireRunLease(`orphan:${index}`, lockPath, { orgId: randomUUID() });
        leases.push(lease);
        lease.attachChild(child.pid!);
      }
      const db = new Database(lockPath);
      db.prepare('UPDATE mcp_run_lease SET owner_pid = 2147483647').run();
      db.close();
      const exclusive = await acquireRunLease('operator:recovery', lockPath);
      try {
        expect(exclusive.recoveredRuns).toEqual(children.map((child, index) => ({ runId: `orphan:${index}`, childPgid: child.pid })));
        expect(exclusive.recovered).toEqual(exclusive.recoveredRuns?.[0]);
        for (const child of children) expect(() => process.kill(-child.pid!, 0)).toThrow();
        for (const lease of leases) lease.release();
        expect(peekRunLeases(lockPath).map((row) => row.runId)).toEqual(['operator:recovery']);
      } finally { exclusive.release(); }
    } finally {
      for (const lease of leases) lease.release();
      for (const child of children) if (child.pid) forceKillTestProcessTree(child.pid);
    }
  }, 15_000);

  /**
   * peekRunLease exists so atoma_run_status can report a previous server's
   * possibly-live run after a restart (records are in-memory only). Its
   * contract is LOOK, NEVER TOUCH: no recovery, no signal, no write — a
   * status poll must never kill or mutate what it reports on.
   */
  it('peekRunLease reads the row without signalling or mutating anything', async () => {
    expect(peekRunLease(join(dir, 'absent.db'))).toBeNull();

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!child.pid) throw new Error('child pid unavailable');
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    try {
      const db = inspect();
      db.prepare(
        `INSERT INTO mcp_run_lease
         (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
         VALUES (1, 'tok', 'prev-run', 12345, ?, '2026-08-14T00:00:00.000Z')`
      ).run(child.pid);
      db.close();

      const owner = peekRunLease(lockPath);
      expect(owner).toMatchObject({
        runId: 'prev-run',
        ownerPid: 12345,
        childPgid: child.pid,
        acquiredAt: '2026-08-14T00:00:00.000Z',
      });
      // The group the row names is STILL ALIVE: the peek sent no signal —
      // unlike acquireRunLease, whose recovery would have reaped it.
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      // And the row is untouched.
      const after = inspect();
      const row = after
        .prepare('SELECT token, run_id, owner_pid, child_pgid FROM mcp_run_lease')
        .get();
      after.close();
      expect(row).toEqual({
        token: 'tok',
        run_id: 'prev-run',
        owner_pid: 12345,
        child_pgid: child.pid,
      });
    } finally {
      forceKillTestProcessTree(child.pid);
    }
  });

  it('peekRunLease sees a live WAL-mode lease and its release', async () => {
    // acquireRunLease opens the store in WAL mode — the readonly peek must
    // read it while the writer connection is still open.
    const lease = await acquireRunLease('held-run', lockPath);
    try {
      expect(peekRunLease(lockPath)?.runId).toBe('held-run');
    } finally {
      lease.release();
    }
    expect(peekRunLease(lockPath)).toBeNull();
  });

  it('lets exactly one of two processes recover the same stale token', async () => {
    // The WINNER holds the lease until its stdin closes. The original 500ms
    // hold was a race under a fully parallel suite: a loser whose event loop
    // lagged past the winner's release acquired a lease of its own and the
    // exclusivity this test exists to prove looked broken. The 30s ready
    // deadline is a watchdog for the same contention — two cold `npx tsx`
    // boots outran the old 5s there — not an expected duration.
    seedStale('dead-run');
    const go = join(dir, 'go');
    const launch = (id: string): {
      child: ChildProcessWithoutNullStreams;
      ready: string;
      verdict: Promise<string>;
      closed: Promise<void>;
    } => {
      const ready = join(dir, `ready-${id}`);
      const script = [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import { acquireRunLease } from './src/mcp/runLock.ts';",
        '(async () => {',
        "writeFileSync(process.env['READY'], '1');",
        "while (!existsSync(process.env['GO'])) await new Promise(r => setTimeout(r, 10));",
        'try {',
        "const lease = await acquireRunLease(process.env['ID'], process.env['LOCK_PATH']);",
        "process.stdout.write('ACQUIRED:' + process.env['ID'] + '\\n');",
        'process.stdin.resume();',
        "process.stdin.on('end', () => { lease.release(); process.exit(0); });",
        '} catch {',
        "process.stdout.write('BUSY:' + process.env['ID'] + '\\n'); process.exit(0);",
        '}',
        '})().catch(() => process.exit(1));',
      ].join(' ');
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, ID: id, READY: ready, GO: go, LOCK_PATH: lockPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise<void>((resolveClosed) => {
        child.once('close', () => resolveClosed());
      });
      const verdict = new Promise<string>((resolveVerdict) => {
        let stdout = '';
        let childStderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n')) resolveVerdict(stdout.split('\n')[0] ?? '');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          childStderr += chunk.toString();
        });
        // A child that dies before printing its verdict (an external kill, a
        // native crash — nothing the in-script catch can see) must still
        // settle the race, immediately and carrying its own diagnostics,
        // instead of hanging Promise.all until the test budget kills the run
        // anonymously. `close` fires after the streams flush, so a buffered
        // BUSY line always wins over this fallback.
        child.once('close', () => resolveVerdict(`DIED:${id}: ${childStderr.slice(0, 2000)}`));
      });
      return { child, ready, verdict, closed };
    };

    const a = launch('A');
    const b = launch('B');
    try {
      const deadline = Date.now() + 30_000;
      while ((!existsSync(a.ready) || !existsSync(b.ready)) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(existsSync(a.ready) && existsSync(b.ready)).toBe(true);
      writeFileSync(go, 'go');
      const verdicts = await Promise.all([a.verdict, b.verdict]);
      expect(verdicts.filter((value) => value.startsWith('ACQUIRED:'))).toHaveLength(1);
      expect(verdicts.filter((value) => value.startsWith('BUSY:'))).toHaveLength(1);
      a.child.stdin.end();
      b.child.stdin.end();
      await Promise.all([a.closed, b.closed]);
    } finally {
      for (const contender of [a, b]) {
        contender.child.stdin.end();
        if (contender.child.exitCode === null && contender.child.signalCode === null) {
          contender.child.kill('SIGKILL');
        }
      }
      await Promise.all([a.closed, b.closed]);
    }
  }, 60_000);
});

/**
 * A DEPLOYMENT WAITING FOR THE SLOT (2026-09-27): two production deployments
 * in a row were refused because the mender chained mends with no gap, and at
 * a steady run rate the slot never frees. The waiting deployment's row is
 * what closes the door to new takers while it waits — without interrupting
 * whoever is inside — and it must die with the guard that wrote it.
 * POSIX only where a row is registered: it needs a birth identity, which
 * Windows cannot give.
 */
describe('a deployment waiting for the run slot', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-pending-'));
    lockPath = join(dir, 'run-lock.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedPending(ownerPid: number, fingerprint: string | null): void {
    const db = new Database(lockPath);
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_deployment_pending (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), token TEXT NOT NULL, run_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL, owner_fingerprint TEXT, registered_at TEXT NOT NULL)`);
    db.prepare(
      `INSERT OR REPLACE INTO mcp_deployment_pending VALUES (1, 'void-token', 'deployment:dead', ?, ?, ?)`
    ).run(ownerPid, fingerprint, new Date().toISOString());
    db.close();
  }

  function pendingRows(): number {
    const db = new Database(lockPath, { readonly: true });
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM mcp_deployment_pending').get() as { n: number }).n;
    } finally {
      db.close();
    }
  }

  posixIt('refuses every new taker, lets only its own token through, and names itself', async () => {
    const pending = registerDeploymentPending('deployment:test', lockPath);
    try {
      const refused = await acquireRunLease('project:new', lockPath).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(RunLockBusyError);
      expect((refused as RunLockBusyError).condition).toBe('pending');
      expect((refused as RunLockBusyError).owner?.runId).toBe('deployment:test');
      expect(() => acquireRunLeaseWithoutRecovery('mender:next', lockPath)).toThrow(/a deployment is waiting/);
      expect(() => acquireRunLeaseWithoutRecovery('mender:next', lockPath, { pendingToken: 'forged' }))
        .toThrow(/a deployment is waiting/);
      const own = acquireRunLeaseWithoutRecovery('deployment:test', lockPath, { pendingToken: pending.token });
      expect(peekRunLease(lockPath)?.runId).toBe('deployment:test');
      own.release();
    } finally {
      pending.release();
    }
    // Withdrawn: the door is open again.
    const next = await acquireRunLease('project:after', lockPath);
    next.release();
  });

  posixIt('never interrupts the holder already inside', async () => {
    const inside = await acquireRunLease('project:running', lockPath);
    const pending = registerDeploymentPending('deployment:test', lockPath);
    try {
      inside.attachChild(process.pid);
      expect(peekRunLease(lockPath)?.runId).toBe('project:running');
      expect(() => acquireRunLeaseWithoutRecovery('deployment:test', lockPath, { pendingToken: pending.token }))
        .toThrow(/occupied \(project:running/);
      inside.release();
      const own = acquireRunLeaseWithoutRecovery('deployment:test', lockPath, { pendingToken: pending.token });
      own.release();
    } finally {
      inside.release();
      pending.release();
    }
  });

  posixIt('lets one deployment wait at a time', () => {
    const first = registerDeploymentPending('deployment:first', lockPath);
    try {
      expect(() => registerDeploymentPending('deployment:second', lockPath))
        .toThrow(/already waiting for the run slot \(deployment:first/);
    } finally {
      first.release();
    }
    registerDeploymentPending('deployment:second', lockPath).release();
  });

  it('reads a waiting row whose guard is gone as nothing, and deletes it on the next acquisition only', async () => {
    seedPending(99_999_999, 'linux:dead:1');
    expect(peekDeploymentPending(lockPath)).toBeNull();
    // Look, never touch: the peek left the void row where it was.
    expect(pendingRows()).toBe(1);
    const lease = await acquireRunLease('project:after-crash', lockPath);
    lease.release();
    expect(pendingRows()).toBe(0);
  });

  posixIt('dies with a guard that is killed while it waits', async () => {
    const script = [
      "import { registerDeploymentPending } from './src/mcp/runLock.ts';",
      "registerDeploymentPending('deployment:child', process.env['LOCK_PATH']);",
      "process.stdout.write('WAITING');",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    try {
      await new Promise<void>((resolveWaiting, rejectWaiting) => {
        const timer = setTimeout(() => rejectWaiting(new Error('child never registered')), 30_000);
        child.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('WAITING')) return;
          clearTimeout(timer);
          resolveWaiting();
        });
      });
      expect(peekDeploymentPending(lockPath)?.runId).toBe('deployment:child');
      await expect(acquireRunLease('project:blocked', lockPath)).rejects.toThrow(/a deployment is waiting/);
      child.kill('SIGKILL');
      await exited;
      expect(peekDeploymentPending(lockPath)).toBeNull();
      const lease = await acquireRunLease('project:after', lockPath);
      lease.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 60_000);

  it('treats a store no deployment ever waited on as nothing waiting', () => {
    const db = new Database(lockPath);
    db.exec(LEGACY_SCHEMA);
    db.close();
    expect(peekDeploymentPending(lockPath)).toBeNull();
  });

  it('blocks a deployment on a gone owner only while its run may survive, and reads without touching', async () => {
    expect(runLeaseOwnerGone(lockPath)).toBe(false);
    const db = new Database(lockPath);
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO mcp_run_lease (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
       VALUES (1, 'dead', 'mender:gone', 99999999, NULL, '2026-01-01T00:00:00.000Z')`
    ).run();
    db.close();
    // Nothing behind it: the next taker reclaims it, so nothing blocks on it.
    expect(runLeaseOwnerGone(lockPath)).toBe(false);
    expect(runLeaseOwnerLive(lockPath)).toBe(false);
    expect(peekRunLease(lockPath)?.runId).toBe('mender:gone');
    const cleared = new Database(lockPath);
    cleared.prepare('DELETE FROM mcp_run_lease').run();
    cleared.close();
    const lease = await acquireRunLease('project:live', lockPath);
    expect(runLeaseOwnerGone(lockPath)).toBe(false);
    expect(runLeaseOwnerLive(lockPath)).toBe(true);
    lease.release();
  });
});

describe('a deployment that begins waiting during a recovery', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-pending-reap-'));
    lockPath = join(dir, 'run-lock.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The reap takes seconds, and a deployment may announce itself meanwhile.
   * The start is refused — nothing new may take the slot — but the dead
   * server's run is already destroyed by then, and a refusal that stayed
   * silent about it is the amnesia the `recovered` field exists to prevent.
   */
  posixIt('refuses the start and says what was reaped', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!child.pid) throw new Error('child pid unavailable');
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    let pending: { release(): void } | undefined;
    try {
      const fingerprint = processFingerprint(child.pid);
      expect(fingerprint).toBeTruthy();
      const db = new Database(lockPath);
      db.exec(SCHEMA);
      db.prepare(
        `INSERT INTO mcp_run_lease
         (singleton, token, run_id, owner_pid, child_pgid, acquired_at,
          owner_fingerprint, child_fingerprint)
         VALUES (1, 'dead-owner', 'orphaned-run', 99999999, ?, ?, NULL, ?)`
      ).run(child.pid, new Date().toISOString(), fingerprint);
      db.close();

      const acquiring = acquireRunLease('new-run', lockPath).catch((error: unknown) => error);
      // The acquisition is now awaiting the reap it started — its first await.
      pending = registerDeploymentPending('deployment:test', lockPath);
      const refused = await acquiring;

      expect(refused).toBeInstanceOf(RunLockBusyError);
      expect((refused as RunLockBusyError).condition).toBe('pending');
      expect((refused as RunLockBusyError).owner?.runId).toBe('deployment:test');
      expect((refused as RunLockBusyError).recovered).toEqual({ runId: 'orphaned-run', childPgid: child.pid });
      expect((refused as Error).message).toMatch(/orphaned-run \(group \d+\) was already reaped/);
      expect(() => process.kill(-child.pid!, 0)).toThrow();
    } finally {
      pending?.release();
      forceKillTestProcessTree(child.pid);
    }
  }, 15_000);
});
