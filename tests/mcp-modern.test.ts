import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CreateTaskResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Viewer } from '../src/auth/store.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { operatorRunUri } from '../src/mcp/resources.js';
import type { McpCaller } from '../src/mcp/identity.js';
import { resetRunsForTest, type RunDriver } from '../src/mcp/run.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import { forgetTasksForTest } from '../src/mcp/tasks.js';
import { TASKS_EXTENSION } from '../src/mcp/taskWire.js';
import type { McpToolDeps } from '../src/mcp/tools.js';

/**
 * THE 2026-07-28 ERA ON THE SAME ROUTE. What these hold, through the SDK v2
 * client pinned to 2026-07-28 (and hand-built requests where the tasks
 * extension has no client support yet), against the real host on a real port:
 *   - a 2026 client is served statelessly, per request, with its tier's tools,
 *     beside a 2025 client that keeps its session — and `health()` says who
 *     speaks what;
 *   - a start tool is a task of the extension when the request declares it,
 *     followed by `tasks/get` (result inline) and `tasks/cancel`, answered by
 *     the host because the SDK refuses them on this era;
 *   - a task belongs to its caller, not to an era: one started by a 2025
 *     session answers a 2026 `tasks/get`, and nobody else's.
 */

const servers: Server[] = [];
const hosts: McpHttpHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  resetRunsForTest();
  forgetTasksForTest();
});

const MODERN = '2026-07-28';
const NO_TENANT: McpToolDeps = { projects: null, auth: null, journal: null, operatorRuns: true };
const lease = async () => ({ path: '<test>', attachChild() {}, release() {} });
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function viewer(role: Viewer['role']): Viewer {
  return { principalId: `p-${role}`, displayName: role, kind: 'human', orgId: 'org-1', orgName: 'Org One', role, platformAdmin: false, displayNameSource: 'provider' };
}

/** A driver the test feeds: chunks on demand, a settle to end, and an abort that ends it as cancelled. */
function scriptedDriver() {
  const handle = { chunk: (_text: string) => {}, settle: (_log: string) => {}, aborted: false };
  const driver: RunDriver = (opts) =>
    new Promise<string>((resolve) => {
      handle.settle = resolve;
      handle.chunk = (text) => opts.onChunk?.(text);
      opts.signal?.addEventListener('abort', () => { handle.aborted = true; resolve('cancelled'); }, { once: true });
    });
  return { driver, handle };
}

async function listen(resolveCaller: (req: IncomingMessage) => McpCaller | null, deps: McpToolDeps, frozen = () => false) {
  const server = createServer((req, res) => void host.handle(req, res, { frozen: frozen() }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const host = new McpHttpHost({ resolveCaller, ...mcpHostWiring(deps), allowedHosts: [`127.0.0.1:${port}`] });
  hosts.push(host);
  return { url: `http://127.0.0.1:${port}/mcp`, host };
}

async function modernClient(url: string, bearer?: string): Promise<ModernClient> {
  const client = new ModernClient({ name: 'modern-test', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });
  await client.connect(new ModernTransport(new URL(url), { requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {} }));
  return client;
}

async function legacyClient(url: string): Promise<LegacyClient> {
  const client = new LegacyClient({ name: 'legacy-test', version: '0' });
  await client.connect(new LegacyTransport(new URL(url)));
  return client;
}

/**
 * One 2026 request by hand, as a client of the tasks extension sends it: the
 * envelope in `_meta`, the routing headers, and the extension on its
 * capabilities. Answers the JSON-RPC response, from a JSON or an SSE body.
 */
async function modernRequest(url: string, method: string, params: Record<string, unknown>, options: { tasks?: boolean; bearer?: string } = {}) {
  const name = typeof params['name'] === 'string' ? params['name'] : typeof params['taskId'] === 'string' ? params['taskId'] : undefined;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}), ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN,
      'io.modelcontextprotocol/clientInfo': { name: 'hand-built', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': options.tasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } },
    } } }),
  });
  const text = await response.text();
  const frame = text.startsWith('{') ? text : text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).find((data) => data.includes('"id"')) ?? '{}';
  return { status: response.status, body: JSON.parse(frame) as { result?: Record<string, unknown>; error?: { code: number; message: string } } };
}

