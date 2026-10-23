import { silentLogger } from './helpers.js';
import { afterAll, beforeAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTH_TABLES_DDL } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { ComputeDeviceStore } from '../src/projects/computeDevices.js';
import { type ComputeActor } from '../src/contracts/computeDevice.js';

let db: Database.Database, projects: ProjectStore, devices: ComputeDeviceStore, now: number;
const imageDigest = `sha256:${'a'.repeat(64)}`;
const policy = { appVersions: new Set(['test-1']), imageDigests: new Set([imageDigest]) };
const capabilities = { protocol: 1 as const, appVersion: 'test-1', platform: 'darwin' as const, architecture: 'arm64' as const,
  services: ['workspace', 'tools', 'retrieval', 'preview'] as ('workspace' | 'tools' | 'retrieval' | 'preview')[], imageDigest, cpus: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 };
const resources = { cpus: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3 };
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db); now = 1_000_000;
  devices = new ComputeDeviceStore(db, policy, () => now);
});

function actor(orgId?: string): ComputeActor {
  const id = randomUUID(), org = orgId ?? randomUUID(), at = new Date().toISOString();
  if (!orgId) db.prepare('INSERT INTO auth_organisations VALUES(?,?,?)').run(org, 'Organization', at);
  db.prepare("INSERT INTO auth_principals VALUES(?,'human',?,?)").run(id, 'Member', at);
  db.prepare("INSERT INTO auth_memberships VALUES(?,?,'org:owner',?)").run(org, id, at);
  return { orgId: org, principalId: id };
}
function pairing(owner: ComputeActor) {
  const secret = randomBytes(32).toString('base64url');
  const request = devices.beginPairing({ name: 'My computer', secretHash: createHash('sha256').update(secret).digest('hex') });
  devices.confirmPairing(owner, request.code);
  return { ...devices.redeemPairing(request.code, secret), secret, code: request.code };
}
function project(owner: ComputeActor) {
  return projects.createProject({ orgId: owner.orgId, principalId: owner.principalId,
    project: { name: 'Compute', slug: `compute-${randomUUID()}`, repositoryTarget: {
      installationId: '1', owner: 'tests', name: `compute-${randomUUID()}`, visibility: 'private',
    } } });
}
function run(owner: ComputeActor, projectId: string) {
  return projects.createProjectRun({ orgId: owner.orgId, projectId, principalId: owner.principalId,
    request: { idempotencyKey: randomUUID(), goal: 'Test compute control' },
    hostPaths: { workspacePath: '/not-used/workspace', runsPath: '/not-used/runs', logPath: '/not-used/log' } })!.run.projectRunId;
}
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachComputeGateway } from '../src/projects/computeGateway.js';
import { ComputeConnection, ComputeIndeterminateError } from '../src/projects/computeConnection.js';
import { COMPUTE_FRAME_BYTES, computeServerFrameSchema } from '../src/contracts/computeProtocol.js';

let root: string, server: Server, gateway: ReturnType<typeof attachComputeGateway>;
let url: string, peers: ComputeConnection[], clients: WebSocket[];
const controls = vi.fn();
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-compute-tls-')));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key'),
    '-out', join(root, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
  peers = []; clients = []; controls.mockReset();
  server = createServer({ key: readFileSync(join(root, 'key')), cert: readFileSync(join(root, 'cert')) });
  gateway = attachComputeGateway(server, devices, peer => peers.push(peer), { addresses: [] }, () => true, controls);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  url = `wss://127.0.0.1:${address.port}/compute/v1`;
});
afterEach(async () => {
  gateway.close();
  for (const client of clients) client.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
});
async function client() {
  const ws = new WebSocket(url, { rejectUnauthorized: false }); clients.push(ws);
  await once(ws, 'open'); return ws;
}
async function message(ws: WebSocket) {
  const [raw] = await once(ws, 'message');
  return computeServerFrameSchema.parse(JSON.parse(String(raw)));
}
async function connected() {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  const ws = await client(), ready = message(ws);
  ws.send(JSON.stringify({ kind: 'hello', version: 1, credential: paired.credential, machineId: paired.deviceId, capabilities }));
  const frame = await ready;
  if (frame.kind !== 'ready') throw new Error('Expected handshake');
  const execution = devices.assign(owner, frame.session, runId, resources);
  return { owner, paired, p, runId, ws, peer: peers.at(-1)!, execution: { runId, generation: execution.generation }, session: frame.session };
}

it('authenticates over TLS and round-trips the private workspace command with a fresh heartbeat', async () => {
  const f = await connected();
  const heartbeat = message(f.ws); f.ws.send(JSON.stringify({ kind: 'heartbeat', id: 1 }));
  expect(await heartbeat).toEqual({ kind: 'heartbeat', id: 1 });
  const command = message(f.ws), result = f.peer.request(f.execution, { method: 'prepare', clean: false });
  const frame = await command;
  expect(frame).toMatchObject({ kind: 'workspace-command', execution: f.execution, command: { method: 'prepare', clean: false } });
  if (frame.kind !== 'workspace-command') throw new Error('Expected command');
  f.ws.send(JSON.stringify({ kind: 'workspace-result', execution: f.execution,
    response: { id: frame.id, ok: true, reply: { method: 'prepare', value: null } } }));
  expect(await result).toEqual({ method: 'prepare', value: null });
});

it('keeps an admitted device connected during preparation while idle devices move to the new executor', async () => {
  const f = await connected();
  expect(f.peer.executing()).toBe(false); // Assigned in SQLite, not bound to the tool driver yet.
  gateway.closeIdle(session => session.deviceId === f.session.deviceId);
  const heartbeat = message(f.ws); f.ws.send(JSON.stringify({ kind: 'heartbeat', id: 1 }));
  expect(await heartbeat).toEqual({ kind: 'heartbeat', id: 1 });
  const closed = once(f.ws, 'close'); gateway.closeIdle(); await closed;
  expect(f.ws.readyState).toBe(WebSocket.CLOSED);
});

it.each(['disconnect', 'revocation', 'generation', 'method', 'request-id'] as const)('fences pending effects on %s without replay or slot release', async failure => {
  const f = await connected(), command = message(f.ws);
  const result = f.peer.request(f.execution, { method: 'restart' });
  const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
  const frame = await command;
  if (frame.kind !== 'workspace-command') throw new Error('Expected command');
  if (failure === 'disconnect') f.ws.terminate();
  else {
    if (failure === 'revocation') devices.grantProject(f.owner, f.paired.deviceId, f.p.projectId, false);
    f.ws.send(JSON.stringify({ kind: 'workspace-result', execution: { ...f.execution, generation: f.execution.generation + Number(failure === 'generation') },
      response: { id: frame.id + Number(failure === 'request-id'), ok: true,
        reply: { method: failure === 'method' ? 'prepare' : 'restart', value: null } } }));
  }
  await rejected;
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
  await expect(f.peer.request(f.execution, { method: 'restart' })).rejects.toThrow('unavailable');
});

it('does not let a stale socket close the replacement connection or reactivate its workload', async () => {
  const f = await connected(), ws = await client(), ready = message(ws);
  ws.send(JSON.stringify({ kind: 'hello', version: 1, credential: f.paired.credential, machineId: f.paired.deviceId, capabilities }));
  const replacement = await ready;
  if (replacement.kind !== 'ready') throw new Error('Expected handshake');
  f.peer.close();
  devices.validateSession(replacement.session);
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
  await expect(peers.at(-1)!.request(f.execution, { method: 'restart' })).rejects.toThrow('execution');
});

it('rejects concurrent commands before dispatch', async () => {
  const f = await connected(), command = message(f.ws);
  const first = f.peer.request(f.execution, { method: 'restart' });
  const rejected = expect(first).rejects.toBeInstanceOf(ComputeIndeterminateError);
  await command;
  await expect(f.peer.request(f.execution, { method: 'prepare', clean: true })).rejects.toThrow('busy');
  f.peer.close(); await rejected;
});

it('rejects oversized commands before changing the assignment or sending bytes', async () => {
  const f = await connected();
  await expect(f.peer.request(f.execution, { method: 'replace-manifest', text: 'x'.repeat(COMPUTE_FRAME_BYTES) })).rejects.toThrow('too large');
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('active');
});

