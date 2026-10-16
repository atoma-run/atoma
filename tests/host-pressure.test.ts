import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PlatformEvent, PlatformEventInput } from '../src/contracts/platformEvents.js';
import { parseMeminfo, type HostMemory, type RunMemoryAdmission } from '../src/core/hostMemory.js';
import { recordStorePressure } from '../src/core/storePressure.js';
import { HostPressureWatch, PRESSURE_ALERT_INTERVAL_MS, STORE_ALERT_MS } from '../src/platform/hostPressure.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const MiB = 1024 * 1024;
function fixture(options: { alerts?: PlatformEvent[]; admission?: RunMemoryAdmission | null; memory?: HostMemory | null; now?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'atoma-host-pressure-')); roots.push(root);
  const storePath = join(root, 'atoma.db');
  const emitted: PlatformEventInput[] = [];
  const clock = { now: options.now ?? Date.now() };
  const state = { admission: options.admission ?? null, memory: options.memory ?? null };
  const watch = new HostPressureWatch({ storePath, emit: (event) => emitted.push(event), recentAlerts: () => options.alerts ?? [],
    memoryProbe: () => state.memory, admission: () => state.admission, now: () => clock.now });
  return { storePath, emitted, clock, state, watch };
}

it('journals SQLITE_BUSY and lock holds past half the busy timeout, at most hourly, never shorter slow records', () => {
  const f = fixture();
  recordStorePressure(f.storePath, { kind: 'slow', mode: 'immediate', waitMs: 0, holdMs: 1_600 });
  f.watch.tick();
  expect(f.emitted).toEqual([]);
  recordStorePressure(f.storePath, { kind: 'busy', mode: 'statement', waitMs: 5_000, holdMs: 0 });
  recordStorePressure(f.storePath, { kind: 'slow', mode: 'immediate', waitMs: STORE_ALERT_MS, holdMs: 400 });
  f.watch.tick();
  expect(f.emitted.map(e => [e.kind, e.detail?.['cause'], e.detail?.['count']])).toEqual([
    ['server.pressure', 'store_busy', 1], ['server.pressure', 'store_slow', 1]]);
  expect(f.emitted[1]!.detail).toMatchObject({ slowestMs: STORE_ALERT_MS + 400, waitMs: STORE_ALERT_MS, holdMs: 400 });
  // A second failure inside the hour waits, then arrives with what accumulated.
  recordStorePressure(f.storePath, { kind: 'busy', mode: 'immediate', waitMs: 5_000, holdMs: 0 });
  f.watch.tick();
  expect(f.emitted).toHaveLength(2);
  f.clock.now += PRESSURE_ALERT_INTERVAL_MS;
  f.watch.tick();
  expect(f.emitted.slice(2).map(e => [e.detail?.['cause'], e.detail?.['count']])).toEqual([['store_busy', 1]]);
  expect(f.watch.health().store).toMatchObject({ busy: 2, slow: 2 });
});

it('resumes at the same millisecond after a restart: no repeat, nothing skipped', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const first = fixture();
  recordStorePressure(first.storePath, { kind: 'busy', mode: 'statement', waitMs: 5_000, holdMs: 0 });
  first.watch.tick();
  const row = { ...first.emitted[0]!, seq: 1, at: new Date(first.clock.now).toISOString(), severity: 'warning' } as PlatformEvent;
  const restarted = new HostPressureWatch({ storePath: first.storePath, emit: (event) => first.emitted.push(event),
    recentAlerts: () => [row], memoryProbe: () => null, admission: () => null, now: () => first.clock.now + PRESSURE_ALERT_INTERVAL_MS });
  restarted.tick();
  expect(first.emitted).toHaveLength(1);
  recordStorePressure(first.storePath, { kind: 'busy', mode: 'statement', waitMs: 5_000, holdMs: 0 });
  restarted.tick();
  expect(first.emitted).toHaveLength(2);
});

it('journals memory under the run reserve only while runs are in flight', () => {
  const GiB = 1024 * MiB;
  const low: HostMemory = { availableBytes: 900 * MiB, totalBytes: 8 * GiB, swapTotalBytes: 2 * GiB, swapFreeBytes: 400 * MiB };
  const f = fixture({ memory: low, admission: { reserveMb: 2048, activeRuns: 0, deferrals: 0, lastDeferral: null } });
  f.watch.tick();
  expect(f.emitted).toEqual([]);
  f.state.admission = { reserveMb: 2048, activeRuns: 2, deferrals: 1, lastDeferral: null };
  f.watch.tick();
  expect(f.emitted.map(e => e.detail)).toEqual([expect.objectContaining({ cause: 'memory_low', availableMb: 900, reserveMb: 2048, activeRuns: 2, swapFreeMb: 400 })]);
  expect(f.watch.health().memory).toMatchObject({ availableMb: 900, minAvailableWithRunsMb: 900 });
  f.state.admission = { reserveMb: 0, activeRuns: 2, deferrals: 0, lastDeferral: null };
  f.clock.now += PRESSURE_ALERT_INTERVAL_MS;
  f.watch.tick();
  expect(f.emitted).toHaveLength(1);
});

it('reads MemAvailable, not MemFree', () => {
  expect(parseMeminfo('MemTotal:        7943056 kB\nMemFree:          219000 kB\nMemAvailable:    3455992 kB\nSwapTotal:       2097148 kB\nSwapFree:         466404 kB\n'))
    .toEqual({ totalBytes: 7943056 * 1024, availableBytes: 3455992 * 1024, swapTotalBytes: 2097148 * 1024, swapFreeBytes: 466404 * 1024 });
  expect(parseMeminfo('MemTotal: 1 kB\n')).toBeNull();
});
