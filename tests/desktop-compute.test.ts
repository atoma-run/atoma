import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { DesktopCompute } from '../src/launcher/desktopCompute.js';

const exec = promisify(execFile);
const workspaceImage = process.env['ATOMA_TEST_WORKSPACE_IMAGE'];
const workerImage = process.env['ATOMA_TEST_WORKER_IMAGE'];
const docker = async (args: string[]) => (await exec('docker', args, { timeout: 30_000 })).stdout.trim();

it('refuses mutable images before contacting the engine', () => {
  expect(() => new DesktopCompute({ machineId: randomUUID(), workspaceImage: 'latest', workerImage: 'latest' })).toThrow();
});

it.skipIf(!workspaceImage || !workerImage)('runs tools in a managed Linux volume and seals after engine-confirmed drain', async () => {
  const machineId = randomUUID();
  const runtime = new DesktopCompute({ machineId,
    workspaceImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workspaceImage!]),
    workerImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workerImage!]) });
  const filter = `label=dev.atoma.compute=${machineId}`;
  try {
    await runtime.open();
    await expect(runtime.open()).rejects.toThrow('already opened');
    await runtime.command({ method: 'prepare', clean: false });
    await runtime.executor.execute('write_file', { path: 'proof.txt', content: 'customer bytes' });
    expect(JSON.stringify(await runtime.executor.execute('read_file', { path: 'proof.txt' }))).toContain('customer bytes');
    const ids = (await docker(['ps', '-q', '--filter', filter])).split('\n');
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const units = JSON.parse(await docker(['inspect', id])) as Array<{
        HostConfig: { NanoCpus: number; Memory: number; MemorySwap: number; NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[] };
        Config: { User: string }; Mounts: Array<{ Type: string; Destination: string }>;
      }>;
      expect(units[0]!.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'] });
      if (units[0]!.HostConfig.Memory > 512 * 1024 ** 2) expect(units[0]!.HostConfig).toMatchObject({ NanoCpus: 2e9, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3 });
      expect(units[0]!.Config.User).toBe('10001:10001');
      expect(units[0]!.Mounts.every(mount => mount.Type !== 'bind')).toBe(true);
    }
    await expect(runtime.command({ method: 'restart' })).rejects.toThrow('confirmed tool drain');
    await runtime.drain();
    expect((await docker(['ps', '-q', '--filter', filter])).split('\n')).toHaveLength(1);
    await expect(runtime.executor.execute('read_file', { path: 'proof.txt' })).rejects.toThrow('drained');
    const opened = await runtime.command({ method: 'checkpoint-open' });
    if (opened.method !== 'checkpoint-open') throw new Error('Wrong response');
    expect(await runtime.command({ method: 'checkpoint-next', handle: opened.value.handle }))
      .toMatchObject({ value: { kind: 'entry', entry: { path: 'proof.txt' } } });
    expect(await runtime.command({ method: 'checkpoint-next', handle: opened.value.handle }))
      .toMatchObject({ value: { kind: 'chunk', data: Buffer.from('customer bytes').toString('base64') } });
    await runtime.command({ method: 'checkpoint-close', handle: opened.value.handle });
    await runtime.nextAttempt();
    expect(JSON.stringify(await runtime.executor.execute('read_file', { path: 'proof.txt' }))).toContain('customer bytes');
    await runtime.drain();
    await runtime.command({ method: 'restart' });
    await runtime.executor.execute('write_file', { path: 'next.txt', content: 'next attempt' });
    await runtime.close();
    expect(await docker(['ps', '-aq', '--filter', filter])).toBe('');
    await expect(runtime.nextAttempt()).rejects.toThrow('unavailable');
  } finally {
    await runtime.close();
    await DesktopCompute.reconcile(machineId);
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', filter])).split('\n').filter(Boolean);
    if (volumes.length) await docker(['volume', 'rm', ...volumes]);
  }
}, 90_000);

it.skipIf(!workspaceImage || !workerImage)('keeps dynamically provisioned reference copies read-only inside the real worker', async () => {
  const { mkdtempSync, realpathSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { remoteWorkspaceRuntime } = await import('../src/run/workspaceRpc.js');
  const { buildWorkspaceArtifactManifest } = await import('../src/projects/artifacts.js');
  const { captureCheckpointExport } = await import('../src/run/checkpointExport.js');
  const { provisionWorkspaceSource } = await import('../src/run/workspaceImport.js');
  const { readRunCopyPath } = await import('../src/contracts/readRuns.js');
  const machineId = randomUUID(), runId = randomUUID();
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'compute-reference-')));
  writeFileSync(join(source, 'proof.txt'), 'saved reference');
  const built = buildWorkspaceArtifactManifest({ workspaceRoot: source });
  const runtime = new DesktopCompute({ machineId,
    workspaceImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workspaceImage!]),
    workerImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workerImage!]) });
  const filter = `label=dev.atoma.compute=${machineId}`;
  try {
    await runtime.open();
    const workspace = remoteWorkspaceRuntime(command => runtime.command(command));
    await workspace.bindSources!({ seed: false, readRuns: { version: 1, orgId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
      readRuns: [{ runId, status: 'delivered', endedAt: new Date().toISOString(), workspacePath: 'remote-source', manifest: built.manifest, manifestHash: built.hash }] } });
    await provisionWorkspaceSource(workspace, { kind: 'read-run', runId }, captureCheckpointExport(source));
    await workspace.prepare(false); await workspace.captureReadRuns();
    const copy = `${readRunCopyPath(runId)}/proof.txt`;
    expect(JSON.stringify(await runtime.executor.execute('read_file', { path: copy }))).toContain('saved reference');
    const result = await runtime.executor.execute('run_shell', { cmd: `printf changed > '${copy}'` });
    expect(JSON.stringify(result)).toMatch(/read.only|denied|not permitted/i);
    expect(await workspace.checkReadRuns()).toMatchObject([{ runId, changedCount: 0, touchedCount: 0, missingCount: 0 }]);
  } finally {
    await runtime.close(); await DesktopCompute.reconcile(machineId);
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', filter])).split('\n').filter(Boolean);
    if (volumes.length) await docker(['volume', 'rm', ...volumes]);
    rmSync(source, { recursive: true, force: true });
  }
}, 90_000);

