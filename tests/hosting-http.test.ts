import { createServer, request, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Viewer } from '../src/auth/store.js';
import { ProjectHttpError, roleAtLeast } from '../src/projects/service.js';
import { HOSTING_ROUTE, hostingHttp } from '../src/viz/hostingHttp.js';

/**
 * The browser door of "Update the application" and its put-back: the same
 * route family, origin check and administrator authority as deploy and stop.
 */
const ORIGIN = 'https://atoma.run';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }))); });

const owner = { orgId: randomUUID(), principalId: randomUUID(), role: 'org:owner' } as Viewer;
const projectId = randomUUID();
/** Authority as the service decides it: an organisation administrator for every write. */
const admin = (viewer: Viewer) => { if (!roleAtLeast(viewer.role, 'org:admin')) throw new ProjectHttpError(403, 'An organisation administrator is required'); };
const service = {
  status: vi.fn(() => ({ state: 'ready' })),
  deploy: vi.fn(async (viewer: Viewer) => { admin(viewer); return { state: 'starting' }; }),
  update: vi.fn(async (viewer: Viewer) => { admin(viewer); return { state: 'starting' }; }),
  restore: vi.fn(async (viewer: Viewer) => { admin(viewer); return { state: 'starting' }; }),
  stop: vi.fn(async (viewer: Viewer) => { admin(viewer); return { state: 'stopped' }; }),
};

async function serve(viewer: Viewer | null, history = false) {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const match = new URL(req.url!, 'http://localhost').pathname.match(HOSTING_ROUTE);
    if (!match) { send(404, {}); return; }
    void hostingHttp(match, {
      viewer,
      methodAllowed: method => { if (req.method === method) return true; res.writeHead(405).end(); return false; },
      sameOrigin: () => { if (req.headers.origin === ORIGIN) return true; send(403, { error: 'origin mismatch' }); return false; },
      readBody: async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks); },
      runtime: async () => ({ service: service as never, gateway: { open: () => 'https://app.atoma.run/#claim' } }),
      send,
      history: history && new URL(req.url!, 'http://localhost').searchParams.get('history') === '1',
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let text = ''; res.on('data', chunk => text += String(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on('error', reject); req.end(body);
  });
}
const body = JSON.stringify({ runId: randomUUID(), manifestHash: 'f'.repeat(64), expectedDeploymentId: randomUUID() });

it.each(['update', 'restore'] as const)('serves %s as a same-origin administrator POST beside deploy and stop', async action => {
  vi.clearAllMocks();
  const port = await serve(owner);
  const path = `/api/projects/${projectId}/hosting/${action}`;
  expect((await call(port, 'GET', path)).status).toBe(405);
  // A cross-origin write never reaches the service.
  expect((await call(port, 'POST', path, { origin: 'https://evil.test' }, body)).status).toBe(403);
  expect((await call(port, 'POST', path, {}, body)).status).toBe(403);
  expect(service[action]).not.toHaveBeenCalled();
  expect((await call(port, 'POST', path, { origin: ORIGIN }, '{not json')).status).toBe(400);
  const accepted = await call(port, 'POST', path, { origin: ORIGIN }, body);
  expect(accepted).toEqual({ status: 202, body: JSON.stringify({ state: 'starting' }) });
  expect(service[action]).toHaveBeenCalledExactlyOnceWith(owner, projectId, JSON.parse(body));
});

it('answers a member exactly as deploy does, and an anonymous caller not at all', async () => {
  vi.clearAllMocks();
  const member = await serve({ ...owner, role: 'org:member' });
  for (const action of ['deploy', 'update', 'restore']) {
    expect(await call(member, 'POST', `/api/projects/${projectId}/hosting/${action}`, { origin: ORIGIN }, body))
      .toEqual({ status: 403, body: JSON.stringify({ error: 'An organisation administrator is required' }) });
  }
  const anonymous = await serve(null);
  expect((await call(anonymous, 'POST', `/api/projects/${projectId}/hosting/update`, { origin: ORIGIN }, body)).status).toBe(401);
  expect(service.update).toHaveBeenCalledTimes(1);
  // An unexpected failure is reported as an unconfirmed operation, never as success.
  service.update.mockRejectedValueOnce(new Error('launcher socket closed'));
  const owned = await serve(owner);
  expect((await call(owned, 'POST', `/api/projects/${projectId}/hosting/update`, { origin: ORIGIN }, body)).status).toBe(503);
  // The existing operations keep their routes.
  expect((await call(owned, 'GET', `/api/projects/${projectId}/hosting`)).status).toBe(200);
  expect((await call(owned, 'POST', `/api/projects/${projectId}/hosting/stop`, { origin: ORIGIN }, body)).status).toBe(200);
  expect((await call(owned, 'POST', `/api/projects/${projectId}/hosting/deploy`, { origin: ORIGIN }, body)).status).toBe(202);
  expect(`/api/projects/${projectId}/hosting/rollback`.match(HOSTING_ROUTE)).toBeNull();
});

it('sends the deployment history only to a tab that asks for it, never in an action answer (2026-10-26)', async () => {
  vi.clearAllMocks();
  const entry = { deploymentId: randomUUID(), runId: randomUUID(), title: null, traceId: null, createdAt: '2026-10-26T10:00:00.000Z',
    replaced: false, outcome: 'online', keptOnline: false };
  service.status.mockReturnValue({ state: 'ready', history: [entry] } as never);
  service.stop.mockResolvedValueOnce({ state: 'stopped', history: [entry] } as never);
  const port = await serve(owner, true);
  // A tab from before the history parses strictly: an unknown field would cost it the whole hosting view.
  expect(JSON.parse((await call(port, 'GET', `/api/projects/${projectId}/hosting`)).body)).toEqual({ state: 'ready' });
  expect(JSON.parse((await call(port, 'GET', `/api/projects/${projectId}/hosting?history=1`)).body)).toEqual({ state: 'ready', history: [entry] });
  expect(JSON.parse((await call(port, 'POST', `/api/projects/${projectId}/hosting/stop`, { origin: ORIGIN }, body)).body)).toEqual({ state: 'stopped' });
  service.status.mockReturnValue({ state: 'ready' });
});
