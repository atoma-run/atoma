import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type Viewer } from '../src/auth/store.js';
import { COMPUTE_RESULTS_STALLED_MESSAGE, COMPUTE_RESULTS_WAITING_MESSAGE } from '../src/contracts/computeDevice.js';
import { computeProjectViewSchema } from '../src/contracts/computeProject.js';
import { runProgressSchema, runReviewSchema } from '../src/contracts/clientExperience.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { ComputeDispatcher, ComputeDispatchPendingError, ComputeDispatchStore } from '../src/projects/computeDispatch.js';
import { ComputeDeviceStore } from '../src/projects/computeDevices.js';
import type { ComputeConnection } from '../src/projects/computeConnection.js';
import { callExecutor, serveExecutor } from '../src/projects/executorTransport.js';
import {
  ComputeFinalizationWaiting,
  ComputeResultsWaitingConflict,
  ProjectRunCoordinator,
  RESULTS_WAITING_NOTICE_MS,
  projectRunHostLayout,
  resultsWaitingEventInput,
  type ComputeResultsWaitingEvent,
} from '../src/projects/coordinator.js';
import { ProjectHttpError, ProjectService } from '../src/projects/service.js';
import { ProjectStateConflict, ProjectStore } from '../src/projects/store.js';
import { notificationTray } from '../src/viz/push/tray.js';
import { haystackTestEnvironment } from './helpers/haystack.js';

/**
 * A Compute run whose runner ended while its files wait on the customer's
 * computer (run 40c20c5d sat 4.5 hours reading "in progress"). Everything here
 * goes through the real store, transfer journal, lease store, coordinator,
 * project service and notification tray; nothing is mocked but the clock.
 */

const roots: string[] = [];
let lockPath = '';

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-results-waiting-lock-'));
  roots.push(root);
  lockPath = join(root, 'mcp-run-lock.db');
  vi.stubEnv('ATOMA_MCP_RUN_LOCK', lockPath);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-results-waiting-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const owner = auth.completeLogin({ provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false }, null)!.viewer;
  const invitation = auth.createInvitation({ orgId: owner.orgId, token: 'member-invitation', role: 'org:member', ttlMs: 60_000 });
  const member = auth.completeLogin({ provider: 'github', subject: 'member', displayName: 'Member', email: null, emailVerified: false },
    invitation.tokenHash)!.viewer;
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({ orgId: owner.orgId, principalId: owner.principalId, project: {
    name: 'Clock', slug: 'clock', initialPrompt: 'Build a clock.',
    repositoryTarget: { installationId: '123', owner: 'owner', name: 'clock', visibility: 'private' } } });
  const db = new Database(dbPath);
  db.prepare('UPDATE projects SET execution_target_json=? WHERE project_id=?')
    .run(JSON.stringify({ kind: 'customer-device', deviceId: randomUUID() }), project.projectId);
  db.close();
  return { root, dbPath, store, owner, member, project };
}

/** A running Compute run whose transfer journal reached `phase`, as `drive` leaves it. */
function remoteRun(f: ReturnType<typeof fixture>, phase: 'executing' | 'finalizing' = 'finalizing') {
  const runId = randomUUID(), paths = projectRunHostLayout(f.root, f.owner.orgId, f.project.projectId, runId);
  mkdirSync(paths.runsPath, { recursive: true });
  const run = f.store.createProjectRun({ orgId: f.owner.orgId, principalId: f.owner.principalId, projectId: f.project.projectId,
    request: { goal: 'Build the booking page', idempotencyKey: runId }, projectRunId: runId,
    hostPaths: { workspacePath: paths.workspacePath, runsPath: paths.runsPath, logPath: paths.logPath } })!.run;
  f.store.transitionProjectRun({ orgId: f.owner.orgId, projectRunId: runId, from: 'queued', to: 'running' });
  // A trace whose last event is a build step: the trace alone would say "building".
  writeFileSync(join(paths.runsPath, `${runId}.json`), JSON.stringify({ id: runId, endedAt: new Date().toISOString(),
    events: [{ kind: 'tool', ts: Date.now() }] }));
  const journal = ComputeDispatchStore.open(f.dbPath);
  journal.begin(runId, 1);
  if (phase === 'finalizing') {
    writeFileSync(`${paths.logPath}.compute-result`, 'runner result');
    journal.phase(runId, 1, 'finalizing');
  }
  return run;
}

