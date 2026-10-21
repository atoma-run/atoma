import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { forceKillTestProcessTree } from './helpers.js';

/**
 * `npm run viz:dev` must not leave a dev server behind on Ctrl-C.
 *
 * Measured 2026-08-18: an interrupted session left Vite listening on 5173
 * with PPID 1, so the next `npm run viz:dev` died with EADDRINUSE and the
 * port had to be reclaimed by hand.
 *
 * The launcher spawned both children `detached: true`, which puts them in
 * their own process groups — outside the terminal's foreground group. Their
 * only exit path was the launcher's own SIGTERM/SIGKILL cleanup, and file
 * logging from an instrumented launcher proved that cleanup never runs:
 * under `npm run` the heartbeat stops dead at Ctrl-C with no signal handler
 * and no `process.on('exit')` line, i.e. npm SIGKILLs the script. Whichever
 * child was slower to notice was orphaned holding its port. Vite happened to
 * survive on the reported machine (it exits by itself when the tty is
 * revoked); here the API server is the one that outlives the terminal.
 *
 * The fix keeps the children in the launcher's process group so the kernel
 * signals them directly. This test reproduces that boundary without a pty:
 * the launcher is spawned as its own group leader (standing in for the
 * terminal's foreground group), the group gets SIGINT exactly as a tty
 * delivers it, and the launcher is SIGKILLed the way npm kills it — so
 * nothing but the children's own signal disposition can free the ports.
 */
const posixIt = it.skipIf(process.platform === 'win32');

async function availablePorts(): Promise<number[]> {
  // Reserve both together so the OS cannot return the same port twice.
  const reservations = [createServer(), createServer()];
  try {
    return await Promise.all(reservations.map(async server => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      return address.port;
    }));
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })));
  }
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function waitFor(want: boolean, ports: number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const states = await Promise.all(ports.map(isListening));
    if (states.every((open) => open === want)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('viz:dev — Ctrl-C frees both ports', () => {
  posixIt('leaves no server behind when the launcher is killed the way npm kills it', async () => {
    const [apiPort, devPort] = await availablePorts();
    if (!apiPort || !devPort) throw new Error('Missing fixture ports');

    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/viz-dev.mjs'], {
      // Own process group: this stands in for the terminal's foreground group.
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ATOMA_VIZ_API_PORT: String(apiPort),
        ATOMA_VIZ_DEV_PORT: String(devPort),
      },
    });
    const group = child.pid ?? 0;
    expect(group).toBeGreaterThan(1);

    try {
      expect(await waitFor(true, [apiPort, devPort], 45_000), 'both servers never came up').toBe(
        true
      );

      // A tty signals the whole foreground group; npm then SIGKILLs the script.
      process.kill(-group, 'SIGINT');
      process.kill(group, 'SIGKILL');

      expect(
        await waitFor(false, [apiPort, devPort], 10_000),
        'a child outlived the launcher and kept its port'
      ).toBe(true);
    } finally {
      forceKillTestProcessTree(group);
      // A failing run can leave detached children outside the owned group.
      for (const port of [apiPort, devPort]) if (await isListening(port)) reclaim(port);
    }
  }, 70_000);
});

function reclaim(port: number): void {
  if (process.platform === 'win32') return;
  const found = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  for (const line of (found.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Best effort: the pid may already be gone.
      }
    }
  }
}
