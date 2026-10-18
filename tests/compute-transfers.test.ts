import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ComputeTransfers } from '../src/launcher/computeTransfers.js';
import { ComputeBandwidth } from '../src/launcher/computeBandwidth.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';
import { workspaceCommandHandler, remoteWorkspaceRuntime } from '../src/run/workspaceRpc.js';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('reports streamed checkpoint bytes without claiming server confirmation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-progress-')));
  const progress = new ComputeTransfers();
  const execute = workspaceCommandHandler(localWorkspaceRuntime({ root, log: () => {} }));
  const remote = remoteWorkspaceRuntime(async command => { const reply = await execute(command); progress.observe(command, reply); return reply; });
  try {
    writeFileSync(join(root, 'bytes.bin'), Buffer.alloc(800_000, 42));
    const transfer = await remote.checkpointExport();
    for await (const frame of transfer.frames()) if (frame.kind === 'chunk') expect(progress.list()[0]?.bytes).toBeGreaterThan(0);
    expect(progress.list()).toEqual([expect.objectContaining({ kind: 'checkpoint', direction: 'upload', bytes: 800_000, files: 1, state: 'transferred' })]);
    const abandoned = await remote.checkpointExport();
    progress.interrupted();
    expect(progress.list()[1]?.state).toBe('interrupted');
    await abandoned.close();
    for (let i = 0; i < 12; i++) progress.observe({ method: 'checkpoint-open' }, { method: 'checkpoint-open', value: { handle: randomUUID(), header: { digest: 'a'.repeat(64), rootMode: 0o700 } } });
    expect(progress.list()).toHaveLength(8);
  } finally { await execute.close(); rmSync(root, { recursive: true, force: true }); }
});
it('bounds shared bulk bandwidth and cancels waiting transfers on disconnect', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const abort = new AbortController(), bandwidth = new ComputeBandwidth(256 * 1024);
  const first = vi.fn(), second = vi.fn();
  try {
    const a = bandwidth.consume(256 * 1024, abort.signal).then(first);
    const b = bandwidth.consume(256 * 1024, abort.signal).then(second);
    const cancelled = expect(b).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000); await a;
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    abort.abort(); await cancelled;
  } finally { vi.useRealTimers(); }
});
