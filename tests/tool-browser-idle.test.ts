import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { createToolBrowser, defaultBuiltinTools, type BuiltinTool } from '../src/tools/builtin.js';
import type { SharedToolBrowser } from '../src/tools/toolBrowser.js';

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

  function toolSet(idleMs: number): { browser: SharedToolBrowser; validate: BuiltinTool; shell: BuiltinTool } {
    const browser = createToolBrowser({ sandbox, idleMs });
    const tools = defaultBuiltinTools({ sandbox, toolBrowser: browser });
    const byName = (name: string): BuiltinTool => tools.find((t) => t.declaration.name === name)!;
    return { browser, validate: byName('validate_html'), shell: byName('run_shell') };
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
});
