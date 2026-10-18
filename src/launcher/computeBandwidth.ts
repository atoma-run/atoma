import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/** Shared bulk-transfer budget. Commands, heartbeats and preview traffic use
 * independent channels and are never queued behind a workspace transfer. */
export class ComputeBandwidth {
  private next = 0;
  constructor(private readonly bytesPerSecond = 8 * 1024 ** 2) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) throw new Error('Invalid transfer bandwidth');
  }
  async consume(bytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 256 * 1024) throw new Error('Invalid transfer chunk');
    const now = performance.now();
    this.next = Math.max(now, this.next) + bytes * 1000 / this.bytesPerSecond;
    if (this.next > now) await delay(this.next - now, undefined, { signal });
  }
}
