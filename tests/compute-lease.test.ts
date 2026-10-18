import { afterEach, expect, it, vi } from 'vitest';
import { ComputeLease } from '../src/launcher/computeLease.js';
import { COMPUTE_LEASE_MS } from '../src/contracts/computeDevice.js';

afterEach(() => vi.useRealTimers());
function fixture(stop: () => Promise<void> = async () => undefined) {
  vi.useFakeTimers();
  let monotonic = 0, wall = 0;
  const stopWorkloads = vi.fn(stop);
  const lease = new ComputeLease(stopWorkloads, { monotonic: () => monotonic, wall: () => wall });
  return { lease, stopWorkloads, advance: (ms: number) => { monotonic += ms; wall += ms; },
    sleep: (ms: number) => { wall += ms; }, rewindWall: (ms: number) => { wall -= ms; } };
}

it('requires an acknowledged heartbeat, renews from dispatch, and never accepts a replay', async () => {
  const f = fixture();
  expect(() => f.lease.assertActive()).toThrow();
  const first = f.lease.heartbeatSent(); f.advance(5_000);
  expect(f.lease.acknowledge(first)).toBe(true); f.lease.assertActive();
  expect(f.lease.acknowledge(first)).toBe(false);
  f.advance(COMPUTE_LEASE_MS - 5_000);
  expect(() => f.lease.assertActive()).toThrow();
  expect(await f.lease.stop()).toBe(true); expect(f.stopWorkloads).toHaveBeenCalledTimes(1);
});

it('ignores old out-of-order replies and tears down all workloads on timer expiry', async () => {
  const f = fixture();
  const first = f.lease.heartbeatSent(); f.advance(5_000);
  const second = f.lease.heartbeatSent(); expect(f.lease.acknowledge(second)).toBe(true);
  expect(f.lease.acknowledge(first)).toBe(false);
  f.advance(COMPUTE_LEASE_MS); await vi.advanceTimersByTimeAsync(COMPUTE_LEASE_MS);
  expect(f.lease.state()).toBe('stopped'); expect(f.stopWorkloads).toHaveBeenCalledTimes(1);
});

it('checks elapsed sleep before any new work, even when the timer has not fired', async () => {
  const f = fixture(); f.lease.acknowledge(f.lease.heartbeatSent());
  f.sleep(COMPUTE_LEASE_MS + 1);
  expect(() => f.lease.assertActive()).toThrow();
  expect(await f.lease.stop()).toBe(true);
});

it('never extends a lease when the wall clock moves backwards', async () => {
  const f = fixture(); f.lease.acknowledge(f.lease.heartbeatSent());
  f.rewindWall(3_600_000); f.advance(COMPUTE_LEASE_MS);
  expect(() => f.lease.assertActive()).toThrow(); await f.lease.stop();
});

it('stays unconfirmed after engine failure, refuses late replies and cannot restart the old generation', async () => {
  const f = fixture(async () => { throw new Error('Docker is unavailable'); });
  f.lease.acknowledge(f.lease.heartbeatSent()); const pending = f.lease.heartbeatSent();
  expect(await f.lease.stop()).toBe(false);
  expect(f.lease.state()).toBe('unconfirmed'); expect(f.lease.acknowledge(pending)).toBe(false);
  expect(() => f.lease.assertActive()).toThrow(); expect(() => f.lease.heartbeatSent()).toThrow();
  expect(await f.lease.stop()).toBe(false); expect(f.stopWorkloads).toHaveBeenCalledTimes(1);
});

it('does not report stopped before engine confirmation resolves', async () => {
  let confirm!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { confirm = resolve; }));
  const stopped = f.lease.stop(); await Promise.resolve();
  expect(f.lease.state()).toBe('stopping'); confirm();
  expect(await stopped).toBe(true); expect(f.lease.state()).toBe('stopped');
});
