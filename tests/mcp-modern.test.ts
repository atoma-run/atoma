import { runReviewFixture } from './helpers/projectRetrievalLaunch.js';
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
import { MemoryTasks, forgetTasksForTest } from '../src/mcp/tasks.js';
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

async function listen(resolveCaller: (req: IncomingMessage) => McpCaller | null, deps: McpToolDeps, frozen = () => false, hostOptions: { keepAliveMs?: number } = {}) {
  const server = createServer((req, res) => void host.handle(req, res, { frozen: frozen() }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const host = new McpHttpHost({ resolveCaller, ...mcpHostWiring(deps), allowedHosts: [`127.0.0.1:${port}`], ...hostOptions });
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
  it('validates every declared output schema through the 2026 SDK client, keeping them open', async () => {
    const platform: McpCaller = { kind: 'principal', viewer: { ...viewer('org:owner'), platformAdmin: true }, tokenId: 'platform' };
    const { url } = await listen(() => platform, {
      ...NO_TENANT,
      projects: { service: {
        projectContext: () => ({ context: { projectId: '00000000-0000-4000-8000-000000000001', version: 0, brief: null, decisions: [], change: null }, history: [], nextBeforeVersion: null }),
        reviewRun: runReviewFixture,
        compareRuns: () => ({ projectId: 'p', baseRunId: 'b', runId: 'r', snapshot: 'a'.repeat(64), evidence: 'saved_manifests', untrusted: true,
          base: { status: 'delivered', coverage: 'workspace' }, target: { status: 'delivered', coverage: 'workspace' },
          counts: { added: 0, removed: 0, modified: 0, unchanged: 0 }, files: [], total: 0, nextOffset: null, note: 'Saved inventories only.' }),
        artifacts: () => ({ projectId: 'p', runId: 'r', status: 'delivered', files: [], total: 0, nextOffset: null }),
        artifactFile: () => ({ projectId: 'p', runId: 'r', path: 'a.txt', size: 1, snapshot: 'f'.repeat(64), mimeType: 'text/plain',
          kind: 'text', text: 'a', textOffset: 0, nextTextOffset: null, untrusted: true }),
      } as never, store: {} as never },
      auth: {} as never,
      journal: { list: () => ({ events: [], nextBefore: null }) },
      notifications: () => ({ notifications: [], nextBefore: null }),
    });
    const client = await modernClient(url);
    try {
      const withSchema = (await client.listTools()).tools.filter((tool) => tool.outputSchema);
      expect(withSchema.map((tool) => tool.name).sort()).toEqual([
        'atoma_costs', 'atoma_ledger_tail', 'atoma_mcp_health', 'atoma_notifications', 'atoma_project_context', 'atoma_run_artifacts', 'atoma_run_compare', 'atoma_run_file', 'atoma_run_review', 'atoma_sentinel_health',
      ]);
      for (const tool of withSchema) {
        expect(tool.outputSchema?.['additionalProperties'], tool.name).not.toBe(false);
        const args = tool.name === 'atoma_project_context' ? { projectId: 'p' } : tool.name === 'atoma_run_review' ? { projectId: 'p', runId: 'r' } : tool.name === 'atoma_run_compare' ? { projectId: 'p', runId: 'r', baseRunId: 'b' } : tool.name === 'atoma_run_artifacts' || tool.name === 'atoma_run_file' ? { projectId: 'p', runId: 'r', path: 'a.txt' } : {};
        const result = await client.callTool({ name: tool.name, arguments: args });
        expect(result.isError, tool.name).not.toBe(true);
        expect(result.structuredContent, tool.name).toBeDefined();
      }
    } finally {
      await client.close();
    }
  });

  it('lets a member create a first project over MCP: the installations reader and a typed create schema', async () => {
    const installations = [{ installationId: '123', accountLogin: 'acme', targetType: 'Organization', status: 'active', repositorySelection: 'all' }];
    const member: McpCaller = { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' };
    const { url } = await listen(() => member, {
      ...NO_TENANT, operatorRuns: false, auth: {} as never,
      projects: { service: { listInstallations: () => installations } as never, store: {} as never },
    });
    const client = await modernClient(url);
    try {
      const listed = await client.callTool({ name: 'atoma_github_installations', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toEqual({ installations });
      // The create input is the console's schema, visible to the model, not an untyped record.
      const create = (await client.listTools()).tools.find((tool) => tool.name === 'atoma_project_create')!;
      const project = (create.inputSchema.properties as Record<string, { properties?: Record<string, unknown>; required?: string[] }>)['project']!;
      expect(Object.keys(project.properties ?? {})).toEqual(expect.arrayContaining(['name', 'slug', 'repositoryTarget', 'showcase']));
      expect(project.required).toEqual(expect.arrayContaining(['name', 'slug', 'repositoryTarget']));
      // Keeping a project off the public showcase is optional: a client that never heard of it still creates one.
      expect(project.required).not.toContain('showcase');
    } finally {
      await client.close();
    }
  });

  it('marks the four irreversible catalogue writes for a person, and never claims an open world for a local write', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await modernClient(url);
    try {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      for (const name of ['atoma_skill_reset', 'atoma_skill_drop', 'atoma_skill_merge', 'atoma_registry_rollback']) {
        expect(tools.get(name)?._meta, name).toMatchObject({ 'anthropic/requiresUserInteraction': true });
        expect(tools.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      }
      // The start tools stay unmarked: agent-driven campaigns start runs unattended.
      expect(tools.get('atoma_operator_run_start')?._meta?.['anthropic/requiresUserInteraction']).toBeUndefined();
    } finally {
      await client.close();
    }
  });

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
      // Both eras name the server with its mark and site (2026-09-30).
      expect(member.getServerVersion()).toMatchObject({ name: 'atoma', websiteUrl: 'https://atoma.run',
        icons: [{ mimeType: 'image/svg+xml', src: expect.stringMatching(/^data:image\/svg\+xml;base64,/) }] });
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

  it('streams a synchronous start as SSE: progress before the result when asked, keepalives either way', async () => {
    // THE PATH CLAUDE CODE USES (no tasks): its idle watchdog cuts a call
    // with no response and no progress for 5 min, so the 30 s heartbeat must
    // reach it on THIS wire, through the SDK's per-request transport. And a
    // call without a progressToken must still send bytes, or an idle proxy
    // or client deadline cuts a run that lasts minutes (2026-10-03).
    const raw = async (url: string, progressToken?: string) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call', 'mcp-name': 'atoma_operator_run_start' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
        name: 'atoma_operator_run_start', arguments: { goal: 'a streamed 2026 goal' },
        _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'hand-built', version: '0' }, ...(progressToken ? { progressToken } : {}) },
      } }),
    });
    for (const progressToken of ['p1', undefined]) {
      const { driver, handle } = scriptedDriver();
      const { url } = await listen(() => ({ kind: 'operator' }),
        { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease, taskHeartbeatMs: 20 }, () => false, { keepAliveMs: 15 });
      const response = await raw(url, progressToken);
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
      await tick(120);
      handle.settle('done');
      const text = await response.text();
      expect(text).toContain(': keepalive');
      const frames = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
      const result = frames.findIndex((frame) => frame['id'] === 7);
      expect(result).toBeGreaterThanOrEqual(0);
      const progress = frames.findIndex((frame) => frame['method'] === 'notifications/progress');
      if (progressToken) {
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThan(result);
        expect((frames[progress]!['params'] as { progressToken: string }).progressToken).toBe('p1');
      } else {
        expect(progress).toBe(-1);
      }
      resetRunsForTest();
      forgetTasksForTest();
    }
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
      // SEP-2663: cancelling a task that already ended is acknowledged with an
      // empty result, and the task keeps its terminal state; -32602 is for an
      // unknown id only.
      const ack = await modernRequest(url, 'tasks/cancel', { taskId });
      expect(ack.body.error).toBeUndefined();
      expect(ack.body.result).toMatchObject({ resultType: 'complete' });
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
    const read = await modernRequest(url, 'tools/list', {});
    expect(read.status).toBe(200);
    expect(read.body.result).toMatchObject({ tools: expect.any(Array) });
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

/*
 * The 2026-09-30 adversarial review of this port, one regression each. The
 * numbers are the review's.
 */
describe('the 2026-09-30 review of the two-era port', () => {
  it('finishes an operator task whose run ended before its watchers were hooked (1)', async () => {
    // A driver settled at once — what spawnRun does on a host that cannot run —
    // ended the run a microtask before the task listened for its end.
    const settled: RunDriver = () => Promise.resolve('--- run failed ---\n');
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: settled, operatorRunLease: lease });
    const created = await modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'ends at once' } });
    const taskId = created.body.result!['taskId'] as string;
    await tick(50);
    expect((await modernRequest(url, 'tasks/get', { taskId })).body.result).toMatchObject({ status: 'completed' });
    // And the synchronous start answers instead of waiting out the task's ttl.
    const sync = await Promise.race([
      modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: 'ends at once, synchronously' } }, { tasks: false }),
      tick(5_000).then(() => null),
    ]);
    expect(sync?.body.result).toMatchObject({ structuredContent: expect.objectContaining({ status: expect.any(String) }) });
  });

  it('holds a caller to its own number of listen streams, and a listener to what its tier may follow (2, 3)', async () => {
    const callers: Record<string, McpCaller> = { member: { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' } };
    const { url } = await listen((req) => callers[String(req.headers.authorization).replace('Bearer ', '')] ?? { kind: 'operator' }, NO_TENANT);
    const listenBody = (notifications: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {
      notifications, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} },
    } });
    const open: AbortController[] = [];
    const headersFor = (bearer: string) => ({
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN,
      'mcp-method': 'subscriptions/listen', authorization: `Bearer ${bearer}`,
    });
    try {
      // What a member may follow: not the operator corpus, and no listing notice.
      const abort = new AbortController();
      open.push(abort);
      const first = await fetch(url, { method: 'POST', signal: abort.signal, headers: headersFor('member'),
        body: listenBody({ toolsListChanged: true, resourceSubscriptions: [operatorRunUri('someone-elses-run'), 'atoma://runs/some-trace.json'], resourcesListChanged: true }) });
      const reader = first.body!.getReader();
      const { value } = await reader.read();
      const acknowledged = new TextDecoder().decode(value);
      expect(acknowledged).toContain('notifications/subscriptions/acknowledged');
      expect(acknowledged).not.toContain('someone-elses-run');
      expect(acknowledged).not.toContain('some-trace.json');
      expect(acknowledged).not.toContain('resourcesListChanged');
      // Seven more are this caller's share; the next is refused, and nobody else's is.
      for (let i = 1; i < 8; i++) {
        const more = new AbortController();
        open.push(more);
        const response = await fetch(url, { method: 'POST', signal: more.signal, headers: headersFor('member'), body: listenBody({ toolsListChanged: true }) });
        expect(response.status).toBe(200);
      }
      const refused = await fetch(url, { method: 'POST', headers: headersFor('member'), body: listenBody({ toolsListChanged: true }) });
      expect(refused.status).toBe(429);
      const other = new AbortController();
      open.push(other);
      expect((await fetch(url, { method: 'POST', signal: other.signal, headers: headersFor('operator'), body: listenBody({ toolsListChanged: true }) })).status).toBe(200);
    } finally {
      for (const abort of open) abort.abort();
    }
  });

  it('answers invalid task arguments as a tool error, as the SDK answers any call (5)', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const invalid = await modernRequest(url, 'tools/call', { name: 'atoma_operator_run_start', arguments: { goal: '' } });
    expect(invalid.body.error).toBeUndefined();
    expect(invalid.body.result).toMatchObject({ isError: true });
    expect(JSON.stringify(invalid.body.result)).toMatch(/Invalid arguments/);
  });

  it('checks a task request it answers itself as the SDK checks every 2026 request (6)', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const send = (headers: Record<string, string>, meta: Record<string, unknown>) => fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 't', _meta: meta } }),
    });
    const envelope = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
    const complete = { 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'tasks/get', 'mcp-name': 't' };
    expect((await send({ ...complete, 'content-type': 'text/plain' }, envelope)).status).toBe(415);
    expect((await send({ 'content-type': 'application/json', 'mcp-method': 'tasks/get' }, envelope)).status).toBe(400);
    expect((await send({ 'content-type': 'application/json', 'mcp-protocol-version': MODERN }, envelope)).status).toBe(400);
    // Mcp-Name mirrors the task id (SEP-2243, SEP-2663), and the capabilities key is required.
    const misnamed = await send({ ...complete, 'mcp-name': 'other' }, envelope);
    expect(misnamed.status).toBe(400);
    expect(((await misnamed.json()) as { error: { code: number } }).error.code).toBe(-32020);
    expect((await send(complete, { 'io.modelcontextprotocol/protocolVersion': MODERN })).status).toBe(400);
    expect((await send(complete, envelope)).status).toBe(200);
  });

  it('keeps one caller from crowding the others out of health().clients (8)', async () => {
    const { url, host } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    for (let i = 0; i < 10; i++) {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list', params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: `noise-${i}`, version: '0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } } }),
      }).then((response) => response.text());
    }
    const kinds = Object.keys(host.health().clients);
    expect(kinds.filter((kind) => kind.includes('noise-'))).toHaveLength(4);
    expect(host.health().clients['other']).toBe(6);
  });
  it('evicts a caller’s own finished tasks past its share, never another caller’s (4)', () => {
    const memory = new MemoryTasks();
    const theirs = memory.create('platform-admin', { ttl: 60_000, pollInterval: 1_000 });
    memory.finish(theirs.taskId, 'completed', { content: [] });
    for (let i = 0; i < 1_100; i++) {
      const refusal = memory.create('noisy-member', { ttl: 60_000, pollInterval: 1_000 });
      memory.finish(refusal.taskId, 'failed', { content: [], isError: true });
    }
    expect(memory.get('platform-admin', theirs.taskId)).toMatchObject({ status: 'completed' });
    expect(memory.list('noisy-member').length).toBeLessThanOrEqual(1_000);
    memory.forgetAll();
  });
});
