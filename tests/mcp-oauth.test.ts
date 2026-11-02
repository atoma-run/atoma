import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, type Viewer } from '../src/auth/store.js';
import { McpOAuth } from '../src/auth/mcpOAuth.js';
import { coarseNetwork, MCP_REFRESH_REUSE_GRACE_MS } from '../src/auth/mcpOAuthStore.js';
import { loginClientAddress, snapshotTrustedProxies } from '../src/auth/rate-limit.js';
import { issueSession, parseCookieHeader, SESSION_COOKIE } from '../src/auth/sessions.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import { auth as sdkAuth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';

let db: Database.Database;
let auth: AuthStore;
let server: Server;
let mcp: McpHttpHost;
let base: string;
let viewer: Viewer;
let cookie: string;
let events: PlatformEventInput[];
/** The client metadata documents the fake web serves, and the URLs the server fetched. */
let documents: Map<string, string>;
let fetched: string[];
const callback = 'http://127.0.0.1:54321/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

beforeEach(async () => {
  db = new Database(':memory:'); auth = new AuthStore(db); events = []; documents = new Map(); fetched = [];
  viewer = auth.completeLogin({ provider: 'github', subject: 'oauth-test', displayName: 'OAuth Test', email: null, emailVerified: false }, null)!.viewer;
  cookie = `${SESSION_COOKIE}=${issueSession(auth, viewer, { secure: false }).token}`;
  server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const gate = { enabled: true, store: auth, resolve: (req: import('node:http').IncomingMessage) => {
    const tokens = parseCookieHeader(req.headers.cookie).filter(c => c.name === SESSION_COOKIE);
    return tokens.length === 1 ? auth.resolveSession(tokens[0]!.value) : null;
  } };
  const oauth = new McpOAuth({ gate, origin: new URL(base), clientAddress: req => String(req.headers['x-test-address'] ?? 'local'), emit: e => { events.push(e); },
    fetchClientMetadata: (url) => {
      fetched.push(url.href);
      const body = documents.get(url.href);
      return body === undefined ? Promise.reject(new Error('404')) : Promise.resolve({ body, cacheControl: undefined });
    } });
  mcp = new McpHttpHost({ resourceMetadataUrl: oauth.metadataUrl, allowedHosts: [new URL(base).host],
    resolveCaller: req => {
      const resolved = auth.resolveApiToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!resolved) return null;
      const { tokenId, ...identity } = resolved;
      return { kind: 'principal', viewer: identity, tokenId };
    }, ...mcpHostWiring({ projects: null, auth, journal: null, operatorRuns: false }) });
  server.on('request', (req, res) => {
    void (async () => {
      if (await oauth.handle(req, res, new URL(req.url!, base))) return;
      if (req.url === '/mcp') { await mcp.handle(req, res); return; }
      res.writeHead(404).end();
    })().catch((error: unknown) => { res.writeHead(500).end(String(error)); });
  });
});
afterEach(async () => {
  await mcp.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve())); db.close();
});
const post = (path: string, data: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data),
});
async function register(redirects = [callback]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Codex <test>', redirect_uris: redirects, token_endpoint_auth_method: 'none' }) });
  expect(r.status).toBe(201);
  return (await r.json() as { client_id: string }).client_id;
}
async function consent(clientId: string, changes: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback,
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'mcp', state: 'client-state', ...changes });
  return fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie }, redirect: 'manual' });
}
async function code(clientId: string) {
  const page = await consent(clientId); expect(page.status).toBe(200);
  const html = await page.text(); expect(html).toContain('Codex &lt;test&gt;');
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const approved = await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('client-state');
  expect(location.searchParams.get('iss')).toBe(base);
  return location.searchParams.get('code')!;
}
function exchange(clientId: string, authorizationCode: string, changes: Record<string, string> = {}) {
  return post('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: authorizationCode,
    redirect_uri: callback, code_verifier: verifier, resource: `${base}/mcp`, ...changes });
}
interface Tokens { access_token: string; refresh_token: string; expires_in: number }

