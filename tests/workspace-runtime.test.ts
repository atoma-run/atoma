import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWorkspaceProcess } from '../src/run/workspaceProcess.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';
import { remoteWorkspaceRuntime, workspaceCommandHandler } from '../src/run/workspaceRpc.js';
import { snapshotStartingWorkspace } from '../src/run/workspace.js';
import { withinReadOnlyPhase } from '../src/atoms/dispatch.js';
import { randomUUID } from 'node:crypto';
import { RunCheckpointStore, SequentialCheckpoint } from '../src/run/checkpoint.js';
import { PhaseBoundaryPause, runCheckpointSchema } from '../src/contracts/runCheckpoint.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { withRecoveryEffects } from '../src/core/recoveryEffects.js';
import { makeCtx } from './helpers.js';

const roots: string[] = [];
const services: ReturnType<typeof startWorkspaceProcess>[] = [];
afterEach(async () => { closeStoreHandles(); for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-workspace-'))); roots.push(root);
  writeFileSync(join(root, 'README.md'), 'original');
  const local = localWorkspaceRuntime({ root, log: () => undefined });
  const process = startWorkspaceProcess({ root }); services.push(process);
  return { root, local, remote: process.runtime, process };
}

describe('private workspace runtime', () => {
  it('returns the same routing and delivery evidence across the process boundary', async () => {
    const { root, local, remote } = fixture();
    const start = snapshotStartingWorkspace(root);
    expect(await remote.routingRepository()).toEqual(await local.routingRepository());
    writeFileSync(join(root, 'README.md'), 'changed');
    writeFileSync(join(root, 'new.txt'), 'added');
    expect(await remote.deliveredSnapshot(start)).toEqual(await local.deliveredSnapshot(start));
    await remote.captureReadRuns();
    expect(await remote.checkReadRuns()).toEqual([]);
  });

  it('awaits the photograph and restore in the production supervision hook', async () => {
    const { root, remote } = fixture();
    const ctx = makeCtx();
    const result = await withinReadOnlyPhase({ ...ctx, readOnlyPhases: remote.readOnlyPhases }, {
      description: 'Inspect the existing files', criteria: [], readOnly: true,
    }, async () => {
      writeFileSync(join(root, 'README.md'), 'wrong replacement');
      return null;
    });
    expect(result).toBeNull();
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('original');
    expect(remote.readOnlyPhases.restorations()).toHaveLength(1);
    expect(remote.readOnlyPhases.restorations()[0]?.paths[0]?.restored).toBe(true);
  });

  it('does not replay an end whose acknowledgement was lost', async () => {
    const { local } = fixture();
    const handler = workspaceCommandHandler(local);
    let endings = 0;
    const remote = remoteWorkspaceRuntime(async command => {
      const result = await handler(command);
      if (command.method === 'end-read-only') { endings++; throw new Error('connection lost'); }
      return result;
    });
    const guard = await remote.readOnlyPhases.begin('Read', 1);
    await expect(guard.end()).rejects.toThrow('connection lost');
    await expect(guard.end()).rejects.toThrow('connection lost');
    expect(endings).toBe(1);
  });

  it('rejects unknown commands, caller-selected roots and handles from another service', async () => {
    const { local } = fixture();
    const execute = workspaceCommandHandler(local);
    await expect(execute({ method: 'run_shell', args: { cmd: 'id' } })).rejects.toThrow();
    await expect(execute({ method: 'routing', root: '/etc' })).rejects.toThrow();
    const guard = await execute({ method: 'begin-read-only', phase: 'Read', attempt: 1 });
    await expect(execute({ method: 'begin-read-only', phase: 'Overlap', attempt: 1 })).rejects.toThrow('already active');
    await expect(workspaceCommandHandler(local)({ method: 'end-read-only', handle: guard.value, record: {} })).rejects.toThrow('Unknown');
  });

  it('fails outstanding and future requests after confirmed process shutdown', async () => {
    const { process, remote } = fixture();
    await remote.routingRepository();
    await process.close();
    await expect(remote.routingRepository()).rejects.toThrow('stopped');
  });
});


it.each([false, true])('seals a sequential boundary without host files, or refuses a disconnected transfer (disconnect=%s)', async disconnect => {
  const { root, remote, process } = fixture();
  const product = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-workspace-product-'))); roots.push(product);
  const store = new RunCheckpointStore(join(product, 'product.db'));
  const data = runCheckpointSchema.parse({ version: 1, id: randomUUID(), goal: 'Test remote checkpoint', workspace: '/unavailable-on-host',
    policy: '{}', actor: null, checklist: null, root: null, completed: [], workspaceDigest: null, processes: [],
    consumed: { tokens: 0, costUsd: 0 }, remainingMs: 60000, lastRunId: null });
  await withRecoveryEffects(async () => {
    const checkpoint = new SequentialCheckpoint(data, store, { fresh: true, pauseAfter: 1,
      account: () => ({ tokens: 5, costUsd: 0 }), deadlineAt: Date.now() + 60000,
      settle: async () => {}, processes: () => [], workspace: { ...remote, checkpointExport: async () => {
        const exporting = await remote.checkpointExport();
        return { ...exporting, async *frames() {
          for await (const frame of exporting.frames()) {
            yield frame;
            if (disconnect) await process.close();
          }
        } };
      } },
      drain: async () => { writeFileSync(join(root, 'README.md'), 'shutdown persisted'); },
    });
    const phase = { description: 'Build' };
    checkpoint.planned({ description: 'Build' }, { reasoning: 'One approved phase', expectedOutput: 'Built files',
      subtasks: [phase], aggregation: { mode: 'sequential' } }, {}, 1);
    await checkpoint.beforePhase(0, phase);
    const sealing = checkpoint.afterPhase(0, { output: {}, summary: 'Done', producedBy: { name: 'Cell', tier: 2, viaFallback: false },
      trace: [{ kind: 'verdict-result', ts: '0', atom: 'Cell', payload: { approved: true } }] });
    if (disconnect) await expect(sealing).rejects.toThrow('stopped');
    else await expect(sealing).rejects.toBeInstanceOf(PhaseBoundaryPause);
    await checkpoint.release();
  });
  if (disconnect) {
    expect(() => store.read(data.id)).toThrow('not at a resumable');
    expect(data.snapshotId).toBeUndefined();
  } else {
    store.materialize(data, join(product, 'restored'), false);
    expect(readFileSync(join(product, 'restored/README.md'), 'utf8')).toBe('shutdown persisted');
  }
});
