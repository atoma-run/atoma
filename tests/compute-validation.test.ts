import { BudgetGateLlmClient, RunBudgetMeter } from '../src/core/runBudget.js';
import { RunInitialStateStore, retainInitialWorkspace } from '../src/run/initialState.js';
import { captureCheckpointExport } from '../src/run/checkpointExport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { appendLedgerStrict, openLedgerHandle, readLedger } from '../src/core/ledger.js';
import { ComputeValidationQueue } from '../src/core/computeValidation.js';
import { withheldComputeKnowledge } from '../src/contracts/executionTarget.js';
import { COMPUTE_VALIDATION, COMPUTE_VALIDATION_ENV } from '../src/contracts/computeValidation.js';
import { validateComputeNext, type ComputeValidationOptions } from '../src/supervisor/computeValidation.js';
import { defaultLauncher, type ArmLaunch } from '../src/supervisor/assayer.js';
import * as burnin from '../src/cli/burnin.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { acquireRunLeaseWithoutRecovery } from '../src/mcp/runLock.js';
import { resolveToolBackendMode } from '../src/run/backendMode.js';

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
  return { db, store, source, options, launch, events, scope, auth, viewer: login.viewer };
}

describe('resident Compute verification through the real queue, store and lease', () => {
  it('allows the observed cached proof volume while still stopping cost and token overruns', async () => {
    const call = { model: 'fixture', inputTokens: 19071, outputTokens: 7303, cacheReadInputTokens: 136592,
      cacheCreationInputTokens: 0, durationMs: 1, stopReason: 'end_turn' };
    const prices = [{ match: /^fixture$/, prices: { input: 0.2, output: 10, cachedInput: 0.02 } }];
    const transport = vi.fn(async () => ({ text: 'verified', stopReason: 'end_turn' as const,
      usage: { inputTokens: 0, outputTokens: 0 } }));
    const meter = new RunBudgetMeter({ record: () => {} }, COMPUTE_VALIDATION, () => {}, prices);
    meter.record(call); // 162,966 billable tokens: the original production failure, cache included.
    expect(meter.consumed().tokens).toBe(162966);
    expect(meter.exceeded()).toBeNull();
    const gate = new BudgetGateLlmClient({ complete: transport }, meter);
    const request = { model: 'fixture', systemPrompt: '', userContent: '' };
    await gate.complete(request);
    expect(transport).toHaveBeenCalledOnce();
    meter.record({ ...call, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: COMPUTE_VALIDATION.tokens });
    expect(meter.exceeded()?.kind).toBe('tokens');
    await expect(gate.complete(request)).rejects.toThrow('token ceiling');
    expect(transport).toHaveBeenCalledOnce();
    const cost = new RunBudgetMeter({ record: () => {} }, COMPUTE_VALIDATION, () => {}, prices);
    cost.record({ ...call, inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 30000 });
    expect(cost.exceeded()?.kind).toBe('cost');
    await expect(new BudgetGateLlmClient({ complete: transport }, cost).complete(request)).rejects.toThrow('cost ceiling');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('coalesces success, failure and revision, launches once and never credits the device receipts', async () => {
    const f = fixture();
    expect((await validateComputeNext(f.options))?.outcome).toBe('compute-validated');
    expect(f.launch).toHaveBeenCalledTimes(1);
    const call = f.launch.mock.calls[0]![0];
    expect(call).toMatchObject({ isolation: 'container-egress', timeoutMs: 900_000, goal: f.source.goal });
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
    expect(call.extraArgs).toContain('--egress');
    expect(call.onSpawn).toBeTypeOf('function');
  });
  it.skipIf(process.platform === 'win32')('passes controlled egress and the host allowlist through the real runner process', async () => {
    const f = fixture();
    const receipt = join(f.options.repoRoot, 'launch.json');
    writeFileSync(join(f.options.repoRoot, 'package.json'), JSON.stringify({ scripts: {
      'run:build:dev': 'node capture-launch.cjs', 'run:build': 'node capture-launch.cjs',
    } }));
    writeFileSync(join(f.options.repoRoot, 'capture-launch.cjs'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.LAUNCH_RECEIPT, JSON.stringify({
  argv: process.argv.slice(2), allowlist: process.env.ATOMA_EGRESS_ALLOWLIST,
}));
`);
    await validateComputeNext({ ...f.options, launch: defaultLauncher, hostEnv: {
      PATH: process.env.PATH, LAUNCH_RECEIPT: receipt, ATOMA_EGRESS_ALLOWLIST: 'registry.npmjs.org',
    } });
    const observed = JSON.parse(readFileSync(receipt, 'utf8')) as { argv: string[]; allowlist: string };
    expect(resolveToolBackendMode(observed.argv, {})).toEqual({ container: true, egress: true });
    expect(observed.allowlist).toBe('registry.npmjs.org');
    expect(observed.argv).toContain(f.source.goal);
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
  it('retries from identical initial bytes while preserving every legacy and previous attempt file', async () => {
    const f = fixture('seeded'); const snapshot = await savedInitial(f);
    f.auth.grantPlatformAdmin(f.viewer.principalId);
    await validateComputeNext(f.options);
    const legacy = join(f.options.supervisorDir, 'compute-validation', f.source.projectRunId);
    writeFileSync(join(legacy, 'run.log'), 'legacy complete log');
    const legacyTrace = readFileSync(join(legacy, 'runs', `${f.launch.mock.calls[0]![0].env['ATOMA_RUN_ID']}.json`));
    const input = { projectId: f.source.projectId, runId: f.source.projectRunId, idempotencyKey: 'explicit-one' };
    const retry = () => f.store.retryComputeValidation(f.viewer.principalId, f.viewer.orgId, input);
    const receipt = retry();
    expect(receipt.initialSnapshot).toEqual(snapshot);
    expect(retry()).toEqual(receipt);
    await validateComputeNext(f.options);
    const call = f.launch.mock.calls[1]![0];
    expect(call.env['ATOMA_RUN_ID']).toBe(receipt.attemptId);
    expect(JSON.parse(call.env[COMPUTE_VALIDATION_ENV]!)).toMatchObject({ attemptId: receipt.attemptId });
    expect(call.logPath).toBe(join(legacy, 'attempts', receipt.attemptId, 'run.log'));
    expect(readFileSync(join(legacy, 'run.log'), 'utf8')).toBe('legacy complete log');
    expect(readFileSync(join(legacy, 'runs', `${f.launch.mock.calls[0]![0].env['ATOMA_RUN_ID']}.json`))).toEqual(legacyTrace);
    expect(retry()).toMatchObject({ status: 'completed', result: { validationRunId: receipt.attemptId } });
    const firstTracePath = join(legacy, 'attempts', receipt.attemptId, 'runs', `${receipt.attemptId}.json`);
    const firstTrace = readFileSync(firstTracePath);
    f.store.retryComputeValidation(f.viewer.principalId, f.viewer.orgId, { ...input, idempotencyKey: 'explicit-two' });
    await validateComputeNext(f.options);
    expect(readFileSync(firstTracePath)).toEqual(firstTrace);
    expect(new RunInitialStateStore(f.db).read({ sourceRunId: f.source.projectRunId, ...f.scope })?.snapshot).toEqual(snapshot);
    expect(f.launch).toHaveBeenCalledTimes(3);
  });
  it.each(['missing', 'expired', 'corrupt'] as const)('refuses or blocks a retry with %s starting state before any launch', async reason => {
    const f = fixture('seeded'); const snapshot = await savedInitial(f);
    f.auth.grantPlatformAdmin(f.viewer.principalId);
    await validateComputeNext(f.options); f.launch.mockClear();
    if (reason === 'missing') new RunInitialStateStore(f.db).expire(f.source.projectRunId);
    if (reason === 'expired') f.db.prepare('UPDATE project_runs SET bytes_expired_at=?').run(new Date().toISOString());
    if (reason === 'corrupt') f.db.prepare("UPDATE run_checkpoint_files SET content=? WHERE snapshot=? AND kind='file'").run(Buffer.from('corrupted'), snapshot.id);
    const retry = () => f.store.retryComputeValidation(f.viewer.principalId, f.viewer.orgId,
      { projectId: f.source.projectId, runId: f.source.projectRunId, idempotencyKey: 'explicit-one' });
    if (reason === 'corrupt') { retry(); await validateComputeNext(f.options); expect(retry().status).toBe('blocked'); }
    else expect(retry).toThrow();
    expect(f.launch).not.toHaveBeenCalled();
    expect(new ComputeValidationQueue(f.db).pending()).toBeNull();
  });
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
