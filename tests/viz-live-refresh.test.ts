import { describe, expect, it } from 'vitest';
import type { GpuDataSnapshot, GpuRenderSnapshot } from '../src/viz/client-gl/gpu-renderer.js';
import {
  LIVE_REFRESH_MAX_DEFER_MS,
  LIVE_REFRESH_MIN_INTERVAL_MS,
  LIVE_REFRESH_QUIET_MS,
  classifySnapshotChange,
  liveRefreshDecision,
} from '../src/viz/client-gl/renderer/live-refresh.js';
import type { RunIndexEntry, VizProjectRun, VizRun } from '../src/viz/client/types.js';

/**
 * A live run's own refresh may wait for a still reader; nothing a reader
 * caused may. The classifier is the line between the two, so it is pinned
 * here case by case: the renderer test in viz-gpu-views drives the wait.
 */

const NOW = Date.parse('2026-09-30T18:40:00.000Z');
const t = (key: string) => key;
const onActivate = () => {};

function liveRun(events: number, overrides: Partial<VizRun> = {}): VizRun {
  return {
    id: 'run-live',
    label: 'live',
    startedAt: new Date(NOW - 60_000).toISOString(),
    events: Array.from({ length: events }, (_, index) => ({
      id: `event-${index}`,
      ts: NOW - 50_000 + index * 1_000,
      kind: 'llm',
    })),
    ...overrides,
  };
}

function snapshot(
  data: Partial<GpuDataSnapshot> = {},
  state: Record<string, unknown> = {}
): GpuRenderSnapshot {
  return {
    state: { view: 'runs', selectedEventId: null, scrollY: { runs: 0 }, ...state },
    data: { run: null, runs: [], projectRuns: {}, preview: null, ...data },
    releaseVersion: '1.0.0',
    t,
    onActivate,
    onScroll: () => {},
    onRunPickerScroll: () => {},
  } as unknown as GpuRenderSnapshot;
}

/** The same state object, as a React render with only new data would pass it. */
function withData(previous: GpuRenderSnapshot, data: Partial<GpuDataSnapshot>): GpuRenderSnapshot {
  return { ...previous, data: { ...previous.data, ...data } };
}

const liveEntry: RunIndexEntry = {
  id: 'run-live',
  label: 'live',
  startedAt: new Date(NOW - 60_000).toISOString(),
  inFlight: true,
  lastEventAt: NOW - 1_000,
};
const doneEntry: RunIndexEntry = {
  id: 'run-done',
  label: 'done',
  startedAt: new Date(NOW - 600_000).toISOString(),
  endedAt: new Date(NOW - 500_000).toISOString(),
};

function projectRun(status: VizProjectRun['status']): VizProjectRun {
  return { projectRunId: `pr-${status}`, projectId: 'p1', goal: 'g', status } as VizProjectRun;
}