describe('MCP OAuth over HTTP', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts an ephemeral HTTP loopback port for %s and binds the code to that exact callback', async (host) => {
    const clientId = 'https://chatgpt.com/oauth/codex/client.json';
    const registered = `http://${host}/callback`;
    const actual = `http://${host}:55661/callback`;
    documents.set(clientId, JSON.stringify({ client_id: clientId, client_name: 'Codex',
      application_type: 'native', redirect_uris: [registered], token_endpoint_auth_method: 'none' }));
    for (const id of [clientId, await register([registered])]) {
      const page = await consent(id, { redirect_uri: actual });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(actual);
      const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
      const approved = await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base });
      expect(approved.status).toBe(302);
      const location = new URL(approved.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(actual);
      const authorizationCode = location.searchParams.get('code')!;
      expect((await exchange(id, authorizationCode, { redirect_uri: registered })).status).toBe(400);
      const response = await exchange(id, authorizationCode, { redirect_uri: actual });
      expect(response.status).toBe(200);
      const tokens = await response.json() as Tokens;
      expect(auth.resolveApiToken(tokens.access_token)?.principalId).toBe(viewer.principalId);
    }
  });

  it('defers anonymous metadata fetches until the login continuation authenticates', async () => {
    const clientId = 'https://client.example/oauth/metadata.json';
    documents.set(clientId, JSON.stringify({ client_id: clientId, client_name: 'Codex', redirect_uris: [callback] }));
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback,
      code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp` });
    const anonymous = await fetch(`${base}/oauth/authorize?${query}`, { redirect: 'manual' });
    expect(anonymous.headers.get('location')).toBe('/auth/login');
    expect(fetched).toEqual([]);
    const continuation = parseCookieHeader(anonymous.headers.get('set-cookie') ?? '')
      .find(value => value.name === 'atoma_mcp_return')!.value;
    const page = await fetch(`${base}/oauth/authorize?request=${continuation}`, { headers: { cookie }, redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connect to Atoma');
    expect(fetched).toEqual([clientId]);
  });

  it('admits a client by its metadata document: fetched, verified, shown by domain, remembered for its tokens', async () => {
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server`).then(r => r.json());
    expect(discovery).toMatchObject({ client_id_metadata_document_supported: true });
    const clientId = 'https://client.example/oauth/metadata.json';
    documents.set(clientId, JSON.stringify({ client_id: clientId, client_name: 'Codex <test>', redirect_uris: [callback] }));
    const page = await consent(clientId);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`Client description read at <code>${clientId}</code>`);
    expect(html).toContain('returns to a program on your own computer');
    // Nothing is written for a client nobody has allowed yet.
    expect(auth.mcpOAuth.client(clientId)).toBeNull();
    const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
    const approved = await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base });
    expect(auth.mcpOAuth.client(clientId)).toMatchObject({ client_name: 'Codex <test>' });
    const authorizationCode = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    // The token endpoint never fetches: it finds the client the authorization remembered.
    const response = await exchange(clientId, authorizationCode);
    expect(response.status).toBe(200);
    const tokens = await response.json() as Tokens;
    const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` });
    expect(refreshed.status).toBe(200);
    const client = new Client({ name: 'oauth-cimd', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${(await refreshed.json() as Tokens).access_token}` } } }));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally { await client.close(); }
    expect(fetched).toEqual([clientId]);
  });

  it('refuses a metadata client whose document does not vouch for the request, without redirecting', async () => {
    const clientId = 'https://client.example/oauth/metadata.json';
    documents.set(clientId, JSON.stringify({ client_id: 'https://other.example/metadata.json', client_name: 'Other', redirect_uris: [callback] }));
    const mismatched = await consent(clientId);
    expect(mismatched.status).toBe(400);
    expect(mismatched.headers.get('location')).toBeNull();
    const narrow = 'https://client.example/narrow.json';
    documents.set(narrow, JSON.stringify({ client_id: narrow, client_name: 'Narrow', redirect_uris: ['http://127.0.0.1:9/elsewhere'] }));
    expect((await consent(narrow)).status).toBe(400);
    // Not a metadata URL: looked up as a registered id, never fetched.
    expect((await consent('https://client.example:8443/oauth/metadata.json')).status).toBe(400);
    expect((await consent('http://client.example/oauth/metadata.json')).status).toBe(400);
    expect(fetched).toEqual([clientId, narrow]);
    // Nothing unverified reached the token endpoint's client table.
    expect(auth.mcpOAuth.client(clientId)).toBeNull();
  });

  it('switches accounts without granting access or reusing the displayed consent', async () => {
    auth.grantPlatformAdmin(viewer.principalId);
    const clientId = await register();
    const existing = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const request = /name="request" value="([^"]+)"/.exec(await (await consent(clientId)).text())![1]!;
    expect((await post('/oauth/authorize', { request, decision: 'switch' }, { cookie, origin: 'https://evil.example' })).status).toBe(403);
    const switched = await post('/oauth/authorize', { request, decision: 'switch' }, { cookie, origin: base });
    expect(switched.headers.get('location')).toBe('/auth/login?select_account=1');
    expect(auth.resolveSession(cookie.split('=')[1]!)).toBeNull();
    expect(auth.resolveApiToken(existing.access_token)?.principalId).toBe(viewer.principalId);
    const returnCookie = switched.headers.getSetCookie().find(c => c.startsWith('atoma_mcp_return='))!;
    const nextRequest = parseCookieHeader(returnCookie)[0]!.value;
    expect(nextRequest).not.toBe(request);
    const second = auth.completeLogin({ provider: 'github', subject: 'normal-user', displayName: 'Normal User',
      email: 'normal@example.com', emailVerified: false }, null)!.viewer;
    const secondCookie = `${SESSION_COOKIE}=${issueSession(auth, second, { secure: false }).token}`;
    expect((await post('/oauth/authorize', { request, decision: 'allow' }, { cookie: secondCookie, origin: base })).status).toBe(400);
    expect((await post('/oauth/authorize', { request: nextRequest, decision: 'allow' }, { cookie: secondCookie, origin: base })).status).toBe(403);
    const page = await fetch(`${base}/oauth/authorize?request=${nextRequest}`, { headers: { cookie: secondCookie } });
    const html = await page.text();
    expect(html).toContain('Normal User'); expect(html).toContain('normal@example.com');
    expect(html).not.toContain('OAuth Test');
    expect(html).not.toContain('Platform administrator');
    const approved = await post('/oauth/authorize', { request: nextRequest, decision: 'allow' }, { cookie: secondCookie, origin: base });
    const location = new URL(approved.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe('client-state');
    const tokens = await (await exchange(clientId, location.searchParams.get('code')!)).json() as Tokens;
    expect(auth.resolveApiToken(tokens.access_token)?.principalId).toBe(second.principalId);
    expect(auth.resolveApiToken(tokens.access_token)?.platformAdmin).toBe(false);
    expect(auth.listApiTokens(viewer.principalId)).toHaveLength(1);
  });

  it('discovers, consents, exchanges, calls the real MCP and revokes through existing API-token ownership', async () => {
    const denied = await fetch(`${base}/mcp`);
    expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain('resource_metadata=');
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then(r => r.json());
    expect(metadata).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server`).then(r => r.json());
    expect(discovery).toMatchObject({ code_challenge_methods_supported: ['S256'], registration_endpoint: `${base}/oauth/register` });
    const clientId = await register();
    const response = await exchange(clientId, await code(clientId)); expect(response.status).toBe(200);
    const tokens = await response.json() as Tokens; expect(tokens.expires_in).toBeGreaterThanOrEqual(3599);
    const client = new Client({ name: 'oauth-smoke', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally { await client.close(); }
    const record = auth.listApiTokens(viewer.principalId)[0]!;
    expect(record.label).toBe('OAuth: Codex <test>');
    expect(events.map(e => e.kind)).toContain('token.created');
    auth.revokeApiToken(viewer.principalId, record.tokenId);
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect((await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` })).status).toBe(400);
  });

  it('rejects invalid PKCE, redirect, audience and client without consuming a valid code; a valid replay revokes it', async () => {
    const clientId = await register(); const authCode = await code(clientId);
    for (const invalid of ([{ code_verifier: 'x'.repeat(43) }, { redirect_uri: 'https://evil.example/cb' },
      { resource: 'https://evil.example/mcp' }, { client_id: await register() }] as Record<string, string>[])) {
      expect((await exchange(clientId, authCode, invalid)).status).toBe(400);
    }
    const tokens = await (await exchange(clientId, authCode)).json() as Tokens;
    expect(auth.resolveApiToken(tokens.access_token)).not.toBeNull();
    expect((await exchange(clientId, authCode)).status).toBe(400);
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect(events.filter(e => e.kind === 'token.revoked')).toMatchObject([
      { detail: { clientId, reason: 'authorization_code_reuse' } },
    ]);
  });

  /** Ages every consumed refresh token past the reuse grace, as two minutes passing would. */
  const pastGrace = () => db.prepare('UPDATE auth_mcp_refresh SET used_at = used_at - ? WHERE used_at IS NOT NULL').run(MCP_REFRESH_REUSE_GRACE_MS + 1);

  it('rotates refresh tokens, detects reuse past the grace and enforces access expiry and current roles', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    db.prepare('UPDATE auth_mcp_grants SET access_expires_at = 0').run();
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    db.prepare("UPDATE auth_memberships SET role = 'org:viewer'").run();
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    const refreshed = await (await post('/oauth/token', data)).json() as Tokens;
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    expect(auth.resolveApiToken(refreshed.access_token)?.role).toBe('org:viewer');
    pastGrace();
    expect((await post('/oauth/token', data)).status).toBe(400);
    expect(auth.resolveApiToken(refreshed.access_token)).toBeNull();
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(401);
    expect(events.filter(e => e.kind === 'token.revoked')).toMatchObject([
      { detail: { clientId, reason: 'refresh_token_reuse' } },
    ]);
    expect(events.filter(e => e.kind === 'token.refresh_replayed')).toEqual([]);
  });

  // Production journaled 42 refresh_token_reuse revocations in October 2026,
  // nearly all a second client process renewing within seconds of the first.
  it('answers racing renewals of one refresh token with one pair, journals the replay, and keeps the grant', async () => {
    const clientId = await register(); const authCode = await code(clientId);
    const tokens = await (await exchange(clientId, authCode)).json() as Tokens;
    const tokenId = auth.resolveApiToken(tokens.access_token)!.tokenId;
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    // Two HTTP requests share one refresh credential, as independent client instances can.
    const responses = await Promise.all([post('/oauth/token', data), post('/oauth/token', data)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(responses.map(r => r.json() as Promise<Tokens>));
    // The same pair; only the countdown to its one expiry may have ticked between the two answers.
    expect({ ...second, expires_in: 0 }).toEqual({ ...first, expires_in: 0 });
    expect(Math.abs(second!.expires_in - first!.expires_in)).toBeLessThanOrEqual(1);
    expect(first!.refresh_token).not.toBe(tokens.refresh_token);
    const client = new Client({ name: 'grace', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${first!.access_token}` } } }));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally { await client.close(); }
    expect(events.filter(e => e.kind === 'token.revoked')).toEqual([]);
    // A third presentation still answers, and the journal keeps one row per consumed token.
    expect((await post('/oauth/token', data)).status).toBe(200);
    const replays = events.filter(e => e.kind === 'token.refresh_replayed');
    expect(replays).toMatchObject([{
      kind: 'token.refresh_replayed', actorType: 'principal', actorId: viewer.principalId, orgId: viewer.orgId,
      summary: 'MCP OAuth refresh answered again within its reuse grace', detail: { tokenId, clientId },
    }]);
    expect((replays[0]!.detail as { secondsAfterRotation: number }).secondsAfterRotation).toBeLessThanOrEqual(2);
    // The next generation still rotates and still detects reuse past the grace.
    const next = await (await post('/oauth/token', { ...data, refresh_token: first!.refresh_token })).json() as Tokens;
    expect(auth.resolveApiToken(next.access_token)?.tokenId).toBe(tokenId);
    pastGrace();
    expect((await post('/oauth/token', data)).status).toBe(400);
    expect(auth.resolveApiToken(next.access_token)).toBeNull();
    expect(events.filter(e => e.kind === 'token.revoked')).toMatchObject([{ detail: { tokenId, clientId, reason: 'refresh_token_reuse' } }]);
    for (const secret of [authCode, tokens.access_token, tokens.refresh_token, first!.access_token, first!.refresh_token]) {
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(createHash('sha256').update(secret).digest('hex'));
    }
  });

  it('answers a refresh token consumed twice since with the grant\'s CURRENT pair, never a superseded one', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const data = { grant_type: 'refresh_token', client_id: clientId, resource: `${base}/mcp` };
    const second = await (await post('/oauth/token', { ...data, refresh_token: tokens.refresh_token })).json() as Tokens;
    const third = await (await post('/oauth/token', { ...data, refresh_token: second.refresh_token })).json() as Tokens;
    expect(auth.resolveApiToken(second.access_token)).toBeNull();
    // A process that lost the first response retries with the first token.
    const retried = await (await post('/oauth/token', { ...data, refresh_token: tokens.refresh_token })).json() as Tokens;
    expect(retried.access_token).toBe(third.access_token);
    expect(retried.refresh_token).toBe(third.refresh_token);
    expect(auth.resolveApiToken(retried.access_token)).not.toBeNull();
    expect(events.filter(e => e.kind === 'token.revoked')).toEqual([]);
  });

  it('refuses a replay from another client and revokes a consumed token that predates the grace columns', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    const refreshed = await (await post('/oauth/token', data)).json() as Tokens;
    expect((await post('/oauth/token', { ...data, client_id: await register() })).status).toBe(400);
    expect(auth.resolveApiToken(refreshed.access_token)).not.toBeNull();
    // A refresh consumed by the previous release carries no used_at and no successor.
    db.prepare('UPDATE auth_mcp_refresh SET used_at = NULL, successor = NULL WHERE used = 1').run();
    expect((await post('/oauth/token', data)).status).toBe(400);
    expect(auth.resolveApiToken(refreshed.access_token)).toBeNull();
    expect(events.filter(e => e.kind === 'token.revoked')).toMatchObject([{ detail: { clientId, reason: 'refresh_token_reuse' } }]);
  });

  it('stores no readable credential for the grace and drops the sealed pair once the grace is over', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const refreshed = await (await post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` })).json() as Tokens;
    const rows = JSON.stringify(db.prepare('SELECT * FROM auth_mcp_refresh').all());
    for (const secret of [tokens.refresh_token, refreshed.access_token, refreshed.refresh_token]) {
      expect(rows).not.toContain(secret);
      expect(rows).not.toContain(Buffer.from(secret).toString('base64url'));
    }
    expect(db.prepare('SELECT count(*) AS n FROM auth_mcp_refresh WHERE successor IS NOT NULL').get()).toEqual({ n: 1 });
    auth.mcpOAuth.sweep();
    expect(db.prepare('SELECT count(*) AS n FROM auth_mcp_refresh WHERE successor IS NOT NULL').get()).toEqual({ n: 1 });
    pastGrace(); auth.mcpOAuth.sweep();
    expect(db.prepare('SELECT count(*) AS n FROM auth_mcp_refresh WHERE successor IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('adds the grace columns when the auth store opens a store created before them', () => {
    const old = new Database(':memory:');
    try {
      new AuthStore(old);
      for (const column of ['replays', 'rotated_from', 'successor', 'used_at']) old.exec(`ALTER TABLE auth_mcp_refresh DROP COLUMN ${column}`);
      expect((old.prepare('PRAGMA table_info(auth_mcp_refresh)').all() as Array<{ name: string }>).map(c => c.name)).toEqual(['token_hash', 'token_id', 'used']);
      new AuthStore(old);
      new AuthStore(old);
      expect((old.prepare('PRAGMA table_info(auth_mcp_refresh)').all() as Array<{ name: string }>).map(c => c.name))
        .toEqual(['token_hash', 'token_id', 'used', 'used_at', 'successor', 'rotated_from', 'replays']);
    } finally { old.close(); }
  });

  it('replays only to the network that rotated: elsewhere a reuse still revokes, as a theft must', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    const rotated = await (await post('/oauth/token', data, { 'x-test-address': '203.0.113.7' })).json() as Tokens;
    // Another process behind the same home router: same /24.
    const sibling = await post('/oauth/token', data, { 'x-test-address': '203.0.113.9' });
    expect(sibling.status).toBe(200);
    expect((await sibling.json() as Tokens).access_token).toBe(rotated.access_token);
    // Someone elsewhere holding the same consumed token.
    expect((await post('/oauth/token', data, { 'x-test-address': '198.51.100.4' })).status).toBe(400);
    expect(auth.resolveApiToken(rotated.access_token)).toBeNull();
    expect(events.filter(e => e.kind === 'token.revoked')).toMatchObject([{ detail: { clientId, reason: 'refresh_token_reuse' } }]);
  });

  it('answers nothing in the grace once the member has left the organisation', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    expect((await post('/oauth/token', data)).status).toBe(200);
    db.prepare('DELETE FROM auth_memberships WHERE principal_id = ?').run(viewer.principalId);
    expect((await post('/oauth/token', data)).status).toBe(400);
    expect(events.filter(e => e.kind === 'token.refresh_replayed')).toEqual([]);
  });

  it('refuses a replay from a revoked grant without journaling another revocation', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const data = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${base}/mcp` };
    const rotated = await (await post('/oauth/token', data)).json() as Tokens;
    const tokenId = auth.resolveApiToken(rotated.access_token)!.tokenId;
    expect(auth.revokeApiToken(viewer.principalId, tokenId)).toBe(true);
    const before = events.length;
    expect((await post('/oauth/token', data)).status).toBe(400);
    expect(events.length).toBe(before);
  });

  // Review 2026-11-02: refusing here left the rightful client locked out while
  // a same-network thief who rotated in a burst kept the grant for 30 days.
  it('revokes, with its own reason, when a replay would walk more rotations than one grace can hold', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const input = { clientId, resource: `${base}/mcp`, network: 'local' };
    let current = tokens.refresh_token;
    for (let i = 0; i < 34; i += 1) current = auth.mcpOAuth.refresh(auth, { ...input, token: current })!.refresh_token;
    const revoked: Array<{ reason: string }> = [];
    expect(auth.mcpOAuth.refresh(auth, { ...input, token: tokens.refresh_token }, r => revoked.push(r))).toBeNull();
    expect(revoked.map(r => r.reason)).toEqual(['refresh_chain_exhausted']);
    expect(auth.mcpOAuth.refresh(auth, { ...input, token: current })).toBeNull();
  });

  it('never hands a replaying process a pair that a rotation from another network issued', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const input = { clientId, resource: `${base}/mcp` };
    // The rightful process rotates at home; someone elsewhere rotates the result.
    const home = auth.mcpOAuth.refresh(auth, { ...input, token: tokens.refresh_token, network: coarseNetwork('203.0.113.7') })!;
    auth.mcpOAuth.refresh(auth, { ...input, token: home.refresh_token, network: coarseNetwork('198.51.100.4') });
    const revoked: unknown[] = [];
    // A second home process presenting the first token must not receive what the other network obtained.
    expect(auth.mcpOAuth.refresh(auth, { ...input, token: tokens.refresh_token, network: coarseNetwork('203.0.113.9') }, r => revoked.push(r))).toBeNull();
    expect(revoked).toHaveLength(1);
  });

  it('derives the network from the forwarded client address behind the trusted proxy, as production does', () => {
    const trusted = snapshotTrustedProxies({ ATOMA_VIZ_TRUSTED_PROXIES: '127.0.0.1,::1' });
    const via = (forwarded: string, peer = '127.0.0.1') => coarseNetwork(loginClientAddress(
      { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } } as unknown as import('node:http').IncomingMessage, trusted));
    expect(via('203.0.113.7')).toBe(via('203.0.113.9'));
    expect(via('203.0.113.7')).not.toBe(via('198.51.100.4'));
    // Without the trusted proxy every caller would share the proxy's network and the binding would bind nothing.
    expect(coarseNetwork(loginClientAddress({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7' } } as unknown as import('node:http').IncomingMessage,
      snapshotTrustedProxies({})))).toBe('v4:127.0.0');
  });

  it('revokes when a sealed pair was tampered with, and never answers without a network', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    const input = { clientId, resource: `${base}/mcp`, token: tokens.refresh_token };
    const rotated = auth.mcpOAuth.refresh(auth, { ...input, network: 'local' })!;
    const revoked: unknown[] = [];
    expect(auth.mcpOAuth.refresh(auth, input, r => revoked.push(r))).toBeNull();
    expect(revoked).toHaveLength(1);
    const other = await register(); const second = await (await exchange(other, await code(other))).json() as Tokens;
    const again = { clientId: other, resource: `${base}/mcp`, token: second.refresh_token, network: 'local' };
    auth.mcpOAuth.refresh(auth, again);
    const sealed = (db.prepare('SELECT successor FROM auth_mcp_refresh WHERE successor IS NOT NULL AND replays = 0 ORDER BY rowid DESC').get() as { successor: string }).successor;
    const flipped = Buffer.from(sealed, 'base64url'); flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
    db.prepare('UPDATE auth_mcp_refresh SET successor = ? WHERE successor = ?').run(flipped.toString('base64url'), sealed);
    expect(auth.mcpOAuth.refresh(auth, again, r => revoked.push(r))).toBeNull();
    expect(revoked).toHaveLength(2);
    void rotated;
  });

  it('groups addresses by the network a NAT shares', () => {
    expect(coarseNetwork('203.0.113.7')).toBe(coarseNetwork('203.0.113.250'));
    expect(coarseNetwork('203.0.113.7')).not.toBe(coarseNetwork('203.0.114.7'));
    expect(coarseNetwork('::ffff:203.0.113.7')).toBe(coarseNetwork('203.0.113.1'));
    expect(coarseNetwork('2001:db8:1:2:aaaa::1')).toBe(coarseNetwork('2001:0db8:0001:0002:ffff:0:0:9'));
    expect(coarseNetwork('2001:db8:1:2::1')).not.toBe(coarseNetwork('2001:db8:1:3::1'));
    expect(coarseNetwork('local')).toBe('raw:local');
  });

  it('requires explicit consent bound to the displayed browser session, origin and organisation', async () => {
    const clientId = await register(); const html = await (await consent(clientId)).text();
    const request = /name="request" value="([^"]+)"/.exec(html)![1]!;
    const otherCookie = `${SESSION_COOKIE}=${issueSession(auth, viewer, { secure: false }).token}`;
    for (const headers of [{ cookie, origin: 'https://evil.example' }, { cookie, origin: 'null' }, { cookie: otherCookie, origin: base }]) {
      expect((await post('/oauth/authorize', { request, decision: 'allow' }, headers)).status).toBe(403);
    }
    expect(auth.listApiTokens(viewer.principalId)).toHaveLength(0);
    const denied = await post('/oauth/authorize', { request, decision: 'deny' }, { cookie, origin: base });
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect((await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base })).status).toBe(400);
  });

  it('rejects unsafe redirects, duplicate parameters, plain PKCE, unregistered redirects and foreign resources', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://user:pass@example.com/cb', 'https://example.com/cb#fragment']) {
      const refused = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [uri] }) });
      expect(refused.status).toBe(400);
      // RFC 7591 §3.2.2 names the refused field.
      expect(await refused.json()).toEqual({ error: 'invalid_redirect_uri' });
    }
    const badMetadata = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'client_secret_basic' }) });
    expect(await badMetadata.json()).toEqual({ error: 'invalid_client_metadata' });
    const clientId = await register();
    for (const invalid of ([{ code_challenge_method: 'plain' }, { redirect_uri: 'http://127.0.0.1:123/other' }, { resource: 'https://other.example/mcp' }] as Record<string, string>[])) {
      const r = await consent(clientId, invalid);
      if (invalid['redirect_uri']) { expect(r.status).toBe(400); expect(r.headers.get('location')).toBeNull(); }
      else { expect(r.status).toBe(302); expect(new URL(r.headers.get('location')!).searchParams.has('error')).toBe(true); }
    }
    expect((await fetch(`${base}/oauth/authorize?request=a&request=b`)).status).toBe(400);
  });

  it('interoperates with the SDK OAuth client for automatic discovery, DCR, PKCE and refresh', async () => {
    let clientInfo: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let authorizationUrl: URL | undefined;
    let savedVerifier = '';
    const provider: OAuthClientProvider = {
      redirectUrl: callback,
      clientMetadata: { client_name: 'SDK client', redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      clientInformation: () => clientInfo,
      saveClientInformation: value => { clientInfo = value; },
      tokens: () => tokens,
      saveTokens: value => { tokens = value; },
      redirectToAuthorization: value => { authorizationUrl = value; },
      saveCodeVerifier: value => { savedVerifier = value; },
      codeVerifier: () => savedVerifier,
    };
    expect(await sdkAuth(provider, { serverUrl: `${base}/mcp` })).toBe('REDIRECT');
    const page = await fetch(authorizationUrl!, { headers: { cookie }, redirect: 'manual' });
    expect(page.status).toBe(200);
    const request = /name="request" value="([^"]+)"/.exec(await page.text())![1]!;
    const allowed = await post('/oauth/authorize', { request, decision: 'allow' }, { cookie, origin: base });
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    expect(await sdkAuth(provider, { serverUrl: `${base}/mcp`, authorizationCode: code })).toBe('AUTHORIZED');
    const access = tokens!.access_token;
    expect(auth.resolveApiToken(access)).not.toBeNull();
    db.prepare('UPDATE auth_mcp_grants SET access_expires_at = 0').run();
    expect(await sdkAuth(provider, { serverUrl: `${base}/mcp` })).toBe('AUTHORIZED');
    expect(tokens!.access_token).not.toBe(access);
    expect(auth.resolveApiToken(tokens!.access_token)).not.toBeNull();
  });

  it('persists only credential hashes and enforces absolute renewal expiry after reopening the store', async () => {
    const clientId = await register();
    // A registration about to expire under a grant it receives now lives at
    // least as long as that grant can be renewed.
    db.prepare('UPDATE auth_mcp_clients SET expires_at = ? WHERE client_id = ?').run(Date.now() + 24 * 60 * 60 * 1000, clientId);
    const authCode = await code(clientId);
    const tokens = await (await exchange(clientId, authCode)).json() as Tokens;
    const registered = db.prepare('SELECT expires_at FROM auth_mcp_clients WHERE client_id = ?').get(clientId) as { expires_at: number };
    expect(registered.expires_at).toBeGreaterThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const copy = new Database(db.serialize());
    try {
      const reopened = new AuthStore(copy);
      expect(reopened.resolveApiToken(tokens.access_token)?.principalId).toBe(viewer.principalId);
      for (const table of ['auth_api_tokens', 'auth_mcp_codes', 'auth_mcp_refresh']) {
        const rows = JSON.stringify(copy.prepare(`SELECT * FROM ${table}`).all());
        for (const secret of [authCode, tokens.access_token, tokens.refresh_token]) expect(rows).not.toContain(secret);
      }
      copy.prepare('UPDATE auth_mcp_grants SET refresh_expires_at = 0').run();
      expect(reopened.mcpOAuth.refresh(reopened, { token: tokens.refresh_token, clientId, resource: `${base}/mcp` })).toBeNull();
      reopened.sweep();
      expect(copy.prepare('SELECT count(*) AS n FROM auth_mcp_refresh').get()).toEqual({ n: 0 });
    } finally { copy.close(); }
  });

  it('revokes via RFC 7009 without accepting another client’s token', async () => {
    const clientId = await register(); const tokens = await (await exchange(clientId, await code(clientId))).json() as Tokens;
    await post('/oauth/revoke', { client_id: await register(), token: tokens.refresh_token });
    expect(auth.resolveApiToken(tokens.access_token)).not.toBeNull();
    expect(events.filter(e => e.kind === 'token.revoked')).toHaveLength(0);
    await post('/oauth/revoke', { client_id: clientId, token: tokens.refresh_token });
    expect(auth.resolveApiToken(tokens.access_token)).toBeNull();
    await post('/oauth/revoke', { client_id: clientId, token: tokens.refresh_token });
    expect(events.filter(e => e.kind === 'token.revoked')).toMatchObject([
      { detail: { clientId, reason: 'client_revocation' } },
    ]);
  });
});
