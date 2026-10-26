import { z } from 'zod';

/** Observations only: envelopes overlap tools and never imply inference time. */
export const runtimeTimingSchema = z.object({
  phase: z.enum(['profile-wait', 'profile-local-wait', 'first-response', 'first-token', 'response-envelope', 'tool-wait-response', 'tool-queue',
    'preparation', 'process', 'process-finalization', 'handoff', 'host-finalization', 'naming', 'deepening', 'transport-finalization', 'transport-cleanup', 'setup', 'execution', 'acceptance', 'parent-tests', 'finalization']),
  startedAt: z.number().finite().nonnegative(),
  durationMs: z.number().finite().nonnegative(),
}).strict();
export type RuntimeTiming = z.infer<typeof runtimeTimingSchema>;

/** Union, not sum: parallel lanes and nested call envelopes overlap. */
export function timingUnionMs(intervals: readonly Pick<RuntimeTiming, 'startedAt' | 'durationMs'>[]): number {
  const sorted = intervals.filter(i => Number.isFinite(i.startedAt) && Number.isFinite(i.durationMs) && i.durationMs >= 0)
    .map(i => [i.startedAt, i.startedAt + i.durationMs] as const).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [start, stop] of sorted) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}