it.each(['credential', 'binary', 'oversized', 'version'] as const)('refuses an invalid %s during authentication', async failure => {
  const owner = actor(), paired = pairing(owner), ws = await client(), closed = once(ws, 'close');
  const hello = JSON.stringify({ kind: 'hello', version: failure === 'version' ? 2 : 1,
    credential: failure === 'credential' ? randomBytes(32).toString('base64url') : paired.credential, capabilities });
  ws.send(failure === 'oversized' ? 'x'.repeat(COMPUTE_FRAME_BYTES + 1) : hello, { binary: failure === 'binary' });
  await closed;
  expect(peers[0]?.identity()).toBeUndefined();
  expect(devices.inspect(owner, paired.deviceId).connected).toBe(false);
});

it('refuses browser-origin WebSocket upgrades before device authentication', async () => {
  const ws = new WebSocket(url, { rejectUnauthorized: false, origin: 'https://attacker.test' }); clients.push(ws);
  await expect(once(ws, 'open')).rejects.toThrow();
  expect(peers).toHaveLength(0);
});

it('times out an unanswered command without pretending the workload stopped', async () => {
  const f = await connected();
  vi.useFakeTimers();
  try {
    const result = f.peer.request(f.execution, { method: 'restart' });
    const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
  } finally { vi.useRealTimers(); }
});

it('stops renewing a workload lease after its project grant is withdrawn', async () => {
  const f = await connected(), command = message(f.ws);
  const result = f.peer.request(f.execution, { method: 'restart' });
  const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
  await command;
  devices.grantProject(f.owner, f.paired.deviceId, f.p.projectId, false);
  const closed = once(f.ws, 'close');
  f.ws.send(JSON.stringify({ kind: 'heartbeat', id: 1 }));
  await rejected; await closed;
  expect(devices.inspect(f.owner, f.paired.deviceId).connected).toBe(false);
});

import { connectComputeWorkspace } from '../src/launcher/computeClient.js';
import { workspaceCommandHandler, remoteWorkspaceRuntime } from '../src/run/workspaceRpc.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';

it('uses the outbound client, local lease and existing workspace runtime for a real checkpoint transfer', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  const workspace = join(root, randomUUID());
  const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: workspace, log: () => {} }));
  let stops = 0;
  const execution = { runId, generation: 1 };
  const connection = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities, execution,
    ca: readFileSync(join(root, 'cert'), 'utf8'), execute: handler, stopWorkloads: async () => { stops++; } });
  try {
    expect(connection.state()).toBe('active');
    expect(devices.assign(owner, connection.session, runId, resources).generation).toBe(execution.generation);
    const runtime = remoteWorkspaceRuntime(command => peers.at(-1)!.request(execution, command));
    await runtime.prepare(false);
    writeFileSync(join(workspace, 'result.txt'), 'checkpoint bytes over WSS');
    const snapshot = await runtime.checkpointExport();
    try {
      expect(snapshot.header.digest).toBe(await runtime.checkpointDigest());
      const frames = [];
      for await (const frame of snapshot.frames()) frames.push(frame);
      expect(frames.length).toBeGreaterThan(1);
      expect(Buffer.concat(frames.filter(frame => frame.kind === 'chunk').map(frame => Buffer.from(frame.bytes))).toString())
        .toBe('checkpoint bytes over WSS');
    } finally { await snapshot.close(); }
    expect(await connection.close()).toBe(true);
    expect(stops).toBe(1);
    expect(connection.state()).toBe('stopped');
  } finally { await connection.close(); await handler.close(); }
});

it('does not acknowledge a failed launcher teardown as stopped after the socket disappears', async () => {
  const owner = actor(), paired = pairing(owner), execution = { runId: randomUUID(), generation: 1 };
  let stops = 0;
  const connection = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities, execution,
    ca: readFileSync(join(root, 'cert'), 'utf8'), execute: async () => { throw new Error('Must not execute'); },
    stopWorkloads: async () => { stops++; throw new Error('Engine unavailable'); } });
  peers.at(-1)!.close();
  expect(await connection.close()).toBe(false);
  expect(connection.state()).toBe('unconfirmed'); expect(stops).toBe(1);
});

it('refuses plaintext endpoints before constructing a connection', async () => {
  await expect(connectComputeWorkspace({ url: url.replace('wss:', 'ws:'), credential: '', machineId: randomUUID(), capabilities,
    execution: { runId: randomUUID(), generation: 1 }, execute: async () => { throw new Error('Unreachable'); },
    stopWorkloads: async () => {} })).rejects.toThrow('WSS');
});

it('closes the socket and rejects unknown effects even when persisting disconnection fails', async () => {
  const f = await connected(), command = message(f.ws), closed = once(f.ws, 'close');
  const result = f.peer.request(f.execution, { method: 'restart' });
  const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
  await command;
  db.pragma('query_only=ON');
  try { expect(() => f.peer.close()).not.toThrow(); }
  finally { db.pragma('query_only=OFF'); }
  await rejected; await closed;
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment).not.toBeNull();
});

import { computeToolBackend } from '../src/run/computeToolBackend.js';
import { localToolBackend } from '../src/run/toolBackend.js';

it('executes real tools through their separate WSS channel and exports the workspace after acknowledged drain', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId), execution = { runId, generation: 1 }, workspace = join(root, randomUUID());
  const local = localToolBackend({ workspaceRoot: workspace, logger: silentLogger() });
  const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: workspace, log: () => {} }));
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities, execution,
    ca: readFileSync(join(root, 'cert'), 'utf8'), execute: handler, stopWorkloads: () => local.cleanup(),
    tools: { ...local.executor, has: name => local.executor.has(name), execute: (name, args) => local.executor.execute(name, args), drain: () => local.drain!() } });
  try {
    devices.assign(owner, client.session, runId, resources);
    const peer = peers.at(-1)!;
    const backend = computeToolBackend({ declarations: local.toolDecls, send: command => peer.requestTool(execution, command) });
    const runtime = remoteWorkspaceRuntime(command => peer.request(execution, command));
    await runtime.prepare(false);
    await backend.executor.execute('write_file', { path: 'remote.txt', content: 'written remotely' });
    const reads = await Promise.all([
      backend.executor.execute('read_file', { path: 'remote.txt' }),
      backend.executor.execute('list_files', { path: '.' }),
    ]);
    expect(JSON.stringify(reads)).toContain('written remotely');
    await expect(backend.executor.execute('prepare', {})).rejects.toThrow('unavailable');
    await backend.drain!();
    await expect(backend.executor.execute('read_file', { path: 'remote.txt' })).rejects.toThrow('unavailable');
    const snapshot = await runtime.checkpointExport();
    try { expect(snapshot.header.digest).toBe(await runtime.checkpointDigest()); }
    finally { await snapshot.close(); }
    expect(readFileSync(join(workspace, 'remote.txt'), 'utf8')).toBe('written remotely');
  } finally { await client.close(); await handler.close(); }
});

import { TraceRecorder } from '../src/viz/trace.js';

it('records the customer origin beside tool observations without trusting a tool-supplied origin', () => {
  const recorder = new TraceRecorder(root);
  const trace = recorder.beginRun({ description: 'Remote observation' }, 'Remote', { computeProvenance: 'customer-device' });
  recorder.record({ kind: 'tool', id: randomUUID(), ts: Date.now(), llmEventId: randomUUID(),
    name: 'read_file', args: {}, durationMs: 1, provenance: 'hosted' });
  expect(trace.events[0]).toMatchObject({ provenance: 'customer-device' });
  recorder.endRun();
});

it('binds a server-issued execution only after local allocation and fences commands until acknowledgement', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: join(root, randomUUID()), log: () => {} }));
  let release!: () => void;
  const allocated = new Promise<void>(resolve => { release = resolve; });
  const assign = vi.fn(async () => { await allocated; return { execute: handler }; });
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), assign, stopWorkloads: () => handler.close() });
  try {
    const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
    const peer = peers.at(-1)!, bound = peer.bind(execution);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(execution));
    await expect(peer.request(execution, { method: 'prepare', clean: false })).rejects.toThrow('unavailable');
    release(); await bound;
    expect(await peer.request(execution, { method: 'prepare', clean: false })).toEqual({ method: 'prepare', value: null });
    await expect(peer.bind(execution)).rejects.toThrow('unavailable');
  } finally { release(); await client.close(); }
});

