import { createServer, request, type Server, type ClientRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpHttpHost, mcpMaxRequestMsFromEnv, MCP_MAX_REQUEST_MS, STANDALONE_SSE_STREAM_ID } from '../src/mcp/http.js';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifetimes', version: '1' },
} });
let host: McpHttpHost;
let hostOptions: ConstructorParameters<typeof McpHttpHost>[0];
/** Whether the route is under a deployment's write freeze, as `server.ts` passes it. */
let frozen = false;
let server: Server;
let now = 0;
let built = 0;
const requests: ClientRequest[] = [];
afterEach(async () => {
  for (const req of requests.splice(0)) req.destroy();
  await host?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.useRealTimers();
});
async function listen(build: () => McpServer, limits = 1, perCaller = 1, bodyTimeoutMs?: number) {
  now = 0;
  built = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  frozen = false;
  server = createServer((req, res) => { void host.handle(req, res, { frozen }).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  hostOptions = { resolveCaller: req => ({ kind: 'principal', tokenId: String(req.headers['authorization'] ?? 'a'),
    viewer: { principalId: String(req.headers['authorization'] ?? 'a'), orgId: 'o', orgName: 'o', displayName: 'a', displayNameSource: 'provider', kind: 'human', role: 'org:member', platformAdmin: false } }),
    buildServer: () => { built++; return build(); }, allowedHosts: [`127.0.0.1:${address.port}`],
    // The sweep tests keep their thirty-minute clock; production's day is the default.
    now: () => now, idleMs: 30 * 60_000, maxSessions: limits, maxSessionsPerCaller: perCaller,
    ...(bodyTimeoutMs !== undefined ? { bodyTimeoutMs } : {}) };
  host = new McpHttpHost(hostOptions);
  return `http://127.0.0.1:${address.port}/mcp`;
}
function fragmented(url: string, authorization = 'a') {
  let req: ClientRequest;
  const response = new Promise<{ status: number; body: string; id?: string }>((resolve, reject) => {
    req = request(url, { method: 'POST', headers: { ...headers, authorization } }, res => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, body, id: res.headers['mcp-session-id'] as string | undefined }));
    });
    req.on('error', reject);
    req.write(initialize.slice(0, 10));
    requests.push(req);
  });
  return { req: req!, response };
}
const fresh = () => new McpServer({ name: 'test', version: '1' });
/*
 * A body still arriving holds a socket and nothing else: the era of a POST is
 * read from its body (2026-09-30), so no place is reserved and no server built
 * until it is complete, and one that does not arrive in time is closed. Until
 * then the reservation was taken first, which only a 2025-only host could do.
 */
it.each([1, 2])('builds nothing for fragmented initialize bodies until they arrive, then holds the ceilings (limit=%s)', async limit => {
  const url = await listen(fresh, limit);
  const first = fragmented(url);
  const second = fragmented(url, 'b');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(built).toBe(0);
  expect(host.health()).toMatchObject({ sessions: 0, initializing: 0 });
  first.req.end(initialize.slice(10));
  expect((await first.response).status).toBe(200);
  second.req.end(initialize.slice(10));
  // At a host ceiling of one, the second caller's opening is refused; at two it has its own.
  expect((await second.response).status).toBe(limit === 1 ? 503 : 200);
  expect(host.health().sessions).toBe(limit);
});
it('closes a body that does not arrive in time, and answers an unreadable one without building a server', async () => {
  const url = await listen(fresh, 1, 1, 100);
  const invalid = fragmented(url);
  invalid.req.end('invalid');
  expect((await invalid.response).status).toBe(400);
  const stalled = fragmented(url);
  await expect(stalled.response).rejects.toThrow();
  expect(built).toBe(0);
  const valid = fragmented(url);
  valid.req.end(initialize.slice(10));
  expect((await valid.response).status).toBe(200);
});
it('keeps a pending POST past idle, delivers its response, then sweeps the idle session', async () => {
  let finish!: () => void;
  let entered = false;
  const result = new Promise<void>(resolve => { finish = resolve; });
  const url = await listen(() => {
    const sdk = fresh();
    sdk.registerTool('slow', {}, async () => { entered = true; await result; return { content: [{ type: 'text', text: 'finished' }] }; });
    return sdk;
  });
  const init = fragmented(url); init.req.end(initialize.slice(10));
  const id = (await init.response).id!;
  const pending = fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': id },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }),
  }).then(res => res.text());
  await vi.waitFor(() => expect(entered).toBe(true));
  now = 31 * 60_000;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.health().sessions).toBe(1);
  finish();
  expect(await pending).toContain('finished');
  now += 31 * 60_000;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.health().sessions).toBe(0);
});
it('does not let a standalone GET event stream pin an idle session', async () => {
  const url = await listen(fresh);
  const init = fragmented(url); init.req.end(initialize.slice(10));
  const id = (await init.response).id!;
  const stream = await fetch(url, { headers: { ...headers, 'mcp-session-id': id } });
  const body = stream.text();
  now = 31 * 60_000;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(host.health().sessions).toBe(0);
  await body;
});

