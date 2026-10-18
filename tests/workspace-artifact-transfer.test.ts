import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceProcess } from '../src/run/workspaceProcess.js';
import { captureCheckpointExport } from '../src/run/checkpointExport.js';
import { provisionWorkspaceSource } from '../src/run/workspaceImport.js';
import { receiveArtifactExport, captureArtifactExport } from '../src/run/artifactTransfer.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { readRunCopyPath } from '../src/contracts/readRuns.js';
import { workspaceCommandSchema } from '../src/contracts/workspaceProtocol.js';

const roots: string[] = [];
const services: ReturnType<typeof startWorkspaceProcess>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-artifact-transfer-'))); roots.push(root);
  const source = join(root, 'server-source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), 'source bytes');
  const workspace = join(root, 'device', 'current');
  const seedRoot = join(root, 'device-control', 'seed');
  return { root, source, workspace, seedRoot };
}
function service(options: Parameters<typeof startWorkspaceProcess>[0]) {
  const opened = startWorkspaceProcess({ ...options, onLog: () => undefined }); services.push(opened); return opened;
}

it('provisions a bound seed through RPC, then prepares and deepens after the server source is gone', async () => {
  const { root, source, workspace, seedRoot } = fixture();
  const { runtime } = service({ root: workspace, seedRoot });
  await provisionWorkspaceSource(runtime, { kind: 'seed' }, captureCheckpointExport(source));
  rmSync(source, { recursive: true });
  await runtime.prepare(false);
  writeFileSync(join(workspace, 'README.md'), 'attempt');
  await runtime.restart();
  expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('source bytes');
  expect(readFileSync(join(`${workspace}.prev1`, 'README.md'), 'utf8')).toBe('attempt');
  await expect(runtime.importSource({ kind: 'seed' }, { digest: '0'.repeat(64), rootMode: 0o755 })).rejects.toThrow('frozen');
  expect(existsSync(join(root, 'server-source'))).toBe(false);
});

it('accepts only launcher-bound reference ids and compares identities on the destination filesystem', async () => {
  const { root, source, workspace } = fixture();
  const bound = join(root, 'control', 'reference');
  const runId = randomUUID();
  const built = buildWorkspaceArtifactManifest({ workspaceRoot: source });
  const indexPath = join(root, 'index.json');
  writeFileSync(indexPath, JSON.stringify({ version: 1, orgId: randomUUID(), projectId: randomUUID(), runId: randomUUID(),
    readRuns: [{ runId, status: 'delivered', endedAt: new Date().toISOString(), workspacePath: bound,
      manifestHash: built.hash, manifest: built.manifest }] }));
  const { runtime } = service({ root: workspace, readRunsIndex: indexPath });
  await expect(provisionWorkspaceSource(runtime, { kind: 'read-run', runId: randomUUID() }, captureCheckpointExport(source)))
    .rejects.toThrow('not authorized');
  await provisionWorkspaceSource(runtime, { kind: 'read-run', runId }, captureCheckpointExport(source));
  await expect(provisionWorkspaceSource(runtime, { kind: 'read-run', runId }, captureCheckpointExport(source)))
    .rejects.toThrow('already exists');
  rmSync(source, { recursive: true });
  await runtime.prepare(false); await runtime.captureReadRuns();
  expect(readFileSync(join(workspace, readRunCopyPath(runId), 'README.md'), 'utf8')).toBe('source bytes');
  expect(await runtime.checkReadRuns()).toMatchObject([{ runId, changedCount: 0, touchedCount: 0, missingCount: 0 }]);
});

it('never accepts a caller-selected source path on the wire', () => {
  expect(workspaceCommandSchema.safeParse({ method: 'import-open', archive: false,
    source: { kind: 'seed', path: '/etc' }, header: { digest: '0'.repeat(64), rootMode: 0o755 } }).success).toBe(false);
});

it('cleans an interrupted source import without publishing the bound seed', async () => {
  const { root, workspace, seedRoot } = fixture();
  const opened = service({ root: workspace, seedRoot });
  const receiver = await opened.runtime.importSource({ kind: 'seed' }, { digest: '0'.repeat(64), rootMode: 0o755 });
  await receiver.begin({ path: 'unfinished', kind: 'file', mode: 0o100644, size: 100 });
  await receiver.append(0, Buffer.from('partial'));
  await opened.close();
  expect(existsSync(seedRoot)).toBe(false);
  expect(readdirSync(join(root, 'device-control'))).toEqual([]);
});

it.each(['../outside', '.env', './README.md'])('refuses the unsafe artifact manifest path %s before receiving bytes', async path => {
  const { root, source } = fixture();
  const manifest = buildWorkspaceArtifactManifest({ workspaceRoot: source }).manifest;
  manifest.files[0]!.path = path;
  await expect(receiveArtifactExport({ ...captureCheckpointExport(source), manifest }, join(root, 'delivery'))).rejects.toThrow();
  expect(existsSync(join(root, 'delivery'))).toBe(false);
  expect(readdirSync(root).filter(name => name.startsWith('.artifact-transfer-'))).toEqual([]);
});

it('exports only publishable files and keeps private captured bytes stable after the workspace changes', async () => {
  const { root, source } = fixture();
  writeFileSync(join(source, '.env'), 'private');
  mkdirSync(join(source, 'node_modules')); writeFileSync(join(source, 'node_modules', 'dependency'), 'dependency');
  mkdirSync(join(source, 'bin')); writeFileSync(join(source, 'bin', 'start'), 'executable', { mode: 0o755 });
  const { runtime } = service({ root: source });
  const exported = await runtime.artifactExport({ allowEmpty: false });
  writeFileSync(join(source, 'README.md'), 'later bytes');
  const target = join(root, 'atoma-delivery');
  const manifest = await receiveArtifactExport({ ...exported, header: { ...exported.header, rootMode: 0o777 } }, target);
  expect(statSync(target).mode & 0o777).toBe(0o700);
  expect(manifest.files.map(file => file.path)).toEqual(['bin/start', 'README.md']);
  expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('source bytes');
  expect(statSync(join(target, 'bin', 'start')).mode & 0o777).toBe(0o755);
  expect(readdirSync(target).sort()).toEqual(['README.md', 'bin'].sort());
});

it.each(['false-hash', 'extra-file', 'interrupted'])('refuses %s without exposing a final artifact directory', async kind => {
  const { root, source } = fixture();
  const target = join(root, 'delivery');
  const manifest = buildWorkspaceArtifactManifest({ workspaceRoot: source }).manifest;
  if (kind === 'extra-file') writeFileSync(join(source, 'unlisted'), 'not in the manifest');
  if (kind === 'false-hash') manifest.files[0]!.sha256 = '0'.repeat(64);
  const captured = captureCheckpointExport(source);
  const exported = { ...captured, manifest, async *frames() {
    for await (const frame of captured.frames()) {
      if (kind === 'interrupted' && frame.kind === 'chunk') throw new Error('Connection lost');
      yield frame;
    }
  } };
  await expect(receiveArtifactExport(exported, target)).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(root).filter(name => name.startsWith('.artifact-transfer-'))).toEqual([]);
});

it('transfers an empty text delivery and refuses an empty ordinary delivery', async () => {
  const { root, source } = fixture(); rmSync(join(source, 'README.md'));
  expect(() => captureArtifactExport(source, { allowEmpty: false })).toThrow();
  const manifest = await receiveArtifactExport(captureArtifactExport(source, { allowEmpty: false, delivery: 'text' }), join(root, 'text'));
  expect(manifest).toMatchObject({ delivery: 'text', files: [], totalBytes: 0 });
});
