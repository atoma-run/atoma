import { createServer, request, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostingGateway } from '../src/projects/hostingGateway.js';
import { probeHostedApplication, type HostingService } from '../src/projects/hostingService.js';
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
  const service = { deps: { store: { list: () => [row] } }, host: () => host, movedHost: () => null, status: vi.fn() } as unknown as HostingService;
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
  const service = { deps: { store: { list: () => [row] } }, host: () => host, movedHost: () => null, status: vi.fn() } as unknown as HostingService;
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
  const service = { deps: { store: { list: () => [row] } }, host: () => 'weather-lab.app.atoma.run', movedHost: () => null, status: vi.fn() } as unknown as HostingService;
  const port = await listen(createHostingGateway(service, 'https://atoma.run', () => true).server);
  for (const path of ['/', '/.atoma/open']) {
    const known = await call(port, 'weather-lab.app.atoma.run', path); const unknown = await call(port, 'weather-lob.app.atoma.run', path);
    expect([unknown.status, unknown.body.replace(/nonce-[^']+|nonce="[^"]+"/g, '')]).toEqual([known.status, known.body.replace(/nonce-[^']+|nonce="[^"]+"/g, '')]);
  }
  const claim = (host: string) => call(port, host, '/.atoma/claim', { origin: `https://${host}` }, JSON.stringify({ token: 'guess' }));
  expect((await claim('weather-lob.app.atoma.run')).status).toBe((await claim('weather-lab.app.atoma.run')).status);
});
it('redirects a retired address permanently to the current one, keeping path and query but never the request host', async () => {
  const service = { deps: { store: { list: () => [] } }, host: () => 'none', status: vi.fn(),
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
  const service = { deps: { store: { list: () => [row] } }, host: () => host, movedHost: () => null, status: vi.fn() } as unknown as HostingService;
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
