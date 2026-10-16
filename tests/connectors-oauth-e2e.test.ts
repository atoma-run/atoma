import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ConnectorService, type ConnectorActor } from '../src/connectors/service.js';
import { ConnectorStore } from '../src/connectors/store.js';
import { connectorFetch } from '../src/connectors/guardedFetch.js';
import { openConnectorRuntime } from '../src/connectors/runtime.js';
import { createMcpConnectorTools } from '../src/tools/mcpConnectors.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';

/**
 * A customer's MCP server behind its own OAuth authorization server, both on
 * loopback: discovery, dynamic registration, S256 PKCE, the code exchange,
 * tool discovery, the launch hand-off and the run's two elements, end to end.
 */

interface FakeState {
  base: string;
  codes: Map<string, { challenge: string; redirect: string }>;
  access: Set<string>;
  refresh: string | null;
  refreshes: number;
  calls: { tool: string; args: unknown }[];
  registered: number;
}

async function fakeCustomer(): Promise<{ server: Server; state: FakeState }> {
  const state: FakeState = { base: '', codes: new Map(), access: new Set(), refresh: null, refreshes: 0, calls: [], registered: 0 };
  const issue = (res: ServerResponse) => {
    const access = `at-${randomBytes(6).toString('hex')}`;
    const refresh = `rt-${randomBytes(6).toString('hex')}`;
    state.access.add(access);
    state.refresh = refresh;
    json(res, 200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh });
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) => new Promise<string>(resolve => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => resolve(text));
  });
  const mcp = () => {
    const server = new McpServer({ name: 'customer', version: '1' });
    server.registerTool('search_notes', {
      description: 'Search notes', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true },
    }, async ({ query }) => {
      state.calls.push({ tool: 'search_notes', args: { query } });
      return { content: [{ type: 'text', text: `found: ${query}` }] };
    });
    server.registerTool('delete_note', { description: 'Delete a note', inputSchema: { id: z.string() } }, async ({ id }) => {
      state.calls.push({ tool: 'delete_note', args: { id } });
      return { content: [{ type: 'text', text: `deleted ${id}` }] };
    });
    server.registerTool('snapshot', { description: 'A picture', inputSchema: {} }, async () => ({
      content: [{ type: 'image', data: 'A'.repeat(50_000), mimeType: 'image/png' }, { type: 'text', text: 'ok' }],
    }));
    return server;
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', state.base);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, { resource: `${state.base}/mcp`, authorization_servers: [state.base] });
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: state.base, authorization_endpoint: `${state.base}/authorize`, token_endpoint: `${state.base}/token`,
        registration_endpoint: `${state.base}/register`, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (url.pathname === '/register') {
      state.registered++;
      const metadata = JSON.parse(await body(req)) as Record<string, unknown>;
      json(res, 201, { ...metadata, client_id: `client-${state.registered}` });
      return;
    }
    if (url.pathname === '/authorize') {
      const code = `code-${randomBytes(4).toString('hex')}`;
      state.codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect: url.searchParams.get('redirect_uri') ?? '' });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await body(req));
      if (form.get('grant_type') === 'authorization_code') {
        const pending = state.codes.get(form.get('code') ?? '');
        state.codes.delete(form.get('code') ?? '');
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!pending || pending.challenge !== challenge || pending.redirect !== form.get('redirect_uri')) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        issue(res);
        return;
      }
      if (form.get('grant_type') === 'refresh_token') {
        // Rotation: a refresh token works once.
        if (!state.refresh || form.get('refresh_token') !== state.refresh) { json(res, 400, { error: 'invalid_grant' }); return; }
        state.refreshes++;
        issue(res);
        return;
      }
      json(res, 400, { error: 'unsupported_grant_type' });
      return;
    }
    if (url.pathname === '/mcp') {
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!token || !state.access.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp"` });
        res.end();
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const instance = mcp();
      res.on('close', () => { void transport.close(); void instance.close(); });
      await instance.connect(transport);
      const raw = req.method === 'POST' ? JSON.parse(await body(req) || 'null') as unknown : undefined;
      await transport.handleRequest(req, res, raw);
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, state };
}

let dir: string;
let customer: Awaited<ReturnType<typeof fakeCustomer>>;
let service: ConnectorService;
let events: PlatformEventInput[];
let dbFile: string;
let clock: number;
const actor: ConnectorActor = { principalId: 'admin-1', orgId: 'org', role: 'org:admin', platformAdmin: false };
const member: ConnectorActor = { ...actor, principalId: 'member-1', role: 'org:member' };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atoma-connectors-e2e-'));
  dbFile = join(dir, 'atoma.db');
  const seed = new Database(dbFile);
  seed.exec(`CREATE TABLE auth_organisations (org_id TEXT PRIMARY KEY);
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, UNIQUE(project_id, org_id));
    INSERT INTO auth_organisations VALUES ('org'); INSERT INTO projects VALUES ('proj', 'org');`);
  seed.close();
  customer = await fakeCustomer();
  events = [];
  clock = Date.now();
  service = new ConnectorService({
    store: ConnectorStore.open(dbFile, { loopbackForTests: true }),
    encryption: { key: createSecretKey(randomBytes(32)), keyId: 'k1' },
    fetch: connectorFetch({ loopbackForTests: true }),
    redirectUrl: 'https://atoma.test/api/org/mcp-servers/oauth/callback',
    events: event => { events.push(event); },
    projectInOrg: (orgId, projectId) => orgId === 'org' && projectId === 'proj',
    loopbackForTests: true,
    now: () => clock,
  });
});

