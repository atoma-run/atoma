import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_RESTART_EXIT_CODE, watchRelease } from '../src/launcher/releaseWatch.js';
import { retryingStart } from '../src/viz/retryingStart.js';

/**
 * 2026-10-25: the hosting launcher started on 2026-10-16 seven minutes before
 * the address pinning landed. Deployments move `current` and restart the web
 * and the executor, never this unit, so it created the 2026-10-18 deployment
 * with the old code; a Docker restart then cut that application off.
 */
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function releases() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-release-'));
  roots.push(root);
  for (const name of ['a', 'b']) {
    mkdirSync(join(root, 'releases', name), { recursive: true });
    writeFileSync(join(root, 'releases', name, 'entry.js'), '');
  }
  symlinkSync(join(root, 'releases', 'a'), join(root, 'current'));
  // The deploy activator's atomic switch: a new link renamed over `current`.
  const activate = (name: string) => {
    symlinkSync(join(root, 'releases', name), join(root, '.next'));
    renameSync(join(root, '.next'), join(root, 'current'));
  };
  return { root, entry: join(root, 'current', 'entry.js'), activate };
}

describe.skipIf(process.platform === 'win32')('a launcher started from the active release', () => {
  async function launcher(entry: string, socketPath: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/release-watch-child.ts', import.meta.url)), entry, socketPath],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    await vi.waitFor(() => expect(out).toContain('ready'), { timeout: 15_000 });
    return child;
  }

  it('restarts on the new release once no operation is open, and not before', async () => {
    const { root, entry, activate } = releases();
    const socketPath = join(root, 'l.sock');
    const child = await launcher(entry, socketPath);
    const client: Socket = createConnection(socketPath);
    await once(client, 'connect');

    activate('b');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(child.exitCode).toBeNull();

    const exited = once(child, 'exit');
    client.destroy();
    const [code] = await exited;
    expect(code).toBe(RELEASE_RESTART_EXIT_CODE);
  }, 30_000);

  it('keeps running while the release is unchanged', async () => {
    const { root, entry } = releases();
    const child = await launcher(entry, join(root, 'l.sock'));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(child.exitCode).toBeNull();
  }, 30_000);
});

describe('watchRelease', () => {
  it('ignores a transient resolution failure during the switch', async () => {
    vi.useFakeTimers();
    try {
      let target: string | Error = '/releases/a/entry.js';
      const restart = vi.fn();
      watchRelease({ entry: '/current/entry.js', idle: () => true, restart, intervalMs: 10,
        resolve: () => { if (target instanceof Error) throw target; return target; } });
      target = new Error('ENOENT');
      await vi.advanceTimersByTimeAsync(30);
      expect(restart).not.toHaveBeenCalled();
      target = '/releases/b/entry.js';
      await vi.advanceTimersByTimeAsync(30);
      expect(restart).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledWith('/releases/a/entry.js', '/releases/b/entry.js');
      await vi.advanceTimersByTimeAsync(100);
      expect(restart).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retryingStart', () => {
  it('settles the first attempt at once and keeps retrying until the service starts', async () => {
    const scheduled: Array<() => void> = [];
    let attempts = 0;
    const start = retryingStart(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('launcher restarting');
      return 'runtime';
    }, { schedule: run => { scheduled.push(run); return {}; } });
    await expect(start.first).rejects.toThrow('launcher restarting');
    expect(start.current()).toBeUndefined();
    scheduled.shift()!();
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()!();
    await vi.waitFor(() => expect(start.current()).toBe('runtime'));
    expect(attempts).toBe(3);
    expect(scheduled).toHaveLength(0);
  });
});