it('bounds a POST that never answers even though it pins the idle clock', async () => {
  let finish!: () => void;
  let entered = false;
  const result = new Promise<void>(resolve => { finish = resolve; });
  const url = await listen(() => {
    const sdk = fresh();
    sdk.registerTool('wedged', {}, async () => { entered = true; await result; return { content: [] }; });
    return sdk;
  });
  const init = fragmented(url); init.req.end(initialize.slice(10));
  const id = (await init.response).id!;
  const pending = fetch(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': id },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wedged' } }),
  }).then(res => res.text()).catch(() => '');
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    now = 181 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // The stalled CALL ends; its session, and whatever else it holds, does not.
    await pending;
    expect(host.health().sessions).toBe(1);
    now += 31 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(0);
  } finally { finish(); }
});

it('reads the request ceiling from the deployment, refusing a value it cannot honour', () => {
  expect(mcpMaxRequestMsFromEnv({})).toBe(MCP_MAX_REQUEST_MS);
  expect(mcpMaxRequestMsFromEnv({ ATOMA_MCP_MAX_REQUEST_MS: '43200000' })).toBe(43_200_000);
  expect(() => mcpMaxRequestMsFromEnv({ ATOMA_MCP_MAX_REQUEST_MS: '5000' })).toThrow(/at least 60000/);
  expect(() => mcpMaxRequestMsFromEnv({ ATOMA_MCP_MAX_REQUEST_MS: '3h' })).toThrow(/integer/);
});

it('names the SDK standalone stream id it relies on', () => {
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined }) as unknown as Record<string, unknown>;
  const inner = (transport['_webStandardTransport'] ?? transport) as Record<string, unknown>;
  expect(inner['_standaloneSseStreamId']).toBe(STANDALONE_SSE_STREAM_ID);
});