it('waits for an in-flight local allocation before confirming teardown after connection loss', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  let release!: () => void;
  const allocated = new Promise<void>(resolve => { release = resolve; });
  const assign = vi.fn(async () => { await allocated; return { execute: async () => { throw new Error('Must not run'); } }; });
  const stop = vi.fn(async () => {});
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), assign, stopWorkloads: stop });
  try {
    const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
    const peer = peers.at(-1)!, rejected = expect(peer.bind(execution)).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    peer.close(); const stopped = client.close();
    expect(stop).not.toHaveBeenCalled();
    release(); expect(await stopped).toBe(true); await rejected;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('indeterminate');
  } finally { release(); await client.close(); }
});

import { DesktopCompute } from '../src/launcher/desktopCompute.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { buildTierClients } from '../src/run/providers.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { receiveArtifactExport } from '../src/run/artifactTransfer.js';
import { OLLAMA_PINS } from './tier-pins.js';

vi.mock('../src/run/providers.js', async original => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));

it.skipIf(!process.env['ATOMA_TEST_WORKSPACE_IMAGE'] || !process.env['ATOMA_TEST_WORKER_IMAGE'])(
  'assigns a real desktop container over TLS and confirms engine teardown on disconnection', async () => {
    const owner = actor(), paired = pairing(owner), p = project(owner);
    devices.grantProject(owner, paired.deviceId, p.projectId, true);
    devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
    const runId = run(owner, p.projectId);
    const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    const machineId = randomUUID(), filter = `label=dev.atoma.compute=${machineId}`;
    const runtime = new DesktopCompute({ machineId,
      workspaceImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKSPACE_IMAGE']!]),
      workerImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKER_IMAGE']!]) });
    const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
      ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: () => runtime.close(),
      assign: async () => { await runtime.open(); return { execute: command => runtime.command(command), tools: runtime.executor }; } });
    try {
      const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
      const peer = peers.at(-1)!;
      await peer.bind(execution);
      const workspace = remoteWorkspaceRuntime(command => peer.request(execution, command));
      const hostPath = join(root, `unavailable-${randomUUID()}`);
      writeFileSync(hostPath, 'host sentinel');
      for (const [key, value] of Object.entries({ ...OLLAMA_PINS, ATOMA_DB_PATH: join(root, `${randomUUID()}.db`),
        ATOMA_BUILD_WORKSPACE: hostPath, ATOMA_RUNS_DIR: join(root, 'runner-traces'), ATOMA_SKILLS_DIR: join(root, 'runner-skills'),
        ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_BUILD_TIMEOUT_MS: '60000' })) vi.stubEnv(key, value);
      resetHostLifecycleSnapshotForTests();
      vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async request => {
        await request.executor!.execute('write_file', { path: 'remote.txt', content: 'real remote bytes' });
        return { text: 'Done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      } } });
      // Trusted host declarations, not a catalogue supplied by the device.
      const catalogue = localToolBackend({ workspaceRoot: join(root, 'catalogue'), logger: silentLogger() });
      const declarations = catalogue.toolDecls; await catalogue.cleanup();
      const handle = await startTask(['--baseline', '--no-learn-skills', '--no-direct-skills', 'Write a result'], {
        workspaceRuntime: workspace, createToolBackend: async () => computeToolBackend({ declarations,
          send: command => peer.requestTool(execution, command) }),
      });
      try { await handle.settled; } finally { await handle.shutdown(); }
      expect(readFileSync(hostPath, 'utf8')).toBe('host sentinel');
      const delivery = join(root, `delivery-${randomUUID()}`);
      await receiveArtifactExport(await workspace.artifactExport({ allowEmpty: false }), delivery);
      expect(readFileSync(join(delivery, 'remote.txt'), 'utf8')).toBe('real remote bytes');
      const snapshot = await workspace.checkpointExport();
      try {
        const bytes: Buffer[] = [];
        for await (const frame of snapshot.frames()) if (frame.kind === 'chunk') bytes.push(Buffer.from(frame.bytes));
        expect(Buffer.concat(bytes).toString()).toBe('real remote bytes');
      } finally { await snapshot.close(); }
      peer.close();
      expect(await client.close()).toBe(true);
      expect(docker(['ps', '-aq', '--filter', filter])).toBe('');
      // Local absence is not yet an authenticated server reconciliation report.
      expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('indeterminate');
    } finally {
      closeStoreHandles(); vi.unstubAllEnvs(); resetHostLifecycleSnapshotForTests();
      await client.close(); await runtime.close();
      const volumes = docker(['volume', 'ls', '-q', '--filter', filter]).split('\n').filter(Boolean);
      if (volumes.length) docker(['volume', 'rm', ...volumes]);
    }
  }, 90_000);

it.each([true, false])('reconciles the old generation after reconnect only with confirmed local stop (%s)', async confirmed => {
  const f = await connected(); f.peer.close();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reconcile = vi.fn(async () => { await wait; if (!confirmed) throw new Error('Docker unavailable'); });
  const connecting = connectComputeWorkspace({ url, credential: f.paired.credential, machineId: f.paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), reconcile,
    assign: async () => ({ execute: async () => { throw new Error('Must not run'); } }), stopWorkloads: async () => {} });
  const rejected = confirmed ? undefined : expect(connecting).rejects.toThrow('reconciliation');
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith(f.execution));
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
  release();
  if (confirmed) {
    const client = await connecting;
    try {
      expect(devices.inspect(f.owner, f.paired.deviceId).assignment).toBeNull();
      await expect(peers.at(-1)!.request(f.execution, { method: 'restart' })).rejects.toThrow('execution');
    } finally { await client.close(); }
  } else {
    await rejected;
    expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
  }
});

