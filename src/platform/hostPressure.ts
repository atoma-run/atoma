import type { PlatformEvent, PlatformEventInput } from '../contracts/platformEvents.js';
import { MIB, type HostMemory, type RunMemoryAdmission } from '../core/hostMemory.js';
import { STORE_BUSY_TIMEOUT_MS } from '../core/stores.js';
import { readStorePressure, type StorePressureRecord, type StorePressureSummary } from '../core/storePressure.js';

/**
 * THE HOST-PRESSURE WATCH (2026-10-16).
 * =====================================
 *
 * Reads what every process left beside the store (`src/core/storePressure.ts`)
 * and what the host has left in memory, and journals `server.pressure` — the
 * one channel that reaches an operator (journal, tray, push). It decides
 * nothing: admission's memory reserve lives in the coordinator, and the
 * PostgreSQL question stays the owner's. This turns both into facts.
 *
 * THREE CAUSES, each journaled at most once per `PRESSURE_ALERT_INTERVAL_MS`,
 * carrying what accumulated since the previous row of that cause:
 *   - `store_busy`: any `SQLITE_BUSY` on a writer handle. Gate 0's reopen
 *     criterion, verbatim.
 *   - `store_slow`: a transaction that waited or held the lock for
 *     `STORE_ALERT_MS` (half the busy timeout) or more. A writer that long
 *     put every other writer halfway to a `SQLITE_BUSY`. Shorter slow records
 *     (from 1 s) are counted in the health read, not pushed: the checkpoint
 *     seal legitimately takes 1.6-3.6 s on a large tree.
 *   - `memory_low`: `MemAvailable` under the run reserve while project runs
 *     are in flight — the point where admission starts queueing. Silent when
 *     no reserve is configured.
 *
 * DEPLOY-SAFE. Every push restarts this server. Each cause resumes from its
 * last journal row (`detail.through`, its `at`), never from boot, so a
 * restart neither repeats an alert nor skips what happened while it was down.
 */
export const PRESSURE_ALERT_INTERVAL_MS = 60 * 60_000;
export const PRESSURE_TICK_MS = 60_000;
export const STORE_ALERT_MS = STORE_BUSY_TIMEOUT_MS / 2;
const HEALTH_WINDOW_MS = 24 * 60 * 60_000;

export type PressureCause = 'store_busy' | 'store_slow' | 'memory_low';
const CAUSES: readonly PressureCause[] = ['store_busy', 'store_slow', 'memory_low'];

export interface HostPressureOptions {
  readonly storePath: string;
  readonly emit: (input: PlatformEventInput) => void;
  /** The newest `server.pressure` rows, newest first. */
  readonly recentAlerts: () => readonly PlatformEvent[];
  readonly memoryProbe: () => HostMemory | null;
  /** Null where this server admits no project runs. */
  readonly admission: () => RunMemoryAdmission | null;
  readonly now?: () => number;
}

export interface HostPressureHealth {
  readonly store: StorePressureSummary & { readonly alertMs: number };
  readonly memory: {
    readonly availableMb: number | null;
    readonly totalMb: number | null;
    readonly swapFreeMb: number | null;
    /** Lowest reading this process took while project runs were in flight. */
    readonly minAvailableWithRunsMb: number | null;
  };
  readonly admission: RunMemoryAdmission | null;
  readonly lastAlerts: Partial<Record<PressureCause, string>>;
}

const mb = (bytes: number) => Math.floor(bytes / MIB);

export class HostPressureWatch {
  private readonly now: () => number;
  /** Per cause: when it was last journaled, and the newest record it covered. */
  private readonly lastAlertAt = new Map<PressureCause, number>();
  private readonly through = new Map<PressureCause, number>();
  private readonly throughCount = new Map<PressureCause, number>();
  private minAvailableWithRuns: number | null = null;

