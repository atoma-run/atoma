import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformStatsSchema, platformStatsSince } from '../src/contracts/platformStats.js';
import { observePlatformRequest, PlatformTrafficStore, trafficSurface } from '../src/platform/traffic.js';
import { AuthStore } from '../src/auth/store.js';
import { platformDaily } from '../src/viz/client-gl/platform-stats.js';
import { platformStatsFixture } from './helpers/platformStats.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); vi.restoreAllMocks(); });
function database() { const db = new Database(':memory:'); dbs.push(db); return db; }

describe('platform traffic', () => {
  it('counts completed HTTP requests at the real boundary and excludes assets and probes', async () => {
    const db = database();
    const store = new PlatformTrafficStore(db, () => new Date('2026-10-20T10:00:00Z'));
    const server = createServer((req, res) => {
      observePlatformRequest(store, req, res);
      res.writeHead(req.url?.startsWith('/api/') ? 503 : 200, { 'content-type': 'text/html' });
      res.end('<p>Hello</p>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const path of ['/', '/api/projects/private-id?token=private', '/assets/app.js', '/health']) {
        await (await fetch(base + path)).text();
      }
      const snapshot = store.snapshot('2026-10-20', '2026-10-20');
      expect(snapshot.totals).toMatchObject({ requests: 2, pageLoads: 1, serverErrors: 1, clientErrors: 0 });
      expect(snapshot.totals.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(db.prepare('SELECT * FROM platform_traffic_daily').all())).not.toMatch(/private|token|127\.0\.0/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('persists the collection start, separates errors and retains 90 UTC calendar days', () => {
    const db = database(); let now = new Date('2026-07-22T15:00:00Z');
    const store = new PlatformTrafficStore(db, () => now);
    store.record('auth', 403, 10, false);
    now = new Date('2026-07-23T15:00:00Z'); store.record('mcp', 500, 30, false);
    now = new Date('2026-10-20T15:00:00Z'); store.record('api', 200, 20, false);
    store.sweep();
    const reopened = new PlatformTrafficStore(db, () => now);
    const stats = reopened.snapshot('2026-07-01', now.toISOString());
    expect(stats.startedAt).toBe('2026-07-22T15:00:00.000Z');
    expect(stats.daily.map(row => row.day)).toEqual(['2026-07-23', '2026-10-20']);
    expect(stats.totals).toMatchObject({ requests: 2, serverErrors: 1, clientErrors: 0 });
    db.close(); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reopened.record('api', 200, 10, false)).not.toThrow();
    expect(() => reopened.snapshot('2026-07-01', now.toISOString())).toThrow();
  });
  it('has a closed route vocabulary and never interprets a subject id as a surface', () => {
    expect(trafficSurface('/mcp')).toBe('mcp');
    expect(trafficSurface('/auth/callback')).toBe('auth');
    expect(trafficSurface('/api/admin/stats')).toBe('admin');
    expect(trafficSurface('/assets/private.js')).toBeNull();
    expect(trafficSurface('/api/projects-evil')).toBe('api');
    expect(trafficSurface('/missing-page')).toBe('other');
  });
});

it('counts human registrations once across logins and organisations', () => {
  const db = database(); const auth = new AuthStore(db);
  const identity = { provider: 'github' as const, subject: 'one', displayName: 'Alice', email: null, emailVerified: false };
  const first = auth.completeLogin(identity, null)!;
  auth.completeLogin(identity, null);
  const second = auth.completeLogin({ ...identity, subject: 'two' }, null)!;
  auth.createSession({ principalId: first.viewer.principalId, orgId: first.viewer.orgId, token: 'session-one', ttlMs: 60000 });
  auth.createSession({ principalId: first.viewer.principalId, orgId: first.viewer.orgId, token: 'session-two', ttlMs: 60000 });
  const apiToken = auth.createApiToken({ principalId: second.viewer.principalId, orgId: second.viewer.orgId, label: 'Recent client' });
  db.prepare('UPDATE auth_api_tokens SET last_used_at = ? WHERE token_id = ?').run(new Date().toISOString(), apiToken.tokenId);
  const since = '2000-01-01T00:00:00.000Z'; const now = new Date(Date.now() + 1000).toISOString();
  const stats = auth.platformStats(since, now);
  expect(stats).toMatchObject({ accounts: 2, organisations: 2, signups: 2, activeUsers24h: 2 });
  expect(stats.daily.reduce((sum, row) => sum + row.count, 0)).toBe(2);
  expect(stats.recent).toHaveLength(2);
  expect(JSON.stringify(stats)).not.toContain(first.viewer.principalId);
});

it('keeps unmeasured traffic distinct from measured zero and uses inclusive UTC calendar days', () => {
  const fixture = platformStatsSchema.parse(platformStatsFixture(7));
  fixture.traffic!.startedAt = '2026-10-18T15:00:00.000Z';
  const daily = platformDaily(fixture);
  expect(daily).toHaveLength(7);
  expect(daily[0]?.requests).toBeNull();
  expect(daily.at(-1)?.requests).toBeGreaterThan(0);
  expect(platformStatsSince(7, new Date('2026-10-20T23:59:59Z'))).toBe('2026-10-14T00:00:00.000Z');
});
