import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

/** A fake Docker engine: named volumes with labels and named containers with
 * labels, driven through the same `docker` argv the launcher sends. */
const engine = vi.hoisted(() => {
  const volumes = new Map<string, Record<string, string>>();
  const containers = new Map<string, { id: string; labels: Record<string, string> }>();
  const busy = new Set<string>();
  const filtersOf = (args: string[]) => args.flatMap((arg, index) => args[index - 1] === '--filter' ? [arg] : []);
  const matches = (name: string, labels: Record<string, string>, filters: string[], container: boolean) => filters.every(filter => {
    const [key, ...rest] = filter.split('='); const value = rest.join('=');
    if (key === 'name') return container ? new RegExp(value).test(`/${name}`) : name.includes(value);
    if (key === 'label') { const [label, ...expected] = value.split('='); return labels[label!] === expected.join('='); }
    throw new Error(`unsupported filter ${filter}`);
  });
  const labelsOf = (args: string[]) => Object.fromEntries(args.flatMap((arg, index) => args[index - 1] === '--label' ? [arg.split(/=(.*)/s).slice(0, 2)] : []));
  const run = (args: string[]): string => {
    const [command, sub] = args;
    if (command === 'info') return JSON.stringify({ OSType: 'linux', NCPU: 8, MemTotal: 16 * 1024 ** 3, ServerVersion: '28.0.0', OperatingSystem: 'Docker Desktop' });
    if (command === 'ps') return [...containers].filter(([name, unit]) => matches(name, unit.labels, filtersOf(args), true)).map(([, unit]) => unit.id).join('\n');
    if (command === 'rm') { for (const name of args.slice(2)) for (const [key, unit] of containers) if (key === name || unit.id === name) containers.delete(key); return ''; }
    if (command === 'network') return '';
    if (command !== 'volume') throw new Error(`unsupported docker ${args.join(' ')}`);
    const name = args.at(-1)!;
    if (sub === 'create') { if (!volumes.has(name)) volumes.set(name, labelsOf(args)); return name; }
    if (sub === 'inspect') { const labels = volumes.get(name); if (!labels) throw new Error('No such volume'); return JSON.stringify(labels); }
    if (sub === 'ls') return [...volumes].filter(([volume, labels]) => matches(volume, labels, filtersOf(args), false)).map(([volume]) => volume).join('\n');
    if (sub === 'rm') {
      const refused = args.slice(2).filter(volume => busy.has(volume) || !volumes.has(volume));
      for (const volume of args.slice(2)) if (!refused.includes(volume)) volumes.delete(volume);
      if (refused.length) throw new Error(`volume is in use: ${refused.join(' ')}`);
      return '';
    }
    throw new Error(`unsupported docker ${args.join(' ')}`);
  };
  const exec = vi.fn(async (_command: string, args: string[]) => ({ stdout: run(args), stderr: '' }));
  return { volumes, containers, busy, exec, labelsOf };
});

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: engine.exec }),
    spawn: vi.fn((_command: string, args: string[]) => {
      const name = args[args.indexOf('--name') + 1]!;
      engine.containers.set(name, { id: randomUUID().replaceAll('-', '').slice(0, 12), labels: engine.labelsOf(args) });
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    }),
  };
});
vi.mock('../src/run/workspaceProcess.js', () => ({
  workspaceProcessChannel: () => ({ runtime: { validateSources: async () => undefined }, close: async () => undefined, command: async () => ({}) }),
}));
vi.mock('../src/launcher/computeRetrievalProcess.js', () => ({
  computeRetrievalProcess: () => ({ execute: async () => ({ method: 'status', value: null }), close: async () => undefined }),
}));
vi.mock('../src/launcher/docker.js', async original => ({
  ...await original<typeof import('../src/launcher/docker.js')>(),
  createContainerLauncher: () => ({ purgeOwner: async () => undefined, unitName: (kind: string, owner: string) => `${kind}-${owner}`,
    networkName: ({ kind, ownerId }: { kind: string; ownerId: string }) => `${kind}-${ownerId}` }),
}));
vi.mock('../src/launcher/computeClient.js', () => ({
  connectComputeWorkspace: async () => ({ state: () => 'active', close: async () => true }),
}));

