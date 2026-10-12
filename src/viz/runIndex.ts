import { projectTraceDocument } from '../contracts/traceFields.js';
import { readBoundedRunFile } from '../contracts/traceFile.js';
export { readBoundedRunFile, type BoundedRunFileRead } from '../contracts/traceFile.js';
import { RUN_INDEX_GOAL_MAX, runLabelFromGoal, type VizRun, type VizRunIndexEntry } from './trace.js';
import { isLanded } from '../contracts/runLanding.js';
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

function summarizeTraceFileWith(file: string, withCost: boolean): { entry: VizRunIndexEntry; costBreakdown?: RunCostBreakdown } | null {
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
          return { refusal: result['refusal'], unfinishedPhases: result['unfinishedPhases'] };
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

/** Newest `startedAt` first. */
export function sortRunIndex(entries: readonly VizRunIndexEntry[]): VizRunIndexEntry[] {
  return [...entries].sort((a, b) => {
    const tb = Date.parse(b.startedAt);
    const ta = Date.parse(a.startedAt);
    if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) return tb - ta;
    return b.id.localeCompare(a.id);
  });
}
