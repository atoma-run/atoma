import { createServer, request, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostingGateway } from '../src/projects/hostingGateway.js';
import { HOSTING_HEALTH, probeHostedApplication, type HostingService } from '../src/projects/hostingService.js';
import type { HostedDeployment } from '../src/contracts/projectHosting.js';
import type { Viewer } from '../src/auth/store.js';
import { ATTRIBUTION_BADGE_HTML } from '../src/preview/attribution.js';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }))); });
async function listen(server: Server) { servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as { port: number }).port; }
function call(port: number, host: string, path = '/', headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers: { host, ...headers } }, res => {
      let text = ''; res.on('data', b => text += String(b)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    }); req.on('error', reject); req.end(body);
  });
}
it('exchanges a one-time private claim, strips credentials, and refuses cross-org/CSRF/removed membership', async () => {
  let received = {};
  const upstreamPort = await listen(createServer((req, res) => { received = req.headers; res.setHeader('Set-Cookie', 'evil=1; Domain=atoma.run'); res.end('offers'); }));
  const row: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', entry: 'server.js', createdAt: new Date().toISOString(), error: null, hostPort: upstreamPort, image: 'image' };
  const host = `p-${row.projectId}.app.atoma.run`;
  const service = { deps: { store: { list: () => [row] } }, host: () => host, movedHost: () => null, swapping: () => null, status: vi.fn() } as unknown as HostingService;
  const viewer = { orgId: row.orgId, principalId: randomUUID() } as Viewer;
  let allowed = true;
  const gateway = createHostingGateway(service, 'https://atoma.run', () => allowed);
  const port = await listen(gateway.server);
  expect((await call(port, host)).status).toBe(404);
  const url = new URL(gateway.open(viewer, row.projectId)); const payload = JSON.stringify({ token: url.hash.slice(1) });
  const redeemed = await call(port, host, '/.atoma/claim', { origin: `https://${host}` }, payload);
  expect(redeemed.status).toBe(204);
  expect((await call(port, host, '/.atoma/claim', { origin: `https://${host}` }, payload)).status).toBe(404);
  const cookie = redeemed.headers['set-cookie']![0]!.split(';')[0]!;
  const served = await call(port, host, '/', { cookie, authorization: 'Bearer platform-secret' });
  expect(served.body).toBe('offers'); expect(received).not.toHaveProperty('cookie'); expect(received).not.toHaveProperty('authorization');
  expect(served.headers['set-cookie']!.join()).not.toContain('evil');
  expect(served.headers['content-security-policy']).toContain("worker-src 'none'");
  expect((await call(port, host, '/', { cookie, origin: 'https://evil.test' }, '{}')).status).toBe(403);
  allowed = false; expect((await call(port, host, '/', { cookie })).status).toBe(404);
});
it('appends the Atoma badge to hosted pages but not to the platform desktop', async () => {
  let encoding: string | undefined;
  const upstreamPort = await listen(createServer((req, res) => {
    encoding = req.headers['accept-encoding'];
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': '8' }); res.end('<p>x</p>');
  }));
  const row: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', entry: 'server.js', createdAt: new Date().toISOString(), error: null, hostPort: upstreamPort, image: 'image', browser: true };
  const host = 'weather-lab.app.atoma.run';
  const service = { deps: { store: { list: () => [row] } }, host: () => host, movedHost: () => null, swapping: () => null, status: vi.fn() } as unknown as HostingService;
  const gateway = createHostingGateway(service, 'https://atoma.run', () => true);
  const port = await listen(gateway.server);
  const url = new URL(gateway.open({ orgId: row.orgId, principalId: randomUUID() } as Viewer, row.projectId));
  const redeemed = await call(port, host, '/.atoma/claim', { origin: `https://${host}` }, JSON.stringify({ token: url.hash.slice(1) }));
  const cookie = redeemed.headers['set-cookie']![0]!.split(';')[0]!;
  const page = await call(port, host, '/', { cookie, 'sec-fetch-dest': 'document', 'accept-encoding': 'br' });
  expect(page.body).toBe(`<p>x</p>${ATTRIBUTION_BADGE_HTML}`); expect(page.headers['content-length']).toBeUndefined(); expect(encoding).toBe('identity');
  expect((await call(port, host, '/.atoma/browser/', { cookie, 'sec-fetch-dest': 'document' })).body).toBe('<p>x</p>');
  expect((await call(port, host, '/', { cookie, 'sec-fetch-dest': 'empty' })).body).toBe('<p>x</p>');
  // A paid organisation: same gateway shape, no mark, and the page's encoding left alone.
  const paid = createHostingGateway(service, 'https://atoma.run', () => true, org => org !== row.orgId);
  const paidPort = await listen(paid.server);
  const paidUrl = new URL(paid.open({ orgId: row.orgId, principalId: randomUUID() } as Viewer, row.projectId));
  const paidClaim = await call(paidPort, host, '/.atoma/claim', { origin: `https://${host}` }, JSON.stringify({ token: paidUrl.hash.slice(1) }));
  const paidCookie = paidClaim.headers['set-cookie']![0]!.split(';')[0]!;
  expect((await call(paidPort, host, '/', { cookie: paidCookie, 'sec-fetch-dest': 'document', 'accept-encoding': 'br' })).body).toBe('<p>x</p>');
  expect(encoding).toBe('br');
});
it('answers an unknown address exactly as a private one, so readable addresses cannot be enumerated', async () => {
  const upstreamPort = await listen(createServer((_req, res) => res.end('offers')));
  const row: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'static', entry: 'index.js', createdAt: new Date().toISOString(), error: null, hostPort: upstreamPort, image: 'image' };
  const service = { deps: { store: { list: () => [row] } }, host: () => 'weather-lab.app.atoma.run', movedHost: () => null, swapping: () => null, status: vi.fn() } as unknown as HostingService;
  const port = await listen(createHostingGateway(service, 'https://atoma.run', () => true).server);
  for (const path of ['/', '/.atoma/open']) {
    const known = await call(port, 'weather-lab.app.atoma.run', path); const unknown = await call(port, 'weather-lob.app.atoma.run', path);
    expect([unknown.status, unknown.body.replace(/nonce-[^']+|nonce="[^"]+"/g, '')]).toEqual([known.status, known.body.replace(/nonce-[^']+|nonce="[^"]+"/g, '')]);
  }
  const claim = (host: string) => call(port, host, '/.atoma/claim', { origin: `https://${host}` }, JSON.stringify({ token: 'guess' }));
  expect((await claim('weather-lob.app.atoma.run')).status).toBe((await claim('weather-lab.app.atoma.run')).status);
});
it('redirects a retired address permanently to the current one, keeping path and query but never the request host', async () => {
  const service = { deps: { store: { list: () => [] } }, host: () => 'none', swapping: () => null, status: vi.fn(),
    movedHost: (host: string) => host === 'weather-lab.app.atoma.run' ? 'cloud-desk.app.atoma.run' : null } as unknown as HostingService;
  const port = await listen(createHostingGateway(service, 'https://atoma.run', () => true).server);
  const moved = await call(port, 'weather-lab.app.atoma.run', '/offers?page=2');
  expect(moved.status).toBe(308);
  expect(moved.headers.location).toBe('https://cloud-desk.app.atoma.run/offers?page=2');
  expect((await call(port, 'weather-lab.app.atoma.run', 'http://evil.test/steal')).headers.location).toBe('https://cloud-desk.app.atoma.run/steal');
  expect((await call(port, 'unknown.app.atoma.run', '/')).status).toBe(404);
});
it('does not confuse a relay 502 with application readiness', async () => {
  let status = 502; const port = await listen(createServer((_req, res) => { res.writeHead(status); res.end(); }));
  expect(await probeHostedApplication(port)).toBe(false); status = 200; expect(await probeHostedApplication(port)).toBe(true);
});
it('gives the periodic health check its own, longer probe timeout', async () => {
  const port = await listen(createServer((_req, res) => { setTimeout(() => res.end('busy but alive'), 300); }));
  expect(await probeHostedApplication(port, 100)).toBe(false);
  expect(await probeHostedApplication(port, 2000)).toBe(true);
  expect(HOSTING_HEALTH.timeoutMs).toBeGreaterThan(2000);
  expect(HOSTING_HEALTH.timeoutMs).toBeLessThan(HOSTING_HEALTH.intervalMs);
});

// ---------------------------------------------------------------------------
// An application that is not online (incident 2026-10-26): its own page's
// polls met the 404 meant for strangers while the health check flapped.
// ---------------------------------------------------------------------------
async function offlineFixture() {
  const upstreamPort = await listen(createServer((req, res) => res.end(`app ${req.url}`)));
  const ready: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', browser: true, entry: 'server.js', createdAt: new Date().toISOString(), error: null, hostPort: upstreamPort, image: 'image' };
  const host = 'attica-homes.app.atoma.run';
  let rows: HostedDeployment[] = [ready];
  const projectAt = vi.fn((h: string) => h === host ? { orgId: ready.orgId, projectId: ready.projectId } : null);
  const service = { deps: { store: { list: (_org?: string, project?: string) => rows.filter(r => !project || r.projectId === project) } }, host: () => host,
    movedHost: () => null, swapping: () => null, projectAt, status: vi.fn() } as unknown as HostingService;
  let allowed = true;
  const gateway = createHostingGateway(service, 'https://atoma.run', () => allowed);
  const port = await listen(gateway.server);
  const cookie = await claimed(gateway, port, host, ready);
  return { ready, host, port, cookie, projectAt, set(next: HostedDeployment[]) { rows = next; }, deny() { allowed = false; } };
}
const lost = (row: HostedDeployment): HostedDeployment => ({ ...row, state: 'failed', error: 'runtime-unavailable', hostPort: null });

it('tells a granted visitor of an application that is not online to come back, with Retry-After, and renews the grant', async () => {
  const f = await offlineFixture();
  expect((await call(f.port, f.host, '/api/status', { cookie: f.cookie })).body).toBe('app /api/status');
  for (const rows of [[lost(f.ready)], [{ ...f.ready, state: 'stopped' as const, hostPort: null }], [{ ...f.ready, state: 'starting' as const, hostPort: null }]]) {
    f.set(rows);
    for (const path of ['/', '/api/schedule']) {
      const answer = await call(f.port, f.host, path, { cookie: f.cookie });
      expect(answer).toMatchObject({ status: 503, body: expect.stringContaining('This application is temporarily unavailable. Please try again in a moment.') });
      expect(answer.headers['retry-after']).toBe(String(HOSTING_HEALTH.intervalMs / 1000));
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['content-security-policy']).toContain('sandbox');
      expect(answer.headers['set-cookie']![0]).toContain(f.cookie);
    }
  }
  // Back online: the same grant reaches the application, as before.
  f.set([f.ready]);
  expect(await call(f.port, f.host, '/api/status', { cookie: f.cookie })).toMatchObject({ status: 200, body: 'app /api/status' });
});

