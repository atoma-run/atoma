import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  acquireRunLease,
  acquireRunLeaseWithoutRecovery,
  peekDeploymentPending,
  peekRunLease,
  processFingerprint,
  registerDeploymentPending,
  RunLockBusyError,
  runLeaseOwnerGone,
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

  it('lets a deployment claim only an empty slot and never recover a stale owner', async () => {
    seedStale('unfinished-run');

    expect(() => acquireRunLeaseWithoutRecovery('deployment:revision', lockPath)).toThrow(
      /will not recover or interrupt/
    );
    expect(peekRunLease(lockPath)?.runId).toBe('unfinished-run');

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

  it('tells a gone lease owner apart from a live one, without touching either', async () => {
    expect(runLeaseOwnerGone(lockPath)).toBe(false);
    const db = new Database(lockPath);
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO mcp_run_lease (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
       VALUES (1, 'dead', 'mender:gone', 99999999, NULL, '2026-01-01T00:00:00.000Z')`
    ).run();
    db.close();
    expect(runLeaseOwnerGone(lockPath)).toBe(true);
    expect(peekRunLease(lockPath)?.runId).toBe('mender:gone');
    const cleared = new Database(lockPath);
    cleared.prepare('DELETE FROM mcp_run_lease').run();
    cleared.close();
    const lease = await acquireRunLease('project:live', lockPath);
    expect(runLeaseOwnerGone(lockPath)).toBe(false);
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