function coordinatorFor(f: ReturnType<typeof fixture>, onComputeResultsWaiting?: (event: ComputeResultsWaitingEvent) => void,
  options: Partial<ConstructorParameters<typeof ProjectRunCoordinator>[0]> = {}) {
  return new ProjectRunCoordinator({ store: f.store, dbPath: f.dbPath, projectsRoot: f.root,
    hostEnv: haystackTestEnvironment(f.root), driver: vi.fn(),
    ...(onComputeResultsWaiting ? { onComputeResultsWaiting } : {}), ...options });
}

/** A selected executor's dispatcher whose transfer stays pending: the computer never sends the files. */
function pendingCompute() {
  // The coordinator reads only these four members of the dispatcher here.
  return () => ({ readiness: vi.fn(), drive: vi.fn(), interruptedStopped: () => false,
    recover: async () => { throw new ComputeDispatchPendingError(true); } }) as never;
}

function serviceFor(f: ReturnType<typeof fixture>, coordinator: ProjectRunCoordinator) {
  return new ProjectService({ store: f.store, coordinator, github: null });
}

describe('a Compute run whose results wait on the customer computer', () => {
  it('reads as finished and waiting, never "in progress", on the run list, the status, the task line and the review', () => {
    const f = fixture(), coordinator = coordinatorFor(f), service = serviceFor(f, coordinator);
    const run = remoteRun(f);
    try {
      const listed = (service.listProjectRuns(f.owner, f.project.projectId) as Array<Record<string, unknown>>)
        .find(row => row['projectRunId'] === run.projectRunId)!;
      expect(listed['status']).toBe('running');
      expect(listed['resultsWaiting']).toEqual({ since: expect.any(String), computerReady: false });
      const status = service.projectRunStatus(f.member, f.project.projectId, run.projectRunId) as Record<string, unknown>;
      const progress = runProgressSchema.parse(status['progress']);
      expect(progress.stage).toBe('awaiting-results');
      expect(progress.message).toBe(COMPUTE_RESULTS_WAITING_MESSAGE);
      expect(progress.message).not.toMatch(/in progress|reconcil|transfer|journal/i);
      // Other members read it too (this is the member's status): never "your computer".
      expect(progress.message).toContain('on the computer that ran it');
      expect(progress.message).toContain('as soon as Atoma Compute is open, connected and accepting work');
      expect(progress.message).not.toMatch(/your computer/i);
      expect(runProgressSchema.parse(service.projectRunState(f.owner, f.project.projectId, run.projectRunId).progress).stage)
        .toBe('awaiting-results');
      expect(runReviewSchema.parse(service.reviewRun(f.owner, f.project.projectId, run.projectRunId)).verification.stage)
        .toBe('awaiting-results');
    } finally { coordinator.stopQueue(); }
  });

  it('is not waiting while a process drives the transfer (a live run lease) or before the runner ended', async () => {
    const f = fixture(), coordinator = coordinatorFor(f), service = serviceFor(f, coordinator);
    const finalizing = remoteRun(f), executing = remoteRun(f, 'executing');
    const held = await acquireRunLease(`project:${finalizing.projectRunId}`, lockPath);
    try {
      for (const run of [finalizing, executing]) {
        const status = service.projectRunStatus(f.owner, f.project.projectId, run.projectRunId) as Record<string, unknown>;
        expect(status['resultsWaiting'], run.projectRunId).toBeNull();
        expect(runProgressSchema.parse(status['progress']).stage).not.toBe('awaiting-results');
      }
      held.release();
      expect(coordinator.computeResultsWaiting(f.store.getProjectRun(f.owner.orgId, finalizing.projectRunId)!)).not.toBeNull();
      // A row that ended is never "waiting", whatever its journal still says.
      f.store.transitionProjectRun({ orgId: f.owner.orgId, projectRunId: finalizing.projectRunId, from: 'running', to: 'failed', error: 'stopped' });
      expect(coordinator.computeResultsWaiting(f.store.getProjectRun(f.owner.orgId, finalizing.projectRunId)!)).toBeNull();
    } finally { held.release(); coordinator.stopQueue(); }
  });

  it('explains a refused start plainly, to the requester and to another member', async () => {
    const f = fixture(), coordinator = coordinatorFor(f), service = serviceFor(f, coordinator);
    const run = remoteRun(f);
    try {
      const refusal = async (viewer: Viewer) => {
        try { await service.startProjectRunFromInput(viewer, f.project.projectId, { goal: 'Next change', idempotencyKey: randomUUID() }); }
        catch (error) { return error; }
        throw new Error('start was admitted');
      };
      const own = await refusal(f.owner);
      expect(own).toBeInstanceOf(ProjectHttpError);
      expect((own as ProjectHttpError).status).toBe(409);
      expect((own as Error).message).toContain('your previous run in Clock is finished, but its results are still on your computer');
      expect((own as Error).message).toContain('They arrive by themselves as soon as Atoma Compute is open, connected and accepting work on that computer');
      // The web maps a typed reason to its own copy; the machine-facing message stays for MCP.
      expect((own as ProjectHttpError).problem.reason).toBe('results-waiting');
      expect((own as Error).message).toContain('"Get the results"');
      expect((own as Error).message).not.toContain('still in progress');
      expect((own as Error).message).toContain(run.projectRunId);
      const other = await refusal(f.member);
      expect((other as Error).message).toContain('a finished run in Clock is waiting for its results from the computer of the person who started it');
      expect((other as Error).message).not.toContain(run.projectRunId);
      expect((other as ProjectHttpError).problem.reason).toBe('others-results-waiting');
      // Its computer connected and accepting work: "open Atoma Compute" is the wrong advice (review 2026-10-25).
      connectDevice(f);
      const stalled = await refusal(f.owner);
      expect((stalled as ProjectHttpError).problem.reason).toBe('results-stalled');
      expect((stalled as Error).message).toContain('its results could not be transferred from your computer yet');
      expect((stalled as Error).message).not.toContain('as soon as Atoma Compute is open');
      const stalledOther = await refusal(f.member);
      expect((stalledOther as ProjectHttpError).problem.reason).toBe('others-results-stalled');
      expect((stalledOther as Error).message).not.toContain('as soon as Atoma Compute is open');
    } finally { coordinator.stopQueue(); }
  });

  it('tells the requester once, after ten minutes, through the journal the tray reads', () => {
    const f = fixture(), journal = PlatformEventLog.open(f.dbPath);
    const notices: ComputeResultsWaitingEvent[] = [];
    const sink = (event: ComputeResultsWaitingEvent) => { notices.push(event); journal.append(resultsWaitingEventInput(event)); };
    const run = remoteRun(f);
    const since = Date.parse(ComputeDispatchStore.open(f.dbPath).inspect(run.projectRunId)!.updatedAt);
    let coordinator = coordinatorFor(f, sink);
    try {
      coordinator.noticeWaitingComputeResults(since + RESULTS_WAITING_NOTICE_MS - 60_000);
      expect(notices).toEqual([]);
      coordinator.noticeWaitingComputeResults(since + RESULTS_WAITING_NOTICE_MS + 60_000);
      expect(notices).toEqual([expect.objectContaining({ projectRunId: run.projectRunId, principalId: f.owner.principalId })]);
      coordinator.noticeWaitingComputeResults(since + RESULTS_WAITING_NOTICE_MS + 10 * 60_000);
      coordinator.stopQueue();
      // A restarted (or newly selected) executor does not tell them again.
      coordinator = coordinatorFor(f, sink);
      coordinator.noticeWaitingComputeResults(since + 2 * RESULTS_WAITING_NOTICE_MS);
      expect(notices).toHaveLength(1);
      const directory = { ownersOf: () => [f.owner.principalId], platformAdmins: () => [], allPrincipals: () => [], membersOf: () => [] };
      const tray = notificationTray({ journal, principalId: f.owner.principalId, directory, locale: 'en' });
      expect(tray.notifications).toEqual([expect.objectContaining({ kind: 'run.results_waiting', runId: run.projectRunId,
        projectId: f.project.projectId, title: 'Atoma — your results are waiting',
        body: '“Build the booking page” is finished. Its results will arrive by themselves as soon as Atoma Compute is open, connected and accepting work on your computer.' })]);
      expect(notificationTray({ journal, principalId: f.member.principalId, directory, locale: 'en' }).notifications).toEqual([]);
    } finally { coordinator.stopQueue(); }
  });

  it('never tells anyone about a run whose transfer a process is driving', async () => {
    const f = fixture(), notices: ComputeResultsWaitingEvent[] = [];
    const run = remoteRun(f);
    const since = Date.parse(ComputeDispatchStore.open(f.dbPath).inspect(run.projectRunId)!.updatedAt);
    const held = await acquireRunLease(`project:${run.projectRunId}`, lockPath);
    const coordinator = coordinatorFor(f, event => notices.push(event));
    try {
      coordinator.noticeWaitingComputeResults(since + 2 * RESULTS_WAITING_NOTICE_MS);
      expect(notices).toEqual([]);
      // Nor did it spend the one claim: once the transfer stops, the notice still comes.
      held.release();
      coordinator.noticeWaitingComputeResults(since + 3 * RESULTS_WAITING_NOTICE_MS);
      expect(notices).toHaveLength(1);
    } finally { held.release(); coordinator.stopQueue(); }
  });
});

