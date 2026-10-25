import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type Viewer } from '../src/auth/store.js';
import { COMPUTE_RESULTS_WAITING_MESSAGE } from '../src/contracts/computeDevice.js';
import { runProgressSchema, runReviewSchema } from '../src/contracts/clientExperience.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { PlatformEventLog } from '../src/platform/events.js';
import { ComputeDispatchStore } from '../src/projects/computeDispatch.js';
import {
  ProjectRunCoordinator,
  RESULTS_WAITING_NOTICE_MS,
  projectRunHostLayout,
  resultsWaitingEventInput,
  type ComputeResultsWaitingEvent,
} from '../src/projects/coordinator.js';
import { ProjectHttpError, ProjectService } from '../src/projects/service.js';
import { ProjectStore } from '../src/projects/store.js';
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

function coordinatorFor(f: ReturnType<typeof fixture>, onComputeResultsWaiting?: (event: ComputeResultsWaitingEvent) => void) {
  return new ProjectRunCoordinator({ store: f.store, dbPath: f.dbPath, projectsRoot: f.root,
    hostEnv: haystackTestEnvironment(f.root), driver: vi.fn(),
    ...(onComputeResultsWaiting ? { onComputeResultsWaiting } : {}) });
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
      expect(listed['resultsWaiting']).toEqual({ since: expect.any(String) });
      const status = service.projectRunStatus(f.member, f.project.projectId, run.projectRunId) as Record<string, unknown>;
      const progress = runProgressSchema.parse(status['progress']);
      expect(progress.stage).toBe('awaiting-results');
      expect(progress.message).toBe(COMPUTE_RESULTS_WAITING_MESSAGE);
      expect(progress.message).not.toMatch(/in progress|reconcil|transfer|journal/i);
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
      expect((own as Error).message).toContain('Open Atoma Compute on that computer');
      expect((own as Error).message).toContain('"Get the results"');
      expect((own as Error).message).not.toContain('still in progress');
      expect((own as Error).message).toContain(run.projectRunId);
      const other = await refusal(f.member);
      expect((other as Error).message).toContain('a finished run in Clock is waiting for its results from the computer of the person who started it');
      expect((other as Error).message).not.toContain(run.projectRunId);
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
        body: '“Build the booking page” is finished. Open Atoma Compute on your computer so its results can arrive.' })]);
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