it('accepts forwarded TLS only from an explicitly trusted proxy and locates exact session generations', async () => {
  const { createServer: httpServer } = await import('node:http');
  const http = httpServer();
  let admissionCount = 0;
  let proxy = attachComputeGateway(http, devices, () => { admissionCount++; });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const endpoint = `ws://127.0.0.1:${address.port}/compute/v1`;
  const refused = async (headers: Record<string, string>, path = '/compute/v1') => {
    const ws = new WebSocket(new URL(path, endpoint), { headers, handshakeTimeout: 1000 });
    const failure = new Promise<string>(resolve => ws.once('error', error => resolve(error.message)));
    const error = await failure; ws.terminate();
    expect(error).not.toMatch(/timed out/i);
  };
  try {
    await refused({ 'x-forwarded-proto': 'https' }, '/unsupported-upgrade');
    await refused({ 'x-forwarded-proto': 'https' });
    expect(admissionCount).toBe(0);
    proxy.close(); proxy = attachComputeGateway(http, devices, () => { admissionCount++; }, { addresses: ['127.0.0.1'] });
    await refused({ 'x-forwarded-proto': 'http' });
    await refused({ 'x-forwarded-proto': 'https', origin: 'https://attacker.example' });
    await refused({ 'x-forwarded-proto': 'https', cookie: 'session=browser' });
    expect(admissionCount).toBe(0);
    const owner = actor(), paired = pairing(owner);
    const ws = new WebSocket(endpoint, { headers: { 'x-forwarded-proto': 'https' } });
    clients.push(ws); await once(ws, 'open');
    const response = message(ws);
    ws.send(JSON.stringify({ kind: 'hello', version: 1, credential: paired.credential, machineId: paired.deviceId, capabilities }));
    const ready = await response;
    if (ready.kind !== 'ready') throw new Error('Expected ready');
    expect(proxy.connectionFor(ready.session)?.identity()).toEqual(ready.session);
    expect(proxy.connectionFor({ ...ready.session, generation: ready.session.generation + 1 })).toBeUndefined();
    expect(admissionCount).toBe(1);
  } finally { proxy.close(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

it.skipIf(!process.env['ATOMA_TEST_WORKSPACE_IMAGE'] || !process.env['ATOMA_TEST_WORKER_IMAGE'])(
  'reconciles a headless machine journal before reconnecting and never restarts its old generation', async () => {
    const { ComputeMachine } = await import('../src/launcher/computeMachine.js');
    const owner = actor(), paired = pairing(owner), p = project(owner);
    devices.grantProject(owner, paired.deviceId, p.projectId, true);
    devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
    const runId = run(owner, p.projectId);
    const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    const config = { stateRoot: realpathSync(mkdtempSync(join(root, 'machine-'))),
      workspaceImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKSPACE_IMAGE']!]),
      workerImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKER_IMAGE']!]) };
    let machine = new ComputeMachine(config);
    const filter = `label=dev.atoma.compute=${machine.machineId()}`;
    const connection = { url, credential: paired.credential, capabilities, ca: readFileSync(join(root, 'cert'), 'utf8') };
    try {
      const client = await machine.connect(connection);
      const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
      const peer = peers.at(-1)!; await peer.bind(execution);
      await peer.request(execution, { method: 'prepare', clean: false });
      await peer.requestTool(execution, { method: 'invoke', name: 'write_file', args: { path: 'proof.txt', content: 'retained' } });
      expect(() => new ComputeMachine(config)).toThrow(/locked/i);
      peer.close();
      expect(await client.finished).toBe(true);
      // The native client reconnects using the same inventory owner, without
      // constructing a new machine or replaying the previous execution.
      const fresh = await machine.connect(connection);
      expect(fresh.session.generation).toBeGreaterThan(client.session.generation);
      expect(devices.inspect(owner, paired.deviceId).assignment).toBeNull();
      await machine.close(); await machine.close();
      machine = new ComputeMachine(config);
      expect(machine.allocations()).toMatchObject([{ execution, state: 'stopped' }]);
      const reconnected = await machine.connect(connection);
      expect(devices.inspect(owner, paired.deviceId).assignment).toBeNull();
      expect(docker(['ps', '-aq', '--filter', filter])).toBe('');
      await expect(peers.at(-1)!.request(execution, { method: 'prepare', clean: true })).rejects.toThrow();
      const recovered = { runId, generation: devices.assign(owner, reconnected.session, runId, resources).generation };
      const recoveryPeer = peers.at(-1)!;
      await recoveryPeer.bind(recovered, execution);
      const recoveredWorkspace = remoteWorkspaceRuntime(command => recoveryPeer.request(recovered, command));
      const output = join(root, `recovered-${randomUUID()}`);
      await receiveArtifactExport(await recoveredWorkspace.artifactExport({ allowEmpty: false }), output);
      expect(readFileSync(join(output, 'proof.txt'), 'utf8')).toBe('retained');
      await expect(recoveredWorkspace.prepare(true)).rejects.toThrow();
      expect(machine.allocations()).toHaveLength(2);
    } finally {
      await machine.close();
      const volumes = docker(['volume', 'ls', '-q', '--filter', filter]).split('\n').filter(Boolean);
      if (volumes.length) docker(['volume', 'rm', ...volumes]);
    }
  }, 90_000);

import { ComputeDispatcher, ComputeDispatchStore, ComputeDispatchPendingError } from '../src/projects/computeDispatch.js';
import { connectComputeBridge } from '../src/run/computeBridge.js';
import { COMPUTE_BRIDGE_ENV } from '../src/contracts/computeBridge.js';
import { formatRunStatsEpilogue } from '../src/contracts/runStats.js';

it.each(['complete', 'lost-command', 'lost-transfer'] as const)('dispatches the real bridge and preserves remote recovery evidence: %s', async scenario => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const folder = join(root, randomUUID());
  const workspace = localWorkspaceRuntime({ root: join(folder, 'remote'), log: () => {} });
  await workspace.prepare(true);
  writeFileSync(join(folder, 'remote', 'result.txt'), 'remote delivery');
  const handler = workspaceCommandHandler(workspace);
  const receipt = projects.createProjectRun({ orgId: owner.orgId, projectId: p.projectId, principalId: owner.principalId,
    request: { idempotencyKey: randomUUID(), goal: 'Compute dispatch' },
    hostPaths: { workspacePath: join(folder, 'received'), runsPath: join(folder, 'traces'), logPath: join(folder, 'run.log') } })!.run;
  const manifestPath = join(folder, 'declared.json');
  writeFileSync(manifestPath, JSON.stringify({ version: 1, runId: receipt.projectRunId, generatedAt: new Date().toISOString(), outputs: ['result.txt'] }));
  const drain = vi.fn(async () => {});
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: async () => {},
    assign: async () => ({ execute: async command => {
      if (scenario === 'lost-transfer' && command.method === 'artifact-open') throw new Error('Lost transport');
      return handler(command);
    }, tools: { has: () => true, execute: async () => null, drain } }) });
  const journal = new ComputeDispatchStore(db);
  const dispatcher = new ComputeDispatcher({ devices, journal, resources, connectionFor: session => gateway.connectionFor(session) });
  expect(dispatcher.readiness(receipt).status).toBe('ready');
  projects.transitionProjectRun({ orgId: owner.orgId, projectRunId: receipt.projectRunId, from: 'queued', to: 'running' });
  const driver = vi.fn(async (input: Parameters<import('../src/projects/coordinator.js').ProjectRunDriver>[0]) => {
    expect(input.env?.['PRIVATE_MODEL_KEY']).toBe('host-only');
    const bridge = await connectComputeBridge(JSON.parse(input.env![COMPUTE_BRIDGE_ENV]!));
    try {
      await bridge.send({ channel: 'workspace', command: { method: 'validate-sources' } });
      if (scenario === 'lost-command') {
        peers.at(-1)!.close();
        await vi.waitFor(() => expect(input.signal?.aborted).toBe(true));
      }
      return formatRunStatsEpilogue({ outcome: 'delivered', costUsd: 0, llmCalls: 0, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, otherCalls: 0,
        deterministicPhases: 0, deepenings: 0, rootRemediations: 0, landingRemediations: 0, unjudgedRemediations: 0,
        discardedLessons: 0, triggerRejections: 0, suiteDisputes: 0, landingReasons: [], escalations: 0, learnedSkills: 0,
        learnedEventSkills: 0, promotions: 0, refusals: 0, compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0 });
    } finally { bridge.close(); }
  });
  try {
    const result = dispatcher.drive(receipt, driver, { goal: receipt.goal, timeoutMs: 5000, logPath: receipt.hostPaths.logPath,
      env: { PRIVATE_MODEL_KEY: 'host-only' } }, manifestPath);
    if (scenario === 'complete') {
      await result;
      expect(readFileSync(join(receipt.hostPaths.workspacePath, 'result.txt'), 'utf8')).toBe('remote delivery');
      expect(journal.inspect(receipt.projectRunId)?.phase).toBe('transferred');
      expect(drain).toHaveBeenCalledOnce();
    } else {
      await expect(result).rejects.toBeInstanceOf(ComputeDispatchPendingError);
      expect(journal.inspect(receipt.projectRunId)?.phase).toBe(scenario === 'lost-command' ? 'interrupted' : 'finalizing');
    }
    expect(driver).toHaveBeenCalledOnce();
    expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('indeterminate');
    projects.reconcileInterrupted('server restarted');
    expect(projects.getProjectRun(owner.orgId, receipt.projectRunId)?.status).toBe('running');
    if (scenario === 'lost-transfer') {
      await client.close();
      const previous = { runId: receipt.projectRunId, generation: journal.inspect(receipt.projectRunId)!.generation };
      const recovery = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
        ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: async () => {},
        reconcile: async execution => { expect(execution).toEqual(previous); },
        assign: async (execution, recover) => {
          expect(recover).toEqual(previous); expect(execution.generation).toBeGreaterThan(previous.generation);
          return { execute: handler };
        } });
      try {
        await dispatcher.recover(projects.getProjectRun(owner.orgId, receipt.projectRunId)!, manifestPath);
        expect(readFileSync(join(receipt.hostPaths.workspacePath, 'result.txt'), 'utf8')).toBe('remote delivery');
        expect(journal.inspect(receipt.projectRunId)?.phase).toBe('transferred');
        expect(driver).toHaveBeenCalledOnce();
      } finally { await recovery.close(); }
    }
  } finally { await client.close(); }
});

