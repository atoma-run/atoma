import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deploymentBlockers,
  watchDeploymentParent,
  waitForDeploymentSlot,
  type DeploymentBlockerFacts,
} from '../src/cli/deploy-preflight.js';
import {
  acquireRunLease,
  acquireRunLeaseWithoutRecovery,
  peekDeploymentPending,
  peekRunLease,
  processFingerprint,
  type RunLockBusyError,
} from '../src/mcp/runLock.js';
import { requestWaitsForDeployment } from '../src/viz/deployment.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atoma-deploy-preflight-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deployment preflight', () => {
  it('is clear without a store or run lease', () => {
    const root = temporaryRoot();
    expect(
      deploymentBlockers({
        dbPath: join(root, 'absent.db'),
        runLockPath: join(root, 'absent-lock.db'),
      })
    ).toEqual([]);
  });

  it('reads runtime state without repairing or rewriting it', () => {
    const root = temporaryRoot();
    const dbPath = join(root, 'atoma.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE project_runs (status TEXT NOT NULL);
      CREATE TABLE project_run_preview_instances (state TEXT NOT NULL);
      INSERT INTO project_runs VALUES ('running'), ('delivered');
      INSERT INTO project_run_preview_instances VALUES ('ready'), ('stopped');
    `);
    db.close();

    expect(
      deploymentBlockers({ dbPath, runLockPath: join(root, 'absent-lock.db') })
    ).toEqual(['1 project run(s) are queued or running', '1 result preview(s) still own runtime']);

    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT COUNT(*) AS n FROM project_runs').get() as { n: number }).n).toBe(2);
    expect(
      (after.prepare('SELECT COUNT(*) AS n FROM project_run_preview_instances').get() as { n: number }).n
    ).toBe(2);
    after.close();
  });
});

describe('deployment admission marker', () => {
  it('keeps reads up and pauses every mutating request plus stateful OAuth callbacks', () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'deploy.lock');
    writeFileSync(lockPath, 'deploying\n');
    const env = { ATOMA_DEPLOY_LOCK_PATH: lockPath };

    expect(requestWaitsForDeployment('GET', '/', env)).toBe(false);
    expect(requestWaitsForDeployment('GET', '/api/projects', env)).toBe(false);
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(true);
    expect(requestWaitsForDeployment('POST', '/webhooks/github', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/login', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/callback', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/oauth/authorize', env)).toBe(true);
    expect(requestWaitsForDeployment('POST', '/oauth/token', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/.well-known/oauth-authorization-server', env)).toBe(false);
    expect(requestWaitsForDeployment('GET', '/auth/github/connect', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/github/authorize', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/github/setup', env)).toBe(true);
    expect(requestWaitsForDeployment('GET', '/auth/whoami', env)).toBe(false);
  });

  it('changes nothing when the deployment marker is absent', () => {
    const root = temporaryRoot();
    const env = { ATOMA_DEPLOY_LOCK_PATH: join(root, 'absent.lock') };
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(false);
  });
});

describe('deployment preflight, publications', () => {
  it('waits for a publication in flight, which a restart would fail', () => {
    const root = temporaryRoot();
    const dbPath = join(root, 'atoma.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE project_publications (status TEXT NOT NULL);
      INSERT INTO project_publications VALUES ('publishing'), ('published'), ('failed');
    `);
    db.close();
    expect(deploymentBlockers({ dbPath, runLockPath: join(root, 'absent-lock.db') })).toEqual([
      '1 publication(s) are uploading',
    ]);
  });
});

/**
 * A DEPLOYMENT THAT WAITS (2026-09-27): refusing whenever the slot was busy
 * made every deployment bet on a gap, and the mender left none — two
 * deployments in a row were refused. These drive `waitForDeploymentSlot` on a
 * fake clock against a real lease store. POSIX only: waiting needs a birth
 * identity for the guard, which Windows cannot give.
 */
const posixIt = it.skipIf(process.platform === 'win32');
const NOTHING: DeploymentBlockerFacts = { lease: null, projectRuns: 0, previews: 0, publications: 0 };

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 0;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

