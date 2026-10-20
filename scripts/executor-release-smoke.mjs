#!/usr/bin/env node
// Source and packaged regression: real executor processes, shared SQLite,
// two generations, a frontend restart, rollback, cancellation and finalization.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { haystackTestRuntime } from './fixtures/haystack-test-runtime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv.includes('--source');
const ext = source ? 'ts' : 'js';
const tree = source ? 'src' : 'dist';
const moduleAt = async path => import(`${repo}/${tree}/${path}.${ext}`);
const { AuthStore } = await moduleAt('auth/store');
const { ProjectStore } = await moduleAt('projects/store');
const { ProjectRunCoordinator } = await moduleAt('projects/coordinator');
const { closeStoreHandles } = await moduleAt('core/stores');
const { callExecutor: invoke, executorSelected } = await moduleAt('projects/executorTransport');
async function callExecutor(socket, input) {
  try { return await invoke(socket, input); }
  catch (error) { error.message += ` (${input.method} ${input.input?.request?.goal ?? ''} via ${socket})`; throw error; }
}
const { startExecutorHost } = await moduleAt('projects/executorHost');
const { formatRunStatsEpilogue } = await moduleAt('contracts/runStats');
const { HAYSTACK_LAUNCH_ENV } = await moduleAt('contracts/retrievalHaystack');
const { startRun, runStatus, cancelRun } = await moduleAt('mcp/run');

async function until(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(30); }
  throw new Error(`executor smoke timed out: ${label}`);
}

const stats = { outcome: 'delivered', costUsd: 0, llmCalls: 0, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, otherCalls: 0,
  deterministicPhases: 0, deepenings: 0, rootRemediations: 0, landingRemediations: 0, unjudgedRemediations: 0,
  discardedLessons: 0, triggerRejections: 0, suiteDisputes: 0, landingReasons: [], escalations: 0, learnedSkills: 0,
  learnedEventSkills: 0, promotions: 0, refusals: 0, compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0 };

async function child(root, generation) {
  const dbPath = join(root, 'product.db');
  const store = ProjectStore.open(dbPath);
  const own = join(root, `${generation}.sock`), active = join(root, 'active.sock');
  const coordinator = new ProjectRunCoordinator({ store, dbPath, projectsRoot: root, skillsDir: join(root, 'skills'),
    hostEnv: { ...process.env, [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)),
      ATOMA_MODEL_L1: 'api:anthropic:claude-haiku-4-5', ATOMA_MODEL_L2: 'api:anthropic:claude-sonnet-4-6',
      ATOMA_MODEL_L3: 'api:anthropic:claude-opus-4-6', ANTHROPIC_API_KEY: 'quota-free-mock' },
    platformAdmins: () => true,
    dispatchAllowed: () => executorSelected(active, own),
    driver: async input => {
      appendFileSync(join(root, 'launches'), `${input.goal}:${generation}\n`);
      const env = input.env;
      await until(() => input.signal.aborted || existsSync(join(root, `${input.goal}.release`)), `finish ${input.goal}`);
      const cancelled = input.signal.aborted;
      mkdirSync(env.ATOMA_BUILD_WORKSPACE, { recursive: true });
      mkdirSync(env.ATOMA_RUNS_DIR, { recursive: true });
      writeFileSync(env.ATOMA_ARTIFACT_MANIFEST_PATH, JSON.stringify({ version: 1, runId: env.ATOMA_RUN_ID,
        generatedAt: new Date().toISOString(), outputs: [], delivery: 'text' }));
      writeFileSync(join(env.ATOMA_RUNS_DIR, `${env.ATOMA_RUN_ID}.json`), JSON.stringify({ id: env.ATOMA_RUN_ID,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), events: [],
        ...(cancelled ? { cancelled: true } : { result: { output: 'A deterministic, quota-free smoke result.' } }) }));
      return formatRunStatsEpilogue({ ...stats, outcome: cancelled ? 'cancelled' : 'delivered' });
    } });
  coordinator.reconcileInterrupted();
  await startExecutorHost({ socket: own, activeSocket: active, release: repo, coordinator,
    preview: () => ({
      start: async () => ({ connect: async () => { throw new Error('not used'); }, runtime: 'atoma-compute' }),
      stop: async () => { appendFileSync(join(root, 'preview-stops'), `${generation}\n`); },
    }),
    onRunAdmitted: run => appendFileSync(join(root, 'admissions'), `${run.projectRunId}\n`),
    workIdle: () => !existsSync(join(root, `${generation}.hold`)),
    operatorStart: input => startRun(input, async options => {
      options.onChunk?.('Quota-free operator driver ready.');
      await until(() => options.signal.aborted, 'operator cancellation');
      return formatRunStatsEpilogue({ ...stats, outcome: 'cancelled' });
    }),
    retirementConfirmed: () => existsSync(`${own}.retire`), onIdle: () => process.exit(0) });
  process.send?.({ ready: true });
}

