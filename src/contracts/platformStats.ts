import { z } from 'zod';

export const PLATFORM_STATS_DAYS = [7, 30, 90] as const;
export const platformStatsDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type PlatformStatsDays = z.infer<typeof platformStatsDaysSchema>;
const count = z.number().int().nonnegative();
const dailyCount = z.object({ day: z.string(), count });
export const platformAccountStatsSchema = z.object({
  accounts: count, organisations: count, signups: count, activeUsers24h: count,
  pendingInvitations: count, daily: z.array(dailyCount),
  recent: z.array(z.object({ displayName: z.string(), createdAt: z.string() })),
});
export type PlatformAccountStats = z.infer<typeof platformAccountStatsSchema>;
export const platformProjectStatsSchema = z.object({
  projects: count, activeProjects: count, runs: count, periodRuns: count,
  queued: count, running: count, delivered: count, partial: count, failed: count, cancelled: count,
  recordedCostUsd: z.number().nonnegative().nullable(), unmeteredRuns: count,
  daily: z.array(dailyCount),
});
export type PlatformProjectStats = z.infer<typeof platformProjectStatsSchema>;
export const TRAFFIC_SURFACES = ['pages', 'auth', 'mcp', 'projects', 'admin', 'api', 'other'] as const;
export type TrafficSurface = (typeof TRAFFIC_SURFACES)[number];
const trafficCounts = z.object({
  requests: count, pageLoads: count, clientErrors: count, serverErrors: count,
  durationMs: z.number().nonnegative(),
});
export const platformTrafficStatsSchema = z.object({
  startedAt: z.string(), totals: trafficCounts,
  daily: z.array(trafficCounts.extend({ day: z.string() })),
  surfaces: z.array(trafficCounts.extend({ surface: z.enum(TRAFFIC_SURFACES) })),
});
export type PlatformTrafficStats = z.infer<typeof platformTrafficStatsSchema>;
export const platformStatsSchema = z.object({
  generatedAt: z.string(), since: z.string(), days: platformStatsDaysSchema,
  uptimeSeconds: z.number().nonnegative(), accounts: platformAccountStatsSchema,
  projects: platformProjectStatsSchema.nullable(), traffic: platformTrafficStatsSchema.nullable(),
});
export type PlatformStats = z.infer<typeof platformStatsSchema>;

/** Calendar days in UTC, including today, shared by all three data sources. */
export function platformStatsSince(days: PlatformStatsDays, now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1)).toISOString();
}