/** A paired device for the run's target, connected and accepting work (`compute_devices`). */
function connectDevice(f: ReturnType<typeof fixture>, accepting = true) {
  const target = f.store.getProject(f.owner.orgId, f.project.projectId)!.executionTarget;
  if (target.kind !== 'customer-device') throw new Error('fixture target');
  ComputeDeviceStore.open(f.dbPath, { appVersions: new Set(), imageDigests: new Set() });
  const db = new Database(f.dbPath);
  db.prepare(`INSERT INTO compute_devices (device_id, org_id, principal_id, name, credential_hash, accepting, session_id, lease_until)
    VALUES (?,?,?,?,?,?,?,?)`).run(target.deviceId, f.owner.orgId, f.owner.principalId, 'Laptop', randomUUID(), Number(accepting),
    randomUUID(), Date.now() + 60 * 60_000);
  db.close();
}

describe('results waiting: what each reader is told, and when', () => {
  it('says plainly that the transfer is stuck, not "open Atoma Compute", when the computer is connected and accepting work', () => {
    const f = fixture(), coordinator = coordinatorFor(f), service = serviceFor(f, coordinator);
    const run = f.store.getProjectRun(f.owner.orgId, remoteRun(f).projectRunId)!;
    try {
      connectDevice(f, false);
      // Connected but not accepting work: opening/enabling Atoma Compute is still the remedy.
      expect(coordinator.computeResultsWaiting(run)).toEqual({ since: expect.any(String), computerReady: false });
      const db = new Database(f.dbPath);
      db.prepare('UPDATE compute_devices SET accepting=1').run();
      db.close();
      expect(coordinator.computeResultsWaiting(run)).toEqual({ since: expect.any(String), computerReady: true });
      const status = service.projectRunStatus(f.member, f.project.projectId, run.projectRunId) as Record<string, unknown>;
      const progress = runProgressSchema.parse(status['progress']);
      expect(progress.stage).toBe('awaiting-results');
      expect(progress.message).toBe(COMPUTE_RESULTS_STALLED_MESSAGE);
      expect(progress.message).not.toMatch(/open Atoma Compute|as soon as/i);
    } finally { coordinator.stopQueue(); }
  });

  it('counts the wait from when no driver held the run any more, not from when the runner ended', () => {
    const f = fixture(), notices: ComputeResultsWaitingEvent[] = [];
    const run = f.store.getProjectRun(f.owner.orgId, remoteRun(f).projectRunId)!;
    // The runner ended 40 minutes ago, the transfer was driven for 35 of them
    // and stopped 5 minutes ago: the files have waited 5 minutes, not 40.
    const now = Date.now();
    const db = new Database(f.dbPath);
    db.prepare('UPDATE compute_dispatches SET updated_at=? WHERE run_id=?').run(new Date(now - 40 * 60_000).toISOString(), run.projectRunId);
    db.close();
    const journal = ComputeDispatchStore.open(f.dbPath);
    journal.transferStopped(run.projectRunId);
    const stopped = journal.inspect(run.projectRunId)!.waitingSince;
    // Only the first stop counts: a later automatic attempt does not move the clock.
    journal.transferStopped(run.projectRunId);
    expect(journal.inspect(run.projectRunId)!.waitingSince).toBe(stopped);
    let coordinator = coordinatorFor(f, event => notices.push(event));
    try {
      expect(coordinator.computeResultsWaiting(run)?.since).toBe(stopped);
      coordinator.noticeWaitingComputeResults(Date.parse(stopped) + 5 * 60_000);
      expect(notices).toEqual([]);
      coordinator.stopQueue();
      coordinator = coordinatorFor(f, event => notices.push(event));
      coordinator.noticeWaitingComputeResults(Date.parse(stopped) + RESULTS_WAITING_NOTICE_MS + 1_000);
      expect(notices).toEqual([expect.objectContaining({ projectRunId: run.projectRunId, since: stopped, computerReady: false })]);
    } finally { coordinator.stopQueue(); }
  });

  it('records the stop when a driver lets go of a finished run whose files did not arrive', async () => {
    const f = fixture(), run = remoteRun(f);
    const db = new Database(f.dbPath);
    db.prepare('UPDATE compute_dispatches SET updated_at=? WHERE run_id=?').run('2026-01-01T00:00:00.000Z', run.projectRunId);
    db.close();
    const journal = ComputeDispatchStore.open(f.dbPath);
    const session = { deviceId: randomUUID(), sessionId: randomUUID(), generation: 1 };
    const dispatcher = new ComputeDispatcher({ journal, resources: { cpus: 1, memoryBytes: 1, diskBytes: 1 },
      devices: { currentSession: () => session, assign: () => ({ generation: 2 }) } as unknown as ComputeDeviceStore,
      connectionFor: () => ({ bind: () => Promise.reject(new Error('connection lost')), close: () => undefined }) as unknown as ComputeConnection });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const current = f.store.getProjectRun(f.owner.orgId, run.projectRunId)!;
    await expect(dispatcher.recover(current, join(f.root, 'manifest.json'))).rejects.toBeInstanceOf(ComputeDispatchPendingError);
    expect(journal.inspect(run.projectRunId)!.waitingSince > '2026-01-01T00:00:00.000Z').toBe(true);
  });

  it('tells the requester neutrally when the computer was connected and accepting work', () => {
    const f = fixture(), journal = PlatformEventLog.open(f.dbPath);
    const run = remoteRun(f);
    connectDevice(f);
    const since = Date.parse(ComputeDispatchStore.open(f.dbPath).inspect(run.projectRunId)!.waitingSince);
    const coordinator = coordinatorFor(f, event => { journal.append(resultsWaitingEventInput(event)); });
    try {
      coordinator.noticeWaitingComputeResults(since + RESULTS_WAITING_NOTICE_MS + 1_000);
      const directory = { ownersOf: () => [f.owner.principalId], platformAdmins: () => [], allPrincipals: () => [], membersOf: () => [] };
      const [notice] = notificationTray({ journal, principalId: f.owner.principalId, directory, locale: 'en' }).notifications;
      expect(notice?.body).toBe('“Build the booking page” is finished, but its results could not be transferred from your computer yet. ' +
        'Choose Get the results on the run, or contact support if this continues.');
    } finally { coordinator.stopQueue(); }
  });

  it('labels a project card by what its running runs are doing: all waiting on a computer, or not', () => {
    const f = fixture(), coordinator = coordinatorFor(f), service = serviceFor(f, coordinator);
    const card = () => (service.listProjects(f.owner) as Array<Record<string, unknown>>)
      .find(project => project['projectId'] === f.project.projectId)!;
    const waiting = remoteRun(f);
    try {
      expect(card()).toMatchObject({ hasRunningRun: true, runningRunsAwaitResults: true });
      remoteRun(f, 'executing');
      expect(card()).toMatchObject({ hasRunningRun: true, runningRunsAwaitResults: false });
      f.store.transitionProjectRun({ orgId: f.owner.orgId, projectRunId: waiting.projectRunId, from: 'running', to: 'failed', error: 'x' });
      expect(card()).toMatchObject({ hasRunningRun: true, runningRunsAwaitResults: false });
    } finally { coordinator.stopQueue(); }
  });

  it('names each pending run in Project settings by title and start, with its journal phase', () => {
    const f = fixture(), coordinator = coordinatorFor(f);
    const finished = remoteRun(f), interrupted = remoteRun(f, 'executing');
    try {
      const rows = coordinator.pendingComputeRuns(f.owner.orgId, f.project.projectId, f.owner.principalId);
      expect(computeProjectViewSchema.shape.pendingRuns.parse(rows)).toEqual(rows);
      expect(rows).toEqual(expect.arrayContaining([
        { runId: finished.projectRunId, label: 'Build the booking page', startedAt: expect.any(String), phase: 'finalizing', computerReady: false },
        { runId: interrupted.projectRunId, label: 'Build the booking page', startedAt: expect.any(String), phase: 'executing', computerReady: false },
      ]));
      // Its computer connected and accepting work: the row says the transfer stalled, so Settings
      // can pick the neutral copy (review 2026-10-25). A stopped run has no such story.
      connectDevice(f);
      const ready = coordinator.pendingComputeRuns(f.owner.orgId, f.project.projectId, f.owner.principalId);
      expect(ready.find(row => row.runId === finished.projectRunId)?.computerReady).toBe(true);
      expect(ready.find(row => row.runId === interrupted.projectRunId)?.computerReady).toBe(false);
    } finally { coordinator.stopQueue(); }
  });

  it('types a failed "Get the results": active while a transfer holds the run, else pending', async () => {
    const f = fixture(), coordinator = coordinatorFor(f, undefined, { compute: pendingCompute() });
    const run = remoteRun(f);
    try {
      await expect(coordinator.getComputeResults(f.owner.orgId, run.projectRunId, f.owner.principalId))
        .rejects.toMatchObject({ name: 'ComputeResultsNotYet', reason: 'pending' });
      const held = await acquireRunLease(`project:${run.projectRunId}`, lockPath);
      try {
        await expect(coordinator.getComputeResults(f.owner.orgId, run.projectRunId, f.owner.principalId))
          .rejects.toMatchObject({ name: 'ComputeResultsNotYet', reason: 'active' });
      } finally { held.release(); }
    } finally { coordinator.stopQueue(); }
  });

  // Review 2026-10-25: every failure used to read "make sure Atoma Compute is
  // open", including refusals no computer can change.
  it('keeps the refusals a computer cannot change as they are: access, the project, no dispatcher, no executor', async () => {
    const f = fixture();
    let allowed = true;
    const coordinator = coordinatorFor(f, undefined, { compute: pendingCompute(), queuedRunAllowed: () => allowed });
    const bare = coordinatorFor(f);
    const offline = coordinatorFor(f, undefined, { executorSocket: join(f.root, 'no-executor.sock') });
    const run = remoteRun(f);
    const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (caught: unknown) => caught);
    const get = (c: ProjectRunCoordinator) => refusal(c.getComputeResults(f.owner.orgId, run.projectRunId, f.owner.principalId));
    try {
      allowed = false;
      expect(await get(coordinator)).toMatchObject({ name: 'ProjectStateConflict', message: 'Compute finalization unavailable' });
      allowed = true;
      const setProject = (status: string) => {
        const db = new Database(f.dbPath);
        try { db.prepare('UPDATE projects SET status=? WHERE project_id=?').run(status, f.project.projectId); } finally { db.close(); }
      };
      setProject('archived');
      expect(await get(coordinator)).toMatchObject({ name: 'ProjectStateConflict', message: 'Compute finalization unavailable' });
      setProject('active');
      // A host with no Compute dispatcher, and a frontend whose executor is unreachable.
      expect(await get(bare)).toMatchObject({ name: 'ProjectStateConflict', message: 'Compute run is unavailable' });
      expect(await get(offline)).toMatchObject({ name: 'ProjectRunBusy' });
      for (const c of [bare, offline]) expect(await get(c)).not.toMatchObject({ name: 'ComputeResultsNotYet' });
      // The pending answer still holds once nothing but the computer stands in the way.
      expect(await get(coordinator)).toMatchObject({ name: 'ComputeResultsNotYet', reason: 'pending' });
    } finally { coordinator.stopQueue(); bare.stopQueue(); offline.stopQueue(); }
  });

  it('reads the lease store once per run list, and opens the transfer journal once per coordinator', () => {
    const f = fixture(), coordinator = coordinatorFor(f), service = serviceFor(f, coordinator);
    remoteRun(f); remoteRun(f); remoteRun(f);
    try {
      const leases = vi.spyOn(coordinator, 'liveRunLeases');
      const opened = vi.spyOn(ComputeDispatchStore, 'open');
      service.listProjectRuns(f.owner, f.project.projectId);
      service.listProjectRuns(f.owner, f.project.projectId);
      expect(leases).toHaveBeenCalledTimes(2);
      expect(opened.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { coordinator.stopQueue(); }
  });
});

describe('a pending "Get the results" crosses the executor socket typed', () => {
  it.each([['finalization-pending', 'pending'], ['finalization-active', 'active']] as const)('%s reads %s on the web frontend', async (wait, reason) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-exec-'));
    roots.push(root);
    chmodSync(root, 0o700);
    const socket = join(root, 'executor.sock');
    const server = await serveExecutor(socket, () => Promise.reject(new ComputeFinalizationWaiting('Compute finalization remains pending', wait)));
    const f = fixture(), run = remoteRun(f);
    const frontend = new ProjectRunCoordinator({ store: f.store, dbPath: f.dbPath, projectsRoot: f.root,
      hostEnv: haystackTestEnvironment(f.root), driver: vi.fn(), executorSocket: socket });
    try {
      await expect(frontend.getComputeResults(f.owner.orgId, run.projectRunId, f.owner.principalId))
        .rejects.toMatchObject({ name: 'ComputeResultsNotYet', reason });
    } finally { frontend.stopQueue(); await new Promise(resolve => server.close(resolve)); }
  });

  it('keeps an executor-side refusal a refusal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-exec-'));
    roots.push(root);
    chmodSync(root, 0o700);
    const socket = join(root, 'executor.sock');
    const server = await serveExecutor(socket, () => Promise.reject(new ProjectStateConflict('Compute finalization unavailable')));
    const f = fixture(), run = remoteRun(f);
    const frontend = new ProjectRunCoordinator({ store: f.store, dbPath: f.dbPath, projectsRoot: f.root,
      hostEnv: haystackTestEnvironment(f.root), driver: vi.fn(), executorSocket: socket });
    try {
      const error = await frontend.getComputeResults(f.owner.orgId, run.projectRunId, f.owner.principalId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectStateConflict);
      expect(error).not.toBeInstanceOf(ComputeFinalizationWaiting);
      expect(error).toMatchObject({ message: 'Compute finalization unavailable' });
    } finally { frontend.stopQueue(); await new Promise(resolve => server.close(resolve)); }
  });
});

