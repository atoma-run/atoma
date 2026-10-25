import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AuthStore, type Viewer } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { ComputeDeviceStore } from '../src/projects/computeDevices.js';
import { ComputeHttp } from '../src/viz/computeHttp.js';
import { issueSession, parseCookieHeader, SESSION_COOKIE, authCookieName } from '../src/auth/sessions.js';
import type { PlatformEventInput } from '../src/contracts/platformEvents.js';

let db: Database.Database, auth: AuthStore, server: Server, base: string, cookie: string, viewer: Viewer;
let devices: ComputeDeviceStore, events: PlatformEventInput[];
const origin = 'https://compute.example';
beforeEach(async () => {
  db = new Database(':memory:'); auth = new AuthStore(db); new ProjectStore(db);
  devices = new ComputeDeviceStore(db, { appVersions: new Set(['test']), imageDigests: new Set() }); events = [];
  viewer = auth.completeLogin({ provider: 'github', subject: 'compute-test', displayName: 'Compute Test', email: null, emailVerified: false }, null)!.viewer;
  cookie = `${authCookieName(SESSION_COOKIE, true)}=${issueSession(auth, viewer, { secure: false }).token}`;
  const handler = new ComputeHttp({ devices, origin: new URL(origin), proxies: { addresses: ['127.0.0.1'] }, emit: event => { events.push(event); },
    gate: { enabled: true, store: auth, resolve: req => {
      const tokens = parseCookieHeader(req.headers.cookie).filter(c => c.name === authCookieName(SESSION_COOKIE, true));
      return tokens.length === 1 ? auth.resolveSession(tokens[0]!.value) : null;
    } } });
  server = createServer((req, res) => {
    void handler.handle(req, res, new URL(req.url!, origin)).then(handled => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
function request(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { 'x-forwarded-proto': 'https', ...init.headers } });
}
async function begin() {
  const secret = randomBytes(32).toString('base64url');
  const response = await request('/api/compute/pairings', { method: 'POST', body: JSON.stringify({ name: '<script>computer</script>', secretHash: createHash('sha256').update(secret).digest('hex') }) });
  expect(response.status).toBe(201);
  return { ...await response.json() as { code: string; verificationUrl: string }, secret };
}
async function confirm(code: string, headers = { cookie, origin }) {
  const html = await (await request(`/compute/pair?code=${code}`, { headers: { cookie } })).text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return request(`/compute/pair?code=${code}`, { method: 'POST', headers, body: new URLSearchParams({ consent, orgId: viewer.orgId, principalId: viewer.principalId }) });
}
it('pairs through authenticated browser confirmation and native proof, with secret-free audit', async () => {
  const pending = await begin();
  expect(pending.verificationUrl).toBe(`${origin}/compute/pair?code=${pending.code}`);
  const page = await request(`/compute/pair?code=${pending.code}`, { headers: { cookie } });
  expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(await page.text()).toContain('&lt;script&gt;computer&lt;/script&gt;');
  expect((await confirm(pending.code)).status).toBe(200);
  const redeemed = await request('/api/compute/pairings/redeem', { method: 'POST', body: JSON.stringify({ code: pending.code, secret: pending.secret }) });
  expect(redeemed.status).toBe(200);
  const receipt = await redeemed.json() as { deviceId: string; credential: string };
  const list = await request('/api/compute/devices', { headers: { cookie } });
  const listed = await list.text(); expect(listed).toContain(receipt.deviceId); expect(listed).not.toContain(receipt.credential);
  expect(events).toHaveLength(1); expect(events[0]!.kind).toBe('compute.access_changed');
  for (const secret of [pending.secret, pending.code, receipt.credential]) expect(JSON.stringify(events)).not.toContain(secret);
});
it('refuses cross-origin confirmation, native requests from a browser, and insecure requests', async () => {
  const pending = await begin();
  expect((await confirm(pending.code, { cookie, origin: 'https://attacker.example' })).status).toBe(403);
  expect((await request('/api/compute/pairings', { method: 'POST', headers: { origin }, body: '{}' })).status).toBe(403);
  expect((await fetch(`${base}/api/compute/devices`, { headers: { cookie } })).status).toBe(403);
  expect((await confirm(pending.code)).status).toBe(200);
  expect((await confirm(pending.code)).status).toBe(409);
});
it('requires authentication, rejects changed identity and bounds input bodies', async () => {
  const pending = await begin();
  const login = await request(`/compute/pair?code=${pending.code}`);
  expect(login.status).toBe(302); expect(login.headers.get('location')).toBe('/auth/login');
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  expect((await request(`/compute/pair?code=${pending.code}`, { method: 'POST', headers: { cookie, origin }, body: 'orgId=other' })).status).toBe(409);
  expect((await request('/api/compute/pairings', { method: 'POST', body: 'a'.repeat(8193) })).status).toBe(409);
  expect((await request('/api/compute/devices')).status).toBe(401);
  expect(events).toEqual([]);
});

it('binds approval to the displayed session and consumes the consent token on a failed attempt', async () => {
  const pending = await begin();
  const html = await (await request(`/compute/pair?code=${pending.code}`, { headers: { cookie } })).text();
  const consent = /name="consent" value="([^"]+)"/.exec(html)![1]!;
  const otherSession = `${authCookieName(SESSION_COOKIE, true)}=${issueSession(auth, viewer, { secure: true }).token}`;
  const body = new URLSearchParams({ consent, orgId: viewer.orgId, principalId: viewer.principalId });
  expect((await request(`/compute/pair?code=${pending.code}`, { method: 'POST', headers: { cookie: otherSession, origin }, body })).status).toBe(409);
  expect((await request(`/compute/pair?code=${pending.code}`, { method: 'POST', headers: { cookie, origin }, body })).status).toBe(409);
  expect(events).toEqual([]);
  expect((await confirm(pending.code)).status).toBe(200);
});

it('bounds unauthenticated pairing attempts before allocating additional receipts', async () => {
  for (let i = 0; i < 30; i++) expect((await request('/api/compute/pairings', { method: 'POST', body: '{}' })).status).toBe(409);
  const response = await request('/api/compute/pairings', { method: 'POST', body: '{}' });
  expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
});

it('offers public setup with immutable downloads, checksum verification and both native architectures', async () => {
  const response = await request('/compute/setup?lang=ar&mode=manual');
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('lang="ar" dir="rtl"');
  expect(html).toContain('shasum -a 256'); expect(html).toContain('Get-FileHash');
  expect(html).toContain('npm ci --omit=dev'); expect(html).toContain('node dist/cli/compute.js start');
  expect(html).toContain('npm.cmd ci --omit=dev'); expect(html).toContain('Extraction failed');
  expect(html).toContain('compute-client-20261018-1');
  expect(html).not.toContain('latest');
});
it('requires current identity for the onboarding inventory and reports no implicit hosted permission', async () => {
  expect((await request('/api/compute/onboarding')).status).toBe(401);
  const response = await request('/api/compute/onboarding', { headers: { cookie } });
  expect(await response.json()).toEqual({ hostedAllowed: false, devices: [] });
});

it('does not let onboarding polling consume the native pairing budget', async () => {
  for (let i = 0; i < 35; i++) expect((await request('/api/compute/onboarding', { headers: { cookie } })).status).toBe(200);
  expect((await begin()).code).toBeTruthy();
});

it('defaults to app downloads with an explicit architecture choice and a manual fallback', async () => {
  const response = await request('/compute/setup?lang=en&os=mac-arm64');
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('Atoma-Compute-mac-arm64.dmg');
  expect(html).toContain('mode=manual');
  expect(html).not.toContain('npm ci');
  expect(html).toContain('Unsigned beta: Atoma Compute');
  expect(html).toContain('not notarized by Apple');
  expect(html).toContain('Open Anyway');
  expect(html).toContain('/guides/compute/macos-open-anyway.png');
});

import { ComputeResultsNotYet } from '../src/projects/coordinator.js';
import { ProjectStateConflict } from '../src/projects/store.js';

// Review 2026-10-25: only a transfer that may still finish answers with a
// reason the page turns into "make sure Atoma Compute is open" (`pending`) or
// "getting the results" (`active`); a refusal no computer can change keeps
// the route's own neutral conflict, with no reason.
it('types "Get the results" failures only when the transfer may still finish', async () => {
  const outcomes: unknown[] = [new ComputeResultsNotYet('pending', null), new ComputeResultsNotYet('active', null),
    new ProjectStateConflict('Compute finalization unavailable')];
  const handler = new ComputeHttp({ devices, origin: new URL(origin), proxies: { addresses: ['127.0.0.1'] }, emit: () => {},
    finalize: async () => { throw outcomes.shift(); },
    gate: { enabled: true, store: auth, resolve: req => {
      const tokens = parseCookieHeader(req.headers.cookie).filter(c => c.name === authCookieName(SESSION_COOKIE, true));
      return tokens.length === 1 ? auth.resolveSession(tokens[0]!.value) : null;
    } } });
  const finalizing = createServer((req, res) => {
    void handler.handle(req, res, new URL(req.url!, origin)).then(handled => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>(resolve => finalizing.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${(finalizing.address() as { port: number }).port}`;
  const ask = async () => {
    const response = await fetch(`${at}/api/compute/runs/${randomUUID()}/finalize`, { method: 'POST', body: '{}',
      headers: { 'x-forwarded-proto': 'https', cookie, origin, 'content-type': 'application/json' } });
    return { status: response.status, body: await response.json() as { error?: string; reason?: string } };
  };
  try {
    expect(await ask()).toEqual({ status: 409, body: { error: 'Compute results not transferred yet', reason: 'pending' } });
    expect(await ask()).toEqual({ status: 409, body: { error: 'Compute results not transferred yet', reason: 'active' } });
    const refused = await ask();
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBeUndefined();
  } finally { finalizing.closeAllConnections(); await new Promise<void>(resolve => finalizing.close(() => resolve())); }
});