it.skipIf(!workspaceImage || !workerImage)('recovers recorded volumes for export without restarting workload execution', async () => {
  const { mkdtempSync, realpathSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ComputeInventory } = await import('../src/launcher/computeInventory.js');
  const { remoteWorkspaceRuntime } = await import('../src/run/workspaceRpc.js');
  const { receiveArtifactExport } = await import('../src/run/artifactTransfer.js');
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'compute-recovery-')));
  let inventory = new ComputeInventory(state);
  const machineId = inventory.machineId(), execution = { runId: randomUUID(), generation: 1 };
  const allocation = inventory.reserve(execution);
  const config = { machineId, allocationId: allocation.allocationId,
    workspaceImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workspaceImage!]),
    workerImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workerImage!]) };
  let runtime = new DesktopCompute(config);
  const filter = `label=dev.atoma.compute=${machineId}`;
  try {
    await runtime.open(); inventory.active(execution);
    await runtime.command({ method: 'prepare', clean: false });
    await runtime.executor.execute('write_file', { path: 'proof.txt', content: 'retained bytes' });
    for (const machine of [machineId, randomUUID()]) {
      const other = new DesktopCompute({ ...config, machineId: machine, recovery: true });
      await expect(other.open()).rejects.toThrow('another launcher instance');
      await expect(other.close()).rejects.toThrow('another launcher instance');
      expect(JSON.stringify(await runtime.executor.execute('read_file', { path: 'proof.txt' }))).toContain('retained bytes');
    }
    await runtime.close(); inventory.close();
    inventory = new ComputeInventory(state);
    expect(inventory.find(execution)?.state).toBe('unconfirmed');
    await DesktopCompute.reconcile(machineId); inventory.stopped(execution);
    runtime = new DesktopCompute({ ...config, recovery: true });
    await runtime.open();
    await expect(runtime.command({ method: 'prepare', clean: true })).rejects.toThrow('export only');
    await expect(runtime.executor.execute('write_file', { path: 'proof.txt', content: 'wrong' })).rejects.toThrow('unavailable');
    const workspace = remoteWorkspaceRuntime(command => runtime.command(command));
    await receiveArtifactExport(await workspace.artifactExport({ allowEmpty: false }), join(state, 'delivery'));
    expect(readFileSync(join(state, 'delivery/proof.txt'), 'utf8')).toBe('retained bytes');
  } finally {
    await runtime.close(); inventory.close(); await DesktopCompute.reconcile(machineId);
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', filter])).split('\n').filter(Boolean);
    if (volumes.length) await docker(['volume', 'rm', ...volumes]);
    rmSync(state, { recursive: true, force: true });
  }
}, 90_000);

it.skipIf(!workspaceImage || !workerImage)('permits registry egress only through the isolated desktop proxy and reconciles its networks', async () => {
  const machineId = randomUUID(), worker = await docker(['image', 'inspect', '--format', '{{.Id}}', workerImage!]);
  const runtime = new DesktopCompute({ machineId, egress: true, workerImage: worker,
    workspaceImage: await docker(['image', 'inspect', '--format', '{{.Id}}', workspaceImage!]) });
  const filter = `label=dev.atoma.compute=${machineId}`;
  try {
    await runtime.open(); await runtime.command({ method: 'prepare', clean: false });
    const allowed = await runtime.executor.execute('fetch_url', { url: 'https://registry.npmjs.org/left-pad/latest', timeoutMs: 20_000 });
    expect(allowed).toMatchObject({ status: 200 });
    const denied = await runtime.executor.execute('fetch_url', { url: 'http://host.docker.internal:4111/api/runs', timeoutMs: 3000 });
    expect(denied).toMatchObject({ ok: false, error: expect.any(String) });
    const workerId = await docker(['ps', '-q', '--filter', filter, '--filter', 'label=dev.atoma.compute.kind=worker']);
    const bypass = await docker(['exec', workerId, 'node', '-e',
      "const net=require('node:net');const s=net.connect(443,'1.1.1.1');s.on('connect',()=>{process.stdout.write('REACHED');s.destroy()});s.on('error',()=>process.stdout.write('DENIED'));s.setTimeout(2000,()=>{process.stdout.write('DENIED');s.destroy()})"]);
    expect(bypass).toBe('DENIED');
    await runtime.drain();
    await DesktopCompute.reconcile(machineId, worker);
  } finally {
    await runtime.close();
    await DesktopCompute.reconcile(machineId, worker);
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', filter])).split('\n').filter(Boolean);
    if (volumes.length) await docker(['volume', 'rm', ...volumes]);
  }
}, 90_000);