describe('a start refused for results waiting crosses the executor socket typed', () => {
  it('keeps its reason, so the web frontend still maps it to plain copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-exec-'));
    roots.push(root);
    chmodSync(root, 0o700);
    const socket = join(root, 'executor.sock');
    const server = await serveExecutor(socket, () => Promise.reject(
      new ComputeResultsWaitingConflict('Organisation concurrent run limit reached: …', 'others-results-waiting')));
    const f = fixture();
    const frontend = new ProjectRunCoordinator({ store: f.store, dbPath: f.dbPath, projectsRoot: f.root,
      hostEnv: haystackTestEnvironment(f.root), driver: vi.fn(), executorSocket: socket });
    try {
      const raw = await callExecutor(socket, { method: 'health' }).catch((e: unknown) => e);
      expect(raw).toMatchObject({ name: 'ProjectStateConflict', reason: 'others-results-waiting' });
      const error = await frontend.startOutcome({ orgId: f.owner.orgId, principalId: f.member.principalId, projectId: f.project.projectId,
        request: { goal: 'Next change', idempotencyKey: randomUUID() } }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ComputeResultsWaitingConflict);
      expect(error).toMatchObject({ reason: 'others-results-waiting' });
    } finally { frontend.stopQueue(); await new Promise(resolve => server.close(resolve)); }
  });
});
