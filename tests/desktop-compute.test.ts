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
        HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[] };
        Config: { User: string }; Mounts: Array<{ Type: string; Destination: string }>;
      }>;
      expect(units[0]!.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'] });
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
