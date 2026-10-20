import type { PlatformStats } from '../../contracts/platformStats.js';

/** One presentation model for the GPU screen and its semantic DOM twin. */
export function platformMetrics(stats: PlatformStats) {
  return [
    { key: 'accounts', value: stats.accounts.accounts, hint: 'signups', amount: stats.accounts.signups },
    { key: 'organisations', value: stats.accounts.organisations },
    { key: 'projects', value: stats.projects?.projects ?? null, hint: 'activeProjects', amount: stats.projects?.activeProjects ?? null },
    { key: 'activeUsers', value: stats.accounts.activeUsers24h },
    { key: 'requests', value: stats.traffic?.totals.requests ?? null },
    { key: 'pageLoads', value: stats.traffic?.totals.pageLoads ?? null },
    { key: 'periodRuns', value: stats.projects?.periodRuns ?? null },
    { key: 'recordedCost', value: stats.projects?.recordedCostUsd ?? null, currency: true },
  ];
}

export function platformDaily(stats: PlatformStats): Array<{ day: string; requests: number | null; signups: number; runs: number | null }> {
  const traffic = new Map(stats.traffic?.daily.map(row => [row.day, row]));
  const signups = new Map(stats.accounts.daily.map(row => [row.day, row.count]));
  const runs = new Map(stats.projects?.daily.map(row => [row.day, row.count]));
  return Array.from({ length: stats.days }, (_, index) => {
    const day = new Date(new Date(stats.since).getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return { day, requests: stats.traffic && day >= stats.traffic.startedAt.slice(0, 10) ? traffic.get(day)?.requests ?? 0 : null,
      signups: signups.get(day) ?? 0, runs: stats.projects ? runs.get(day) ?? 0 : null };
  });
}

export function platformNumber(value: number | null, locale: string, currency = false): string {
  if (value === null) return '—';
  return new Intl.NumberFormat(locale, currency ? { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 }).format(value);
}

export const PLATFORM_RUN_STATES = ['running', 'queued', 'delivered', 'partial', 'failed', 'cancelled'] as const;
