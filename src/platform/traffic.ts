import type Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openStoreHandle } from '../core/stores.js';
import { TRAFFIC_SURFACES, type PlatformTrafficStats, type TrafficSurface } from '../contracts/platformStats.js';

export const PLATFORM_TRAFFIC_DDL = `
CREATE TABLE IF NOT EXISTS platform_traffic_meta (id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS platform_traffic_daily (
  day TEXT NOT NULL, surface TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
  page_loads INTEGER NOT NULL DEFAULT 0, client_errors INTEGER NOT NULL DEFAULT 0,
  server_errors INTEGER NOT NULL DEFAULT 0, duration_ms REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, surface)
);`;

/** Closed cardinality: never persist a URL, subject id, query, IP or user agent. */
export function trafficSurface(path: string): TrafficSurface | null {
  if (path === '/' || path === '/index.html' || path === '/app' || path === '/support' || path === '/terms' || path === '/privacy' || path === '/showcase' || path.startsWith('/showcase/')) return 'pages';
  if (path === '/auth' || path.startsWith('/auth/')) return 'auth';
  if (path === '/mcp') return 'mcp';
  if (path === '/api/projects' || path.startsWith('/api/projects/')) return 'projects';
  if (path.startsWith('/api/admin/')) return 'admin';
  if (path.startsWith('/api/')) return 'api';
  if (path.startsWith('/webhooks/')) return 'other';
  if (['/health', '/healthz', '/ready', '/readyz'].includes(path) ||
      /^\/(?:assets|models|textures|fonts|icons|showcase-assets)(?:\/|$)/.test(path) ||
      /\.(?:js|mjs|css|map|json|png|jpg|jpeg|webp|svg|ico|glb|woff2?|webmanifest|txt|xml)$/.test(path)) return null;
  return 'other';
}

export class PlatformTrafficStore {
  private warned = false;
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {
    db.exec(PLATFORM_TRAFFIC_DDL);
    db.prepare('INSERT OR IGNORE INTO platform_traffic_meta VALUES (1, ?)').run(now().toISOString());
    this.sweep();
  }
  static open(path: string): PlatformTrafficStore {
    return new PlatformTrafficStore(openStoreHandle(path, PLATFORM_TRAFFIC_DDL));
  }
  record(surface: TrafficSurface, status: number, durationMs: number, pageLoad: boolean): void {
    try {
      this.db.prepare(`INSERT INTO platform_traffic_daily VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(day, surface) DO UPDATE SET requests = requests + 1,
        page_loads = page_loads + excluded.page_loads, client_errors = client_errors + excluded.client_errors,
        server_errors = server_errors + excluded.server_errors, duration_ms = duration_ms + excluded.duration_ms`)
        .run(this.now().toISOString().slice(0, 10), surface, Number(pageLoad), Number(status >= 400 && status < 500),
          Number(status >= 500), Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
    } catch (error) { this.warn(error); }
  }
  sweep(): void {
    try {
      const cutoff = new Date(this.now().getTime() - 89 * 86_400_000).toISOString().slice(0, 10);
      this.db.prepare('DELETE FROM platform_traffic_daily WHERE day < ?').run(cutoff);
    } catch (error) { this.warn(error); }
  }
  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.error('[viz traffic] aggregation unavailable', error instanceof Error ? error.message : 'unknown storage error');
  }
  snapshot(since: string, until: string): PlatformTrafficStats {
    const rows = this.db.prepare(`SELECT day, surface, requests, page_loads AS pageLoads,
      client_errors AS clientErrors, server_errors AS serverErrors, duration_ms AS durationMs
      FROM platform_traffic_daily WHERE day >= ? AND day <= ? ORDER BY day, surface`)
      .all(since.slice(0, 10), until.slice(0, 10)) as Array<PlatformTrafficStats['daily'][number] & { surface: TrafficSurface }>;
    const empty = () => ({ requests: 0, pageLoads: 0, clientErrors: 0, serverErrors: 0, durationMs: 0 });
    const totals = empty();
    const daily = new Map<string, PlatformTrafficStats['daily'][number]>();
    const surfaces = new Map(TRAFFIC_SURFACES.map(surface => [surface, { surface, ...empty() }]));
    for (const row of rows) {
      const surface = surfaces.get(row.surface);
      if (!surface) continue;
      const day = daily.get(row.day) ?? { day: row.day, ...empty() };
      daily.set(row.day, day);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += row[key]; day[key] += row[key]; surface[key] += row[key];
      }
    }
    const meta = this.db.prepare('SELECT started_at AS startedAt FROM platform_traffic_meta WHERE id = 1').get() as { startedAt: string };
    return { startedAt: meta.startedAt, totals, daily: [...daily.values()], surfaces: [...surfaces.values()] };
  }
}

/** Observe the real HTTP boundary, including authentication failures. Never delay the response. */
export function observePlatformRequest(store: PlatformTrafficStore, req: IncomingMessage, res: ServerResponse): void {
  let surface: TrafficSurface | null;
  try { surface = trafficSurface(new URL(req.url ?? '/', 'http://localhost').pathname); } catch { return; }
  if (!surface) return;
  const started = performance.now();
  res.once('finish', () => {
    store.record(surface, res.statusCode, performance.now() - started,
      surface === 'pages' && req.method === 'GET' && res.statusCode >= 200 && res.statusCode < 300);
  });
}