async function smoke() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aexe-')));
  chmodSync(root, 0o700);
  const children = [];
  const previousLease = process.env.ATOMA_MCP_RUN_LOCK;
  const previousSocket = process.env.ATOMA_EXECUTOR_SOCKET;
  const previousDb = process.env.ATOMA_DB_PATH;
  try {
    const dbPath = join(root, 'product.db');
    process.env.ATOMA_MCP_RUN_LOCK = join(root, 'lease.db');
    const auth = AuthStore.open(dbPath), store = ProjectStore.open(dbPath);
    const owners = ['one', 'two', 'three'].map(subject => auth.completeLogin({ provider: 'github', subject,
      displayName: subject, email: null, emailVerified: false }, null).viewer);
    const projects = owners.map((viewer, i) => store.createProject({ orgId: viewer.orgId, principalId: viewer.principalId,
      project: { name: `Project ${i}`, slug: `project-${i}`, initialPrompt: 'Quota-free smoke',
        repositoryTarget: { installationId: '123', owner: 'smoke', name: `project-${i}`, visibility: 'private' } } }));
    const input = (i, goal) => ({ orgId: owners[i].orgId, principalId: owners[i].principalId, projectId: projects[i].projectId,
      request: { goal, idempotencyKey: `smoke-${goal}` } });
    const active = join(root, 'active.sock');
    const select = name => { const next = join(root, 'next'); symlinkSync(join(root, `${name}.sock`), next); renameSync(next, active); };
    const start = async generation => {
      const processChild = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), fileURLToPath(import.meta.url),
        ...(source ? ['--source'] : []), '--child', root, generation], {
        cwd: repo, env: { ...process.env, ATOMA_RUN_EXECUTOR: '1', ATOMA_DB_PATH: dbPath, ATOMA_RUNS_DIR: join(root, 'operator-runs') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(processChild);
      let output = ''; processChild.stdout.on('data', text => { output += text; }); processChild.stderr.on('data', text => { output += text; process.stderr.write(text); });
      await new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`executor ${generation} startup timed out: ${output}`)), 20_000);
        processChild.once('message', value => { clearTimeout(timer); done(value); });
        processChild.once('error', reject);
        processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`executor ${generation} exited ${code}: ${output}`)); });
      });
      return processChild;
    };
    const old = await start('one'); select('one');
    // The first frontend is a separate process that exits immediately after
    // admission. No executor pipe, finalizer or lease belongs to that process.
    const admitted = await promisify(execFile)(process.execPath, [...(source ? ['--import', 'tsx'] : []),
      fileURLToPath(import.meta.url), ...(source ? ['--source'] : []), '--frontend', root, JSON.stringify(input(0, 'A'))],
    { cwd: repo, timeout: 20_000 });
    const a = JSON.parse(admitted.stdout);
    const c = await callExecutor(active, { method: 'start', input: input(2, 'C') });
    await until(() => existsSync(join(root, 'launches')), 'first launch');
    await callExecutor(active, { method: 'preview-start', input: { orgId: owners[0].orgId,
      projectId: projects[0].projectId, runId: a.run.projectRunId, generation: 1,
      source: 'in-flight', mode: 'terminal', copyMaxBytes: 1024, allowedHosts: [], attribution: true, hardMs: 60_000 } });
    const next = await start('two');
    assert.equal(store.getProjectRun(owners[0].orgId, a.run.projectRunId).status, 'running', 'new host must preserve old live run');
    // A failed activation restores the old pointer; an idle old generation
    // must remain available until the activator commits retirement.
    select('two'); await delay(300); select('one');
    assert.equal((await callExecutor(active, { method: 'health' })).ready, true);
    select('two');
    assert.deepEqual(await callExecutor(join(root, 'one.sock'), { method: 'retire-previews' }), { retiring: 1 });
    await until(() => existsSync(join(root, 'preview-stops')), 'orphaned preview retirement');
    assert.equal(store.getProjectRun(owners[0].orgId, a.run.projectRunId).status, 'running');
    const b = await callExecutor(active, { method: 'start', input: input(1, 'B') });
    assert.equal((await callExecutor(active, { method: 'start', input: input(0, 'A') })).run.projectRunId, a.run.projectRunId);
    await assert.rejects(callExecutor(join(root, 'one.sock'), { method: 'start', input: input(1, 'D') }), /switching versions/);
    writeFileSync(join(root, 'B.release'), 'finish');
    await until(() => {
      const run = store.getProjectRun(owners[1].orgId, b.run.projectRunId);
      assert(!['failed', 'partial'].includes(run.status), JSON.stringify(run));
      return run.status === 'delivered';
    }, 'new generation delivery');
    assert.equal(store.getProjectRun(owners[0].orgId, a.run.projectRunId).status, 'running');
    writeFileSync(join(root, 'A.release'), 'finish');
    await until(() => store.getProjectRun(owners[0].orgId, a.run.projectRunId).status === 'delivered', 'old generation delivery');
    // A fresh frontend owns no driver. Its durable control still reaches the
    // old executor, after the active socket has moved to the new one.
    const frontend = new ProjectRunCoordinator({ store, dbPath, projectsRoot: root, skillsDir: join(root, 'skills'), executorSocket: active });
    assert.equal(frontend.reconcileInterrupted().runs, 0);
    assert.equal(frontend.hasActiveRunForPrincipal(owners[2].principalId), true);
    frontend.cancel(owners[2].orgId, c.run.projectRunId);
    await until(() => store.getProjectRun(owners[2].orgId, c.run.projectRunId).status === 'cancelled', 'old generation cancellation');
    const launches = readFileSync(join(root, 'launches'), 'utf8').trim().split('\n').sort();
    assert.deepEqual(launches, ['A:one', 'B:two', 'C:one'], 'no replay or duplicate execution across cutover');
    assert.deepEqual(readFileSync(join(root, 'admissions'), 'utf8').trim().split('\n').sort(),
      [a.run.projectRunId, b.run.projectRunId, c.run.projectRunId].sort(), 'admission is journaled once by its owner');
    select('one');
    const operator = await callExecutor(active, { method: 'operator-start', input: { goal: 'Quota-free cancellation smoke', timeoutMs: 60_000 } });
    select('two');
    process.env.ATOMA_DB_PATH = dbPath; process.env.ATOMA_EXECUTOR_SOCKET = active;
    assert.equal(runStatus({ runId: operator.runId }).status, 'running', 'fresh frontend reads remote operator receipt');
    cancelRun({ runId: operator.runId });
    await until(() => runStatus({ runId: operator.runId }).status === 'cancelled', 'remote operator cancellation');
    writeFileSync(join(root, 'one.hold'), 'pending notification or background work');
    writeFileSync(join(root, 'one.sock.retire'), 'retire');
    await delay(300);
    assert.equal((await callExecutor(join(root, 'one.sock'), { method: 'health' })).idle, false);
    assert.equal(old.exitCode, null, 'retirement must wait for non-lease work too');
    rmSync(join(root, 'one.hold'));
    await until(() => old.exitCode === 0, 'old executor retirement');
    assert.equal(next.exitCode, null, 'new executor must keep accepting');
    console.log(`executor smoke (${source ? 'source' : 'packaged'}): cutover, rollback, reattach, cancellation, no replay, retirement passed`);
  } finally {
    for (const processChild of children) if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(done => child.once('exit', done))));
    closeStoreHandles(); rmSync(root, { recursive: true, force: true });
    if (previousLease === undefined) delete process.env.ATOMA_MCP_RUN_LOCK;
    else process.env.ATOMA_MCP_RUN_LOCK = previousLease;
    if (previousSocket === undefined) delete process.env.ATOMA_EXECUTOR_SOCKET;
    else process.env.ATOMA_EXECUTOR_SOCKET = previousSocket;
    if (previousDb === undefined) delete process.env.ATOMA_DB_PATH;
    else process.env.ATOMA_DB_PATH = previousDb;
  }
}