it.skipIf(process.platform !== 'linux')('the fallback marker expires with its actual shell writer', async () => {
  const root = temporaryRoot();
  const marker = join(root, 'freeze');
  const script = readFileSync('deploy/host-deploy.sh', 'utf8');
  const start = script.indexOf('    PARENT_STAT=');
  const end = script.indexOf('\n  fi', start);
  const child = spawn('bash', ['-c', `set -e; MARKER_PATH="$1"; ${script.slice(start, end)}; echo ready; read -r release`, 'test', marker],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolveReady, reject) => {
      child.once('error', reject); child.stdout.once('data', () => resolveReady());
      child.once('exit', code => reject(new Error(`writer exited ${code}`)));
    });
    const alive = watchDeploymentParent(child.pid!);
    expect(alive()).toBe(true);
    expect(readFileSync(marker, 'utf8').trim()).toBe(`guard ${child.pid} ${processFingerprint(child.pid!)}`);
    expect(requestWaitsForDeployment('POST', '/api/projects', { ATOMA_DEPLOY_LOCK_PATH: marker })).toBe(true);
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.stdin.end('release\n');
    await exited;
    expect(alive()).toBe(false);
    expect(requestWaitsForDeployment('POST', '/api/projects', { ATOMA_DEPLOY_LOCK_PATH: marker })).toBe(false);
  } finally { child.kill(); }
});