  constructor(private readonly options: HostPressureOptions) {
    this.now = options.now ?? Date.now;
    const booted = this.now();
    for (const event of options.recentAlerts()) {
      const cause = event.detail?.['cause'];
      if (typeof cause !== 'string' || !CAUSES.includes(cause as PressureCause) || this.lastAlertAt.has(cause as PressureCause)) continue;
      const count = event.detail?.['throughCount'];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) this.throughCount.set(cause as PressureCause, count);
      const at = Date.parse(event.at);
      const savedThrough = event.detail?.['through'];
      const through = Date.parse(typeof savedThrough === 'string' ? savedThrough : event.at);
      if (Number.isFinite(at)) this.lastAlertAt.set(cause as PressureCause, at);
      if (Number.isFinite(through)) this.through.set(cause as PressureCause, through);
    }
    // A store that never alerted reports the hour before this boot, no more:
    // records older than this watch are history, not news.
    for (const cause of CAUSES) if (!this.through.has(cause)) this.through.set(cause, booted - PRESSURE_ALERT_INTERVAL_MS);
  }

  private due(cause: PressureCause): boolean {
    const last = this.lastAlertAt.get(cause);
    return last === undefined || this.now() - last >= PRESSURE_ALERT_INTERVAL_MS;
  }

  private alert(cause: PressureCause, summary: string, detail: Record<string, string | number>, through: number, throughCount = 0): void {
    const now = this.now();
    this.options.emit({ kind: 'server.pressure', actorType: 'system', summary,
      detail: { cause, through: new Date(through).toISOString(), throughCount, ...detail } });
    this.lastAlertAt.set(cause, now);
    this.through.set(cause, through);
    this.throughCount.set(cause, throughCount);
  }

  private storeRecords(since: number): StorePressureRecord[] {
    // `recent` is bounded for the health read; here every record counts.
    return [...readStorePressure(this.options.storePath, since, Number.MAX_SAFE_INTEGER).recent];
  }

  /** One pass. Never throws: an observer must not take its host down. */
  tick(): void {
    try {
      const since = Math.min(this.through.get('store_busy')!, this.through.get('store_slow')!);
      const records = this.storeRecords(since);
      // Millisecond timestamps are not unique: multiple writers (or one
      // fast writer) can append after the preceding tick at the same instant.
      const newer = (cause: PressureCause, keep: (r: StorePressureRecord) => boolean) => {
        let atBoundary = 0;
        return records.filter(r => {
          if (!keep(r)) return false;
          const at = Date.parse(r.at);
          return at > this.through.get(cause)! ||
            (at === this.through.get(cause)! && ++atBoundary > (this.throughCount.get(cause) ?? 0));
        });
      };
      const boundaryCount = (cause: PressureCause, rows: StorePressureRecord[]) => {
        const last = rows[rows.length - 1]!.at;
        return rows.filter(r => r.at === last).length +
          (Date.parse(last) === this.through.get(cause) ? this.throughCount.get(cause) ?? 0 : 0);
      };
      const busy = newer('store_busy', r => r.kind === 'busy');
      if (busy.length > 0 && this.due('store_busy')) {
        const last = busy[busy.length - 1]!;
        this.alert('store_busy', `Product store: ${busy.length} write(s) failed with SQLITE_BUSY after the ${STORE_BUSY_TIMEOUT_MS} ms busy timeout`,
          { count: busy.length, where: last.where, pid: last.pid }, Date.parse(last.at), boundaryCount('store_busy', busy));
      }
      const slow = newer('store_slow', r => r.kind === 'slow' && r.waitMs + r.holdMs >= STORE_ALERT_MS);
      if (slow.length > 0 && this.due('store_slow')) {
        const slowest = slow.reduce((a, b) => (b.waitMs + b.holdMs > a.waitMs + a.holdMs ? b : a));
        this.alert('store_slow', `Product store: ${slow.length} transaction(s) waited or held the write lock for ${STORE_ALERT_MS} ms or more`,
          { count: slow.length, slowestMs: slowest.waitMs + slowest.holdMs, waitMs: slowest.waitMs, holdMs: slowest.holdMs, where: slowest.where },
          Date.parse(slow[slow.length - 1]!.at), boundaryCount('store_slow', slow));
      }
      const admission = this.options.admission();
      if (admission && admission.activeRuns > 0) {
        const memory = this.options.memoryProbe();
        if (memory) {
          this.minAvailableWithRuns = Math.min(this.minAvailableWithRuns ?? Infinity, memory.availableBytes);
          if (admission.reserveMb > 0 && mb(memory.availableBytes) < admission.reserveMb && this.due('memory_low')) {
            this.alert('memory_low', `Host memory: ${mb(memory.availableBytes)} MiB available with ${admission.activeRuns} run(s) in flight, under the ${admission.reserveMb} MiB run reserve`,
              { availableMb: mb(memory.availableBytes), reserveMb: admission.reserveMb, activeRuns: admission.activeRuns,
                swapFreeMb: mb(memory.swapFreeBytes), deferrals: admission.deferrals }, this.now());
          }
        }
      }
    } catch (error) {
      process.stderr.write(`[atoma host-pressure] tick failed: ${String(error)}\n`);
    }
  }

  health(): HostPressureHealth {
    const memory = this.options.memoryProbe();
    const lastAlerts: Partial<Record<PressureCause, string>> = {};
    for (const [cause, at] of this.lastAlertAt) lastAlerts[cause] = new Date(at).toISOString();
    return {
      store: { ...readStorePressure(this.options.storePath, this.now() - HEALTH_WINDOW_MS), alertMs: STORE_ALERT_MS },
      memory: {
        availableMb: memory ? mb(memory.availableBytes) : null,
        totalMb: memory ? mb(memory.totalBytes) : null,
        swapFreeMb: memory ? mb(memory.swapFreeBytes) : null,
        minAvailableWithRunsMb: this.minAvailableWithRuns === null ? null : mb(this.minAvailableWithRuns),
      },
      admission: this.options.admission(),
      lastAlerts,
    };
  }

  /** Tick on an unref'd timer; returns the stop function. */
  start(intervalMs = PRESSURE_TICK_MS): () => void {
    const timer = setInterval(() => this.tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
