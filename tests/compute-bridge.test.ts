import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connectComputeBridge, serveComputeBridge } from '../src/run/computeBridge.js';

it('crosses a real child-process boundary and matches concurrent tool results', async () => {
  const seen: string[] = [];
  const server = await serveComputeBridge(async call => {
    seen.push(call.channel);
    return call.channel === 'tools' ? call.command.method : { method: call.command.method, value: null };
  });
  try {
    const code = `import { connectComputeBridge } from './src/run/computeBridge.ts';
      const client = await connectComputeBridge(JSON.parse(process.env.BRIDGE));
      const results = await Promise.all([client.send({channel:'workspace',command:{method:'prepare',clean:false}}),
        client.send({channel:'tools',command:{method:'drain'}})]);
      process.stdout.write(JSON.stringify(results)); client.close();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { PATH: process.env['PATH'], BRIDGE: JSON.stringify(server.address) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { errors += String(b); });
    const [codeResult] = await once(child, 'close');
    expect(errors).toBe(''); expect(codeResult).toBe(0);
    expect(JSON.parse(output)).toEqual([{ method: 'prepare', value: null }, 'drain']);
    expect(seen).toEqual(['workspace', 'tools']);
  } finally { await server.close(); }
});

it('refuses a wrong token and a second child without dispatching operations', async () => {
  const server = await serveComputeBridge(async () => { throw new Error('Must not execute'); });
  try {
    await expect(connectComputeBridge({ ...server.address, token: 'a'.repeat(43) })).rejects.toThrow('lost');
    const client = await connectComputeBridge(server.address);
    await expect(connectComputeBridge(server.address)).rejects.toThrow('lost');
    client.close();
  } finally { await server.close(); }
});

it('rejects an unknown in-flight effect on loss without resending it', async () => {
  let calls = 0;
  let received!: () => void;
  const observed = new Promise<void>(resolve => { received = resolve; });
  const server = await serveComputeBridge(async () => { calls++; received(); return new Promise(() => {}); });
  const client = await connectComputeBridge(server.address);
  const pending = client.send({ channel: 'tools', command: { method: 'invoke', name: 'write_file', args: {} } });
  const rejected = expect(pending).rejects.toThrow('outcome unknown');
  await observed;
  await server.close(); await rejected;
  expect(calls).toBe(1);
});


it('provisions a seed through the runner bridge and keeps host-only source paths private', async () => {
  const { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { localWorkspaceRuntime } = await import('../src/run/workspaceRuntime.js');
  const { workspaceCommandHandler } = await import('../src/run/workspaceRpc.js');
  const { computeRunnerOptions } = await import('../src/run/computeRunner.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-runner-')));
  const source = join(root, 'host-source'), target = join(root, 'device-current');
  mkdirSync(source); writeFileSync(join(source, 'README.md'), 'saved source');
  const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: target, sourceRoot: join(root, 'device-private'), log: () => {} }));
  const commands: unknown[] = [];
  const server = await serveComputeBridge(async call => {
    commands.push(call);
    if (call.channel !== 'workspace') throw new Error('Unexpected tool call');
    return handler(call.command);
  });
  let runtime: Awaited<ReturnType<typeof computeRunnerOptions>> | undefined;
  try {
    runtime = await computeRunnerOptions(server.address);
    await runtime.prepareWorkspaceSources({ seedRoot: source });
    rmSync(source, { recursive: true });
    await runtime.workspaceRuntime.prepare(false);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('saved source');
    expect(JSON.stringify(commands)).not.toContain(source);
    expect((await runtime.createToolBackend()).provenance).toBe('customer-device');
  } finally { runtime?.close(); await server.close(); await handler.close(); rmSync(root, { recursive: true, force: true }); }
});