describe('a deployment that waits for running work', () => {
  posixIt('waits for the holder, refuses new takers meanwhile, then freezes writes and re-reads before it is ready', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    const marker = join(root, 'deploy.lock');
    const holder = acquireRunLeaseWithoutRecovery('mender:busy', lockPath);
    const clock = fakeClock();
    const progress: string[] = [];
    let sleeps = 0;
    let refusedMeanwhile: unknown;
    let factsRead = 0;
    const result = await waitForDeploymentSlot(
      { runLockPath: lockPath, waitMs: 60_000, admissionMarker: marker, parentPid: process.pid },
      {
        now: clock.now,
        sleep: async (ms) => {
          sleeps += 1;
          clock.advance(ms);
          if (sleeps === 1) {
            refusedMeanwhile = await acquireRunLease('project:new', lockPath).catch((error: unknown) => error);
          }
          if (sleeps === 3) holder.release();
        },
        facts: () => {
          factsRead += 1;
          return NOTHING;
        },
        progress: (line) => progress.push(line),
      }
    );
    try {
      expect(result.kind).toBe('ready');
      expect((refusedMeanwhile as RunLockBusyError).condition).toBe('pending');
      expect(progress[0]).toMatch(/^deployment waiting 0s for mender:busy \(holding the run slot since /);
      // Frozen once clear, then read again after the settle.
      expect(factsRead).toBe(2);
      // The freeze names its writer, so a leftover one cannot freeze writes forever.
      expect(readFileSync(marker, 'utf8')).toBe(`guard ${process.pid} ${processFingerprint(process.pid)}\n`);
      // Renamed into place, never written half-way where a reader looks.
      expect(existsSync(`${marker}.${process.pid}.partial`)).toBe(false);
      expect(peekRunLease(lockPath)?.runId).toBe(`deployment:${process.pid}`);
      // Ready withdraws the announcement: the lease alone keeps takers out now.
      expect(peekDeploymentPending(lockPath)).toBeNull();
    } finally {
      if (result.kind === 'ready') result.lease.release();
      holder.release();
    }
  });

  posixIt('lifts the freeze when a preview slipped in before it, and waits for that preview', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    const marker = join(root, 'deploy.lock');
    const clock = fakeClock();
    const answers: DeploymentBlockerFacts[] = [NOTHING, { ...NOTHING, previews: 1 }, { ...NOTHING, previews: 1 }, NOTHING, NOTHING];
    let reads = 0;
    let last = NOTHING;
    const frozenWhilePreviewLive: boolean[] = [];
    const result = await waitForDeploymentSlot(
      { runLockPath: lockPath, waitMs: 60_000, admissionMarker: marker, parentPid: process.pid },
      {
        now: clock.now,
        sleep: async (ms) => {
          clock.advance(ms);
          if (last.previews > 0) frozenWhilePreviewLive.push(existsSync(marker));
        },
        facts: () => {
          last = answers[Math.min(reads, answers.length - 1)]!;
          reads += 1;
          return last;
        },
        progress: () => {},
      }
    );
    try {
      expect(result.kind).toBe('ready');
      expect(frozenWhilePreviewLive).toEqual([false, false]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (result.kind === 'ready') result.lease.release();
    }
  });

  posixIt('refuses at its deadline and leaves the slot exactly as it found it', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    const marker = join(root, 'deploy.lock');
    const holder = acquireRunLeaseWithoutRecovery('project:long', lockPath);
    const clock = fakeClock();
    try {
      const result = await waitForDeploymentSlot(
        { runLockPath: lockPath, waitMs: 5_000, admissionMarker: marker, parentPid: process.pid },
        { now: clock.now, sleep: async (ms) => clock.advance(ms), facts: () => NOTHING, progress: () => {} }
      );
      expect(result).toEqual({ kind: 'refused', reason: expect.stringMatching(/^waited 5s and project:long .* is still there$/) });
      expect(peekDeploymentPending(lockPath)).toBeNull();
      expect(existsSync(marker)).toBe(false);
      expect(peekRunLease(lockPath)?.runId).toBe('project:long');
    } finally {
      holder.release();
    }
  });

  posixIt('refuses at once, and recovers nothing, when a gone owner may still have a run behind it', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    acquireRunLeaseWithoutRecovery('warm-up', lockPath).release();
    // The orphaned run's group is ALIVE: its server died, it did not.
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      orphan.once('spawn', resolveSpawn);
      orphan.once('error', rejectSpawn);
    });
    try {
      const db = new Database(lockPath);
      db.prepare(
        `INSERT INTO mcp_run_lease (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
         VALUES (1, 'dead', 'project:orphaned', 99999999, ?, '2026-01-01T00:00:00.000Z')`
      ).run(orphan.pid);
      db.close();
      const result = await waitForDeploymentSlot(
        { runLockPath: lockPath, waitMs: 60_000, admissionMarker: join(root, 'deploy.lock'), parentPid: process.pid },
        { sleep: async () => { throw new Error('must not wait'); }, facts: () => NOTHING, progress: () => {} }
      );
      expect(result).toEqual({ kind: 'refused', reason: expect.stringMatching(/project:orphaned whose owner process is gone but whose run may survive/) });
      expect(peekRunLease(lockPath)?.runId).toBe('project:orphaned');
      expect(peekDeploymentPending(lockPath)).toBeNull();
    } finally {
      try { process.kill(-orphan.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  posixIt('takes over at once a slot a killed stage left behind, and says so', async () => {
    // 2026-09-27: a mender killed with SIGKILL left its row, which refused two
    // deployments until a person deleted it. It recorded no process group.
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    acquireRunLeaseWithoutRecovery('warm-up', lockPath).release();
    const db = new Database(lockPath);
    db.prepare(
      `INSERT INTO mcp_run_lease (singleton, token, run_id, owner_pid, child_pgid, acquired_at)
       VALUES (1, 'dead', 'mender:killed', 99999999, NULL, '2026-01-01T00:00:00.000Z')`
    ).run();
    db.close();
    const progress: string[] = [];
    const clock = fakeClock();
    const result = await waitForDeploymentSlot(
      { runLockPath: lockPath, waitMs: 60_000, admissionMarker: join(root, 'deploy.lock'), parentPid: process.pid },
      { now: clock.now, sleep: async (ms) => clock.advance(ms), facts: () => NOTHING, progress: (line) => progress.push(line) }
    );
    try {
      expect(result.kind).toBe('ready');
      expect(progress).toContain('reclaimed the run slot from mender:killed (its owner, pid 99999999, is gone or recycled, and nothing it started survives)');
      expect(peekRunLease(lockPath)?.runId).toBe(`deployment:${process.pid}`);
    } finally {
      if (result.kind === 'ready') result.lease.release();
    }
  });

  posixIt('refuses at once for a campaign that runs for hours, and for run rows nothing drives', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    const plan = { runLockPath: lockPath, waitMs: 60_000, admissionMarker: join(root, 'deploy.lock'), parentPid: process.pid };
    const mustNotWait = { sleep: async () => { throw new Error('must not wait'); }, progress: () => {} };
    const campaign = acquireRunLeaseWithoutRecovery('retrieval:round-7', lockPath);
    try {
      const result = await waitForDeploymentSlot(plan, { ...mustNotWait, facts: () => NOTHING });
      expect(result).toEqual({ kind: 'refused', reason: expect.stringMatching(/retrieval:round-7 holds the run slot and runs for hours/) });
    } finally {
      campaign.release();
    }
    // Holding the slot itself, the guard knows no run can be driving these.
    const orphans = await waitForDeploymentSlot(plan, { ...mustNotWait, facts: () => ({ ...NOTHING, projectRuns: 2 }) });
    expect(orphans).toEqual({ kind: 'refused', reason: expect.stringMatching(/^2 project run\(s\) are marked queued or running while no run holds the slot/) });
    expect(peekRunLease(lockPath)).toBeNull();
    expect(peekDeploymentPending(lockPath)).toBeNull();
  });

  posixIt('gives up as soon as the activator does, or is gone', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    const releaseFile = join(root, 'release');
    const holder = acquireRunLeaseWithoutRecovery('mender:busy', lockPath);
    try {
      const plan = { runLockPath: lockPath, waitMs: 60_000, admissionMarker: join(root, 'deploy.lock'), parentPid: process.pid, releaseFile };
      const cancelled = await waitForDeploymentSlot(plan, {
        sleep: async () => writeFileSync(releaseFile, ''),
        facts: () => NOTHING,
        progress: () => {},
      });
      expect(cancelled).toEqual({ kind: 'refused', reason: 'the deployment that started this guard gave up waiting' });
      rmSync(releaseFile);
      const orphaned = await waitForDeploymentSlot(plan, { parentAlive: () => false, facts: () => NOTHING, progress: () => {} });
      expect(orphaned).toEqual({ kind: 'refused', reason: 'the deployment that started this guard is gone' });
      expect(peekDeploymentPending(lockPath)).toBeNull();
    } finally {
      holder.release();
    }
  });

  it('advertises waiting in its usage, which the activator probes before asking for it', () => {
    const usage = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/deploy-preflight.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(usage.status).toBe(0);
    expect(usage.stdout).toContain('--wait-ms');
  }, 60_000);

  posixIt('as a process: lets nothing new in, waits for the holder, then hands over behind a named freeze', async () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'lock.db');
    const ready = join(root, 'ready');
    const release = join(root, 'release');
    const marker = join(root, 'deploy.lock');
    const holder = acquireRunLeaseWithoutRecovery('mender:busy', lockPath);
    const child = spawn(
      process.execPath,
      [
        '--import', 'tsx', 'src/cli/deploy-preflight.ts',
        '--hold', '--wait-ms', '60000', '--parent-pid', String(process.pid),
        '--ready-file', ready, '--release-file', release, '--admission-marker', marker,
        '--run-lock', lockPath, '--db', join(root, 'absent.db'),
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolveExit) => child.once('exit', (code) => resolveExit(code)));
    try {
      await waitFor(() => peekDeploymentPending(lockPath) !== null, 30_000, `the announcement (${stderr})`);
      await expect(acquireRunLease('project:new', lockPath)).rejects.toThrow(/a deployment is waiting/);
      expect(existsSync(ready)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      // Publishing the announcement precedes checking the current holder.
      // Keep that holder until the child has actually observed it, otherwise
      // the handover can succeed without ever entering the waiting branch.
      await waitFor(
        () => /deployment waiting \d+s for mender:busy/.test(stdout),
        30_000,
        `the holder observation (${stderr})`
      );
      holder.release();
      await waitFor(() => existsSync(ready), 30_000, `readiness (${stderr})`);
      expect(readFileSync(marker, 'utf8').startsWith(`guard ${child.pid} `)).toBe(true);
      expect(peekRunLease(lockPath)?.runId).toBe(`deployment:${child.pid}`);
      expect(stdout).toMatch(/deployment waiting \d+s for mender:busy/);
      writeFileSync(release, '');
      expect(await exited).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(peekRunLease(lockPath)).toBeNull();
      expect(peekDeploymentPending(lockPath)).toBeNull();
    } finally {
      holder.release();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 90_000);
});

describe('deployment admission marker, named', () => {
  posixIt('stops freezing writes once the guard that wrote it is gone', () => {
    const root = temporaryRoot();
    const lockPath = join(root, 'deploy.lock');
    const env = { ATOMA_DEPLOY_LOCK_PATH: lockPath };
    writeFileSync(lockPath, `guard ${process.pid} ${processFingerprint(process.pid)}\n`);
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(true);
    // Left by a guard killed mid-deployment, or by a reboot.
    writeFileSync(lockPath, 'guard 99999999 linux:gone:1\n');
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(false);
    // An unnamed marker (an activator's own) still pauses for as long as it
    // exists — and so does a note a person wrote into one by hand.
    writeFileSync(lockPath, 'deploying\n');
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(true);
    writeFileSync(lockPath, '1 maintenance\n');
    expect(requestWaitsForDeployment('POST', '/api/projects/p/runs', env)).toBe(true);
  });
});
