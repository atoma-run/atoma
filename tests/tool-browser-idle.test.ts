import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { createToolBrowser, defaultBuiltinTools, type BuiltinTool } from '../src/tools/builtin.js';
import { SharedToolBrowser } from '../src/tools/toolBrowser.js';

/**
 * validate_html's Chromium is a CACHE, not a resource the run owns (run
 * 40c20c5d, 2026-10-25): one kept open for 21 minutes held ~100 of a Compute
 * worker's 256 tasks while the project's own browser suites could not
 * launch. It now closes when idle and before a project command starts, and
 * relaunches lazily. Real Chromium, through the real tool set: the worker
 * builds exactly this `defaultBuiltinTools` set per sandbox.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

describe.skipIf(process.platform === 'win32')('validate_html releases its idle browser', () => {
  let root: string;
  let sandbox: ToolSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tool-browser-idle-'));
    sandbox = new ToolSandbox(root);
  });
  afterEach(async () => {
    await sandbox.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  function toolSet(idleMs: number): { browser: SharedToolBrowser; validate: BuiltinTool; shell: BuiltinTool; serve: BuiltinTool } {
    const browser = createToolBrowser({ sandbox, idleMs });
    const tools = defaultBuiltinTools({ sandbox, toolBrowser: browser });
    const byName = (name: string): BuiltinTool => tools.find((t) => t.declaration.name === name)!;
    return { browser, validate: byName('validate_html'), shell: byName('run_shell'), serve: byName('start_static_server') };
  }

  const page = { url: 'about:blank', waitMs: 10, smoke: '({ok: document.title === ""})' };

  it('closes the browser after the idle period, confirms its exit, and relaunches on the next call', async () => {
    const { browser, validate } = toolSet(300);
    const hooksBefore = sandbox.cleanupHookCount();
    await expect(validate.execute(page)).resolves.toMatchObject({ ok: true });
    const [pid] = sandbox.trackedChildPids();
    expect(pid).toBeDefined();
    expect(browser.open).toBe(true);
    expect(sandbox.cleanupHookCount()).toBe(hooksBefore + 1);

    expect(await until(() => !browser.open && !alive(pid!))).toBe(true);
    expect(await until(() => sandbox.trackedChildPids().length === 0)).toBe(true);
    // The closed browser's cleanup hook went with it: relaunches do not pile up hooks.
    expect(sandbox.cleanupHookCount()).toBe(hooksBefore);

    await expect(validate.execute(page)).resolves.toMatchObject({ ok: true });
    expect(browser.launchCount).toBe(2);
    expect(sandbox.trackedChildPids()).toHaveLength(1);
    expect(sandbox.trackedChildPids()[0]).not.toBe(pid);
  }, 60_000);

  it('never closes under a validation still running, even past the idle period', async () => {
    const { browser, validate } = toolSet(100);
    // Both share the one launch; the short call ends long before the long one,
    // whose 1.5 s settle is fifteen idle periods.
    const results = await Promise.all([
      validate.execute({ ...page, waitMs: 1500 }),
      validate.execute(page),
    ]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(browser.launchCount).toBe(1);
    expect(await until(() => !browser.open)).toBe(true);
  }, 60_000);

  it('closes an idle browser before a project command starts', async () => {
    const { browser, validate, shell } = toolSet(60_000);
    await expect(validate.execute(page)).resolves.toMatchObject({ ok: true });
    const [pid] = sandbox.trackedChildPids();
    expect(browser.open).toBe(true);

    await expect(shell.execute({ cmd: 'node -e "process.exit(0)"' })).resolves.toMatchObject({ exitCode: 0 });
    expect(browser.open).toBe(false);
    expect(await until(() => !alive(pid!))).toBe(true);

    await expect(validate.execute(page)).resolves.toMatchObject({ ok: true });
    expect(browser.launchCount).toBe(2);
  }, 60_000);

  it('leaves a browser a parallel validation holds alone when a command starts', async () => {
    const { browser, validate, shell } = toolSet(60_000);
    const running = validate.execute({ ...page, waitMs: 1500 });
    expect(await until(() => browser.open)).toBe(true);
    await expect(shell.execute({ cmd: 'node -e "process.exit(0)"' })).resolves.toMatchObject({ exitCode: 0 });
    expect(browser.open).toBe(true);
    await expect(running).resolves.toMatchObject({ ok: true });
    expect(browser.launchCount).toBe(1);
  }, 60_000);

  it('a sandbox cleanup closes the browser and disarms the idle close', async () => {
    const { browser, validate } = toolSet(60_000);
    await expect(validate.execute(page)).resolves.toMatchObject({ ok: true });
    const [pid] = sandbox.trackedChildPids();
    await sandbox.cleanup();
    expect(browser.open).toBe(false);
    expect(alive(pid!)).toBe(false);
  }, 60_000);

  // STORAGE IS PER CALL, whatever the clock did (review of 2026-10-25). Before
  // the idle release, the default context's storage lived as long as the run;
  // with it, a second call would have read the first call's storage or not
  // depending on a 30-second timer and on another branch's commands. Every
  // call now opens a context of its own, as the host replay always did.
  const WRITE = "(() => { localStorage.setItem('k', 'set'); sessionStorage.setItem('k', 'set'); document.cookie = 'k=set; max-age=3600'; return { ok: true }; })()";
  const READ = "(() => ({ ok: true, local: localStorage.getItem('k'), session: sessionStorage.getItem('k'), cookie: document.cookie }))()";
  const EMPTY = { local: null, session: null, cookie: '' };

  async function served(serve: BuiltinTool): Promise<string> {
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>storage</title><p>storage</p>');
    const result = (await serve.execute({})) as { ok: boolean; url: string };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.url;
  }

  it('a call never reads what an earlier call stored, on the same browser', async () => {
    const { browser, validate, serve } = toolSet(60_000);
    const url = await served(serve);
    await expect(validate.execute({ url, smoke: WRITE })).resolves.toMatchObject({ ok: true });
    const read = (await validate.execute({ url, smoke: READ })) as { ok: boolean; smokeResult: unknown };
    expect(read.ok).toBe(true);
    expect(read.smokeResult).toMatchObject(EMPTY);
    expect(browser.launchCount).toBe(1);
  }, 60_000);

  it('nor across an idle release: the same answer either way', async () => {
    const { browser, validate, serve } = toolSet(200);
    const url = await served(serve);
    await expect(validate.execute({ url, smoke: WRITE })).resolves.toMatchObject({ ok: true });
    expect(await until(() => !browser.open)).toBe(true);
    const read = (await validate.execute({ url, smoke: READ })) as { ok: boolean; smokeResult: unknown };
    expect(read.smokeResult).toMatchObject(EMPTY);
    expect(browser.launchCount).toBe(2);
  }, 60_000);

  it('within one call, storage still survives a reload', async () => {
    const { validate, serve } = toolSet(60_000);
    const url = await served(serve);
    // What a reload proves stays inside one call: a click stores, the reload
    // reads a new document of the same context.
    writeFileSync(join(root, 'index.html'),
      "<!doctype html><title>s</title><button id=b onclick=\"localStorage.setItem('k','set')\">b</button>");
    const result = (await validate.execute({ url, interactions: [{ type: 'click', selector: '#b' }, { type: 'reload' }], smoke: READ })) as {
      ok: boolean; smokeResult: unknown;
    };
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.smokeResult).toMatchObject({ local: 'set' });
  }, 60_000);
});

/**
 * THE RELEASE IS BOUNDED (review of 2026-10-25). Puppeteer's `Browser.close()`
 * never rejects, waits the protocol timeout for a wedged CDP close and then an
 * unbounded process exit — and `releaseIdle` runs before every project
 * command. A fake browser whose close never settles stands for the wedge; its
 * process is a real one in its own group, as Puppeteer launches Chromium.
 */