it('rejects a replacement inventory even when it presents the existing device credential', async () => {
  const f = await connected(); f.peer.close();
  const ws = await client(), closed = once(ws, 'close');
  ws.send(JSON.stringify({ kind: 'hello', version: 1, credential: f.paired.credential, machineId: randomUUID(), capabilities }));
  await closed;
  expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
});

it.skipIf(!process.env['ATOMA_TEST_WORKSPACE_IMAGE'] || !process.env['ATOMA_TEST_WORKER_IMAGE'])(
  'reconciles an assignment lost before its first frame without allocating or replaying work', async () => {
    const { ComputeMachine } = await import('../src/launcher/computeMachine.js');
    const owner = actor(), paired = pairing(owner), p = project(owner);
    devices.grantProject(owner, paired.deviceId, p.projectId, true);
    devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
    const runId = run(owner, p.projectId);
    const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    const config = { stateRoot: realpathSync(mkdtempSync(join(root, 'pre-dispatch-'))),
      workspaceImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKSPACE_IMAGE']!]),
      workerImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKER_IMAGE']!]) };
    let machine = new ComputeMachine(config);
    const filter = `label=dev.atoma.compute=${machine.machineId()}`;
    const options = { url, credential: paired.credential, capabilities, ca: readFileSync(join(root, 'cert'), 'utf8') };
    try {
      const connected = await machine.connect(options);
      const execution = devices.assign(owner, connected.session, runId, resources);
      peers.at(-1)!.close(); await machine.close();
      const dispatcher = new ComputeDispatcher({ devices, journal: new ComputeDispatchStore(db), resources, connectionFor: session => gateway.connectionFor(session) });
      const receipt = projects.getProjectRun(owner.orgId, runId)!;
      expect(dispatcher.interruptedStopped(receipt)).toBe(false);
      expect(devices.confirmedStop(paired.deviceId, runId, execution.generation)).toBe(false);
      machine = new ComputeMachine(config); await machine.connect(options);
      expect(devices.confirmedStop(paired.deviceId, runId, execution.generation)).toBe(true);
      expect(dispatcher.interruptedStopped(receipt)).toBe(true);
      expect(devices.inspect(owner, paired.deviceId).assignment).toBeNull();
      expect(docker(['ps', '-aq', '--filter', filter])).toBe('');
      expect(docker(['volume', 'ls', '-q', '--filter', filter])).toBe('');
    } finally { await machine.close(); }
  }, 90_000);

it('accepts device-owner controls only for the bound execution and keeps refusal of new runs durable', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: async () => {},
    assign: async () => ({ execute: async () => { throw new Error('No workspace command expected'); } }) });
  try {
    await expect(client.requestControl('pause')).rejects.toThrow('unavailable');
    await client.requestControl('accepting', false);
    expect(devices.admission(owner, runId, resources)).toEqual({ status: 'waiting', reason: 'not-accepting' });
    await client.requestControl('accepting', true);
    const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
    await peers.at(-1)!.bind(execution);
    await client.requestControl('pause');
    expect(controls).toHaveBeenLastCalledWith(owner.orgId, execution, 'pause');
    await client.requestControl('stop');
    expect(controls).toHaveBeenLastCalledWith(owner.orgId, execution, 'stop');
    await client.requestControl('accepting', false);
    expect(devices.inspect(owner, paired.deviceId).accepting).toBe(false);
    // The acknowledgement means requested, never stopped.
    expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('active');
  } finally { await client.close(); }
});

it('keeps retrieval independent of workspace and tools and fences its results on revocation', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  let finish!: () => void;
  const started = vi.fn();
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: async () => {},
    assign: async () => ({ execute: async () => ({ method: 'validate-sources', value: null }),
      retrieval: async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return { method: 'prepare', value: null }; } }) });
  try {
    const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation }, peer = peers.at(-1)!;
    await peer.bind(execution);
    const pending = peer.requestRetrieval(execution, { method: 'prepare' });
    const rejected = expect(pending).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await expect(peer.requestRetrieval(execution, { method: 'prepare' })).rejects.toThrow('busy');
    await expect(peer.request(execution, { method: 'validate-sources' })).resolves.toEqual({ method: 'validate-sources', value: null });
    devices.revoke(owner, paired.deviceId); finish();
    await rejected;
    expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('indeterminate');
  } finally { finish?.(); await client.close(); }
});

it('relays previews independently and invalidates pending traffic on device revocation', async () => {
  const owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId);
  projects.transitionProjectRun({ orgId: owner.orgId, projectRunId: runId, from: 'queued', to: 'running' });
  let finish!: () => void;
  const reading = vi.fn(), stop = vi.fn();
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: async () => { stop(); },
    preview: async (_identity, command) => {
      if (command.method === 'start') return { method: 'start', value: { kind: 'static', entry: 'index.html', imageDigest } };
      if (command.method === 'read') {
        reading(); await new Promise<void>(resolve => { finish = resolve; });
        return { method: 'read', value: null };
      }
      throw new Error('Unexpected preview command');
    },
    assign: async () => ({ execute: async () => ({ method: 'validate-sources', value: null }) }) });
  try {
    const peer = peers.at(-1)!, identity = { runId, generation: 1, instanceId: randomUUID() };
    const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
    await peer.bind(execution);
    await expect(peer.requestPreview(identity, { method: 'start', source: 'in-flight', mode: 'app', copyMaxBytes: 1024,
      allowedHosts: [], attribution: true, hardMs: 60_000 })).resolves.toMatchObject({ method: 'start' });
    await expect(peer.requestPreview({ ...identity, generation: 2 }, { method: 'connect' })).rejects.toThrow();
    const pending = peer.requestPreview(identity, { method: 'read', stream: randomUUID() });
    const rejected = expect(pending).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    await expect(peer.request(execution, { method: 'validate-sources' })).resolves.toMatchObject({ method: 'validate-sources' });
    devices.revoke(owner, paired.deviceId); finish();
    await rejected;
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('indeterminate');
  } finally { finish?.(); await client.close(); }
});

it.skipIf(!process.env['ATOMA_TEST_WORKSPACE_IMAGE'] || !process.env['ATOMA_TEST_WORKER_IMAGE'])(
  'stops actual workloads on low disk and keeps their server assignment indeterminate until reconciliation', async () => {
    const { ComputeMachine } = await import('../src/launcher/computeMachine.js');
    const owner = actor(), paired = pairing(owner), p = project(owner);
    devices.grantProject(owner, paired.deviceId, p.projectId, true);
    devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
    const runId = run(owner, p.projectId);
    const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    const machine = new ComputeMachine({ stateRoot: realpathSync(mkdtempSync(join(root, 'disk-machine-'))),
      workspaceImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKSPACE_IMAGE']!]),
      workerImage: docker(['image', 'inspect', '--format', '{{.Id}}', process.env['ATOMA_TEST_WORKER_IMAGE']!]) });
    const filter = `label=dev.atoma.compute=${machine.machineId()}`;
    const disk = vi.spyOn(DesktopCompute.prototype, 'freeDiskBytes').mockResolvedValueOnce(8 * 1024 ** 3).mockResolvedValue(0);
    try {
      const client = await machine.connect({ url, credential: paired.credential, capabilities, ca: readFileSync(join(root, 'cert'), 'utf8') });
      const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
      const peer = peers.at(-1)!; await peer.bind(execution);
      await peer.request(execution, { method: 'prepare', clean: false });
      await peer.requestTool(execution, { method: 'invoke', name: 'write_file', args: { path: 'proof.txt', content: 'retained under disk pressure' } });
      expect(await client.finished).toBe(true);
      expect(machine.diskStatus().freeBytes).toBe(0);
      expect(machine.allocations()).toMatchObject([{ execution, state: 'stopped' }]);
      await vi.waitFor(() => expect(devices.inspect(owner, paired.deviceId).assignment?.state).toBe('indeterminate'));
      expect(docker(['ps', '-aq', '--filter', filter])).toBe('');
      expect(docker(['volume', 'ls', '-q', '--filter', filter])).not.toBe('');
    } finally {
      disk.mockRestore(); await machine.close();
      const volumes = docker(['volume', 'ls', '-q', '--filter', filter]).split('\n').filter(Boolean);
      if (volumes.length) docker(['volume', 'rm', ...volumes]);
    }
  }, 90_000);


