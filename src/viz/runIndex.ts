import { lstatSync } from 'node:fs';
import { projectTraceDocument } from '../contracts/traceFields.js';
import { readBoundedRunFile } from '../contracts/traceFile.js';
export { readBoundedRunFile, type BoundedRunFileRead } from '../contracts/traceFile.js';
import { RUN_INDEX_GOAL_MAX, runLabelFromGoal, type VizRun, type VizRunIndexEntry, type VizRunIndexPage } from './trace.js';
import { isLanded } from '../contracts/runLanding.js';
import { compareRunIndex } from './runIndexOrder.js';
export { compareRunIndex } from './runIndexOrder.js';
import { runCostBreakdown, type RunCostBreakdown } from '../contracts/runCostBreakdown.js';

/**
 * The members this row is built from, PINNED AGAINST `VizRun` so renaming one
 * there fails to compile here instead of silently reading `undefined`. The
 * values stay `unknown` on purpose — this parses a file, and a file may hold
 * anything — but the NAMES are not a second copy of the shape.
 */
export const TRACE_HEADER_KEYS = [
  'id',
  'label',
  'task',
  'startedAt',
  'endedAt',
  'durationMs',
  'error',
  'degraded',
  'cancelled',
  'totals',
  'result',
  'events',
] as const satisfies readonly (keyof VizRun)[];

type TraceFileHeader = {
  readonly [K in (typeof TRACE_HEADER_KEYS)[number]]?: K extends 'totals'
    ? { calls?: unknown; costUsd?: unknown; inputTokens?: unknown; outputTokens?: unknown }
    : K extends 'task'
    ? { description?: unknown }
    : unknown;
};

/**
 * Lightweight Runs-tab row from a persisted trace JSON.
 *
 * Whole documents are bounded; larger traces are projected one event at a
 * time, retaining only the fields used for the index and cost attribution.
 * Malformed or over-budget projections remain fail-soft.
 */
export function summarizeTraceFile(file: string): VizRunIndexEntry | null {
  return summarizeTraceFileWith(file, false)?.entry ?? null;
}

/**
 * The same row plus where the run's money went (`runCostBreakdown`), from the
 * ONE parse: a project's run list asks for both, and reading the trace twice
 * per run would double the cost of the poll that lists them.
 */
export function summarizeTraceFileWithCost(file: string): { entry: VizRunIndexEntry; costBreakdown: RunCostBreakdown } | null {
  const summary = summarizeTraceFileWith(file, true);
  return summary?.costBreakdown ? { entry: summary.entry, costBreakdown: summary.costBreakdown } : null;
}

type TraceSummary = { entry: VizRunIndexEntry; costBreakdown?: RunCostBreakdown };

/**
 * A row depends on the file's bytes alone, and a finished trace never changes,
 * yet every run list re-parsed every trace on every poll: a platform admin's
 * `/api/runs` read all of them (712 traces, 471 MB on 2026-10-14) every two
 * seconds. Rows are therefore cached against the file's identity.
 *
 * Only a SETTLED file is cached. Linux advances mtime/ctime in coarse ticks, so
 * two same-size rewrites inside one tick share an identity; a file untouched
 * for `SUMMARY_SETTLED_MS` is past that window, and a live trace (rewritten on
 * every flush) is simply re-read, as before. The identity is taken BEFORE the
 * read: a write racing the read can only leave a newer row under an older
 * identity, which the next poll replaces, never an older row under a newer one.
 * `lstat` keeps the shared reader's symlink refusal: a file swapped for a link
 * changes identity and is read, and refused, again.
 */
const SUMMARY_SETTLED_MS = 2_000;
const SUMMARY_CACHE_MAX = 8_192;
interface CachedSummary {
  readonly identity: string;
  readonly entry: VizRunIndexEntry | null;
  /** Undefined until a reader asked for the cost breakdown of this identity. */
  readonly costBreakdown?: RunCostBreakdown | null;
}
const summaryCache = new Map<string, CachedSummary>();