it('answers anyone else at an application that is not online exactly as an unknown address', async () => {
  const f = await offlineFixture();
  f.set([lost(f.ready)]);
  const strip = (r: { status: number; body: string; headers: import('node:http').IncomingHttpHeaders }) => [r.status, r.body, r.headers['retry-after'], r.headers['set-cookie']];
  const unknown = await call(f.port, 'attica-homos.app.atoma.run', '/api/status', { cookie: f.cookie });
  expect(unknown.status).toBe(404);
  // No cookie, a forged one, and a granted visitor whose membership ended.
  expect(strip(await call(f.port, f.host, '/api/status'))).toEqual(strip(unknown));
  // A cookieless stranger costs no project lookup.
  expect(f.projectAt).not.toHaveBeenCalledWith(f.host);
  expect(strip(await call(f.port, f.host, '/api/status', { cookie: '__Host-AtomaHosted=guess' }))).toEqual(strip(unknown));
  f.deny();
  expect(strip(await call(f.port, f.host, '/api/status', { cookie: f.cookie }))).toEqual(strip(unknown));
});

it('protects desktop HTTP and WebSocket and revokes an established tunnel after membership loss', async () => {
  let received: import('node:http').IncomingHttpHeaders = {};
  const upstream = createServer((_req, res) => res.end('desktop'));
  upstream.on('upgrade', (req, socket) => {
    received = req.headers;
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {}); socket.on('end', () => socket.end());
  });
  const row: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', browser: true, entry: 'server.js', createdAt: new Date().toISOString(), error: null, hostPort: await listen(upstream), image: 'image' };
  const host = `p-${row.projectId}.app.atoma.run`;
  const service = { deps: { store: { list: () => [row] } }, host: () => host, movedHost: () => null, swapping: () => null, status: vi.fn() } as unknown as HostingService;
  let allowed = true;
  const gateway = createHostingGateway(service, 'https://atoma.run', () => allowed);
  const port = await listen(gateway.server);
  const url = new URL(gateway.open({ orgId: row.orgId, principalId: randomUUID() } as Viewer, row.projectId));
  const redeemed = await call(port, host, '/.atoma/claim', { origin: `https://${host}` }, JSON.stringify({ token: url.hash.slice(1) }));
  const cookie = redeemed.headers['set-cookie']![0]!.split(';')[0]!;
  expect((await call(port, host, '/.atoma/browser/vnc.html')).status).toBe(404);
  const desktop = await call(port, host, '/.atoma/browser/vnc.html', { cookie });
  expect(desktop.body).toBe('desktop');
  expect(desktop.headers['content-security-policy']).toContain('sandbox allow-popups');
  expect(desktop.headers['content-security-policy']).toContain(`wss://${host}`);
  const connect = (origin: string, path = '/.atoma/browser/websockify') => new Promise<import('node:stream').Duplex>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host, cookie, origin, authorization: 'Bearer private', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
    req.on('upgrade', (_res, socket) => resolve(socket)); req.on('error', reject); req.end();
  });
  await expect(connect('https://evil.test')).rejects.toThrow();
  await expect(connect(`https://${host}`, '/json/version')).rejects.toThrow();
  const socket = await connect(`https://${host}`);
  expect(received).not.toHaveProperty('cookie'); expect(received).not.toHaveProperty('authorization');
  const closed = new Promise<void>(resolve => { socket.on('close', () => resolve()); socket.resume(); });
  allowed = false;
  await closed;
});