describe('a call the client is still waiting for (2026-09-25 review, 1.3)', () => {
  const callBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } });
  function slowServer(gates: Array<() => void>) {
    return () => {
      const sdk = fresh();
      sdk.registerTool('slow', {}, async () => {
        await new Promise<void>(resolve => gates.push(resolve));
        return { content: [{ type: 'text', text: 'FINISHED-RESULT' }] };
      });
      return sdk;
    };
  }
  function raw(url: string, method: string, headers: Record<string, string>, body?: string,
    onChunk?: (text: string, req: ClientRequest) => void) {
    return new Promise<{ status?: number; text: string }>(resolve => {
      const req = request(url, { method, headers }, res => {
        let text = '';
        res.on('data', chunk => { text += String(chunk); onChunk?.(text, req); });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
        res.on('aborted', () => resolve({ status: res.statusCode!, text }));
        res.on('error', () => resolve({ status: res.statusCode!, text }));
        res.on('close', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', () => resolve({ text: '' }));
      req.on('close', () => setImmediate(() => resolve({ text: '' })));
      requests.push(req);
      req.end(body);
    });
  }

  it('keeps the session of a call resumed with Last-Event-ID, and replays its response', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates));
    const init = fragmented(url); init.req.end(initialize.slice(10));
    const id = (await init.response).id!;
    // As the SDK client does: the negotiated version, whose streams carry
    // priming event ids, and the `initialized` notification.
    const session = { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
    await raw(url, 'POST', session, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    let eventId: string | undefined;
    await raw(url, 'POST', session, callBody, (text, req) => {
      const match = /id: (\S+)/.exec(text);
      if (match && !eventId) { eventId = match[1]; req.destroy(); }
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(eventId).toBeDefined();
    const resumed = raw(url, 'GET', { ...session, accept: 'text/event-stream', 'last-event-id': eventId! });
    await new Promise(resolve => setTimeout(resolve, 100));
    now = 31 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(1);
    gates.shift()!();
    expect((await resumed).text).toContain('FINISHED-RESULT');
  });

  /** A session with a slow call begun at `now`, its POST cut after the first event id. */
  async function cutCall(url: string, gates: Array<() => void>) {
    const init = fragmented(url); init.req.end(initialize.slice(10));
    const id = (await init.response).id!;
    const session = { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' };
    await raw(url, 'POST', session, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    let eventId: string | undefined;
    await raw(url, 'POST', session, callBody, (text, req) => {
      const match = /id: (\S+)/.exec(text);
      if (match && !eventId) { eventId = match[1]; req.destroy(); }
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    return { session, eventId: eventId! };
  }

  it('does not pin a session with the resumed stream of a call already answered', async () => {
    // The SDK holds a resumed stream open after its replay, and nothing more
    // will ever be sent there: pinned, it held the session for the whole
    // request ceiling (2026-09-25 adversarial review).
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates));
    const { session, eventId } = await cutCall(url, gates);
    gates.shift()!();
    await new Promise(resolve => setTimeout(resolve, 100));
    let replayed = false;
    const resumed = raw(url, 'GET', { ...session, accept: 'text/event-stream', 'last-event-id': eventId },
      undefined, (text) => { if (text.includes('FINISHED-RESULT')) replayed = true; });
    await vi.waitFor(() => expect(replayed).toBe(true));
    now = 31 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.health().sessions).toBe(0);
    await resumed;
  });

  it('bounds a resumed call by the start of the call, so reconnecting never extends the ceiling', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates));
    const { session, eventId } = await cutCall(url, gates);
    try {
      now = 170 * 60_000;
      const resumed = raw(url, 'GET', { ...session, accept: 'text/event-stream', 'last-event-id': eventId });
      await new Promise(resolve => setTimeout(resolve, 100));
      now = 181 * 60_000;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // Past three hours of the CALL, not of the reconnect: the response
      // closes, the session stays for its other calls.
      expect((await resumed).text).not.toContain('FINISHED-RESULT');
      expect(host.health().sessions).toBe(1);
    } finally { gates.shift()?.(); }
  });

  it('never evicts a session answering a call to make room for the same caller', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates), 16, 2);
    const openSession = async () => {
      const init = fragmented(url); init.req.end(initialize.slice(10));
      return (await init.response).id!;
    };
    now = 0; const busy = await openSession();
    now = 1_000; const pending = raw(url, 'POST', { ...headers, 'mcp-session-id': busy }, callBody);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    now = 2_000; const idle = await openSession();
    now = 3_000; await openSession();
    // The idle session was the one reclaimed; the busy call answers.
    expect(host.health().evicted).toBe(1);
    const stillThere = await raw(url, 'POST', { ...headers, 'mcp-session-id': idle },
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
    expect(stillThere.status).toBe(404);
    gates.shift()!();
    expect((await pending).text).toContain('FINISHED-RESULT');
  });

  it('answers 503 rather than cutting a call when every place of the caller is busy', async () => {
    const gates: Array<() => void> = [];
    const url = await listen(slowServer(gates), 16, 1);
    const init = fragmented(url); init.req.end(initialize.slice(10));
    const busy = (await init.response).id!;
    const pending = raw(url, 'POST', { ...headers, 'mcp-session-id': busy }, callBody);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const refused = fragmented(url); refused.req.end(initialize.slice(10));
    expect((await refused.response).status).toBe(503);
    expect(host.health().evicted).toBe(0);
    gates.shift()!();
    expect((await pending).text).toContain('FINISHED-RESULT');
  });
});