it('reports connection loss to the desktop before engine teardown has completed', async () => {
  const owner = actor(), paired = pairing(owner);
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  const disconnected = vi.fn();
  const connection = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    execution: { runId: randomUUID(), generation: 1 }, ca: readFileSync(join(root, 'cert'), 'utf8'),
    execute: async () => { throw new Error('Unreachable'); }, onDisconnect: disconnected, stopWorkloads: () => cleanup });
  const stopped = vi.fn();
  const closure = connection.close().then(stopped);
  try {
    expect(disconnected).toHaveBeenCalledOnce(); expect(stopped).not.toHaveBeenCalled();
    expect(connection.state()).toBe('stopping');
  } finally { finish(); await closure; }
  expect(stopped).toHaveBeenCalledWith(true);
});

it('logs the first server close cause with pending identities and excludes private payloads', async () => {
  const f = await connected(), lines: string[] = [];
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  try {
    const command = message(f.ws);
    const result = f.peer.request(f.execution, { method: 'replace-manifest', text: 'PRIVATE_FILE_CONTENT' });
    const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await command;
    const closed = once(f.ws, 'close');
    f.ws.close(1000, 'PRIVATE_CLOSE_REASON');
    await rejected; await closed;
    f.peer.close();
    const records = lines.filter(line => line.startsWith('[atoma compute] ')).map(line => JSON.parse(line.slice(16)) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ side: 'server', reason: 'socket-close', deviceId: f.paired.deviceId,
      connectionGeneration: f.session.generation, runId: f.runId, executionGeneration: f.execution.generation,
      closeCode: 1000, closeReasonBytes: 20, pending: [{ channel: 'workspace', id: 1, method: 'replace-manifest' }] });
    expect(lines.join('')).not.toContain('PRIVATE_');
    expect(lines.join('')).not.toContain(f.paired.credential);
  } finally { output.mockRestore(); }
});

it('reports store lease expiry while fencing pending work without replay', async () => {
  const f = await connected(), lines: string[] = [];
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  try {
    const command = message(f.ws);
    const result = f.peer.request(f.execution, { method: 'restart' });
    const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await command;
    // The actual store deadline expires while the TLS socket still looks open.
    // No fake exception: the production watchdog reads and fences this session.
    const closed = once(f.ws, 'close');
    now += 30_001;
    await rejected; await closed;
    expect(f.peer.signal.aborted).toBe(true);
    expect(f.peer.identity()).toBeUndefined();
    const records = lines.filter(line => line.startsWith('[atoma compute] '))
      .map(line => JSON.parse(line.slice(16)) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ side: 'server', reason: 'session-invalid', failure: 'session-expired',
      deviceId: f.paired.deviceId, sessionId: f.session.sessionId,
      connectionGeneration: f.session.generation, runId: f.runId, executionGeneration: f.execution.generation,
      socketState: WebSocket.OPEN, pending: [{ channel: 'workspace', id: 1, method: 'restart' }] });
    expect(() => devices.validateSession(f.session)).toThrow();
    await expect(f.peer.request(f.execution, { method: 'restart' })).rejects.toThrow('Compute transport unavailable');
    expect(lines.join('')).not.toContain(f.paired.credential);
  } finally { output.mockRestore(); }
});

it('distinguishes a workspace RPC timeout from a socket close', async () => {
  const f = await connected(), lines: string[] = [];
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  try {
    vi.useFakeTimers();
    const result = f.peer.request(f.execution, { method: 'restart' });
    const rejected = expect(result).rejects.toBeInstanceOf(ComputeIndeterminateError);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
    expect(lines.join('')).toContain('"reason":"workspace-timeout"');
    expect(lines.join('')).toContain('"method":"restart"');
    expect(lines.join('')).not.toContain('"reason":"socket-close"');
  } finally { vi.useRealTimers(); output.mockRestore(); }
});

it('records client disconnect and confirmed cleanup in its durable diagnostic sink', async () => {
  const owner = actor(), paired = pairing(owner), lines: string[] = [];
  const stopped = vi.fn(async () => {});
  const client = await connectComputeWorkspace({ url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), assign: async () => { throw new Error('not assigned'); },
    diagnostic: line => lines.push(line), stopWorkloads: stopped });
  try {
    peers.at(-1)!.close();
    expect(await client.finished).toBe(true);
    const records = lines.map(line => JSON.parse(line.slice(16)) as Record<string, unknown>);
    expect(records.map(record => record.reason)).toEqual(['connected', 'socket-close', 'stop-confirmed']);
    expect(records[1]).toMatchObject({ side: 'client', deviceId: paired.deviceId, closeCode: 1000 });
    expect(stopped).toHaveBeenCalledOnce();
    expect(lines.join('')).not.toContain(paired.credential);
  } finally { await client.close(); }
});


it.each(['json', 'schema'] as const)('logs rejected %s frames without their contents', async kind => {
  const f = await connected(), lines: string[] = [];
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
  try {
    const closed = once(f.ws, 'close');
    f.ws.send(kind === 'json' ? 'PRIVATE_NOT_JSON' : JSON.stringify({ kind: 'heartbeat', id: 0, secret: 'PRIVATE_CONTENT' }));
    await closed;
    expect(lines.join('')).toContain('"reason":"invalid-frame"');
    expect(lines.join('')).toContain(kind === 'json' ? '"failure":"json-decoding"' : '"failure":"schema-validation"');
    expect(lines.join('')).not.toContain('PRIVATE');
  } finally { output.mockRestore(); }
});

