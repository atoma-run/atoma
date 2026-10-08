import { spawnSync } from 'node:child_process';
import { PlatformSettingsStore } from '../src/platform/settings.js';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { applyRetention, assertRetentionPath, retentionPlan } from '../src/projects/retention.js';
import { ProjectRunCoordinator, projectRunHostLayout } from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { rmSync } from 'node:fs';
import { acquireRunLease, peekRunLeases, registerDeploymentPending } from '../src/mcp/runLock.js';
import { haystackTestEnvironment } from './helpers/haystack.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

const roots: string[] = [];
afterEach(() => {
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  // realpath: retention refuses a symlinked ancestor, and macOS resolves
  // tmpdir() through /var -> private/var. A deployment root is a real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-maintenance-')));
  roots.push(root);
  return projectRetrievalFixture(root);
}

describe('organisation run admission', () => {
  it.each([10, 12])('runs %i clients and applies live capacity changes without cancelling existing runs', async (limit) => {
    const f = fixture();
    const settings = PlatformSettingsStore.open(f.dbPath);
    if (limit !== 10) settings.set({ 'run.concurrentMax': limit }, null);
    const clients = [f, ...Array.from({ length: limit }, (_, index) =>
      projectRetrievalFixture(f.root, { subject: `client-${index}`, slug: `client-${index}` }))];
    const lockPath = join(f.root, 'lease.db');
    const driver = vi.fn((options: Parameters<typeof import('../src/cli/burnin.js').spawnRun>[0]) =>
      new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }));
    const coordinator = new ProjectRunCoordinator({
      store: f.projects, dbPath: f.dbPath, projectsRoot: f.root,
      hostEnv: { ...haystackTestEnvironment(f.root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'test-key' },
      driver, acquireLease: (id, scope) => acquireRunLease(id, lockPath, scope),
    });
    const start = (index: number, goal = 'Build a clock') => {
      const client = clients[index]!;
      return coordinator.start({ orgId: client.viewer.orgId, principalId: client.viewer.principalId,
        projectId: client.project.projectId, request: { goal, idempotencyKey: randomUUID() } });
    };
    try {
      const runs = await Promise.all(clients.slice(0, limit).map((_, index) => start(index)));
      await vi.waitFor(() => expect(driver).toHaveBeenCalledTimes(limit));
      expect(new Set(runs.map((run) => run.hostPaths.workspacePath)).size).toBe(limit);
      expect(new Set(runs.map((run) => run.hostPaths.runsPath)).size).toBe(limit);
      expect(peekRunLeases(lockPath)).toHaveLength(limit);
      expect((await start(0)).projectRunId).toBe(runs[0]!.projectRunId);
      await expect(start(0, 'A different goal')).rejects.toThrow(/still in progress/);
      const queued = await start(limit);
      expect(queued.status).toBe('queued');
      expect(queued.startedAt).toBeNull();
      settings.set({ 'run.concurrentMax': 1 }, null);
      expect(f.projects.runCapacity(f.viewer.orgId).globalMaxConcurrent).toBe(1);
      expect(peekRunLeases(lockPath)).toHaveLength(limit);
      coordinator.cancel(f.viewer.orgId, runs[0]!.projectRunId);
      await vi.waitFor(() => expect(peekRunLeases(lockPath)).toHaveLength(limit - 1));
      for (const client of clients.slice(1, limit)) expect(client.projects.runCapacity(client.viewer.orgId).active).toBe(1);
      expect((await start(limit)).projectRunId).toBe(queued.projectRunId);
      expect(clients[limit]!.projects.getProjectRun(clients[limit]!.viewer.orgId, queued.projectRunId)?.status).toBe('queued');
      settings.set({ 'run.concurrentMax': limit }, null);
      expect(f.projects.runCapacity(f.viewer.orgId).globalMaxConcurrent).toBe(limit);
      coordinator.resumeQueuedRuns();
      await vi.waitFor(() => expect(driver).toHaveBeenCalledTimes(limit + 1));
      expect(peekRunLeases(lockPath)).toHaveLength(limit);
    } finally {
      for (const client of clients) {
        for (const run of client.projects.listProjectRuns(client.viewer.orgId, client.project.projectId) ?? []) {
          coordinator.cancel(client.viewer.orgId, run.projectRunId);
        }
      }
      await coordinator.waitForIdle();
      coordinator.stopQueue();
    }
    expect(peekRunLeases(lockPath)).toEqual([]);
  });

  it.each([false, true])('persists a selected base across process restart and revalidates its bytes (changed=%s)', async changed => {
    const f = fixture();
    const other = projectRetrievalFixture(f.root, { subject: 'waiting-other', slug: 'waiting-other' });
    const selected = other.makeRun({ 'selected.txt': 'saved version' }).run;
    const setBrief = (text: string, version: number) => other.projects.updateProjectContext(other.viewer.orgId, other.project.projectId, other.viewer.principalId,
      { expectedVersion: version, idempotencyKey: randomUUID(), change: { kind: 'set_brief', text, source: { kind: 'client', summary: 'Client request' }, confirmation: 'Client approved.' } });
    setBrief('Original queued guidance', 0);
    PlatformSettingsStore.open(f.dbPath).set({ 'run.concurrentMax': 1 }, null);
    const lockPath = join(f.root, 'queue-lease.db');
    const holder = await acquireRunLease('busy', lockPath, { orgId: randomUUID() });
    const hostEnv = { ...haystackTestEnvironment(f.root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'test-key' };
    const driver = vi.fn(() => Promise.reject(new Error('must not launch here')));
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath,
      projectsRoot: f.root, hostEnv, driver, timeoutMs: 123_000, acquireLease: (id, scope) => acquireRunLease(id, lockPath, scope) });
    try {
      const first = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId,
        projectId: f.project.projectId, request: { goal: 'Cancelled goal', idempotencyKey: randomUUID() } });
      const second = await coordinator.start({ orgId: other.viewer.orgId, principalId: other.viewer.principalId,
        projectId: other.project.projectId, request: { goal: 'Surviving goal', baseRunId: selected.projectRunId, idempotencyKey: randomUUID() } });
      expect(first.status).toBe('queued');
      expect(second.status).toBe('queued');
      expect(second.contextVersion).toBe(1);
      setBrief('New guidance must not reach queued run', 1);
      other.makeRun({ 'newer.txt': 'must not become the selected seed' });
      expect(coordinator.cancel(f.viewer.orgId, first.projectRunId)?.status).toBe('cancelled');
      coordinator.stopQueue();
      holder.release();
      if (changed) writeFileSync(join(selected.hostPaths.workspacePath, 'selected.txt'), 'changed after admission');
      const script = `
        import { ProjectRunCoordinator } from './src/projects/coordinator.ts';
        import { ProjectStore } from './src/projects/store.ts';
        import { acquireRunLease } from './src/mcp/runLock.ts';
        const coordinator = new ProjectRunCoordinator({
          store: ProjectStore.open(${JSON.stringify(f.dbPath)}), dbPath: ${JSON.stringify(f.dbPath)},
          projectsRoot: ${JSON.stringify(f.root)}, hostEnv: ${JSON.stringify(hostEnv)},
          acquireLease: (id, scope) => acquireRunLease(id, ${JSON.stringify(lockPath)}, scope),
          driver: async (options) => { console.log('CONTEXT:' + options.env.ATOMA_PROJECT_CONTEXT); console.log('LAUNCHED:' + options.goal + ':' + options.timeoutMs + ':' + options.extraArgs.join('|')); throw new Error('test driver ended'); },
        });
        coordinator.reconcileInterrupted();
        await coordinator.waitForIdle();
        coordinator.stopQueue();
      `;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 20_000 });
      expect(child.status, child.stderr).toBe(0);
      if (changed) {
        expect(child.stdout).not.toContain('LAUNCHED:');
        expect(other.projects.getProjectRun(other.viewer.orgId, second.projectRunId)?.error).toContain('unavailable or changed');
      } else {
        expect(child.stdout).toContain('LAUNCHED:Surviving goal:123000');
        expect(child.stdout).toContain('Original queued guidance');
        expect(child.stdout).not.toContain('New guidance must not reach queued run');
        expect(child.stdout).toContain('--seed|' + selected.hostPaths.workspacePath);
      }
      expect(child.stdout).not.toContain('LAUNCHED:Cancelled goal');
      expect(driver).not.toHaveBeenCalled();
      expect(f.projects.getProjectRun(f.viewer.orgId, first.projectRunId)?.status).toBe('cancelled');
      expect(other.projects.getProjectRun(other.viewer.orgId, second.projectRunId)?.startedAt).not.toBeNull();
      expect(peekRunLeases(lockPath)).toEqual([]);
    } finally { coordinator.stopQueue(); holder.release(); }
  });

  it('dispatches FIFO, skips cancelled work and rechecks requester permission', async () => {
    const f = fixture();
    const clients = [f, ...Array.from({ length: 3 }, (_, index) =>
      projectRetrievalFixture(f.root, { subject: `fifo-${index}`, slug: `fifo-${index}` }))];
    PlatformSettingsStore.open(f.dbPath).set({ 'run.concurrentMax': 1 }, null);
    const lockPath = join(f.root, 'fifo-lease.db');
    const holder = await acquireRunLease('busy', lockPath, { orgId: randomUUID() });
    const launched: string[] = [];
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: f.root,
      hostEnv: { ...haystackTestEnvironment(f.root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'test-key' },
      queuedRunAllowed: id => id !== clients[1]!.viewer.principalId,
      acquireLease: (id, scope) => acquireRunLease(id, lockPath, scope),
      driver: async options => { launched.push(options.goal); throw new Error('test driver ended'); } });
    try {
      const runs = [];
      for (const [index, client] of clients.entries()) {
        runs.push(await coordinator.start({ orgId: client.viewer.orgId, principalId: client.viewer.principalId,
          projectId: client.project.projectId, request: { goal: `Goal ${index}`, idempotencyKey: randomUUID() } }));
      }
      coordinator.cancel(clients[2]!.viewer.orgId, runs[2]!.projectRunId);
      const deployment = registerDeploymentPending('deployment:test', lockPath);
      try {
        holder.release();
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(launched).toEqual([]);
        expect(f.projects.listQueuedRuns()).toHaveLength(3);
      } finally { deployment.release(); }
      await coordinator.waitForIdle();
      expect(launched).toEqual(['Goal 0', 'Goal 3']);
      expect(f.projects.getProjectRun(clients[1]!.viewer.orgId, runs[1]!.projectRunId)?.error).toContain('permission');
    } finally { coordinator.stopQueue(); holder.release(); }
  });

  it('defaults to one, persists suspension, and refuses before acquiring a lease', async () => {
    const f = fixture();
    expect(f.projects.runCapacity(f.viewer.orgId)).toEqual({ active: 0, maxConcurrent: 1, globalMaxConcurrent: 10 });
    f.projects.setRunLimit(f.viewer.orgId, 0);
    expect(ProjectStore.open(f.dbPath).runCapacity(f.viewer.orgId).maxConcurrent).toBe(0);
    expect(() => f.projects.setRunLimit(f.viewer.orgId, 2)).toThrow();
    const acquireLease = vi.fn(() => { throw new Error('must not acquire'); });
    const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath,
      projectsRoot: f.root, skillsDir: join(f.root, 'skills'), hostEnv: {}, acquireLease });
    await expect(coordinator.start({ orgId: f.viewer.orgId, projectId: f.project.projectId,
      principalId: f.viewer.principalId, request: { idempotencyKey: randomUUID(), goal: 'Build' } })).rejects.toThrow('suspended');
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it('reserves under the store transaction, preserving retries and other organisations', () => {
    const f = fixture();
    const first = f.makeRun();
    const g = projectRetrievalFixture(f.root, { subject: 'other', slug: 'other' });
    expect(g.projects.runCapacity(g.viewer.orgId).active).toBe(0);
    const request = { idempotencyKey: first.run.requestKey, goal: first.run.goal };
    f.projects.setRunLimit(f.viewer.orgId, 0);
    const input = { orgId: f.viewer.orgId, projectId: f.project.projectId, principalId: f.viewer.principalId,
      request, hostPaths: first.run.hostPaths, enforceCapacity: true };
    expect(f.projects.createProjectRun(input)?.created).toBe(false);
    expect(() => f.projects.createProjectRun({ ...input, request: { ...request, idempotencyKey: randomUUID() } })).toThrow('suspended');
    f.projects.setRunLimit(f.viewer.orgId, 1);
    expect(() => f.projects.createProjectRun({ ...input, request: { ...request, idempotencyKey: randomUUID() } })).toThrow('limit reached');
  });
});

