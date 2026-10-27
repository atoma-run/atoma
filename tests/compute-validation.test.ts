import { RunInitialStateStore, retainInitialWorkspace } from '../src/run/initialState.js';
import { captureCheckpointExport } from '../src/run/checkpointExport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { appendLedgerStrict, openLedgerHandle, readLedger } from '../src/core/ledger.js';
import { withheldComputeKnowledge } from '../src/contracts/executionTarget.js';
import { COMPUTE_VALIDATION, COMPUTE_VALIDATION_ENV } from '../src/contracts/computeValidation.js';
import { validateComputeNext, type ComputeValidationOptions } from '../src/supervisor/computeValidation.js';
import { defaultLauncher, type ArmLaunch } from '../src/supervisor/assayer.js';
import * as burnin from '../src/cli/burnin.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { acquireRunLeaseWithoutRecovery } from '../src/mcp/runLock.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); closeStoreHandles(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(reason?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-validation-'))); roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin({ provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false }, null)!;
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({ orgId: login.viewer.orgId, principalId: login.viewer.principalId,
    project: { name: 'Clock', slug: 'clock', initialPrompt: 'Build a clock.',
      repositoryTarget: { installationId: '123', owner: 'owner', name: 'clock', visibility: 'private' } } });
  const db = openLedgerHandle(dbPath);
  db.prepare('UPDATE projects SET execution_target_json=? WHERE project_id=?').run(JSON.stringify({ kind: 'customer-device', deviceId: randomUUID() }), project.projectId);
  const sourceDir = join(root, 'source'); mkdirSync(sourceDir);
  const seed = reason === 'seeded' ? store.createProjectRun({ orgId: project.orgId, projectId: project.projectId,
    principalId: login.viewer.principalId, request: { goal: 'Initial clock', idempotencyKey: 'seed' },
    hostPaths: { workspacePath: sourceDir, runsPath: sourceDir, logPath: join(sourceDir, 'seed.log') } })!.run : null;
  if (seed) writeFileSync(join(sourceDir, '.atoma-probes.json'), '{"version":1,"probes":[]}');
  const source = store.createProjectRun({ orgId: project.orgId, projectId: project.projectId, principalId: login.viewer.principalId,
    request: { goal: 'Verify the clock', idempotencyKey: 'source' },
    hostPaths: { workspacePath: join(sourceDir, 'workspace'), runsPath: sourceDir, logPath: join(sourceDir, 'run.log') } })!.run;
  store.transitionProjectRun({ orgId: project.orgId, projectRunId: source.projectRunId, from: 'queued', to: 'running' });
  if (reason !== 'missing-seed') store.recordRunSeed(project.orgId, source.projectRunId, seed ? { kind: 'run', runId: seed.projectRunId } : { kind: 'none' });
  store.transitionProjectRun({ orgId: project.orgId, projectRunId: source.projectRunId, from: 'running', to: 'failed', error: 'device observation' });
  writeFileSync(join(sourceDir, `${source.projectRunId}.json`), JSON.stringify({ id: source.projectRunId, events: [] }));
  const scope = { orgId: project.orgId, projectId: project.projectId, runId: source.projectRunId };
  for (const operation of ['success', 'failure', 'revision', 'direct-failure'] as const) {
    appendLedgerStrict({ kind: 'skill-credit-withheld', entity: 'molecule/recipe', scope, detail: withheldComputeKnowledge(operation, 'Cell') }, db);
  }
  const launch = vi.fn(async (input: ArmLaunch) => {
    const recorder = new TraceRecorder(input.env['ATOMA_RUNS_DIR']);
    recorder.beginRun({ description: input.goal }, 'validation', { runId: input.env['ATOMA_RUN_ID']! });
    recorder.endRun({ result: { output: 'Independent result', summary: 'Verified', producedBy: { tier: 1, name: 'Water', viaFallback: false } } });
    return '';
  });
  const options: ComputeValidationOptions = { repoRoot: root, dbPath, store, skillsDir: join(root, 'skills'), runsDir: join(root, 'runs'),
    supervisorDir: join(root, 'supervisor'), leasePath: join(root, 'lease.db'), allowed: () => true, launch, hostEnv: {} };
  const events = () => readLedger(db).filter(e => e.kind === 'compute-validation');
  return { db, store, source, options, launch, events, scope };
}

describe('resident Compute verification through the real queue, store and lease', () => {
  it('coalesces success, failure and revision, launches once and never credits the device receipts', async () => {
    const f = fixture();
    expect((await validateComputeNext(f.options))?.outcome).toBe('compute-validated');
    expect(f.launch).toHaveBeenCalledTimes(1);
    const call = f.launch.mock.calls[0]![0];
    expect(call).toMatchObject({ isolation: 'container', timeoutMs: COMPUTE_VALIDATION.timeoutMs, goal: f.source.goal });
    expect(call.seed).toBeUndefined();
    expect(JSON.parse(call.env[COMPUTE_VALIDATION_ENV]!)).toMatchObject({ sourceRunId: f.source.projectRunId });
    expect(call.env['ATOMA_RUN_ID']).not.toBe(f.source.projectRunId);
    expect(call.env['ATOMA_DEFER_LEARNING']).toBe('0');
    expect(f.events().at(-1)?.detail).toMatchObject({ status: 'completed', countersChanged: false, recipesChanged: false, costUsd: 0 });
    expect(await validateComputeNext(f.options)).toBeNull();
    expect(readLedger(f.db).filter(e => e.kind === 'skill-credit-withheld')).toHaveLength(4);
    expect(f.store.getProjectRun(f.source.orgId, f.source.projectRunId)?.status).toBe('failed');
  });
  it('does not launch while a product run holds the lease', async () => {
    const f = fixture(); const lease = acquireRunLeaseWithoutRecovery('product', f.options.leasePath);
    try { expect((await validateComputeNext(f.options))?.outcome).toBe('refused-active'); expect(f.launch).not.toHaveBeenCalled(); }
    finally { lease.release(); }
  });
  it.each(['access', 'missing-seed', 'expired', 'seeded'] as const)('blocks %s before any paid launch', async reason => {
    const f = fixture(reason);
    if (reason === 'expired') f.db.prepare('UPDATE project_runs SET bytes_expired_at=?').run(new Date().toISOString());
    await validateComputeNext({ ...f.options, allowed: () => reason !== 'access' });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.events().at(-1)?.detail).toMatchObject({ status: 'blocked', costUsd: 0 });
  });
  it('passes the isolated container and child ownership through the production launcher', async () => {
    const f = fixture();
    const spawn = vi.spyOn(burnin, 'spawnRun').mockImplementation(async input => {
      input.onSpawn!(process.pid);
      const leaseDb = new Database(f.options.leasePath, { readonly: true });
      try { expect(leaseDb.prepare('SELECT child_pgid FROM mcp_run_lease').get()).toEqual({ child_pgid: process.pid }); }
      finally { leaseDb.close(); }
      return '';
    });
    await validateComputeNext({ ...f.options, launch: defaultLauncher });
    expect(spawn).toHaveBeenCalledOnce();
    const call = spawn.mock.calls[0]![0];
    expect(call.extraArgs).toContain('--container');
    expect(call.extraArgs).not.toContain('--egress');
    expect(call.onSpawn).toBeTypeOf('function');
  });
  async function savedInitial(f: ReturnType<typeof fixture>) {
    const workspace = f.source.hostPaths.workspacePath;
    mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, '.env.local'), 'private fixture');
    const states = new RunInitialStateStore(f.db);
    const snapshot = await retainInitialWorkspace(f.db, captureCheckpointExport(workspace));
    states.publish({ version: 1, runId: f.source.projectRunId, orgId: f.source.orgId, projectId: f.source.projectId,
      principalId: f.source.requestedByPrincipalId, goal: f.source.goal, snapshot, externalConnectors: false,
      environment: { ATOMA_PREVIOUS_RUN_RESULTS: '{"historyTruncated":false,"runs":[]}' } });
    return snapshot;
  }
  it('verifies a seeded run from its complete retained initial state', async () => {
    const f = fixture('seeded'); await savedInitial(f);
    await validateComputeNext(f.options);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.launch.mock.calls[0]![0].env['ATOMA_PREVIOUS_RUN_RESULTS']).toContain('historyTruncated');
    expect(f.events().at(-1)?.detail).toMatchObject({ status: 'completed' });
  });
  it('refuses corrupt retained bytes before claiming budget or launching', async () => {
    const f = fixture('seeded'); const snapshot = await savedInitial(f);
    f.db.prepare("UPDATE run_checkpoint_files SET content=? WHERE snapshot=? AND path='.env.local'").run(Buffer.from('damaged'), snapshot.id);
    await validateComputeNext(f.options);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.events().map(event => event.detail?.['status'])).toEqual(['queued', 'blocked']);
  });
  it('releases the shared lease even if private snapshot cleanup fails', async () => {
    const f = fixture('seeded'); await savedInitial(f);
    await expect(validateComputeNext({ ...f.options, cleanupInitial() { throw new Error('fixture cleanup failure'); } })).rejects.toThrow('cleanup failure');
    const lease = acquireRunLeaseWithoutRecovery('next-product-run', f.options.leasePath); lease.release();
  });
  it('treats a forged stdout delivery without a host trace as inconclusive', async () => {
    const f = fixture();
    await validateComputeNext({ ...f.options, launch: async () => 'ATOMA_RUN_STATS {"outcome":"delivered","costUsd":0}\n✓ build finished' });
    expect(f.events().at(-1)?.detail).toMatchObject({ status: 'inconclusive', costUsd: null, countersChanged: false });
  });
  it('retains independent counter events when interrupted and never retries the uncertain attempt', async () => {
    const f = fixture(); const controller = new AbortController();
    await validateComputeNext({ ...f.options, signal: controller.signal, launch: async input => {
      appendLedgerStrict({ kind: 'type-success', entity: 'Water', scope: { ...f.scope, runId: input.env['ATOMA_RUN_ID']! }, detail: {} }, f.db);
      controller.abort(); return '';
    } });
    expect(f.events().at(-1)?.detail).toMatchObject({ status: 'interrupted', countersChanged: true });
    expect(await validateComputeNext(f.options)).toBeNull();
  });
});
