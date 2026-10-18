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
  imageDigest, cpus: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 };
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
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-compute-tls-')));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key'),
    '-out', join(root, 'cert'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
  peers = []; clients = [];
  server = createServer({ key: readFileSync(join(root, 'key')), cert: readFileSync(join(root, 'cert')) });
  gateway = attachComputeGateway(server, devices, peer => peers.push(peer));
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
  const owner = actor(), paired = pairing(owner), p = project(owner), runId = run(owner, p.projectId);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  const ws = await client(), ready = message(ws);
  ws.send(JSON.stringify({ kind: 'hello', version: 1, credential: paired.credential, capabilities }));
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
  ws.send(JSON.stringify({ kind: 'hello', version: 1, credential: f.paired.credential, capabilities }));
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
  const owner = actor(), paired = pairing(owner), p = project(owner), runId = run(owner, p.projectId);
  devices.grantProject(owner, paired.deviceId, p.projectId, true);
  const workspace = join(root, randomUUID());
  const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: workspace, log: () => {} }));
  let stops = 0;
  const execution = { runId, generation: 1 };
  const connection = await connectComputeWorkspace({ url, credential: paired.credential, capabilities, execution,
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
  const connection = await connectComputeWorkspace({ url, credential: paired.credential, capabilities, execution,
    ca: readFileSync(join(root, 'cert'), 'utf8'), execute: async () => { throw new Error('Must not execute'); },
    stopWorkloads: async () => { stops++; throw new Error('Engine unavailable'); } });
  peers.at(-1)!.close();
  expect(await connection.close()).toBe(false);
  expect(connection.state()).toBe('unconfirmed'); expect(stops).toBe(1);
});

it('refuses plaintext endpoints before constructing a connection', async () => {
  await expect(connectComputeWorkspace({ url: url.replace('wss:', 'ws:'), credential: '', capabilities,
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
