import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWorkspaceProcess } from '../src/run/workspaceProcess.js';
import { captureCheckpointExport } from '../src/run/checkpointExport.js';
import { restoreWorkspaceExport } from '../src/run/workspaceImport.js';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { buildTierClients } from '../src/run/providers.js';
import { localToolBackend } from '../src/run/toolBackend.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { OLLAMA_PINS } from './tier-pins.js';
import { silentLogger } from './helpers.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';
import { workspaceCommandHandler, remoteWorkspaceRuntime } from '../src/run/workspaceRpc.js';

vi.mock('../src/run/providers.js', async original => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(),
}));
const roots: string[] = [];
const services: ReturnType<typeof startWorkspaceProcess>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  closeStoreHandles(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetHostLifecycleSnapshotForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-workspace-life-'))); roots.push(root);
  const workspace = join(root, 'client', 'current');
  const seedRoot = join(root, 'seed'); mkdirSync(seedRoot);
  writeFileSync(join(seedRoot, 'README.md'), 'seed bytes');
  const service = startWorkspaceProcess({ root: workspace, seedRoot, onLog: () => undefined }); services.push(service);
  return { root, workspace, seedRoot, service, runtime: service.runtime };
}

it('prepares and restarts on the service filesystem, preserving the failed attempt', async () => {
  const { workspace, runtime } = fixture();
  await runtime.validateSources();
  await runtime.prepare(false);
  expect(await runtime.canonicalPath()).toBe(workspace);
  expect((await runtime.startingSnapshot())?.files.map(file => file.path)).toContain('README.md');
  writeFileSync(join(workspace, 'README.md'), 'attempt one');
  await runtime.restart();
  expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('seed bytes');
  expect(readFileSync(join(`${workspace}.prev1`, 'README.md'), 'utf8')).toBe('attempt one');
});

it('refuses a missing launch seed before archiving, but preserves a failed deepening in its archive', async () => {
  const { workspace, seedRoot, runtime } = fixture();
  await runtime.prepare(false);
  rmSync(seedRoot, { recursive: true });
  await expect(runtime.prepare(true)).rejects.toThrow();
  expect(existsSync(`${workspace}.prev1`)).toBe(false);
  await expect(runtime.restart()).rejects.toThrow();
  expect(readFileSync(join(`${workspace}.prev1`, 'README.md'), 'utf8')).toBe('seed bytes');
});

it('restores checkpoint bytes in a new client directory and archives an existing target only after validation', async () => {
  const { workspace, seedRoot, runtime } = fixture();
  const first = captureCheckpointExport(seedRoot);
  await restoreWorkspaceExport(runtime, first, false);
  expect(await runtime.checkpointDigest()).toBe(first.header.digest);
  writeFileSync(join(workspace, 'README.md'), 'old target');
  const broken = captureCheckpointExport(seedRoot);
  await expect(restoreWorkspaceExport(runtime, { ...broken, header: { ...broken.header, digest: '0'.repeat(64) } }, true)).rejects.toThrow();
  expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('old target');
  expect(readdirSync(join(workspace, '..'))).toEqual(['current']);
  await restoreWorkspaceExport(runtime, captureCheckpointExport(seedRoot), true);
  expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('seed bytes');
  const archived = readdirSync(join(workspace, '..')).find(name => name.startsWith('current.interrupted-'))!;
  expect(readFileSync(join(workspace, '..', archived, 'README.md'), 'utf8')).toBe('old target');
});

it('discards a partial import when the service disconnects, never exposing it as the workspace', async () => {
  const { root, workspace, runtime, service } = fixture();
  const importing = await runtime.importWorkspace({ digest: '0'.repeat(64), rootMode: 0o755 }, false);
  await importing.begin({ path: 'unfinished', kind: 'file', mode: 0o100644, size: 5 });
  await importing.append(0, Buffer.from('ab'));
  await expect(runtime.restart()).rejects.toThrow();
  await service.close();
  expect(existsSync(workspace)).toBe(false);
  expect(readdirSync(join(root, 'client'))).toEqual([]);
});

it('never replays a restoration commit after losing its acknowledgement', async () => {
  const { workspace, seedRoot } = fixture();
  const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: workspace, log: () => undefined }));
  let commits = 0;
  const runtime = remoteWorkspaceRuntime(async command => {
    const result = await handler(command);
    if (command.method === 'import-frame' && command.frame.kind === 'end') {
      commits++;
      throw new Error('acknowledgement lost');
    }
    return result;
  });
  const snapshot = captureCheckpointExport(seedRoot);
  const receiver = await runtime.importWorkspace(snapshot.header, false);
  for await (const frame of snapshot.frames()) {
    if (frame.kind === 'entry') await receiver.begin(frame.entry);
    else await receiver.append(frame.offset, frame.bytes);
  }
  await expect(receiver.finish()).rejects.toThrow('acknowledgement lost');
  await expect(receiver.finish()).rejects.toThrow('closed');
  expect(commits).toBe(1);
  expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('seed bytes');
  await handler.close();
});

it('runs the real runner with a host workspace path that cannot contain files', async () => {
  const { root, workspace, runtime } = fixture();
  const hostPath = join(root, 'unavailable-on-host'); writeFileSync(hostPath, 'host sentinel');
  for (const [key, value] of Object.entries({ ...OLLAMA_PINS, ATOMA_DB_PATH: join(root, 'store.db'),
    ATOMA_BUILD_WORKSPACE: hostPath, ATOMA_RUNS_DIR: join(root, 'runs'), ATOMA_SKILLS_DIR: join(root, 'skills'),
    ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_BUILD_TIMEOUT_MS: '60000' })) vi.stubEnv(key, value);
  resetHostLifecycleSnapshotForTests();
  vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async request => {
    await request.executor!.execute('read_file', { path: 'README.md' });
    await request.executor!.execute('write_file', { path: 'result.txt', content: 'client result' });
    return { text: 'Done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  } } });
  const handle = await startTask(['--baseline', '--no-learn-skills', '--no-direct-skills', 'Write a result'], {
    workspaceRuntime: runtime, createToolBackend: async () => localToolBackend({ workspaceRoot: workspace, logger: silentLogger() }),
  });
  try { await handle.settled; } finally { await handle.shutdown(); }
  expect(readFileSync(hostPath, 'utf8')).toBe('host sentinel');
  expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('client result');
});