// Real TLS on both sides of a controllable network link. Only synthetic frames
// are inspected; the production gateway, lease, store and client remain intact.
import { WebSocketServer } from 'ws';
import { COMPUTE_RESUME_PROTOCOL, computeTransportFrameSchema } from '../src/contracts/computeTransport.js';
import type { WorkspaceCommand, WorkspaceReply } from '../src/contracts/workspaceProtocol.js';
async function networkLink() {
  const front = createServer({ key: readFileSync(join(root, 'key')), cert: readFileSync(join(root, 'cert')) });
  const wss = new WebSocketServer({ server: front });
  const links: { incoming: WebSocket; outgoing: WebSocket }[] = [];
  let filter: (direction: 'up' | 'down', text: string, connection: number) => boolean = () => true;
  let offline = false, refused = 0;
  wss.on('connection', incoming => {
    // A proxy that is down refuses the upgrade outright: the client sees a
    // failed candidate and keeps retrying under its unchanged lease.
    if (offline) { refused++; incoming.terminate(); return; }
    const outgoing = new WebSocket(url, incoming.protocol || undefined, { ca: readFileSync(join(root, 'cert'), 'utf8') });
    const link = { incoming, outgoing }, number = links.push(link);
    const queued: string[] = [];
    incoming.on('error', () => {}); outgoing.on('error', () => incoming.terminate());
    incoming.on('close', () => outgoing.terminate()); outgoing.on('close', () => incoming.terminate());
    incoming.on('message', data => {
      const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString('utf8');
      if (!filter('up', text, number)) return;
      if (outgoing.readyState === WebSocket.OPEN) outgoing.send(text); else queued.push(text);
    });
    outgoing.on('open', () => { for (const text of queued) outgoing.send(text); queued.length = 0; });
    outgoing.on('message', data => {
      const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString('utf8');
      if (filter('down', text, number) && incoming.readyState === WebSocket.OPEN) incoming.send(text);
    });
  });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  const address = front.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy');
  return { url: `wss://127.0.0.1:${address.port}/compute/v1`, links,
    filter(value: typeof filter) { filter = value; },
    cut() { for (const { incoming, outgoing } of links) { incoming.terminate(); outgoing.terminate(); } },
    /** Both legs close at once (code 1006 on both peers) and no upgrade is served until the proxy is back. */
    restart(downMs: number) {
      offline = true;
      for (const { incoming, outgoing } of links) { incoming.terminate(); outgoing.terminate(); }
      setTimeout(() => { offline = false; }, downMs).unref();
    },
    refused: () => refused,
    async close() {
      for (const { incoming, outgoing } of links) { incoming.terminate(); outgoing.terminate(); }
      wss.close(); await new Promise<void>(resolve => front.close(() => resolve()));
    } };
}
async function migratingClient(linkUrl: string, execute: (command: WorkspaceCommand) => Promise<WorkspaceReply>,
  tools?: { has(name: string): boolean; execute(name: string, args: unknown): Promise<unknown>; drain(): Promise<void> }) {
  const owner = actor(), paired = pairing(owner), p = project(owner), lines: string[] = [];
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId), execution = { runId, generation: 1 }, stop = vi.fn(async () => {});
  const client = await connectComputeWorkspace({ url: linkUrl, credential: paired.credential, machineId: paired.deviceId, capabilities,
    execution, execute, ...(tools ? { tools } : {}),
    ca: readFileSync(join(root, 'cert'), 'utf8'), stopWorkloads: stop, diagnostic: line => lines.push(line) });
  devices.assign(owner, client.session, runId, resources);
  return { owner, paired, client, execution, stop, lines, peer: peers.at(-1)! };
}
function bodyKind(text: string): string | undefined {
  const parsed = computeTransportFrameSchema.safeParse(JSON.parse(text));
  if (parsed.success && (parsed.data.kind === 'channel-data' || parsed.data.kind === 'channel-open')) return String(parsed.data.body.kind);
  return undefined;
}
it.each(['pending-command', 'lost-command', 'lost-result', 'lost-result-ack'] as const)(
  'keeps the same live execution across Wi-Fi loss without duplicate effects: %s', async scenario => {
    const link = await networkLink();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async (): Promise<WorkspaceReply> => { await gate; return { method: 'prepare', value: null }; });
    const f = await migratingClient(link.url, execute);
    let dropped = false, resultPassed = false;
    link.filter((direction, text) => {
      const kind = bodyKind(text);
      if (scenario === 'lost-result-ack' && direction === 'up' && kind === 'workspace-result') resultPassed = true;
      const target = (scenario === 'lost-command' && direction === 'down' && kind === 'workspace-command') ||
        (scenario === 'lost-result' && direction === 'up' && kind === 'workspace-result') ||
        (scenario === 'lost-result-ack' && resultPassed && direction === 'down' && JSON.parse(text).kind === 'channel-ack');
      if (!dropped && target) { dropped = true; link.cut(); return false; }
      return true;
    });
    try {
      const result = f.peer.request(f.execution, { method: 'prepare', clean: false });
      if (scenario === 'pending-command') {
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce()); link.cut();
      }
      release();
      await expect(result).resolves.toEqual({ method: 'prepare', value: null });
      await vi.waitFor(() => expect(f.lines.some(line => line.includes('transport-resumed'))).toBe(true), { timeout: 4000 });
      expect(execute).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
      expect(peers).toHaveLength(1); expect(f.peer.signal.aborted).toBe(false);
      expect(gateway.connectionFor(f.client.session)).toBe(f.peer);
      expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.generation).toBe(f.execution.generation);
      await expect(f.peer.request(f.execution, { method: 'prepare', clean: false })).resolves.toEqual({ method: 'prepare', value: null });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(f.lines.join('')).not.toContain(f.paired.credential);
    } finally { release(); await f.client.close(); await link.close(); }
  });

it('replaces a silently stale OPEN socket before the unchanged 30-second lease expires', async () => {
  const link = await networkLink();
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(link.url, execute);
  // Old TCP remains OPEN in both processes, but no bytes cross the old network.
  link.filter((_direction, _text, connection) => connection > 1);
  try {
    const result = f.peer.request(f.execution, { method: 'prepare', clean: false });
    await expect(result).resolves.toEqual({ method: 'prepare', value: null });
    expect(link.links.length).toBe(2);
    expect(execute).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
    expect(f.peer.signal.aborted).toBe(false); expect(f.client.state()).toBe('active');
  } finally { await f.client.close(); await link.close(); }
}, 15_000);

it('does not revive an expired server lease during network migration', async () => {
  const link = await networkLink();
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(link.url, execute);
  try {
    now += 30_001; link.cut();
    await vi.waitFor(() => expect(f.peer.signal.aborted).toBe(true), { timeout: 2000 });
    expect(gateway.connectionFor(f.client.session)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(devices.inspect(f.owner, f.paired.deviceId).assignment?.state).toBe('indeterminate');
  } finally { await f.client.close(); await link.close(); }
});

it('rejects forged migration identities and acknowledgements without replacing the healthy connection', async () => {
  const link = await networkLink();
  let token = '', received = 0;
  link.filter((direction, text) => {
    const frame = computeTransportFrameSchema.safeParse(JSON.parse(text));
    if (direction === 'down' && frame.success && (frame.data.kind === 'channel-open' || frame.data.kind === 'channel-data')) {
      received = frame.data.seq;
      if (frame.data.kind === 'channel-open') token = frame.data.token;
    }
    return true;
  });
  const f = await migratingClient(link.url, async () => ({ method: 'prepare', value: null }));
  const other = pairing(actor());
  try {
    const base = { kind: 'channel-resume' as const, token, epoch: 1, received, credential: f.paired.credential,
      machineId: f.paired.deviceId, session: f.client.session };
    const variants = [
      { ...base, token: randomBytes(32).toString('base64url') },
      { ...base, credential: other.credential },
      { ...base, machineId: randomUUID() },
      { ...base, session: { ...base.session, generation: base.session.generation + 1 } },
      { ...base, received: Number.MAX_SAFE_INTEGER },
      { ...base, received: 0 },
    ];
    for (const request of variants) {
      const socket = new WebSocket(url, COMPUTE_RESUME_PROTOCOL, { ca: readFileSync(join(root, 'cert'), 'utf8') });
      clients.push(socket); await once(socket, 'open');
      const closed = once(socket, 'close'); socket.send(JSON.stringify(request)); await closed;
      expect(f.peer.signal.aborted).toBe(false); expect(gateway.connectionFor(f.client.session)).toBe(f.peer);
    }
    expect(peers).toHaveLength(1); expect(f.stop).not.toHaveBeenCalled();
    await expect(f.peer.request(f.execution, { method: 'prepare', clean: false })).resolves.toEqual({ method: 'prepare', value: null });
  } finally { await f.client.close(); await link.close(); }
});

it.each(['device', 'membership', 'project'] as const)('rechecks %s authority before resuming any queued command', async authority => {
  const link = await networkLink();
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(link.url, execute);
  link.filter((_direction, _text, connection) => connection > 1);
  try {
    const pending = f.peer.request(f.execution, { method: 'prepare', clean: false });
    const rejected = expect(pending).rejects.toBeInstanceOf(ComputeIndeterminateError);
    if (authority === 'device') devices.revoke(f.owner, f.paired.deviceId);
    else if (authority === 'membership') db.prepare("UPDATE auth_memberships SET role='org:viewer' WHERE principal_id=?").run(f.owner.principalId);
    else {
      const target = projects.getProjectRun(f.owner.orgId, f.execution.runId)!;
      devices.grantProject(f.owner, f.paired.deviceId, target.projectId, false);
    }
    link.cut(); await rejected;
    expect(execute).not.toHaveBeenCalled(); expect(f.peer.signal.aborted).toBe(true);
    expect(f.lines.join('')).not.toContain('transport-resumed');
  } finally { await f.client.close(); await link.close(); }
});

it('keeps legacy server interoperability and does not mistake a subprotocol echo for migration support', async () => {
  gateway.close();
  const legacy = new WebSocketServer({ noServer: true, maxPayload: COMPUTE_FRAME_BYTES, perMessageDeflate: false });
  const upgrade = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    legacy.handleUpgrade(request, socket, head, ws => {
      const peer = new ComputeConnection(ws, devices); peers.push(peer);
    });
  };
  server.on('upgrade', upgrade);
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(url, execute);
  try {
    await expect(f.peer.request(f.execution, { method: 'prepare', clean: false })).resolves.toEqual({ method: 'prepare', value: null });
    f.peer.close(); expect(await f.client.finished).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.lines.join('')).not.toContain('transport-resumed');
    expect(f.lines.map(line => JSON.parse(line.slice(16))).find(record => record.reason === 'socket-close').closeCode).toBe(1006);
  } finally {
    await f.client.close(); server.off('upgrade', upgrade);
    for (const ws of legacy.clients) ws.terminate(); legacy.close();
  }
});

