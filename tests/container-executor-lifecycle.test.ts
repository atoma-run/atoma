import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContainerToolExecutor,
  type ContainerSpawn,
} from '../src/tools/containerExecutor.js';
import { encodeMessage } from '../src/tools/containerProtocol.js';
import * as launcher from '../src/launcher/docker.js';

afterEach(() => vi.restoreAllMocks());

function fakeWorker(pid: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcess;
  setImmediate(() => {
    child.stdout!.emit(
      'data',
      Buffer.from(
        encodeMessage({
          ready: true,
          root: '/workspace',
          tools: [
            {
              name: 'read_file',
              description: 'read',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        })
      )
    );
  });
  return child;
}

describe('ContainerToolExecutor lifecycle', () => {
  it('waits for engine removal after the CLI exits and permanently closes the old backend', async () => {
    let removed!: () => void;
    const drain = vi.fn(() => new Promise<void>((resolve) => { removed = resolve; }));
    vi.spyOn(launcher, 'attachedWorkerLifecycle').mockReturnValue({ name: 'atoma-worker-owned', drain });
    const root = mkdtempSync(join(tmpdir(), 'atoma-executor-drain-'));
    const worker = fakeWorker(4242);
    const spawnFn = vi.fn((_command: string, args: string[]) => {
      expect(args.slice(0, 3)).toEqual(['run', '--name', 'atoma-worker-owned']);
      return worker;
    }) as unknown as ContainerSpawn;
    const executor = new ContainerToolExecutor({ workspaceHostPath: root, spawnFn, forwardWorkerLogs: false });
    try {
      await executor.start();
      worker.emit('exit', 1);
      let finished = false;
      const pending = executor.drain().then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      await expect(executor.start()).rejects.toThrow('drained');
      removed();
      await pending;
      expect(finished).toBe(true);
      expect(drain).toHaveBeenCalledTimes(1);
      expect(spawnFn).toHaveBeenCalledTimes(1);
    } finally { executor.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['remaining', 'engine-error', 'auto-removed'])('requires an engine proof of absence (%s)', async (state) => {
    const runDocker = vi.fn(async (args: string[]) => {
      if (args[0] === 'rm') throw new Error('Removal raced auto-remove');
      if (state === 'engine-error') throw new Error('Engine unavailable');
      return state === 'remaining' ? 'still-running-id\n' : '';
    });
    const worker = launcher.attachedWorkerLifecycle({ runDocker });
    if (state === 'auto-removed') await expect(worker.drain()).resolves.toBeUndefined();
    else await expect(worker.drain()).rejects.toThrow(state === 'remaining' ? 'refusing workspace replacement' : 'Engine unavailable');
    expect(runDocker.mock.calls.map(([args]) => args)).toEqual([
      ['rm', '-f', worker.name], ['ps', '-a', '--filter', `name=^/${worker.name}$`, '--format', '{{.ID}}'],
    ]);
  });
  it('creates the workspace on the host BEFORE the engine is asked to mount it', async () => {
    // THE DEFECT THIS PINS, measured on a real project run (2026-09-02): a
    // bind-mount source that does not exist is created by the DAEMON, as root.
    // The worker then runs as the host user and finds `/workspace` owned by
    // root, mode 755 — every write refused, the L1 agent improvising in
    // `/tmp`, and a deliverable that never lands where delivery, publication
    // and the preview look for it. The operator path never saw it because its
    // workspace persists across runs; a project run gets a fresh path every
    // time.
    const root = mkdtempSync(join(tmpdir(), 'atoma-executor-'));
    const workspace = join(root, 'fresh', 'workspace');
    expect(existsSync(workspace)).toBe(false);

    let existedAtSpawn: boolean | null = null;
    const spawnFn = ((_command: string, args: readonly string[]) => {
      // What the ENGINE would see: the mount source, at the moment of the
      // spawn. If it is not a directory here, docker creates it as root.
      const mount = args.find((arg) => arg.endsWith(':/workspace')) ?? '';
      const source = mount.slice(0, -':/workspace'.length);
      existedAtSpawn = existsSync(source) && statSync(source).isDirectory();
      return fakeWorker(4242);
    }) as ContainerSpawn;
    const executor = new ContainerToolExecutor({
      workspaceHostPath: workspace,
      spawnFn,
      forwardWorkerLogs: false,
    });

    try {
      await executor.start();
      expect(existedAtSpawn).toBe(true);
    } finally {
      executor.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts a fresh worker after the previous container exits unexpectedly', async () => {
    const children: ChildProcess[] = [];
    const spawnFn = ((_command: string, _args: readonly string[]) => {
      const child = fakeWorker(1000 + children.length);
      children.push(child);
      return child;
    }) as ContainerSpawn;
    const executor = new ContainerToolExecutor({
      workspaceHostPath: '/tmp/workspace',
      spawnFn,
      forwardWorkerLogs: false,
    });

    await executor.start();
    expect(children).toHaveLength(1);
    children[0]!.emit('exit', 1);
    await executor.start();
    expect(children).toHaveLength(2);
    executor.stop();
  });

  // Docker follows a symlinked bind source (measured): the guard refuses
  // anything but a real `.atoma-runs` before the engine is asked, at every
  // start, the restart after a crash included.
  it.skipIf(process.platform === 'win32').each(['link', 'file', 'absent', 'inner link'] as const)('refuses a read-run mount source that is not a real directory without spawning (%s)', async (shape) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-executor-ro-')));
    const workspace = join(root, 'ws');
    mkdirSync(join(workspace, 'inner'), { recursive: true });
    mkdirSync(join(root, 'secret'));
    if (shape === 'link') symlinkSync(join(root, 'secret'), join(workspace, '.atoma-runs'));
    if (shape === 'file') writeFileSync(join(workspace, '.atoma-runs'), '');
    if (shape === 'inner link') symlinkSync('inner', join(workspace, '.atoma-runs'));
    const spawnFn = vi.fn(() => fakeWorker(4242)) as unknown as ContainerSpawn;
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace, spawnFn, forwardWorkerLogs: false, readOnlyRunCopies: true });
    try {
      await expect(executor.start()).rejects.toThrow('read-run copies mount refused');
      expect(spawnFn).not.toHaveBeenCalled();
    } finally { executor.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('mounts the verified realpath, and checks again when it restarts a crashed worker', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-executor-ro-')));
    const workspace = join(root, 'ws');
    mkdirSync(join(workspace, '.atoma-runs'), { recursive: true });
    mkdirSync(join(root, 'secret'));
    const children: ChildProcess[] = [];
    const seen: string[][] = [];
    const spawnFn = ((_command: string, args: string[]) => {
      seen.push(args);
      const child = fakeWorker(1000 + children.length);
      children.push(child);
      return child;
    }) as unknown as ContainerSpawn;
    const executor = new ContainerToolExecutor({ workspaceHostPath: workspace, spawnFn, forwardWorkerLogs: false, readOnlyRunCopies: true });
    try {
      await executor.start();
      expect(seen[0]).toContain(`type=bind,src=${join(workspace, '.atoma-runs')},dst=/workspace/.atoma-runs,readonly`);
      children[0]!.emit('exit', 1);
      rmSync(join(workspace, '.atoma-runs'), { recursive: true });
      symlinkSync(join(root, 'secret'), join(workspace, '.atoma-runs'));
      await expect(executor.start()).rejects.toThrow('read-run copies mount refused');
      expect(seen).toHaveLength(1);
    } finally { executor.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});
