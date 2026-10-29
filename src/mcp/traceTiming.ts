/**
 * Where a run's wall clock went, derived from its trace at read time.
 *
 * The 2026-10-23 replan-loop diagnosis needed an ad hoc timeline script per
 * run; every later latency fix shipped without the same measurement on the
 * next run. This projection makes the reading part of the summary so a fix
 * can be checked on the run that follows it.
 *
 * Events record their completion time; a call's start is `ts - durationMs`.
 * Per-role and tool sums can exceed the wall clock under parallel lanes, so
 * they are spent time, not a partition. Missing timing is unknown, not zero.
 */

export interface TimingEvent {
  id?: unknown;
  ts?: unknown;
  kind?: unknown;
  role?: unknown;
  durationMs?: unknown;
  actor?: { tier?: unknown } | null;
}

export interface WallClockAttribution {
  wallMs: number | null;
  /** startedAt → the first recorded event: admission, seed, retrieval, attach. */
  preFirstEventMs: number | null;
  /** startedAt → the start of the first tool call (the first real work). */
  firstToolStartMs: number | null;
  llmMsByTierRole: Record<string, { calls: number; ms: number }>;
  toolMs: { calls: number; ms: number };
  /** Gaps over a minute where no event completed and no call was in flight. */
  idleGaps: { afterEventId: string | null; ms: number }[];
  idleMs: number;
  /** Last recorded event → endedAt: finalisation and publication. */
  afterLastEventMs: number | null;
  note: string;
}

const IDLE_GAP_MS = 60_000;
const MAX_IDLE_GAPS = 5;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function wallClockAttribution(
  startedAt: string | undefined,
  endedAt: string | undefined,
  events: readonly TimingEvent[]
): WallClockAttribution {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = endedAt ? Date.parse(endedAt) : NaN;
  const llm: Record<string, { calls: number; ms: number }> = {};
  const tool = { calls: 0, ms: 0 };
  const spans: { from: number; to: number; id: string | null }[] = [];
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let firstToolStart: number | undefined;
  for (const e of events) {
    const ts = num(e.ts);
    if (ts === undefined) continue;
    const duration = num(e.durationMs) ?? 0;
    const from = ts - duration;
    firstTs = firstTs === undefined ? from : Math.min(firstTs, from);
    lastTs = lastTs === undefined ? ts : Math.max(lastTs, ts);
    spans.push({ from, to: ts, id: typeof e.id === 'string' ? e.id : null });
    if (e.kind === 'llm') {
      const tier = num(e.actor?.tier);
      const key = `${tier === undefined ? '?' : `L${tier}`}:${typeof e.role === 'string' ? e.role : 'unknown'}`;
      const row = llm[key] ??= { calls: 0, ms: 0 };
      row.calls++;
      row.ms += duration;
    } else if (e.kind === 'tool') {
      tool.calls++;
      tool.ms += duration;
      firstToolStart = firstToolStart === undefined ? from : Math.min(firstToolStart, from);
    }
  }
  spans.sort((a, b) => a.from - b.from);
  const gaps: { afterEventId: string | null; ms: number }[] = [];
  let covered = Number.isFinite(start) ? start : spans[0]?.from;
  let coveredBy: string | null = null;
  for (const span of spans) {
    if (covered !== undefined && span.from - covered > IDLE_GAP_MS) {
      gaps.push({ afterEventId: coveredBy, ms: span.from - covered });
    }
    if (covered === undefined || span.to > covered) {
      covered = span.to;
      coveredBy = span.id;
    }
  }
  // The pre-first-event interval is reported on its own, never as idle.
  const idle = gaps.filter(g => g.afterEventId !== null);
  const known = (a: number, b: number | undefined) => (Number.isFinite(a) && b !== undefined && Number.isFinite(b) ? Math.max(0, b - a) : null);
  return {
    wallMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
    preFirstEventMs: known(start, firstTs),
    firstToolStartMs: known(start, firstToolStart),
    llmMsByTierRole: llm,
    toolMs: tool,
    idleGaps: [...idle].sort((a, b) => b.ms - a.ms).slice(0, MAX_IDLE_GAPS),
    idleMs: idle.reduce((sum, g) => sum + g.ms, 0),
    afterLastEventMs: lastTs === undefined || !Number.isFinite(end) ? null : Math.max(0, end - lastTs),
    note: 'Spent time per tier:role and tools; sums exceed wallMs under parallel lanes. Event times are completions; starts are ts - durationMs.',
  };
}