import { DesktopCompute } from '../src/launcher/desktopCompute.js';

const image = (letter: string) => `ghcr.io/atoma-run/atoma/image@sha256:${letter.repeat(64)}`;
beforeEach(() => { engine.volumes.clear(); engine.containers.clear(); engine.busy.clear(); engine.exec.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

it('removes the allocation corpus volume when retrieval stops and keeps the shared embeddings cache', async () => {
  const machineId = randomUUID(), allocationId = randomUUID();
  const runtime = new DesktopCompute({ machineId, allocationId, workspaceImage: image('a'), workerImage: image('b'), retrievalImage: image('c') });
  await runtime.open();
  await runtime.retrievalCommand({ method: 'status' } as never);
  const corpus = `atoma-compute-${allocationId}-retrieval-data`;
  expect(engine.volumes.has(corpus)).toBe(true);
  await runtime.close();
  expect(engine.containers.size).toBe(0);
  expect(engine.volumes.has(corpus)).toBe(false);
  expect([...engine.volumes.keys()].sort()).toEqual([`atoma-compute-${allocationId}-snapshots`, `atoma-compute-${allocationId}-workspace`,
    `atoma-compute-${machineId}-embeddings`].sort());
});

it('keeps a confirmed stop when the corpus volume cannot be removed', async () => {
  const machineId = randomUUID(), allocationId = randomUUID();
  const runtime = new DesktopCompute({ machineId, allocationId, workspaceImage: image('a'), workerImage: image('b'), retrievalImage: image('c') });
  await runtime.open();
  await runtime.retrievalCommand({ method: 'status' } as never);
  const corpus = `atoma-compute-${allocationId}-retrieval-data`;
  engine.busy.add(corpus);
  await expect(runtime.close()).resolves.toBeUndefined();
  expect(engine.containers.size).toBe(0);
  expect(engine.volumes.has(corpus)).toBe(true);
});


it('reclaims abandoned corpora on boot, preserving recovery, cache, foreign and busy volumes', async () => {
  const machineId = randomUUID(), otherMachine = randomUUID();
  const name = (suffix: string) => `atoma-compute-${randomUUID()}-${suffix}`;
  const corpus = name('retrieval-data'), busy = name('retrieval-data'), foreign = name('retrieval-data');
  const kept = [name('workspace'), name('snapshots'), name('embeddings'), 'atoma-compute-unrecognised-retrieval-data'];
  for (const volume of [corpus, busy, ...kept]) engine.volumes.set(volume, { 'dev.atoma.compute': machineId });
  engine.volumes.set(foreign, { 'dev.atoma.compute': otherMachine });
  engine.busy.add(busy);
  engine.containers.set('abandoned-retrieval', { id: '123456789abc', labels: { 'dev.atoma.compute': machineId } });
  await DesktopCompute.reconcile(machineId);
  expect(engine.containers.size).toBe(0);
  expect([...engine.volumes.keys()].sort()).toEqual([busy, foreign, ...kept].sort());
  const calls = engine.exec.mock.calls.map(([, args]) => args);
  expect(calls.findIndex(args => args[0] === 'rm')).toBeLessThan(calls.findIndex(args => args[0] === 'volume' && args[1] === 'rm'));
  engine.busy.clear();
  await DesktopCompute.reconcile(machineId);
  expect(engine.volumes.has(busy)).toBe(false);
});

it('never reclaims a corpus while workload absence is unconfirmed', async () => {
  const machineId = randomUUID(), corpus = `atoma-compute-${randomUUID()}-retrieval-data`;
  engine.volumes.set(corpus, { 'dev.atoma.compute': machineId });
  engine.exec.mockImplementationOnce(async () => ({ stdout: '', stderr: '' }))
    .mockImplementationOnce(async () => ({ stdout: '123456789abc', stderr: '' }));
  await expect(DesktopCompute.reconcile(machineId)).rejects.toThrow('Compute workloads still exist');
  expect(engine.volumes.has(corpus)).toBe(true);
  expect(engine.exec.mock.calls.some(([, args]) => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
});