describe('offline run retention', () => {
  it('plans without deleting, protects the seed, deletes bytes with receipts and preserves run metadata', () => {
    const f = fixture();
    const old = f.makeRun({ 'old.txt': 'old' });
    const head = f.makeRun({ 'head.txt': 'head' });
    const db = new Database(f.dbPath);
    try {
      db.prepare('UPDATE project_runs SET created_at = ?, ended_at = ? WHERE project_run_id = ?')
        .run('2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z', old.run.projectRunId);
      db.prepare('UPDATE project_runs SET created_at = ?, ended_at = ? WHERE project_run_id = ?')
        .run('2025-02-01T00:00:00.000Z', '2025-02-02T00:00:00.000Z', head.run.projectRunId);
      const now = new Date('2026-09-20T00:00:00Z');
      const plan = retentionPlan(db, f.root, undefined, now);
      expect(plan.find(row => row.runId === head.run.projectRunId)?.held).toBe('current project seed');
      expect(existsSync(old.layout.workspacePath)).toBe(true);
      expect(() => applyRetention(db, f.root, undefined, () => null, now)).toThrow('audit unavailable');
      expect(existsSync(old.layout.workspacePath)).toBe(true);
      const log = PlatformEventLog.open(f.dbPath);
      expect(applyRetention(db, f.root, undefined, event => log.append(event), now)).toBe(1);
      expect(existsSync(old.layout.runRoot)).toBe(false);
      expect(existsSync(head.layout.workspacePath)).toBe(true);
      const receipt = f.projects.getProjectRun(f.viewer.orgId, old.run.projectRunId)!;
      expect(receipt.status).toBe('delivered');
      expect(receipt.artifactManifestHash).toBe(old.run.artifactManifestHash);
      expect(receipt.bytesExpiredAt).toBe(now.toISOString());
      expect(log.list().events.filter(event => event.kind === 'run.retention')).toHaveLength(2);
      expect(applyRetention(db, f.root, undefined, event => log.append(event), now)).toBe(0);
    } finally { db.close(); }
  });

  it('expires the separate launcher projection at the cutoff and keeps the shared catalogue', () => {
    const f = fixture();
    const runId = randomUUID();
    const workspaceRoot = join(f.root, 'launcher-workspaces');
    const layout = projectRunHostLayout(f.root, f.viewer.orgId, f.project.projectId, runId, workspaceRoot);
    f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId,
      principalId: f.viewer.principalId, projectRunId: runId,
      request: { idempotencyKey: runId, goal: 'Retention fixture' },
      hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath,
        logPath: layout.logPath, skillsPath: join(f.root, 'shared-skills') } });
    mkdirSync(layout.workspacePath, { recursive: true });
    writeFileSync(join(layout.workspacePath, 'result.txt'), 'result');
    mkdirSync(join(f.root, 'shared-skills'), { recursive: true });
    writeFileSync(join(f.root, 'shared-skills', 'keep.txt'), 'knowledge');
    const now = new Date('2026-09-20T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const db = new Database(f.dbPath);
    try {
      db.prepare("UPDATE project_runs SET status = 'failed', ended_at = ? WHERE project_run_id = ?")
        .run(cutoff, runId);
      expect(retentionPlan(db, f.root, workspaceRoot, new Date(now.getTime() - 1))).toHaveLength(0);
      expect(retentionPlan(db, f.root, workspaceRoot, now)).toHaveLength(1);
      const log = PlatformEventLog.open(f.dbPath);
      expect(applyRetention(db, f.root, workspaceRoot, event => log.append(event), now)).toBe(1);
      expect(existsSync(layout.workspacePath)).toBe(false);
      expect(existsSync(join(f.root, 'shared-skills', 'keep.txt'))).toBe(true);
    } finally { db.close(); }
  });

  it('refuses live work and forged paths before deleting anything', () => {
    const f = fixture();
    const run = f.makeRun();
    const db = new Database(f.dbPath);
    try {
      expect(() => applyRetention(db, f.root, undefined, () => null)).toThrow('idle services');
      expect(() => assertRetentionPath(f.root, join(f.root, '..', 'outside'))).toThrow('escapes root');
      db.prepare("UPDATE project_runs SET status = 'failed', ended_at = '2025-01-01T00:00:00.000Z' WHERE project_run_id = ?")
        .run(run.run.projectRunId);
      const forgedId = randomUUID();
      f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId,
        principalId: f.viewer.principalId, projectRunId: forgedId,
        request: { idempotencyKey: forgedId, goal: 'Unrecognised legacy layout' },
        hostPaths: { ...run.run.hostPaths, workspacePath: join(f.root, 'other') } });
      db.prepare("UPDATE project_runs SET status = 'failed', ended_at = '2025-01-01T00:00:00.000Z' WHERE project_run_id = ?")
        .run(forgedId);
      expect(() => retentionPlan(db, f.root)).toThrow('unrecognised run layout');
    } finally { db.close(); }
  });

  it.skipIf(process.platform === 'win32')('refuses symlink ancestors', () => {
    const f = fixture();
    symlinkSync(tmpdir(), join(f.root, 'redirect'));
    expect(() => assertRetentionPath(f.root, join(f.root, 'redirect', 'child'))).toThrow('symlinks');
  });
});