/**
 * Every deployment restarts the host, and a restart forgot every session: the
 * next call of every connected client answered 404, and clients failed it
 * (2026-09-28, about ten deployments that day). An authenticated caller's
 * forgotten id is now reopened in place; an id the host evicted on purpose,
 * one it never minted, and a DELETE are not.
 */
describe('a session the host forgot', () => {
  function post(url: string, extra: Record<string, string>, body: string, method = 'POST', authorization = 'a') {
    return new Promise<{ status: number; text: string; id?: string }>((resolve, reject) => {
      const req = request(url, { method, headers: { ...headers, authorization, ...extra } }, res => {
        let text = '';
        res.on('data', chunk => { text += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode!, text, id: res.headers['mcp-session-id'] as string | undefined }));
      });
      req.on('error', reject);
      requests.push(req);
      req.end(body);
    });
  }
  const echo = () => {
    const sdk = fresh();
    sdk.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'ECHOED' }] }));
    return sdk;
  };
  const call = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo' } });
  const on = (id: string) => ({ 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' });
  async function openSession(url: string): Promise<string> {
    const opened = await post(url, {}, initialize);
    await post(url, on(opened.id!), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    return opened.id!;
  }

  it('is reopened under the same id after a restart, for the caller presenting it', async () => {
    const url = await listen(echo, 8, 8);
    const id = await openSession(url);
    await host.close();
    host = new McpHttpHost(hostOptions);
    expect((await post(url, on(id), call, 'POST', 'b')).status).toBe(404);
    const answered = await post(url, on(id), call);
    expect(answered.status).toBe(200);
    expect(answered.text).toContain('ECHOED');
    expect(answered.id).toBe(id);
    expect(host.health()).toMatchObject({ resumed: 1, opened: 0, sessions: 1, clients: { '2025-11-25 atoma-resumed-session': 1 } });
    // Resumed once: the next call rides the session like any other.
    expect((await post(url, on(id), call)).text).toContain('ECHOED');
    expect(host.health().resumed).toBe(1);
    // Bound to its caller again: another identity is refused as before.
    expect((await post(url, on(id), call, 'POST', 'b')).status).toBe(401);
    expect((await post(url, on(id), call)).text).toContain('ECHOED');
  });

  it('counts each resumed session once per process across repeated restarts', async () => {
    const url = await listen(echo, 8, 8);
    const ids = [await openSession(url), await openSession(url)];
    for (let restart = 0; restart < 2; restart++) {
      await host.close();
      host = new McpHttpHost(hostOptions);
      expect(host.health().clients).toEqual({});
      expect((await post(url, on(ids[0]!), call, 'POST', 'another-caller')).status).toBe(404);
      expect(host.health().clients).toEqual({});
      for (const id of ids) expect((await post(url, on(id), call)).text).toContain('ECHOED');
      expect(host.health()).toMatchObject({
        resumed: 2, opened: 0, sessions: 2,
        clients: { '2025-11-25 atoma-resumed-session': 2 },
      });
      for (const id of ids) expect((await post(url, on(id), call)).text).toContain('ECHOED');
      expect(host.health().clients).toEqual({ '2025-11-25 atoma-resumed-session': 2 });
    }
  });

  it('answers a first call on the reopened session that outlasts the opening deadline (2026-09-30 review)', async () => {
    // Until 2026-09-30 the opening's 30s timer stayed armed until the reopening
    // request's WHOLE response had streamed, so after every deployment a first
    // call longer than that — a synchronous run start, a blocking tasks/result —
    // was cut. The deadline bounds the opening only.
    const slow = () => {
      const sdk = fresh();
      sdk.registerTool('echo', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { content: [{ type: 'text', text: 'ECHOED' }] };
      });
      return sdk;
    };
    const url = await listen(slow, 8, 8);
    const id = await openSession(url);
    await host.close();
    host = new McpHttpHost({ ...hostOptions, openTimeoutMs: 100 });
    const answered = await post(url, on(id), call);
    expect(answered.status).toBe(200);
    expect(answered.text).toContain('ECHOED');
  });

  it('is reopened after the idle sweep', async () => {
    const url = await listen(echo, 8, 8);
    const id = await openSession(url);
    now = 25 * 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(host.health().sessions).toBe(0);
    expect((await post(url, on(id), call)).text).toContain('ECHOED');
    expect(host.health().resumed).toBe(1);
  });

  it('stays gone when the host evicted it, never minted it, or is asked to delete it', async () => {
    const url = await listen(echo, 8, 1);
    const evicted = await openSession(url);
    now = 1_000;
    await openSession(url);
    expect(host.health().evicted).toBe(1);
    expect((await post(url, on(evicted), call)).status).toBe(404);
    expect((await post(url, on('not-a-session-this-host-minted'), call)).status).toBe(404);
    await host.close();
    host = new McpHttpHost(hostOptions);
    expect((await post(url, on('4f0c6a2e-8b1d-4c3a-9e5f-7a6b5c4d3e2f'), '', 'DELETE')).status).toBe(404);
    expect(host.health().resumed).toBe(0);
  });
});