describe('classifySnapshotChange', () => {
  it('calls the growing trace of the live run on screen a live refresh', () => {
    const shown = snapshot({ run: liveRun(3) });
    expect(classifySnapshotChange(withData(shown, { run: liveRun(4) }), shown, NOW))
      .toBe('live-refresh');
  });

  it('sees through members the data snapshot derives afresh on every settle', () => {
    // GpuApp rebuilds `data` whenever any query settles, and `?? []` or a
    // flattened page list hands back a new array holding the same rows.
    const row = { id: 'journal-1' };
    const shown = snapshot({ run: liveRun(3), adminEvents: [], notifications: [row] as never });
    const rebuilt = withData(shown, {
      run: liveRun(4),
      adminEvents: [],
      notifications: [row] as never,
      projectRuns: {},
    });
    expect(classifySnapshotChange(rebuilt, shown, NOW)).toBe('live-refresh');
    expect(classifySnapshotChange(withData(shown, { notifications: [{ id: 'new' }] as never }), shown, NOW))
      .toBe('other');
  });

  it('never defers the first arrival of a trace or another run', () => {
    const empty = snapshot();
    expect(classifySnapshotChange(withData(empty, { run: liveRun(3) }), empty, NOW)).toBe('other');
    const shown = snapshot({ run: liveRun(3) });
    const other = liveRun(3, { id: 'run-other' });
    expect(classifySnapshotChange(withData(shown, { run: other }), shown, NOW)).toBe('other');
  });

  it('does not treat a finished run on screen as live', () => {
    const ended = liveRun(3, { endedAt: new Date(NOW - 5_000).toISOString() });
    const shown = snapshot({ run: ended });
    const reread = liveRun(3, { endedAt: ended.endedAt, totals: { calls: 3 } });
    expect(classifySnapshotChange(withData(shown, { run: reread }), shown, NOW)).toBe('other');
  });

  it('defers index and project-list churn only while the list on screen is live', () => {
    const live = snapshot({ runs: [liveEntry] });
    expect(classifySnapshotChange(withData(live, { runs: [{ ...liveEntry, calls: 9 }] }), live, NOW))
      .toBe('live-refresh');
    // The run a reader just launched appears at once.
    const idle = snapshot({ runs: [doneEntry] });
    expect(classifySnapshotChange(withData(idle, { runs: [liveEntry, doneEntry] }), idle, NOW))
      .toBe('other');
    const projects = snapshot({ projectRuns: { p1: [projectRun('running')] } });
    expect(classifySnapshotChange(
      withData(projects, { projectRuns: { p1: [projectRun('delivered')] } }),
      projects,
      NOW
    )).toBe('live-refresh');
    const quiet = snapshot({ projectRuns: { p1: [projectRun('delivered')] } });
    expect(classifySnapshotChange(
      withData(quiet, { projectRuns: { p1: [projectRun('queued'), projectRun('delivered')] } }),
      quiet,
      NOW
    )).toBe('other');
  });

  it('lets any other data change, and any state change but scroll, through at once', () => {
    const shown = snapshot({ run: liveRun(3) });
    expect(classifySnapshotChange(withData(shown, { run: liveRun(4), preview: {} as never }), shown, NOW))
      .toBe('other');
    const selected = { ...shown, state: { ...shown.state, selectedEventId: 'event-1' } };
    expect(classifySnapshotChange(selected as GpuRenderSnapshot, shown, NOW)).toBe('other');
    expect(classifySnapshotChange({ ...shown, t: (key: string) => `${key}!` }, shown, NOW)).toBe('other');
  });

  it('separates a scroll from a scroll that arrives with a live refresh', () => {
    const shown = snapshot({ run: liveRun(3) });
    const scrolled = { ...shown, state: { ...shown.state, scrollY: { runs: 140 } } } as GpuRenderSnapshot;
    expect(classifySnapshotChange(scrolled, shown, NOW)).toBe('scroll');
    expect(classifySnapshotChange(withData(scrolled, { run: liveRun(4) }), shown, NOW))
      .toBe('live-refresh+scroll');
    expect(classifySnapshotChange({ ...shown, onScroll: () => {} }, shown, NOW)).toBe('none');
  });
});

describe('liveRefreshDecision', () => {
  const still = {
    now: 10_000,
    lastInteractionAt: 10_000 - LIVE_REFRESH_QUIET_MS,
    lastRebuildAt: 10_000 - LIVE_REFRESH_MIN_INTERVAL_MS,
    deferredSince: null,
    moving: false,
  };

  it('applies a refresh at once for a still reader past the rebuild interval', () => {
    expect(liveRefreshDecision(still)).toEqual({ defer: false, retryInMs: 0 });
  });

  it('waits out the pointer and the rebuild interval, whichever is later', () => {
    expect(liveRefreshDecision({ ...still, lastInteractionAt: 9_900 }))
      .toEqual({ defer: true, retryInMs: LIVE_REFRESH_QUIET_MS - 100 });
    expect(liveRefreshDecision({ ...still, lastRebuildAt: 9_700 }))
      .toEqual({ defer: true, retryInMs: LIVE_REFRESH_MIN_INTERVAL_MS - 300 });
    expect(liveRefreshDecision({ ...still, moving: true }))
      .toEqual({ defer: true, retryInMs: LIVE_REFRESH_QUIET_MS });
  });

  it('never waits past the maximum, however the reader keeps moving', () => {
    const since = 10_000 - LIVE_REFRESH_MAX_DEFER_MS + 50;
    expect(liveRefreshDecision({ ...still, lastInteractionAt: 10_000, deferredSince: since }))
      .toEqual({ defer: true, retryInMs: 50 });
    expect(liveRefreshDecision({
      ...still,
      lastInteractionAt: 10_000,
      moving: true,
      deferredSince: 10_000 - LIVE_REFRESH_MAX_DEFER_MS,
    })).toEqual({ defer: false, retryInMs: 0 });
  });
});
