import { basename } from 'node:path';
import { executorSnapshots } from '../projects/executorDiscovery.js';
import { ASSAYER_DEFAULT_POLL_MS, ASSAYER_FAILURE_PAUSE_MS, type AssayResult } from './assayer.js';

/**
 * THE RESIDENT ASSAYER — a host-process shell around `assayNext`, armed inside
 * the gated viz server beside the resident analyst.
 *
 * WHAT IT PROMISES. One assay at a time, never while a run is active (the
 * shared idle predicate, read before every attempt), and a product run that
 * starts meanwhile preempts it: `yieldForRun` aborts the arm in flight through
 * its signal, the lease is released, and the recipe stays pending — the interrupted
 * attempt is archived without a recipe judgement. An assay that FAILED (a launch
 * that could not happen, not a verdict) pauses the host for
 * `ASSAYER_FAILURE_PAUSE_MS`: a broken runner must not be retried every
 * minute on the operator's quota. The timer is unref'd, like the sentinel's.
 *
 * ON BY DEFAULT where the server can run at all — the three `ATOMA_MODEL_L*`
 * pins in its environment — and off on `ATOMA_VIZ_ASSAYER=0` (owner decision
 * 2026-10-15: the mechanism needs no condition or configuration to be used).
 */

export const VIZ_ASSAYER_ENV = 'ATOMA_VIZ_ASSAYER';

/** On unless an explicit off; a typo stays on and says so. */
export function vizAssayerEnabled(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): boolean {
  const raw = env[VIZ_ASSAYER_ENV];
  if (raw === undefined) return true;
  const value = raw.trim();
  if (value === '0' || value === 'false') return false;
  if (value === '' || value === '1' || value === 'true') return true;
  warn(`${VIZ_ASSAYER_ENV}="${raw}" is not one of 0, false, 1, true — the assayer stays ON`);
  return true;
}

export interface ResidentAssayerHealth {
  /** Host reader provenance; absent on a local resident. */
  readonly executorRelease?: string;
  readonly armed: boolean;
  readonly inFlight: string | null;
  readonly assayed: number;
  readonly failed: number;
  readonly deferred: number;
  readonly preempted: number;
  readonly pausedUntil: string | null;
  readonly lastResult: { skill: string | null; outcome: string; at: string } | null;
  readonly lastError: string | null;
}

export interface ResidentAssayer {
  stop(): void;
  health(): ResidentAssayerHealth;
  /** Run one tick now (tests). */
  tickNow(): Promise<void>;
  /** A product run needs the slot: abort the assay in flight, if any. True when one was preempted. */
  yieldForRun(): Promise<boolean>;
}

export interface ResidentAssayerOptions {
  /** `assayNext`, bound to the host's options; `signal` aborts the arm in flight. */
  readonly assay: (signal: AbortSignal, progress: (label: string) => void) => Promise<AssayResult>;
  /** The shared idle predicate; the tick waits while it says active. */
  readonly isActive: () => boolean;
  readonly pollMs?: number;
  readonly failurePauseMs?: number;
  readonly now?: () => number;
  readonly logger?: (line: string) => void;
}

export function startResidentAssayer(options: ResidentAssayerOptions): ResidentAssayer {
  const pollMs = Math.max(1_000, options.pollMs ?? ASSAYER_DEFAULT_POLL_MS);
  const failurePauseMs = options.failurePauseMs ?? ASSAYER_FAILURE_PAUSE_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? (() => {});
  let inFlight: string | null = null;
  let current: { readonly controller: AbortController; readonly done: Promise<void> } | null = null;
  let assayed = 0;
  let failed = 0;
  let deferred = 0;
  let preempted = 0;
  let pausedUntil = 0;
  let stopped = false;
  let lastResult: ResidentAssayerHealth['lastResult'] = null;
  let lastError: string | null = null;

  async function tick(signal: AbortSignal): Promise<void> {
    if (now() < pausedUntil) return;
    if (options.isActive()) {
      deferred += 1;
      return;
    }
    inFlight = 'pending';
    try {
      const result = await options.assay(signal, label => { inFlight = label; });
      const skill = result.target ? `${result.target.namespace}/${result.target.skillId}` : null;
      if (result.outcome === 'nothing-pending') return;
      lastResult = { skill, outcome: result.outcome, at: new Date(now()).toISOString() };
      if (result.outcome === 'assayed') {
        assayed += 1;
        lastError = null;
        log(`assayed ${skill}: ${result.judgement?.verdict} → ${result.judgement?.decision}`);
      } else if (result.outcome === 'preempted') {
        preempted += 1;
        log(`assay of ${skill} preempted by a product run; it stays pending`);
      } else if (result.outcome === 'failed') {
        failed += 1;
        lastError = result.detail ?? 'assay failed';
        pausedUntil = now() + failurePauseMs;
        log(`assay of ${skill} failed (${result.detail ?? 'no detail'}); pausing ${Math.round(failurePauseMs / 60_000)} min`);
      } else if (result.outcome === 'refused-active') {
        deferred += 1;
      }
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
      pausedUntil = now() + failurePauseMs;
      log(`assay threw: ${lastError}; pausing ${Math.round(failurePauseMs / 60_000)} min`);
    } finally {
      inFlight = null;
    }
  }

  function drain(): Promise<void> {
    if (inFlight || stopped) return Promise.resolve();
    const controller = new AbortController();
    const done = tick(controller.signal);
    current = { controller, done };
    return done.finally(() => { if (current?.controller === controller) current = null; });
  }

  const timer = setInterval(() => { void drain(); }, pollMs);
  timer.unref();

  return {
    stop() { stopped = true; clearInterval(timer); },
    health() {
      return { armed: !stopped, inFlight, assayed, failed, deferred, preempted,
        pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, lastResult, lastError };
    },
    tickNow: () => drain(),
    async yieldForRun() {
      const flight = current;
      if (!flight || !inFlight) return false;
      flight.controller.abort(new Error('preempted by a product run'));
      await flight.done;
      return true;
    },
  };
}

/** The global lease permits one assay: keep its owning generation visible while it drains. */
export function executorAssayerHealth(active: string): ResidentAssayerHealth | null {
  const generations = executorSnapshots<{ assayer: ResidentAssayerHealth | null }>(active);
  const owner = generations.find(g => g.snapshot.assayer?.inFlight) ?? generations.find(g => g.selected);
  return owner?.snapshot.assayer ? { ...owner.snapshot.assayer, executorRelease: basename(owner.socket, '.sock') } : null;
}
