import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { READ_RUNS_DIRECTORY } from '../contracts/readRuns.js';

/** Where the read-run copies are mounted read-only in the worker. */
export const READ_RUN_COPIES_MOUNT = `/workspace/${READ_RUNS_DIRECTORY}`;

/**
 * THE MOUNT-SOURCE GUARD for the read-run copies (docs/decisions/read-runs-2026-10-17.md),
 * at the mount authority, before every `docker run`: `<workspace>/.atoma-runs`
 * must be a real directory whose realpath is the workspace's own realpath plus
 * that name. Docker FOLLOWS a symlinked bind source (measured on runc and
 * runsc: `.atoma-runs -> /srv/secret` put the host directory in the worker),
 * and `volume-subpath` follows an internal link. Returns the verified realpath,
 * which is what the engine is handed, so no ancestor can be swapped after the
 * check. No worker holds the workspace while this runs: every start follows a
 * fresh workspace, an engine-confirmed drain or a crash whose container held
 * the directory as a mount point it could not rename.
 */
export function verifiedRunCopiesSource(workspace: string): string {
  const source = path.join(workspace, READ_RUNS_DIRECTORY);
  let stat;
  try { stat = lstatSync(source); } catch { throw new Error(`read-run copies mount refused: ${READ_RUNS_DIRECTORY} is absent`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`read-run copies mount refused: ${READ_RUNS_DIRECTORY} is not a real directory`);
  const real = realpathSync(source);
  if (real !== path.join(realpathSync(workspace), READ_RUNS_DIRECTORY)) throw new Error(`read-run copies mount refused: ${READ_RUNS_DIRECTORY} resolves elsewhere`);
  if (/[,"'\n\r]/.test(real)) throw new Error('read-run copies mount refused: the path cannot be written as a mount option');
  return real;
}

/**
 * The task bound of every worker container. Linux `pids.max` counts THREADS,
 * not processes, and one headless Chromium with one page is ~113 of them in
 * the worker image (measured 2026-10-25: 8 tasks before launch, 121 after).
 * Run 40c20c5d's Compute worker hit its 256 bound 9,822 times: the worker
 * (11), validate_html's browser (~100) and four node servers (7–11 each)
 * already held 150 while the run only read files, so the project's own
 * browser suites, npm and node failed with EAGAIN.
 *
 * Sized for what a run legitimately starts at once: Playwright's default of
 * one worker per two host CPUs (seven Chromium trees, ~800 threads, on a
 * 14-CPU Docker Desktop VM, where `os.cpus()` ignores `--cpus`) with their
 * runner processes, the tool browser, four servers and an install — about
 * 1,100 — doubled. It remains a fork-bomb bound: 2,048 tasks cost the kernel
 * tens of MB, charged to the same `--memory` cap that bounds what those
 * tasks can allocate.
 */
export const WORKER_PIDS_LIMIT = '2048';

/**
 * `docker run` arguments that carry the isolation. Exported so a test can
 * assert them rather than trusting a comment — every one of them was
 * verified against a real container before this file existed.
 */
export function workerRunArgs(opts: {
  image: string;
  workspaceHostPath: string;
  workspaceVolume?: string;
  volumeSubpath?: 'current';
  computeMachineId?: string;
  /** Launcher-created socket FILE, mounted read-only; never its control endpoint. */
  socketHostPath?: string;
  memory?: string;
  cpus?: string;
  /** Numeric uid:gid allowed to write the host-owned bind mount. */
  user?: string;
  /**
   * EGRESS MODE. When set, the run joins a per-run Docker network created
   * with `--internal` AND bridge gateway mode `isolated`
   * instead of getting no network at all, and `HTTP_PROXY` points at the one
   * peer on it. Measured, which is why the shape is this and not `bridge`:
   *   --network none      control plane blocked, internet blocked
   *   default bridge      control plane REACHED, internet reached
   *   isolated internal  control plane blocked, internet blocked
   * Plain `--internal` is NOT enough: its bridge gateway can reach host
   * services. Removing that gateway makes the network equivalent to `none`
   * for host/external routes while still BEING a LAN, so a proxy attached
   * to it and to an external network can
   * carry egress selectively — and `decideEgress` is the whole of what it
   * carries. Plain `bridge` is never an option: it hands the run the control
   * plane, the same reachability that made an HTTP-served launch token
   * worthless.
   */
  egress?: { network: string; proxyHost: string; proxyPort: number };
  /**
   * The verified `.atoma-runs` source (`verifiedRunCopiesSource`), mounted
   * READ-ONLY over itself: `run_shell` can no longer edit, chmod, swap or
   * delete another run's copies (EROFS, EBUSY, EXDEV). Always `--mount`,
   * never `-v`, which creates a missing source as root instead of refusing.
   * With a volume, the same directory as a `volume-subpath` (Engine 26+).
   */
  readOnlyRunCopiesSource?: string;
}): string[] {
  if (opts.readOnlyRunCopiesSource !== undefined && /[,"'\n\r]/.test(opts.readOnlyRunCopiesSource)) {
    throw new Error('read-run copies mount refused: the path cannot be written as a mount option');
  }
  if (opts.volumeSubpath && (!opts.workspaceVolume || !/^atoma-compute-[a-f0-9-]{36}-workspace$/.test(opts.workspaceVolume))) {
    throw new Error('Desktop workspace must be launcher-owned');
  }
  if (opts.computeMachineId && !/^[a-f0-9-]{36}$/.test(opts.computeMachineId)) throw new Error('Invalid compute identity');
  return [
    'run',
    '--rm',
    // EVERY worker runs under Docker's init: an orphan a command left behind
    // (a browser a test launched in its own process group, then a timeout
    // killed the test) is reparented to an init the worker does not own,
    // which reaps it and lets the worker tell orphans from its own children
    // (`reapEscapedProcessGroups`, src/tools/sandbox.ts). Without it the
    // worker was PID 1 and an orphan became its unreaped zombie.
    '--init',
    // Every worker, hosted and Compute: one bound, one rationale
    // (`WORKER_PIDS_LIMIT`). It was 256 on Compute and absent on hosted.
    '--pids-limit', WORKER_PIDS_LIMIT,
    ...(opts.computeMachineId ? ['--read-only',
      '--memory-swap', opts.memory ?? '2g', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
      '--label', `dev.atoma.compute=${opts.computeMachineId}`, '--label', 'dev.atoma.compute.kind=worker'] : []),
    ...(opts.socketHostPath ? ['-d', '--mount', `type=bind,src=${opts.socketHostPath},dst=/run/atoma-worker.sock,readonly`, '-e', 'ATOMA_WORKER_SOCKET=/run/atoma-worker.sock'] : ['-i']),
    // NO NETWORK ROUTE OUT. The container keeps its own loopback — verified:
    // a server started inside is reachable from inside — so the HTTP bucket
    // (`start_node_server` + `fetch_url` at 127.0.0.1) works unchanged, while
    // the control plane is unreachable: `host.docker.internal` does not even
    // resolve. This is the network half of invariant T1
    // (docs/saas-architecture.md) and it costs nothing.
    '--network',
    opts.egress ? opts.egress.network : 'none',
    ...(opts.egress
      ? [
          '-e',
          `HTTP_PROXY=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `HTTPS_PROXY=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `npm_config_proxy=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          '-e',
          `npm_config_https_proxy=http://${opts.egress.proxyHost}:${opts.egress.proxyPort}`,
          // The HTTP bucket probes servers inside this SAME container.
          // Loopback must never leave through the default-deny proxy.
          '-e',
          'NO_PROXY=127.0.0.1,localhost,::1',
          '-e',
          'no_proxy=127.0.0.1,localhost,::1',
          // Node 22+ does not consult HTTP_PROXY for fetch() unless this is
          // explicitly enabled. Without it fetch_url had no route on the
          // internal network even for allowlisted hosts.
          '-e',
          'NODE_USE_ENV_PROXY=1',
        ]
      : []),
    // ONLY the workspace. The atom registry, the skill bodies, the ledger and
    // other runs' traces are simply not on this filesystem, so the
    // `../../atoma-build.db` walk that works today finds nothing.
    ...(opts.workspaceVolume ? ['--mount', `type=volume,src=${opts.workspaceVolume},dst=/workspace,volume-nocopy${opts.volumeSubpath ? `,volume-subpath=${opts.volumeSubpath}` : ''}`]
      : ['-v', `${opts.workspaceHostPath}:/workspace`]),
    // Docker mounts by destination depth, so this lands on top of /workspace
    // whatever the argument order (proven against the real engine).
    ...(opts.readOnlyRunCopiesSource === undefined ? []
      : ['--mount', opts.workspaceVolume
        ? `type=volume,src=${opts.workspaceVolume},dst=${READ_RUN_COPIES_MOUNT},volume-subpath=${opts.volumeSubpath ? `${opts.volumeSubpath}/` : ''}${READ_RUNS_DIRECTORY},readonly,volume-nocopy`
        : `type=bind,src=${opts.readOnlyRunCopiesSource},dst=${READ_RUN_COPIES_MOUNT},readonly`]),
    '-w',
    '/workspace',
    // Drop every capability and forbid regaining privilege: nothing the
    // builtins do needs either, and a container that can re-acquire them is
    // one kernel bug away from not being a boundary.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...(opts.user ? ['--user', opts.user, '-e', 'HOME=/tmp/atoma-home'] : []),
    // Bounds, so a runaway build cannot take the host down with it. A run
    // already has a wall-clock budget; this is the resource equivalent.
    '--memory',
    opts.memory ?? '2g',
    '--cpus',
    opts.cpus ?? '2',
    opts.image,
  ];
}
