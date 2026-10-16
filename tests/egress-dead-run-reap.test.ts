import { describe, expect, it } from 'vitest';
import { createContainerLauncher, DEAD_RUN_SWEEP_BUDGET_MS, launcherObjectId, pidNamespace } from '../src/launcher/docker.js';
import { startEgressSidecar } from '../src/tools/egressSidecar.js';

/**
 * 2026-10-15: every production run failed at `docker network create` with
 * "all predefined address pools have been fully subnetted". A runner killed
 * past its SIGTERM grace never reaches its exit cleanup, and the in-process
 * egress path had no sweep, so its two networks stayed forever.
 */

/** A pid no process can hold: kill(pid, 0) answers ESRCH. */
const DEAD_PID = 2_147_483_646;
const HERE = pidNamespace();
const row = (id: string, ns = HERE): string => `${id}\t${ns}`;

function fakeDocker(labels: string[]) {
  const calls: string[][] = [];
  const runDocker = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === 'network' && args[1] === 'ls') return labels.join('\n');
    if (args[0] === 'network' && args[1] === 'inspect') return '';
    return '';
  };
  return { calls, runDocker };
}

const removed = (calls: string[][]): string[] =>
  calls.filter((a) => (a[0] === 'network' && a[1] === 'rm') || (a[0] === 'rm' && a[1] === '-f')).map((a) => a.at(-1)!);

describe('reapDeadRunEgress', () => {
  it('reaps only owners whose hash proves a runner pid that no longer exists', async () => {
    const dead = launcherObjectId('run-111');
    const bareDead = launcherObjectId('444');
    const live = launcherObjectId('run-222');
    const own = launcherObjectId(`run-${process.pid}`);
    const forged = 'run-333-0000000000';
    const operator = launcherObjectId('run/42');
    const elsewhere = launcherObjectId('run-555');
    const { calls, runDocker } = fakeDocker([dead, dead, bareDead, live, own, forged, operator, ''].map((id) => row(id)).concat(row(elsewhere, 'pid:[1]')));
    const launcher = createContainerLauncher({ image: 'worker-image', runDocker, sleep: async () => undefined });

    const concrete = launcher as unknown as { reapDeadRunEgress(isAlive: (pid: number) => boolean): Promise<number> };
    expect(await concrete.reapDeadRunEgress((pid) => pid === 222)).toBe(2);
    const gone = removed(calls);
    for (const id of [dead, bareDead]) {
      expect(gone).toContain(`atoma-egress-${id}`);
      expect(gone).toContain(`atoma-uplink-${id}`);
    }
    for (const id of [live, own, forged, operator, elsewhere]) {
      expect(gone.some((name) => name.includes(id))).toBe(false);
    }
  });

  it('reaps every dead owner when each docker call takes a second, within the sweep bound', async () => {
    // 2026-10-16 on the host: one shared 3.5 s deadline let a sweep reap two
    // to four owners; every later removal returned false without trying.
    let clock = 0;
    const owners = [101, 102, 103, 104, 105].map((pid) => launcherObjectId(`run-${pid}`));
    const { calls, runDocker } = fakeDocker(owners.map((id) => row(id)));
    const slow = async (args: string[]): Promise<string> => { clock += 1_000; return runDocker(args); };
    const launcher = createContainerLauncher({ image: 'worker-image', runDocker: slow, sleep: async () => undefined, now: () => clock });
    const concrete = launcher as unknown as { reapDeadRunEgress(isAlive: (pid: number) => boolean): Promise<number> };
    expect(await concrete.reapDeadRunEgress(() => false)).toBe(5);
    for (const id of owners) expect(removed(calls)).toContain(`atoma-uplink-${id}`);
  });

  it('stops the sweep at its bound so stuck owners cannot stall every run start', async () => {
    let clock = 0;
    const owners = Array.from({ length: 40 }, (_, i) => launcherObjectId(`run-${1000 + i}`));
    const { runDocker } = fakeDocker(owners.map((id) => row(id)));
    const slow = async (args: string[]): Promise<string> => { clock += 1_000; return runDocker(args); };
    const launcher = createContainerLauncher({ image: 'worker-image', runDocker: slow, sleep: async () => undefined, now: () => clock });
    const concrete = launcher as unknown as { reapDeadRunEgress(isAlive: (pid: number) => boolean): Promise<number> };
    const reaped = await concrete.reapDeadRunEgress(() => false);
    expect(reaped).toBeGreaterThan(4);
    expect(reaped).toBeLessThan(40);
    expect(clock).toBeLessThanOrEqual(DEAD_RUN_SWEEP_BUDGET_MS + 10_000);
  });

  it('judges networks without a namespace label only on a Linux sweeper', async () => {
    const legacy = launcherObjectId('run-777');
    const { calls, runDocker } = fakeDocker([row(legacy, '')]);
    const launcher = createContainerLauncher({ image: 'worker-image', runDocker, sleep: async () => undefined });
    const concrete = launcher as unknown as { reapDeadRunEgress(isAlive: (pid: number) => boolean): Promise<number> };
    expect(await concrete.reapDeadRunEgress(() => false)).toBe(process.platform === 'linux' ? 1 : 0);
    expect(removed(calls).includes(`atoma-uplink-${legacy}`)).toBe(process.platform === 'linux');
  });

  it('runs before the new run creates its networks', async () => {
    const dead = launcherObjectId(`run-${DEAD_PID}`);
    const { calls, runDocker } = fakeDocker([row(dead)]);
    const sidecar = await startEgressSidecar(
      { runId: 'run-new', image: 'worker-image' },
      { runDocker, waitUntilReady: async () => undefined, sleep: async () => undefined },
    );
    try {
      const reap = calls.findIndex((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === `atoma-uplink-${dead}`);
      const create = calls.findIndex((a) => a[0] === 'network' && a[1] === 'create');
      expect(reap).toBeGreaterThanOrEqual(0);
      expect(reap).toBeLessThan(create);
    } finally {
      await sidecar.stop();
    }
  });

  it('a failing sweep never blocks the run', async () => {
    const calls: string[][] = [];
    const sidecar = await startEgressSidecar(
      { runId: 'run-new', image: 'worker-image' },
      {
        runDocker: async (args) => {
          calls.push(args);
          if (args[0] === 'network' && args[1] === 'ls') throw new Error('daemon hiccup');
          return '';
        },
        waitUntilReady: async () => undefined,
        sleep: async () => undefined,
      },
    );
    try {
      expect(calls.some((a) => a[0] === 'network' && a[1] === 'create')).toBe(true);
    } finally {
      await sidecar.stop();
    }
  });
});
