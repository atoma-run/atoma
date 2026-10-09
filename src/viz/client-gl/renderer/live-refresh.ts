import { isIndexEntryLive, isRunLive } from '../../client/run-utils.js';
import type { VizProjectRun } from '../../client/types.js';
import type { GpuDataSnapshot, GpuRenderSnapshot } from '../gpu-renderer.js';

/**
 * A LIVE RUN'S REFRESH WAITS FOR A STILL READER.
 *
 * A run in flight is polled once a second and its index every two, and every
 * poll that brings an event used to tear the whole scene down and rebuild it:
 * 22ms at the median and up to 60ms on an integrated GPU (Ryzen 5 5500U,
 * 2026-09-30), about once a second, each one a frozen pointer light and a
 * stalled scroll. Watching a live run was the one screen that stuttered.
 *
 * So the refreshes a live run produces by itself — its own trace growing, the
 * run index, a project's run list while one of its runs is live — wait while
 * the pointer moves or the view scrolls, and are applied once the reader is
 * still, at most one rebuild per `LIVE_REFRESH_MIN_INTERVAL_MS`. They never
 * wait longer than `LIVE_REFRESH_MAX_DEFER_MS`: a live view stays live.
 *
 * Nothing a reader CAUSED waits. A click, a filter, a selection, a view change
 * or a resize is not a live refresh (the state changed, not only the data),
 * and neither is the first arrival of a trace: opening a run shows it at once.
 * A scroll that arrives while a refresh waits moves the retained timeline over
 * the data already on screen; a scroll that has to rebuild takes the fresh
 * data with it.
 */
export const LIVE_REFRESH_QUIET_MS = 400;
export const LIVE_REFRESH_MIN_INTERVAL_MS = 1_000;
export const LIVE_REFRESH_MAX_DEFER_MS = 3_000;

export type SnapshotChange =
  /** Nothing the scene depends on differs. */
  | 'none'
  /** Only the scroll offsets moved. */
  | 'scroll'
  /** Only data a live run refreshes by itself changed. */
  | 'live-refresh'
  /** Both of the above, and nothing else. */
  | 'live-refresh+scroll'
  /** Anything else: it renders at once. */
  | 'other';

function projectRunLive(run: VizProjectRun): boolean {
  return run.status === 'queued' || run.status === 'running';
}

function anyProjectRunLive(runs: Record<string, VizProjectRun[]>): boolean {
  return Object.values(runs).some((list) => list.some(projectRunLive));
}

/**
 * Whether one changed data key is a refresh a live run produced by itself:
 * the list on SCREEN already shows a live run. The run's own trace only while
 * the SAME run, already on screen, is live — the first arrival of a trace, of
 * another run, or of the run a reader just launched is what they asked for.
 */
function isLiveRefreshKey(
  key: keyof GpuDataSnapshot,
  next: GpuDataSnapshot,
  previous: GpuDataSnapshot,
  now: number
): boolean {
  switch (key) {
    case 'run': {
      const shown = previous.run;
      return shown !== null && next.run !== null && next.run.id === shown.id &&
        isRunLive(shown, now);
    }
    case 'runs':
      return previous.runs.some((entry) => isIndexEntryLive(entry, now));
    case 'projectRuns':
      return anyProjectRunLive(previous.projectRuns);
    case 'adminLiveRuns':
      return previous.adminLiveRuns.length > 0;
    default:
      return false;
  }
}

/**
 * One level of structural equality. The data snapshot is rebuilt whenever any
 * query settles, and several members are derived on the spot — `?? []`, a
 * flattened page list — so they are new arrays holding the same rows. Only a
 * member whose CONTENT moved is a change.
 */
function sameMember(next: unknown, previous: unknown): boolean {
  if (next === previous) return true;
  if (Array.isArray(next) && Array.isArray(previous)) {
    return next.length === previous.length &&
      next.every((value, index) => value === previous[index]);
  }
  if (next === null || previous === null || typeof next !== 'object' ||
      typeof previous !== 'object' || Array.isArray(next) || Array.isArray(previous)) {
    return false;
  }
  const nextKeys = Object.keys(next);
  if (nextKeys.length !== Object.keys(previous).length) return false;
  return nextKeys.every((key) =>
    (next as Record<string, unknown>)[key] === (previous as Record<string, unknown>)[key]);
}

/**
 * How `next` differs from the snapshot on screen. The scroll callbacks are
 * rebuilt by React on every render and deliberately ignored, exactly as the
 * retained-scroll path ignores them.
 */
export function classifySnapshotChange(
  next: GpuRenderSnapshot,
  previous: GpuRenderSnapshot,
  now: number = Date.now()
): SnapshotChange {
  if (next.t !== previous.t || next.onActivate !== previous.onActivate ||
      next.releaseVersion !== previous.releaseVersion) return 'other';
  let scroll = false;
  if (next.state !== previous.state) {
    for (const key of Object.keys(next.state) as (keyof GpuRenderSnapshot['state'])[]) {
      if (next.state[key] === previous.state[key]) continue;
      if (key !== 'scrollY') return 'other';
      scroll = true;
    }
  }
  let refresh = false;
  if (next.data !== previous.data) {
    for (const key of Object.keys(next.data) as (keyof GpuDataSnapshot)[]) {
      if (sameMember(next.data[key], previous.data[key])) continue;
      if (!isLiveRefreshKey(key, next.data, previous.data, now)) return 'other';
      refresh = true;
    }
  }
  if (refresh) return scroll ? 'live-refresh+scroll' : 'live-refresh';
  return scroll ? 'scroll' : 'none';
}

export interface LiveRefreshTiming {
  now: number;
  /** Last pointer move, wheel tick or touch drag, in the same clock. */
  lastInteractionAt: number;
  /** Last full scene rebuild. */
  lastRebuildAt: number;
  /** When the waiting refresh first arrived, or null when none waits. */
  deferredSince: number | null;
  /** The scene camera or a route turn is in flight. */
  moving: boolean;
}

/**
 * Whether a live refresh waits, and when to look again. Past the maximum wait
 * it is applied whatever the reader is doing.
 */
export function liveRefreshDecision(timing: LiveRefreshTiming): { defer: boolean; retryInMs: number } {
  const since = timing.deferredSince ?? timing.now;
  const deadline = since + LIVE_REFRESH_MAX_DEFER_MS - timing.now;
  if (deadline <= 0) return { defer: false, retryInMs: 0 };
  const quietFor = timing.now - timing.lastInteractionAt;
  const sinceRebuild = timing.now - timing.lastRebuildAt;
  if (!timing.moving && quietFor >= LIVE_REFRESH_QUIET_MS &&
      sinceRebuild >= LIVE_REFRESH_MIN_INTERVAL_MS) {
    return { defer: false, retryInMs: 0 };
  }
  const wait = Math.max(
    timing.moving ? LIVE_REFRESH_QUIET_MS : 0,
    LIVE_REFRESH_QUIET_MS - quietFor,
    LIVE_REFRESH_MIN_INTERVAL_MS - sinceRebuild,
    16
  );
  return { defer: true, retryInMs: Math.min(wait, deadline) };
}