it('retains the accepted reference and a queued explicit base despite newer candidates', () => {
  const f = fixture();
  const accepted = f.makeRun({ 'app.txt': 'accepted' }).run;
  const selected = f.makeRun({ 'app.txt': 'selected draft' }).run;
  f.makeRun({ 'app.txt': 'newer candidate' });
  f.projects.acceptDelivery(f.viewer.orgId, accepted.projectRunId, f.viewer.principalId,
    { manifestHash: accepted.artifactManifestHash!, review: 'Tested' });
  const id = randomUUID();
  const layout = projectRunHostLayout(f.root, f.viewer.orgId, f.project.projectId, id);
  f.projects.createProjectRun({ orgId: f.viewer.orgId, projectId: f.project.projectId,
    principalId: f.viewer.principalId, projectRunId: id,
    request: { goal: 'Iterate', idempotencyKey: id, baseRunId: selected.projectRunId },
    hostPaths: { workspacePath: layout.workspacePath, runsPath: layout.runsPath, logPath: layout.logPath } });
  const db = new Database(f.dbPath);
  try {
    db.prepare("UPDATE project_runs SET created_at='2025-01-01T00:00:00Z', ended_at='2025-01-02T00:00:00Z' WHERE status='delivered'").run();
    const plan = retentionPlan(db, f.root, undefined, new Date('2026-10-08T00:00:00Z'));
    expect(plan.find(row => row.runId === accepted.projectRunId)?.held).toBe('accepted project reference');
    expect(plan.find(row => row.runId === selected.projectRunId)?.held).toBe('active iteration base');
    expect(() => db.prepare('UPDATE project_runs SET base_run_id=NULL WHERE project_run_id=?').run(id)).toThrow('immutable');
  } finally { db.close(); }
});