it('carries a real SDK client across a host restart without an error or a reconnect', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const url = await listen(() => {
    const sdk = fresh();
    sdk.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'ECHOED' }] }));
    return sdk;
  }, 8, 8);
  const client = new Client({ name: 'restart-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'a' } } });
  await client.connect(transport);
  const before = transport.sessionId;
  expect(JSON.stringify(await client.callTool({ name: 'echo' }))).toContain('ECHOED');
  await host.close();
  host = new McpHttpHost(hostOptions);
  expect(JSON.stringify(await client.callTool({ name: 'echo' }))).toContain('ECHOED');
  expect(transport.sessionId).toBe(before);
  expect(host.health()).toMatchObject({ resumed: 1, opened: 0 });
  await client.close();
});

/**
 * The write freeze answered EVERY MCP POST 503 for the minute of an
 * activation, a verdict read as much as a run start (2026-09-28). A call that
 * starts nothing is served; one that starts something still waits.
 */
describe("a call during a deployment's write freeze", () => {
  function post(url: string, extra: Record<string, string>, body: string) {
    return new Promise<{ status: number; text: string; id?: string }>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, authorization: 'a', ...extra } }, res => {
        let text = '';
        res.on('data', chunk => { text += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode!, text, id: res.headers['mcp-session-id'] as string | undefined }));
      });
      req.on('error', reject);
      requests.push(req);
      req.end(body);
    });
  }
  const tools = () => {
    const sdk = fresh();
    sdk.registerTool('read', { annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'READ-DONE' }] }));
    sdk.registerTool('start', { annotations: { readOnlyHint: false } }, async () => ({ content: [{ type: 'text', text: 'STARTED' }] }));
    return sdk;
  };
  const on = (id: string) => ({ 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25' });
  const callTool = (name: string) => JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name } });

  it('serves reads and refuses what starts something, on a live and on a resumed session', async () => {
    const url = await listen(tools, 8, 8);
    const opened = await post(url, {}, initialize);
    const id = opened.id!;
    frozen = true;
    const read = await post(url, on(id), callTool('read'));
    expect(read.status).toBe(200);
    expect(read.text).toContain('READ-DONE');
    const start = await post(url, on(id), callTool('start'));
    expect(start.status).toBe(503);
    expect(start.text).toContain('deployment in progress');
    expect((await post(url, on(id), JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }))).status).toBe(200);
    // A new client may still open its session under the freeze.
    expect((await post(url, {}, initialize)).status).toBe(200);
    // The restart the freeze precedes: a forgotten session resumes, and reads.
    await host.close();
    host = new McpHttpHost(hostOptions);
    const resumed = await post(url, on(id), callTool('read'));
    expect(resumed.status).toBe(200);
    expect(resumed.text).toContain('READ-DONE');
    expect((await post(url, on(id), callTool('start'))).status).toBe(503);
    frozen = false;
    expect((await post(url, on(id), callTool('start'))).text).toContain('STARTED');
  });
});