async function serverBootSmoke() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aexec-boot-')));
  mkdirSync(join(root, 'home'));
  const own = join(root, 'generation.sock'), active = join(root, 'active.sock'), device = join(root, 'device.sock');
  const child = spawn(process.execPath, [...(source ? ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs')] : []),
    join(repo, tree, `viz/server.${ext}`), '--host', '127.0.0.1', '--port', '0', '--db', join(root, 'product.db'), '--dir', join(root, 'runs')], {
    cwd: root, env: { PATH: process.env.PATH, HOME: join(root, 'home'),
      ATOMA_VIZ_AUTH: '1', ATOMA_VIZ_PUBLIC_ORIGIN: 'https://atoma.test',
      ATOMA_AUTH_GITHUB_CLIENT_ID: 'quota-free-test', ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'quota-free-test',
      ATOMA_RUN_EXECUTOR: '1', ATOMA_EXECUTOR_SOCKET: active, ATOMA_EXECUTOR_OWN_SOCKET: own,
      ATOMA_EXECUTOR_COMPUTE_SOCKET: device, ATOMA_MCP_RUN_LOCK: join(root, 'lease.db'),
      ATOMA_VIZ_ANALYST: '0', ATOMA_VIZ_ASSAYER: '0', ATOMA_COMPUTE_ENABLED: '1',
      ATOMA_COMPUTE_APP_VERSIONS: '0.4.0', ATOMA_COMPUTE_IMAGE_DIGESTS: 'sha256:' + 'a'.repeat(64),
      ATOMA_ACCOUNT_PROFILES_ROOT: join(root, 'profiles'), ATOMA_PROJECTS_ROOT: join(root, 'projects') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  try {
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`real server executor exited: ${output}`);
      try { return (await callExecutor(own, { method: 'health' })).ready; } catch { return false; }
    }, 'real authenticated executor boot');
    assert.equal(existsSync(join(root, 'atoma.db')), false, '--db must govern operator receipts too');
    const status = await new Promise((resolveStatus, reject) => {
      const req = httpRequest({ socketPath: device, path: '/host-rpc', agent: false }, res => {
        res.resume(); res.once('end', () => resolveStatus(res.statusCode));
      });
      req.once('error', reject); req.end();
    });
    assert.equal(status, 404, 'public Compute socket must not expose execution RPC');
    symlinkSync(own, active); await delay(350);
    assert.equal((await callExecutor(own, { method: 'health' })).selected, true);
    unlinkSync(active); writeFileSync(own + '.retire', 'retire');
    await until(() => child.exitCode === 0, 'real executor retirement');
    console.log('executor server boot: authenticated runtime, primary store, device isolation and retirement passed');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--frontend')) {
  const i = process.argv.indexOf('--frontend'), root = process.argv[i + 1];
  const dbPath = join(root, 'product.db');
  const frontend = new ProjectRunCoordinator({ store: ProjectStore.open(dbPath), dbPath,
    executorSocket: join(root, 'active.sock'), projectsRoot: root, skillsDir: join(root, 'skills') });
  console.log(JSON.stringify(await frontend.startOutcome(JSON.parse(process.argv[i + 2]))));
  closeStoreHandles();
} else if (process.argv.includes('--child')) { const i = process.argv.indexOf('--child'); await child(process.argv[i + 1], process.argv[i + 2]); }
else { await smoke(); await serverBootSmoke(); }