describe.skipIf(process.platform === 'win32')('a wedged browser close is bounded', () => {
  let root: string;
  let sandbox: ToolSandbox;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tool-browser-wedge-'));
    sandbox = new ToolSandbox(root);
  });
  afterEach(async () => {
    await sandbox.cleanup().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  function wedged(ignoreTerm: boolean): { browser: Browser; pid: () => number; closeCalls: () => number } {
    const child = spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000);`], {
      detached: true,
      stdio: 'ignore',
    });
    let calls = 0;
    const browser = {
      connected: true,
      process: () => child,
      close: () => {
        calls += 1;
        return new Promise<void>(() => undefined);
      },
    } as unknown as Browser;
    return { browser, pid: () => child.pid!, closeCalls: () => calls };
  }

  for (const ignoreTerm of [false, true]) {
    it(`releaseIdle returns within the bound and stops the process${ignoreTerm ? ' that ignores SIGTERM' : ''}`, async () => {
      const fake = wedged(ignoreTerm);
      const shared = new SharedToolBrowser({ sandbox, launch: () => Promise.resolve(fake.browser), idleMs: 60_000, closeGraceMs: 300 });
      shared.hold();
      await shared.browser();
      shared.unhold();
      expect(sandbox.trackedChildPids()).toEqual([fake.pid()]);

      const started = Date.now();
      await shared.releaseIdle();
      const elapsed = Date.now() - started;
      expect(fake.closeCalls()).toBe(1);
      // Grace (300 ms) + the stop's SIGTERM grace (250 ms) + kill confirmation.
      expect(elapsed).toBeLessThan(3_000);
      expect(alive(fake.pid())).toBe(false);
      expect(shared.open).toBe(false);
    }, 20_000);
  }

  it('an idle close in flight is awaited by the release and by the next launch', async () => {
    const first = wedged(true);
    const second = wedged(false);
    const browsers = [first.browser, second.browser];
    const shared = new SharedToolBrowser({ sandbox, launch: () => Promise.resolve(browsers.shift()!), idleMs: 50, closeGraceMs: 300 });
    shared.hold();
    await shared.browser();
    shared.unhold();
    expect(await until(() => !shared.open, 2_000)).toBe(true);
    // The idle timer started the close; the release must not return beside a live tree.
    await shared.releaseIdle();
    expect(alive(first.pid())).toBe(false);
    shared.hold();
    await shared.browser();
    shared.unhold();
    expect(shared.launchCount).toBe(2);
    await shared.releaseIdle();
    expect(alive(second.pid())).toBe(false);
  }, 20_000);
});