function settledIdentity(file: string): string | null {
  try {
    const stat = lstatSync(file, { bigint: true });
    const changedNs = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
    if (Date.now() - Number(changedNs / 1_000_000n) < SUMMARY_SETTLED_MS) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Test seam: forget every cached row. */
export function clearRunSummaryCache(): void {
  summaryCache.clear();
}

function summarizeTraceFileWith(file: string, withCost: boolean): TraceSummary | null {
  const identity = settledIdentity(file);
  const cached = identity === null ? undefined : summaryCache.get(file);
  const current = cached?.identity === identity ? cached : undefined;
  if (current && (!withCost || current.costBreakdown !== undefined)) {
    // Re-insert so eviction drops the least recently listed file first.
    summaryCache.delete(file);
    summaryCache.set(file, current);
    if (!current.entry) return null;
    return withCost && current.costBreakdown ? { entry: current.entry, costBreakdown: current.costBreakdown } : { entry: current.entry };
  }
  const read = readTraceSummary(file, withCost);
  if (identity !== null) {
    summaryCache.delete(file);
    // Shared by every later reader: frozen, so a caller that mutated a row
    // would throw instead of silently editing another viewer's list.
    summaryCache.set(file, {
      identity,
      entry: deepFreeze(read?.entry ?? null),
      costBreakdown: withCost ? deepFreeze(read?.costBreakdown ?? null) : current?.costBreakdown,
    });
    if (summaryCache.size > SUMMARY_CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value!);
  }
  return read;
}

function readTraceSummary(file: string, withCost: boolean): TraceSummary | null {
  try {
    // The ceiling and the symlink refusal live in the shared reader; the
    // fail-SOFT disposition over them stays HERE, where a skipped row is not a
    // wrong answer about whether work was delivered.
    const read = readBoundedRunFile(file);
    if (!read.ok && read.reason !== 'overCeiling') return null;
    const run = (read.ok ? JSON.parse(read.bytes.toString('utf8')) : projectTraceDocument(
      file,
      (name, readValue) => {
        if (!(TRACE_HEADER_KEYS as readonly string[]).includes(name) && name !== 'tierModels') return undefined;
        const value = readValue();
        if (name === 'result' && value && typeof value === 'object') {
          const result = value as Record<string, unknown>;
          return { refusal: result['refusal'], unfinishedPhases: result['unfinishedPhases'], blockedPhases: result['blockedPhases'] };
        }
        return value;
      },
      readValue => {
        const value = readValue();
        if (!value || typeof value !== 'object') return null;
        const e = value as Record<string, unknown>;
        return Object.fromEntries([
          'kind', 'ts', 'requestCount', 'requestId', 'role', 'model', 'servedModel',
          'actor', 'costUsd', 'usage', 'evaluator',
        ].map(key => [key, e[key]]).concat([['answer', e['answer'] && typeof e['answer'] === 'object' && !Array.isArray(e['answer']) ? {} : null]]));
      },
    ).run) as TraceFileHeader;
    if (typeof run.id !== 'string' || typeof run.label !== 'string' || typeof run.startedAt !== 'string') {
      return null;
    }
    const entry: VizRunIndexEntry = {
      id: run.id,
      label: run.label,
      startedAt: run.startedAt,
      hasError: Boolean(run.error),
    };
    // The goal the LABEL was cut from. Runs recorded before the index carried
    // it still have it here, because it is read from the trace and not from
    // the entry the recorder wrote at the time.
    const goal = typeof run.task?.description === 'string' ? run.task.description.trim() : '';
    if (goal) entry.goal = runLabelFromGoal(goal, RUN_INDEX_GOAL_MAX);
    const input = typeof run.totals?.inputTokens === 'number' ? run.totals.inputTokens : 0;
    const output = typeof run.totals?.outputTokens === 'number' ? run.totals.outputTokens : 0;
    if (typeof run.totals?.inputTokens === 'number' && typeof run.totals.outputTokens === 'number') {
      entry.tokens = input + output;
    }
    if (Array.isArray(run.events)) {
      let calls = 0;
      let lowerBound = false;
      for (const event of run.events as unknown[]) {
        if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'jev') continue;
        if (!('requestCount' in event) || typeof event.requestCount !== 'number' ||
            !Number.isInteger(event.requestCount) || event.requestCount < 0) {
          // Older events record answers, but not HTTP retries. A response
          // proves at least one request; local skips and opaque failures do
          // not. Preserve that evidence without presenting an exact total.
          lowerBound = true;
          if (('requestId' in event && typeof event.requestId === 'string' && event.requestId.length > 0) ||
              ('answer' in event && event.answer !== null && typeof event.answer === 'object' && !Array.isArray(event.answer))) {
            calls += 1;
          }
          continue;
        }
        calls += event.requestCount;
      }
      entry.jevCalls = lowerBound && calls === 0 ? null : calls;
      if (lowerBound) entry.jevCallsLowerBound = true;
    }
    if (typeof run.endedAt === 'string') entry.endedAt = run.endedAt;
    if (typeof run.durationMs === 'number') entry.durationMs = run.durationMs;
    if (run.degraded === true) entry.degraded = true;
    if (run.cancelled === true) entry.cancelled = true;
    if (run.result !== null && typeof run.result === 'object' && isLanded(run.result)) entry.landed = true;
    if (typeof run.totals?.calls === 'number') entry.calls = run.totals.calls;
    if (typeof run.totals?.costUsd === 'number') entry.costUsd = run.totals.costUsd;
    // Gated and benchmark indexes are rebuilt from traces, unlike the
    // operator index.json. Preserve the recorder's live projection here too.
    if (run.endedAt === undefined) {
      entry.inFlight = true;
      if (Array.isArray(run.events)) {
        let last = 0;
        for (const event of run.events as unknown[]) {
          if (event && typeof event === 'object' && 'ts' in event &&
            typeof event.ts === 'number' && Number.isFinite(event.ts)) last = Math.max(last, event.ts);
        }
        if (last > 0) entry.lastEventAt = last;
      }
    }
    return withCost ? { entry, costBreakdown: runCostBreakdown(run) } : { entry };
  } catch {
    return null;
  }
}

export function sortRunIndex(entries: readonly VizRunIndexEntry[]): VizRunIndexEntry[] {
  return [...entries].sort(compareRunIndex);
}

/**
 * A page boundary is the POSITION of the last row in that order, not an
 * offset: runs keep arriving at the top, and an offset would repeat a row on
 * the next page for each one. Opaque to clients.
 */
export function encodeRunCursor(entry: Pick<VizRunIndexEntry, 'startedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([entry.startedAt, entry.id])).toString('base64url');
}

export function decodeRunCursor(cursor: string): Pick<VizRunIndexEntry, 'startedAt' | 'id'> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') return null;
    return { startedAt: value[0], id: value[1] };
  } catch {
    return null;
  }
}

/** Rows strictly after `before`, at most `limit`; `total` counts the whole list. */
export function pageRunIndex(
  sorted: readonly VizRunIndexEntry[],
  limit: number,
  before: Pick<VizRunIndexEntry, 'startedAt' | 'id'> | null
): VizRunIndexPage {
  const rest = before ? sorted.filter((entry) => compareRunIndex(entry, before) > 0) : sorted;
  const runs = rest.slice(0, limit);
  return {
    runs,
    total: sorted.length,
    nextBefore: rest.length > limit ? encodeRunCursor(runs[runs.length - 1]!) : null,
  };
}