// ---------------------------------------------------------------------------
// Holding visitors while an update swaps versions (owner decision 2026-10-25).
// ---------------------------------------------------------------------------
function swapFixture(upstreamPort: number, overrides: Partial<HostedDeployment> = {}) {
  const old: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', entry: 'server.js', createdAt: new Date(Date.now() - 60_000).toISOString(), error: null, hostPort: upstreamPort, image: 'image', ...overrides };
  const host = 'weather-lab.app.atoma.run';
  let rows: HostedDeployment[] = [old];
  let swap: { orgId: string; projectId: string; browser: boolean; settled: Promise<void> } | null = null;
  let end = () => {};
  const service = { deps: { store: { list: (_org?: string, project?: string) => rows.filter(r => !project || r.projectId === project) } }, host: (r: HostedDeployment) => r.projectId === old.projectId ? host : 'other.app.atoma.run',
    movedHost: () => null, swapping: (h: string) => h === host ? swap : null, status: vi.fn() } as unknown as HostingService;
  return { old, host, service,
    begin() { swap = { orgId: old.orgId, projectId: old.projectId, browser: !!old.browser, settled: new Promise<void>(resolve => { end = resolve; }) }; rows = [{ ...old, state: 'stopped' }]; },
    /** The new version is ready (or, with no port, failed), then the window closes, in the service's order. */
    finish(port: number | null) {
      rows = port ? [{ ...old, deploymentId: randomUUID(), createdAt: new Date().toISOString(), hostPort: port }, { ...old, state: 'stopped' }] : [{ ...old, state: 'stopped' }];
      swap = null; end();
    } };
}
async function claimed(gateway: ReturnType<typeof createHostingGateway>, port: number, host: string, row: HostedDeployment) {
  const url = new URL(gateway.open({ orgId: row.orgId, principalId: randomUUID() } as Viewer, row.projectId));
  const redeemed = await call(port, host, '/.atoma/claim', { origin: `https://${host}` }, JSON.stringify({ token: url.hash.slice(1) }));
  return redeemed.headers['set-cookie']![0]!.split(';')[0]!;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

it('holds an authorised visitor through the swap and serves the new version, on the same grant', async () => {
  const before = await listen(createServer((_req, res) => res.end('version one')));
  const after = await listen(createServer((req, res) => { let body = ''; req.on('data', b => body += String(b)); req.on('end', () => res.end(`version two ${req.method} ${body}`)); }));
  const f = swapFixture(before);
  const gateway = createHostingGateway(f.service, 'https://atoma.run', () => true);
  const port = await listen(gateway.server);
  const cookie = await claimed(gateway, port, f.host, f.old);
  expect((await call(port, f.host, '/', { cookie })).body).toBe('version one');
  f.begin();
  let answered = false;
  const page = call(port, f.host, '/', { cookie }).finally(() => { answered = true; });
  const form = call(port, f.host, '/save', { cookie, origin: `https://${f.host}` }, 'draft=1');
  await settle(); expect(answered).toBe(false);
  f.finish(after);
  expect(await page).toMatchObject({ status: 200, body: 'version two GET ' });
  // A held write is forwarded once, body intact, after the new version is ready.
  expect((await form).body).toBe('version two POST draft=1');
  expect((await call(port, f.host, '/', { cookie })).body).toBe('version two GET ');
});

it('never holds a request that may not open the application: it is answered as an unknown address', async () => {
  const f = swapFixture(await listen(createServer((_req, res) => res.end('x'))));
  let allowed = true;
  const gateway = createHostingGateway(f.service, 'https://atoma.run', () => allowed);
  const port = await listen(gateway.server);
  const cookie = await claimed(gateway, port, f.host, f.old);
  f.begin();
  const unknown = await call(port, 'weather-lob.app.atoma.run', '/');
  expect(await call(port, f.host, '/')).toEqual(expect.objectContaining({ status: unknown.status, body: unknown.body }));
  expect((await call(port, f.host, '/', { cookie, origin: 'https://evil.test' }, '{}')).status).toBe(403);
  // Membership is asked again after the wait.
  const held = call(port, f.host, '/', { cookie });
  await settle(); allowed = false; f.finish(f.old.hostPort);
  expect(await held).toMatchObject({ status: 404, body: 'Open this private application from its Atoma project.' });
});

it('answers a plain "being updated" page with Retry-After on a timeout, a failed start, or a full queue, never a bare 502', async () => {
  const f = swapFixture(await listen(createServer((_req, res) => res.end('x'))));
  const gateway = createHostingGateway(f.service, 'https://atoma.run', () => true, undefined, { ms: 200, perProject: 1, total: 8 });
  const port = await listen(gateway.server);
  const cookie = await claimed(gateway, port, f.host, f.old);
  f.begin();
  const first = call(port, f.host, '/', { cookie });
  await settle();
  const full = await call(port, f.host, '/', { cookie });
  expect(full).toMatchObject({ status: 503, body: expect.stringContaining('This application is being updated. Please try again in a moment.') });
  expect(full.headers['retry-after']).toBe('10');
  expect(full.headers['content-security-policy']).toContain('sandbox');
  expect((await first).status).toBe(503);
  // The new version failed to start: the held visitor is told, plainly.
  const failed = call(port, f.host, '/', { cookie });
  await settle(); f.finish(null);
  expect(await failed).toMatchObject({ status: 503, body: expect.stringContaining('being updated') });
});

it('leaves other projects alone while one swaps, and answers the update page, not a 502, for a request the swap cut', async () => {
  const other: HostedDeployment = { orgId: randomUUID(), projectId: randomUUID(), deploymentId: randomUUID(), runId: randomUUID(), manifestHash: 'a'.repeat(64), commitSha: 'b'.repeat(40), state: 'ready', kind: 'node', entry: 'server.js', createdAt: new Date().toISOString(), error: null, hostPort: await listen(createServer((_req, res) => res.end('other app'))), image: 'image' };
  let cut = false;
  // Forwarded just before the update began; the stop then drops the connection.
  const f: ReturnType<typeof swapFixture> = swapFixture(await listen(createServer((req, res) => { if (!cut) { res.end('x'); return; } f.begin(); req.socket.destroy(); })));
  const list = f.service.deps.store.list.bind(f.service.deps.store);
  (f.service.deps.store as { list: (org?: string, project?: string) => HostedDeployment[] }).list = (org, project) => [...list(org, project), other].filter(r => !project || r.projectId === project);
  const gateway = createHostingGateway(f.service, 'https://atoma.run', () => true);
  const port = await listen(gateway.server);
  const cookie = await claimed(gateway, port, f.host, f.old);
  const otherCookie = await claimed(gateway, port, 'other.app.atoma.run', other);
  cut = true;
  expect(await call(port, f.host, '/', { cookie })).toMatchObject({ status: 503, body: expect.stringContaining('being updated') });
  expect((await call(port, 'other.app.atoma.run', '/', { cookie: otherCookie })).body).toBe('other app');
});

it('holds the desktop WebSocket upgrade through the swap, or refuses it plainly so the desktop reconnects', async () => {
  const desktop = (label: string) => {
    const server = createServer((_req, res) => res.end(label));
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n${label}`);
      socket.on('error', () => {}); socket.on('end', () => socket.end());
    });
    return listen(server);
  };
  const f = swapFixture(await desktop('one'), { browser: true });
  const gateway = createHostingGateway(f.service, 'https://atoma.run', () => true, undefined, { ms: 300, perProject: 4, total: 8 });
  const port = await listen(gateway.server);
  const cookie = await claimed(gateway, port, f.host, f.old);
  const connect = () => new Promise<{ status: number; first: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/.atoma/browser/websockify', headers: { host: f.host, cookie, origin: `https://${f.host}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
    req.on('upgrade', (_res, socket, head) => {
      const done = (first: string) => { socket.destroy(); resolve({ status: 101, first }); };
      if (head.length) done(String(head)); else socket.once('data', b => done(String(b)));
    });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode!, first: String(res.headers['retry-after']) }); });
    req.on('error', reject); req.end();
  });
  f.begin();
  const held = connect();
  await settle();
  f.finish(await desktop('two'));
  expect(await held).toEqual({ status: 101, first: 'two' });
  f.begin();
  expect(await connect()).toEqual({ status: 503, first: '10' });
});