it('never resurrects local workloads after the existing client lease expires in a prolonged outage', async () => {
  const link = await networkLink();
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(link.url, execute);
  link.filter(() => false);
  try {
    // Do not alter the timer or budget: wall elapsed time catches sleep/network
    // outages even if the event loop has not delivered the deadline callback.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    link.cut();
    expect(await f.client.finished).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    link.filter(() => true);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(f.client.state()).toBe('stopped'); expect(f.lines.join('')).not.toContain('transport-resumed');
  } finally { vi.restoreAllMocks(); await f.client.close(); await link.close(); }
});

it('reauthenticates a transport resume without renewing the store lease or execution generation', async () => {
  const f = await connected();
  const before = db.prepare('SELECT lease_until,connection_generation,execution_generation FROM compute_devices WHERE device_id=?').get(f.paired.deviceId);
  now += 10_000;
  devices.validateResume(f.paired.credential, f.session, f.paired.deviceId);
  expect(db.prepare('SELECT lease_until,connection_generation,execution_generation FROM compute_devices WHERE device_id=?').get(f.paired.deviceId)).toEqual(before);
});

it('keeps a pending allocation across migration and never allocates the execution twice', async () => {
  const link = await networkLink(), owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId), stop = vi.fn(async () => {});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const allocate = vi.fn(async () => { await gate; return { execute: async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }) }; });
  const client = await connectComputeWorkspace({ url: link.url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    ca: readFileSync(join(root, 'cert'), 'utf8'), assign: allocate, stopWorkloads: stop });
  const execution = { runId, generation: devices.assign(owner, client.session, runId, resources).generation };
  const peer = peers.at(-1)!;
  try {
    const bound = peer.bind(execution);
    await vi.waitFor(() => expect(allocate).toHaveBeenCalledOnce());
    link.cut(); release(); await bound;
    expect(allocate).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
    expect(peer.signal.aborted).toBe(false); expect(peers).toHaveLength(1);
    await expect(peer.request(execution, { method: 'prepare', clean: false })).resolves.toEqual({ method: 'prepare', value: null });
  } finally { release(); await client.close(); await link.close(); }
});

it('preserves an in-flight non-idempotent effect across TLS migration to a separately compiled client process', async () => {
  const { build } = await import('esbuild');
  const { spawn } = await import('node:child_process');
  const link = await networkLink(), owner = actor(), paired = pairing(owner), p = project(owner);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  devices.setProjectTarget(owner, p.projectId, { target: { kind: 'customer-device', deviceId: paired.deviceId }, expected: { kind: 'hosted' } });
  const runId = run(owner, p.projectId), execution = { runId, generation: 1 };
  const compiled = join(root, `${randomUUID()}.cjs`), effects = join(root, `${randomUUID()}.txt`);
  await build({ entryPoints: ['src/launcher/computeClient.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: compiled, logLevel: 'silent' });
  const config = { url: link.url, credential: paired.credential, machineId: paired.deviceId, capabilities,
    execution, ca: readFileSync(join(root, 'cert'), 'utf8') };
  const child = spawn(process.execPath, ['-e', `
    const { connectComputeWorkspace } = require(${JSON.stringify(compiled)});
    const { appendFileSync } = require('node:fs');
    let release; const gate = new Promise(resolve => { release = resolve; });
    const connecting = connectComputeWorkspace({ ...${JSON.stringify(config)},
      execute: async () => { appendFileSync(${JSON.stringify(effects)}, 'effect\\n'); process.send({kind:'started'}); await gate; return { method:'prepare', value:null }; },
      stopWorkloads: async () => { process.send({kind:'stopped'}); }
    });
    process.on('message', async message => {
      if (message === 'release') release();
      if (message === 'close') { await (await connecting).close(); process.disconnect(); }
    });
    connecting.then(client => process.send({kind:'ready', session: client.session}), () => process.exit(1));
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit'), messages: { kind: string; session?: import('../src/contracts/computeDevice.js').ComputeSession }[] = [];
  child.on('message', message => { messages.push(message as typeof messages[number]); });
  try {
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'ready')).toBe(true), { timeout: 5000 });
    const session = messages.find(message => message.kind === 'ready')!.session!;
    devices.assign(owner, session, runId, resources);
    const peer = peers.at(-1)!, result = peer.request(execution, { method: 'prepare', clean: false });
    await vi.waitFor(() => expect(messages.some(message => message.kind === 'started')).toBe(true));
    link.cut(); child.send('release');
    await expect(result).resolves.toEqual({ method: 'prepare', value: null });
    expect(readFileSync(effects, 'utf8')).toBe('effect\n'); expect(peers).toHaveLength(1);
    expect(peer.signal.aborted).toBe(false); expect(gateway.connectionFor(session)).toBe(peer);
    expect(messages.filter(message => message.kind === 'stopped')).toHaveLength(0);
    child.send('close'); expect((await exited)[0]).toBe(0);
    expect(messages.filter(message => message.kind === 'stopped')).toHaveLength(1);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await link.close(); }
});

// Run b0a6c063 (2026-10-23): an unattended nginx upgrade restarted the proxy
// for five seconds. Both ends saw close 1006 in the same millisecond with a
// tool invocation 17 s in flight; the legacy client confirmed a stop and the
// run failed. The resumable transport rides it out: the device retries under
// its unchanged 30-second lease, resumes the same session, and the in-flight
// tool result lands once, with no stop and no second execution.
it('rides out a proxy restart that closes both ends with a tool invocation in flight', async () => {
  const link = await networkLink();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const invoke = vi.fn(async (): Promise<unknown> => { await gate; return { ok: true, bytes: 7 }; });
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(link.url, execute, { has: () => true, execute: invoke, drain: async () => {} });
  try {
    const result = f.peer.requestTool(f.execution, { method: 'invoke', name: 'write_file', args: { path: 'proof.txt', content: 'retained' } });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    link.restart(1500);
    await vi.waitFor(() => expect(f.lines.some(line => line.includes('transport-interrupted'))).toBe(true), { timeout: 4000 });
    release();
    await expect(result).resolves.toEqual({ ok: true, bytes: 7 });
    await vi.waitFor(() => expect(f.lines.some(line => line.includes('transport-resumed'))).toBe(true), { timeout: 6000 });
    expect(link.refused()).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
    expect(peers).toHaveLength(1); expect(f.peer.signal.aborted).toBe(false);
    expect(gateway.connectionFor(f.client.session)).toBe(f.peer);
    expect(f.lines.join('')).not.toContain('socket-close'); expect(f.lines.join('')).not.toContain('stop-confirmed');
    // The same session keeps serving after the proxy is back.
    await expect(f.peer.requestTool(f.execution, { method: 'invoke', name: 'write_file', args: { path: 'again.txt', content: 'x' } })).resolves.toEqual({ ok: true, bytes: 7 });
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally { release(); await f.client.close(); await link.close(); }
});

it('survives another network loss during the resume handshake without losing the pending result', async () => {
  const link = await networkLink();
  const execute = vi.fn(async (): Promise<WorkspaceReply> => ({ method: 'prepare', value: null }));
  const f = await migratingClient(link.url, execute);
  let lostResult = false, lostResume = false;
  link.filter((direction, text, connection) => {
    if (!lostResult && direction === 'up' && bodyKind(text) === 'workspace-result') {
      lostResult = true; link.cut(); return false;
    }
    if (!lostResume && connection === 2 && direction === 'down' && JSON.parse(text).kind === 'channel-resumed') {
      lostResume = true; link.cut(); return false;
    }
    return true;
  });
  try {
    await expect(f.peer.request(f.execution, { method: 'prepare', clean: false })).resolves.toEqual({ method: 'prepare', value: null });
    expect(lostResult && lostResume).toBe(true); expect(link.links).toHaveLength(3);
    expect(execute).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
    expect(peers).toHaveLength(1); expect(f.peer.signal.aborted).toBe(false);
  } finally { await f.client.close(); await link.close(); }
});
