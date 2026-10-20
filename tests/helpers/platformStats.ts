import { platformStatsSince, type PlatformStats, type PlatformStatsDays } from '../../src/contracts/platformStats.js';

export function platformStatsFixture(days: PlatformStatsDays = 30): PlatformStats {
  const now = new Date('2026-10-20T10:00:00.000Z');
  const since = platformStatsSince(days, now);
  const daily = Array.from({ length: days }, (_, i) => ({ day: new Date(new Date(since).getTime() + i * 86_400_000).toISOString().slice(0, 10),
    requests: 200 + i * 35, pageLoads: 20 + i, clientErrors: i % 4, serverErrors: i % 12 === 0 ? 1 : 0, durationMs: (200 + i * 35) * 42 }));
  const totals = daily.reduce((a, row) => ({ requests: a.requests + row.requests, pageLoads: a.pageLoads + row.pageLoads,
    clientErrors: a.clientErrors + row.clientErrors, serverErrors: a.serverErrors + row.serverErrors, durationMs: a.durationMs + row.durationMs }),
    { requests: 0, pageLoads: 0, clientErrors: 0, serverErrors: 0, durationMs: 0 });
  return { generatedAt: now.toISOString(), since, days, uptimeSeconds: 183_600,
    accounts: { accounts: 284, organisations: 196, signups: 38, activeUsers24h: 42, pendingInvitations: 7,
      daily: daily.map((row, i) => ({ day: row.day, count: i % 4 })),
      recent: [{ displayName: 'Ada Lovelace', createdAt: now.toISOString() }] },
    projects: { projects: 132, activeProjects: 118, runs: 904, periodRuns: 71, queued: 1, running: 3,
      delivered: 52, partial: 8, failed: 5, cancelled: 2, recordedCostUsd: 24.38, unmeteredRuns: 4,
      daily: daily.map((row, i) => ({ day: row.day, count: i % 6 })) },
    traffic: { startedAt: since, totals, daily, surfaces: [{ surface: 'pages', ...totals }] },
  };
}