describe('the 2026-07-28 era', () => {
  it('serves a 2026 client per request with its tier’s tools, beside a 2025 session, and counts who speaks what', async () => {
    const callers: Record<string, McpCaller> = {
      viewer: { kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'v' },
      member: { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' },
    };
    const deps: McpToolDeps = {
      projects: { service: {} as never, store: {} as never }, auth: {} as never,
      journal: { list: () => ({ events: [], nextBefore: null }) }, operatorRuns: false,
    };
    const { url, host } = await listen((req) => callers[String(req.headers.authorization).replace('Bearer ', '')] ?? null, deps);
    const member = await modernClient(url, 'member');
    const viewerClient = await modernClient(url, 'viewer');
    try {
      expect(member.getProtocolEra()).toBe('modern');
      const memberTools = (await member.listTools()).tools.map((tool) => tool.name);
      const viewerTools = (await viewerClient.listTools()).tools.map((tool) => tool.name);
      expect(memberTools).toContain('atoma_run_start');
      expect(viewerTools).not.toContain('atoma_run_start');
      expect(viewerTools).toContain('atoma_projects_list');
      // No session on this era, and the handler's tasks capability is the extension.
      expect(host.health().sessions).toBe(0);
      expect(member.getServerCapabilities()?.extensions).toMatchObject({ [TASKS_EXTENSION]: {} });
      expect(host.health().modernRequests).toBeGreaterThan(0);
      expect(Object.keys(host.health().clients)).toContain(`${MODERN} modern-test`);
    } finally {
      await member.close();
      await viewerClient.close();
    }
  });

  it('answers a start as a task of the extension, follows it with tasks/get, and cancels it with tasks/cancel', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const created = await modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'a goal driven as a 2026 task' } });
    expect(created.body.result).toMatchObject({ resultType: 'task', status: 'working', pollIntervalMs: 2000 });
    expect(created.body.result?.['ttlMs']).toEqual(expect.any(Number));
    const taskId = created.body.result!['taskId'] as string;
    handle.chunk('alpha');
    await tick(20);
    const working = await modernRequest(url, 'tasks/get', { taskId });
    expect(working.body.result).toMatchObject({ resultType: 'complete', taskId, status: 'working' });
    expect(working.body.result?.['statusMessage']).toMatch(/1 chunks — untrusted model output: alpha$/);
    handle.settle('no epilogue');
    await tick(100);
    const done = await modernRequest(url, 'tasks/get', { taskId });
    expect(done.body.result).toMatchObject({ status: 'completed', result: { resultType: 'complete', structuredContent: { status: 'finished' } } });
    // Cancelling: an acknowledgement, the task cancelled, the run's abort reached.
    const second = await modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'a goal to cancel' } });
    const secondId = second.body.result!['taskId'] as string;
    expect((await modernRequest(url, 'tasks/cancel', { taskId: secondId })).body.result).toMatchObject({ resultType: 'complete' });
    expect((await modernRequest(url, 'tasks/get', { taskId: secondId })).body.result).toMatchObject({ status: 'cancelled' });
    await tick(50);
    expect(handle.aborted).toBe(true);
    // An unknown task is the extension's -32602; `tasks/update` of a real one acknowledges.
    expect((await modernRequest(url, 'tasks/get', { taskId: 'no-such-task' })).body.error?.code).toBe(-32602);
    expect((await modernRequest(url, 'tasks/update', { taskId, inputResponses: {} })).body.result).toMatchObject({ resultType: 'complete' });
  });

  it('answers a start that did not declare the extension when the run ends, as a synchronous call', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const pending = modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'a synchronous 2026 goal' } }, { tasks: false });
    await tick(50);
    handle.settle('done');
    const answered = await pending;
    expect(answered.body.result).toMatchObject({ structuredContent: { status: 'finished' } });
    expect(answered.body.result?.['resultType']).not.toBe('task');
  });

  it('keeps a task with its caller across eras: a 2025 session starts it, a 2026 request reads it, another caller cannot', async () => {
    const { driver, handle } = scriptedDriver();
    let current: McpCaller = { kind: 'operator' };
    const { url } = await listen(() => current, { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const legacy = await legacyClient(url);
    try {
      const created = await legacy.request(
        { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'started in 2025' } } },
        CreateTaskResultSchema, { task: { ttl: 60_000 } }
      );
      const taskId = created.task.taskId;
      expect((await modernRequest(url, 'tasks/get', { taskId })).body.result).toMatchObject({ taskId, status: 'working' });
      handle.settle('done');
      await tick(100);
      expect((await modernRequest(url, 'tasks/get', { taskId })).body.result).toMatchObject({ status: 'completed' });
      // The binding is the caller: a principal presenting the operator's task id finds nothing.
      current = { kind: 'principal', viewer: { ...viewer('org:member'), platformAdmin: true }, tokenId: 'admin' };
      expect((await modernRequest(url, 'tasks/get', { taskId })).body.error?.code).toBe(-32602);
      expect((await modernRequest(url, 'tasks/cancel', { taskId })).body.error?.code).toBe(-32602);
    } finally {
      await legacy.close();
    }
  });

  it('tells a 2026 listener when the run it follows finishes, through subscriptions/listen', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const created = await modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'a goal to watch' } });
    const runId = /^run (\S+) started/.exec(String(created.body.result?.['statusMessage']))![1]!;
    const client = await modernClient(url);
    const updated: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (notification) => { updated.push(notification.params.uri); });
    const subscription = await client.listen({ resourceSubscriptions: [operatorRunUri(runId)] });
    try {
      expect(subscription.honoredFilter.resourceSubscriptions).toEqual([operatorRunUri(runId)]);
      handle.settle('done');
      await expect.poll(() => updated, { timeout: 2_000 }).toEqual([operatorRunUri(runId)]);
    } finally {
      await subscription.close();
      await client.close();
    }
  });

  it('under a write freeze serves 2026 reads and holds back a start', async () => {
    const { driver } = scriptedDriver();
    let frozen = true;
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease }, () => frozen);
    const read = await modernRequest(url, 'tools/call', { name: 'atoma_families', arguments: {} });
    expect(read.status).toBe(200);
    expect(read.body.result).toMatchObject({ structuredContent: expect.any(Object) });
    const start = await modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'not now' } });
    expect(start.status).toBe(503);
    expect((await modernRequest(url, 'tasks/get', { taskId: 'none' })).status).toBe(200);
    frozen = false;
  });

  it('refuses a 2026 request whose Mcp-Method header contradicts its body', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 't', _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32020);
  });
});
