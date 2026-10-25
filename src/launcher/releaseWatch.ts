import { realpathSync } from 'node:fs';

/**
 * A long-lived service started from `<deploy root>/current/...` keeps the code
 * it loaded. A deployment moves `current` and restarts the web and the
 * executor, never this launcher: the hosting launcher started on 2026-10-16
 * seven minutes before the address pinning landed, served nine more days of
 * releases with the old code, and the deployment it created on 2026-10-18 lost
 * its application when the Docker daemon restarted on 2026-10-25.
 *
 * `watchRelease` resolves the entry path the service was started with, and
 * calls `restart` once the resolution changes AND `idle()` reports no open
 * operation. The launcher's applications outlive it by design; the caller
 * exits non-zero so systemd's `Restart=on-failure` starts the new code.
 */
export function watchRelease(options: {
  /** The unresolved entry path, e.g. process.argv[1] under `current/`. */
  entry: string;
  idle(): boolean;
  restart(from: string, to: string): void;
  intervalMs?: number;
  resolve?: (path: string) => string;
}): { stop(): void } {
  const resolve = options.resolve ?? realpathSync;
  const started = resolve(options.entry);
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    let now: string;
    try { now = resolve(options.entry); }
    catch { return; } // A release switch replaces the link atomically; a miss is transient.
    if (now === started || !options.idle()) return;
    done = true;
    clearInterval(timer);
    options.restart(started, now);
  }, options.intervalMs ?? 2_000);
  timer.unref();
  return { stop: () => { done = true; clearInterval(timer); } };
}

/** Exit status systemd reads as a failure, restarting the unit (EX_TEMPFAIL). */
export const RELEASE_RESTART_EXIT_CODE = 75;
