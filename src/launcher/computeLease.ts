import { performance } from 'node:perf_hooks';
import { COMPUTE_LEASE_MS } from '../contracts/computeDevice.js';

/** One connection generation, never rearmed. The launcher owns stopWorkloads:
 * it resolves only after engine-confirmed teardown of tools/search/preview.
 * Neither a timer nor an unsuccessful teardown is a stop acknowledgement. */
export class ComputeLease {
  private phase: 'waiting' | 'active' | 'stopping' | 'stopped' | 'unconfirmed' = 'waiting';
  private next = 0;
  private acknowledged = 0;
  private readonly pending = new Map<number, { monotonic: number; wall: number }>();
  private deadline: { monotonic: number; wall: number };
  private timer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<boolean>;

  constructor(private readonly stopWorkloads: () => Promise<void>, private readonly clock = {
    monotonic: () => performance.now(), wall: () => Date.now(),
  }) {
    this.deadline = { monotonic: clock.monotonic() + COMPUTE_LEASE_MS, wall: clock.wall() + COMPUTE_LEASE_MS };
    this.arm();
  }
  private remaining(): number {
    // Wall time catches ordinary system sleep; monotonic time prevents a wall
    // clock adjustment from extending an active lease.
    return Math.min(this.deadline.monotonic - this.clock.monotonic(), this.deadline.wall - this.clock.wall());
  }
  private live(): boolean {
    if (this.phase !== 'waiting' && this.phase !== 'active') return false;
    if (this.remaining() <= 0) { void this.stop(); return false; }
    return true;
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.live()) this.arm(); }, Math.max(1, this.remaining()));
    this.timer.unref();
  }
  heartbeatSent(): number {
    if (!this.live()) throw new Error('Compute lease expired');
    if (this.pending.size >= 8) throw new Error('Compute heartbeat capacity exceeded');
    const request = ++this.next;
    this.pending.set(request, { monotonic: this.clock.monotonic(), wall: this.clock.wall() });
    return request;
  }
  /** Called only for an authenticated reply on this object's connection.
   * Count from request dispatch, not response receipt: latency buys no lease. */
  acknowledge(request: number): boolean {
    if (!this.live()) return false;
    const sent = this.pending.get(request);
    if (!sent || request <= this.acknowledged) return false;
    const deadline = { monotonic: sent.monotonic + COMPUTE_LEASE_MS, wall: sent.wall + COMPUTE_LEASE_MS };
    if (deadline.monotonic <= this.clock.monotonic() || deadline.wall <= this.clock.wall()) return false;
    this.acknowledged = request;
    for (const id of this.pending.keys()) if (id <= request) this.pending.delete(id);
    this.deadline = deadline;
    this.phase = 'active';
    this.arm();
    return true;
  }
  assertActive(): void {
    if (!this.live() || this.phase !== 'active') throw new Error('Compute lease is not active');
  }
  state() { this.live(); return this.phase; }
  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    this.phase = 'stopping';
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
    this.stopping = Promise.resolve().then(this.stopWorkloads).then(() => {
      this.phase = 'stopped'; return true;
    }, () => { this.phase = 'unconfirmed'; return false; });
    return this.stopping;
  }
}