afterEach(async () => {
  await new Promise(resolve => customer.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(): Promise<string> {
  const created = service.create(actor, { key: 'notes', name: 'Notes', url: `${customer.state.base}/mcp`, authKind: 'oauth' });
  expect(created.status).toBe('authorization_required');
  const authorizationUrl = await service.startAuthorization(actor, created.id, 'session-a');
  // The admin's browser follows it; the authorization server sends it back to Atoma.
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  const back = new URL(response.headers.get('location')!);
  expect(back.origin + back.pathname).toBe('https://atoma.test/api/org/mcp-servers/oauth/callback');
  const view = await service.finishAuthorization(
    { state: back.searchParams.get('state')!, code: back.searchParams.get('code')!, sessionKey: 'session-a' },
    orgId => orgId === 'org' ? actor : null);
  expect(view.status).toBe('ready');
  return view.id;
}

describe('a customer MCP server behind OAuth', () => {
  it('authorizes, discovers tools and journals without secret material', async () => {
    const id = await connect();
    const [server] = service.list(actor);
    expect(server!.tools.map(tool => tool.name).sort()).toEqual(['delete_note', 'search_notes', 'snapshot']);
    expect(server!.tools.find(tool => tool.name === 'search_notes')?.readOnly).toBe(true);
    expect(server!.id).toBe(id);
    expect(events.map(event => event.kind)).toEqual(['org.mcp_server_added', 'org.mcp_server_authorized']);
    expect(JSON.stringify(events)).not.toMatch(/at-|rt-|code-/);
    // A member reads the connection, never manages it.
    expect(service.list(member)[0]!.url).toBeUndefined();
    await expect(service.refreshTools(member, id)).rejects.toThrow(/owner or admin/);
  });

  it('refuses a callback from another session, and a reused state', async () => {
    const created = service.create(actor, { key: 'notes', name: 'Notes', url: `${customer.state.base}/mcp`, authKind: 'oauth' });
    const authorizationUrl = await service.startAuthorization(actor, created.id, 'session-a');
    const back = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location')!);
    const input = { state: back.searchParams.get('state')!, code: back.searchParams.get('code')! };
    await expect(service.finishAuthorization({ ...input, sessionKey: 'session-b' }, () => actor)).rejects.toThrow(/not started from this session/);
    // The state was consumed by the refused attempt.
    await expect(service.finishAuthorization({ ...input, sessionKey: 'session-a' }, () => actor)).rejects.toThrow();
    expect(service.list(actor)[0]!.oauthConnected).toBe(false);
  });

  it('hands a run an access token, never the refresh token, and the run calls only enabled tools', async () => {
    const id = await connect();
    expect(await service.launchFor('org', 'proj', Date.now() + 60_000)).toBeNull();
    service.setProjectServers(actor, 'proj', { serverIds: [id], expectedServerIds: [] });
    expect(events.at(-1)).toMatchObject({ kind: 'project.mcp_servers_changed', projectId: 'proj', detail: { added: ['notes'] } });
    const launch = (await service.launchFor('org', 'proj', Date.now() + 60_000))!;
    expect(JSON.stringify(launch)).not.toContain(customer.state.refresh!);
    expect(launch.connectors[0]).toMatchObject({ status: 'ready', key: 'notes' });

    const runtime = openConnectorRuntime(dbFile, launch, connectorFetch({ loopbackForTests: true }));
    const tools = createMcpConnectorTools(runtime, { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });
    try {
      const listed = await tools.execute('list_mcp_tools', {}) as unknown as { ok: true; servers: { status: string; tools: { name: string }[] }[] };
      expect(listed.ok).toBe(true);
      expect(listed.servers[0]!.tools.map(tool => tool.name).sort()).toEqual(['delete_note', 'search_notes', 'snapshot']);

      const found = await tools.execute('call_mcp_tool', { server: 'notes', tool: 'search_notes', arguments: { query: 'roadmap' } });
      expect(found).toMatchObject({ ok: true, isError: false, content: [{ type: 'text', text: 'found: roadmap' }] });

      const picture = await tools.execute('call_mcp_tool', { server: 'notes', tool: 'snapshot' }) as unknown as { content: unknown[] };
      expect(JSON.stringify(picture)).not.toContain('AAAA');

      // An admin switches a tool off mid-run: the next call is refused before it reaches the server.
      service.update(actor, id, { expectedRevision: 1, disabledTools: ['delete_note'] });
      const refused = await tools.execute('call_mcp_tool', { server: 'notes', tool: 'delete_note', arguments: { id: 'n1' } });
      expect(refused).toMatchObject({ ok: false, status: 'tool_disabled' });
      expect(customer.state.calls.map(call => call.tool)).toEqual(['search_notes']);
      const relisted = await tools.execute('list_mcp_tools', { server: 'notes' }) as unknown as { servers: { tools: { name: string }[] }[] };
      expect(relisted.servers[0]!.tools.map(tool => tool.name)).not.toContain('delete_note');

      // And takes the server away from the project: every call is denied.
      service.setProjectServers(actor, 'proj', { serverIds: [], expectedServerIds: [id] });
      expect(await tools.execute('call_mcp_tool', { server: 'notes', tool: 'search_notes', arguments: { query: 'x' } }))
        .toMatchObject({ ok: false, status: 'denied' });
      expect(await tools.execute('call_mcp_tool', { server: 'other', tool: 'x' })).toMatchObject({ ok: false, status: 'unknown_server' });
    } finally {
      await tools.close();
      await runtime.dispose();
    }
  });

  it('refreshes once for two launches racing on a rotating refresh token, best effort past the token lifetime', async () => {
    const id = await connect();
    service.setProjectServers(actor, 'proj', { serverIds: [id], expectedServerIds: [] });
    // Ten minutes later, two runs need a token valid past the current one's expiry.
    clock += 10 * 60_000;
    const far = clock + 2 * 3600_000;
    const [a, b] = await Promise.all([service.launchFor('org', 'proj', far), service.launchFor('org', 'proj', far)]);
    expect(a!.connectors[0]!.status).toBe('ready');
    expect(b!.connectors[0]!.status).toBe('ready');
    // No token of this server lives two hours (expires_in 3600): the first launch
    // refreshes and both receive that freshest token; the second does not spend
    // the rotated refresh token again on a token one minute old.
    expect(customer.state.refreshes).toBe(1);
    expect(a!.connectors[0]).toEqual(b!.connectors[0]);
  });

  it('keeps a working authorization when a second one fails', async () => {
    const id = await connect();
    service.setProjectServers(actor, 'proj', { serverIds: [id], expectedServerIds: [] });
    const authorizationUrl = await service.startAuthorization(actor, id, 'session-a');
    const back = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location')!);
    await expect(service.finishAuthorization({ state: back.searchParams.get('state')!, code: 'expired-code', sessionKey: 'session-a' },
      () => actor)).rejects.toThrow();
    expect(service.list(actor)[0]!.oauthConnected).toBe(true);
    expect((await service.launchFor('org', 'proj', Date.now() + 60_000))!.connectors[0]!.status).toBe('ready');
  });

  it('stops a run in flight when its connection is pointed at another server', async () => {
    const id = await connect();
    service.setProjectServers(actor, 'proj', { serverIds: [id], expectedServerIds: [] });
    const launch = (await service.launchFor('org', 'proj', Date.now() + 60_000))!;
    const runtime = openConnectorRuntime(dbFile, launch, connectorFetch({ loopbackForTests: true }));
    const tools = createMcpConnectorTools(runtime, { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });
    expect(await tools.execute('call_mcp_tool', { server: 'notes', tool: 'search_notes', arguments: { query: 'a' } })).toMatchObject({ ok: true });
    service.update(actor, id, { expectedRevision: 1, url: `${customer.state.base}/other-mcp` });
    expect(await tools.execute('call_mcp_tool', { server: 'notes', tool: 'search_notes', arguments: { query: 'b' } })).toMatchObject({ ok: false, status: 'denied' });
    await runtime.dispose();
  });

  it('never shows a member a server\'s response body, which may echo a secret path', async () => {
    const created = service.create(actor, { key: 'lost', name: 'Lost', url: `${customer.state.base}/secret-path-123/mcp`, authKind: 'none' });
    const view = await service.refreshTools(actor, created.id);
    expect(view.toolsError).toMatch(/Could not list tools/);
    expect(view.toolsError).not.toContain('secret-path-123');
  });

  it('reports a connection whose authorization is gone as unavailable, with its reason', async () => {
    const id = await connect();
    service.setProjectServers(actor, 'proj', { serverIds: [id], expectedServerIds: [] });
    customer.state.refresh = null;
    clock += 10 * 60_000;
    const launch = (await service.launchFor('org', 'proj', clock + 2 * 3600_000))!;
    expect(launch.connectors[0]).toMatchObject({ status: 'unavailable', key: 'notes' });
    const runtime = openConnectorRuntime(dbFile, launch, connectorFetch({ loopbackForTests: true }));
    const tools = createMcpConnectorTools(runtime, { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });
    const listed = await tools.execute('list_mcp_tools', {}) as unknown as { servers: { status: string; reason?: string }[] };
    expect(listed.servers[0]).toMatchObject({ status: 'unavailable' });
    expect(listed.servers[0]!.reason).toMatch(/authoriz/);
    await runtime.dispose();
  });
});
