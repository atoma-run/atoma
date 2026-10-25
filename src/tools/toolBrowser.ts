import type { Browser } from 'puppeteer';
import type { Logger } from '../core/types.js';
import type { ToolSandbox } from './sandbox.js';

/**
 * How long `validate_html`'s Chromium stays open with no validation using it.
 *
 * The browser is a CACHE, not a resource the run owns: one launched process
 * tree held ~113 threads and a few hundred MB in the worker image (measured
 * 2026-10-25: 8 threads before launch, 121 with one page, 12 after close), and
 * a relaunch there costs 150–250 ms. Run 40c20c5d kept one open for 21
 * minutes on a Compute worker whose 256-task bound the project's own browser
 * suites then could not fit under (46 EAGAIN or "Chromium could not launch"
 * results). Thirty seconds keeps a burst of validations on one browser — the
 * calls of one molecule are a model turn apart — and a relaunch after a
 * longer gap costs under 1% of the turn that asked for it.
 */
export const TOOL_BROWSER_IDLE_MS = 30_000;

/**
 * The shared `validate_html` browser of ONE tool set: launched lazily,
 * shared by concurrent validations (parallel branches share the in-flight
 * launch as well as the browser), and closed once no validation has held it
 * for `idleMs` — or at once when a project command is about to start
 * (`releaseIdle`), because that command may launch browsers of its own.
 *
 * A validation brackets its whole call with `hold`/`unhold`; the browser is
 * never closed while one is held. Every launched process is registered with
 * `sandbox.trackChild` (hard-exit SIGKILL) and an `onCleanup` hook whose
 * disposer is dropped when the browser is closed here, so relaunches do not
 * accumulate hooks.
 */
export class SharedToolBrowser {
  private current: { browser: Browser; disposeCleanup: () => void } | null = null;
  private launching: Promise<Browser> | null = null;
  private holds = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private launches = 0;

  constructor(
    private readonly opts: {
      sandbox: ToolSandbox;
      launch: () => Promise<Browser>;
      idleMs?: number;
      logger?: Logger;
    }
  ) {}

  /** Browsers launched so far; tests prove a relaunch happened, or did not. */
  get launchCount(): number {
    return this.launches;
  }

  /** Whether a launched browser is currently open. */
  get open(): boolean {
    return this.current !== null;
  }

  /** A validation starts: the browser may not be closed until `unhold`. */
  hold(): void {
    this.holds += 1;
    this.clearIdle();
  }

  /** A validation ended, on every exit path. The last one arms the idle close. */
  unhold(): void {
    this.holds = Math.max(0, this.holds - 1);
    this.armIdleIfUnused();
  }

  /** The connected browser, launching one when none is. Call between `hold` and `unhold`. */
  async browser(): Promise<Browser> {
    const live = this.current;
    if (live?.browser.connected) return live.browser;
    if (live) await this.close(live);
    // Parallel branches must share the in-flight launch as well as the browser.
    // Otherwise each starts a Chromium process tree before any can publish it.
    this.launching ??= this.launch();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Close the browser NOW if no validation holds it. Called before a project
   * command starts: its test runner may launch its own Chromium, and the
   * tool's idle one would only take threads and memory from it.
   */
  async releaseIdle(): Promise<void> {
    if (this.holds > 0 || this.launching || !this.current) return;
    await this.close(this.current);
  }

  private async launch(): Promise<Browser> {
    const browser = await this.opts.launch();
    this.launches += 1;
    // TRACK THE BROWSER PROCESS, not just the graceful close. `onCleanup`
    // hooks are async and only run on the orderly path — a hard exit (the
    // burn-in harness group-killing a run at its wall-clock budget, the
    // build-app watchdog, a crash) skips them entirely, and headless Chrome
    // then survives with its whole helper fleet. Measured 2026-08-08: one
    // web run killed at its 900s budget after 46 validations left Chrome
    // behind; 126 puppeteer processes (42 reparented to init, up to 22h
    // old) had accumulated, loading the machine enough that the next two
    // runs blew their own budgets — a leak that cascades into failures.
    // `trackChild` puts it under the same synchronous process.on('exit')
    // SIGKILL every run_shell / server child already gets.
    const proc = browser.process();
    if (proc) this.opts.sandbox.trackChild(proc);
    const entry = {
      browser,
      disposeCleanup: this.opts.sandbox.onCleanup(async () => {
        this.clearIdle();
        if (this.current === entry) this.current = null;
        await closeQuietly(browser);
      }),
    };
    this.current = entry;
    this.armIdleIfUnused();
    return browser;
  }

  private armIdleIfUnused(): void {
    if (this.holds > 0 || !this.current || this.idleTimer) return;
    const timer = setTimeout(() => {
      this.idleTimer = null;
      if (this.holds > 0 || this.launching || !this.current) return;
      void this.close(this.current);
    }, this.opts.idleMs ?? TOOL_BROWSER_IDLE_MS);
    // An idle browser must never keep a finished process alive.
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async close(entry: { browser: Browser; disposeCleanup: () => void }): Promise<void> {
    if (this.current === entry) this.current = null;
    this.clearIdle();
    entry.disposeCleanup();
    this.opts.logger?.info('[tool:validate_html] closing its browser (idle, disconnected, or yielding to a command)');
    await closeQuietly(entry.browser);
  }
}

/** Puppeteer's close waits for the process to exit; a refusal falls back to SIGKILL. */
async function closeQuietly(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch {
    try {
      browser.process()?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
