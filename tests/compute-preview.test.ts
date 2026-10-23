import { ComputePreviewPipe } from '../src/launcher/computePreviewPipe.js';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { copyComputePreview } from '../src/preview/computeCopy.js';
import { computePreviewCommandSchema } from '../src/contracts/computePreview.js';
import { DesktopPreview } from '../src/launcher/desktopPreview.js';
import { DesktopCompute } from '../src/launcher/desktopCompute.js';
import { openComputePreviewStream } from '../src/preview/computeStream.js';
import { artifactManifestHash, buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';

const start = { method: 'start' as const, source: 'in-flight' as const, mode: 'app' as const, copyMaxBytes: 1024 * 1024,
  allowedHosts: [], attribution: true, hardMs: 60_000 };
it.each(['app', 'terminal'] as const)('takes an executable-preserving %s copy and refuses changed delivery bytes', mode => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-preview-')));
  try {
    writeFileSync(join(root, 'index.html'), '<h1>Original</h1>');
    writeFileSync(join(root, '.env'), 'PRIVATE=value');
    writeFileSync(join(root, 'docker-entrypoint.sh'), '#!/bin/sh\nexec node server.js\n');
    chmodSync(join(root, 'docker-entrypoint.sh'), 0o755);
    const expected = artifactManifestHash(buildWorkspaceArtifactManifest({ workspaceRoot: root }).manifest);
    const copy = root + '-copy';
    try {
      expect(copyComputePreview({ ...start, mode, source: 'delivered', artifactHash: expected }, root, copy)).toEqual(
        mode === 'app' ? { kind: 'static', entry: 'index.html' } : { kind: 'node', entry: 'terminal' });
      expect(statSync(join(copy, 'docker-entrypoint.sh')).mode & 0o100).toBe(statSync(join(root, 'docker-entrypoint.sh')).mode & 0o100);
      expect(artifactManifestHash(buildWorkspaceArtifactManifest({ workspaceRoot: copy }).manifest)).toBe(expected);
      expect(() => readFileSync(join(copy, '.env'))).toThrow();
      writeFileSync(join(copy, 'index.html'), 'Edited preview');
      expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<h1>Original</h1>');
    } finally { rmSync(copy, { recursive: true, force: true }); }
    writeFileSync(join(root, 'index.html'), 'Changed delivery');
    try { expect(() => copyComputePreview({ ...start, source: 'delivered', artifactHash: expected }, root, copy)).toThrow('differs'); }
    finally { rmSync(copy, { recursive: true, force: true }); }
    expect(() => computePreviewCommandSchema.parse({ method: 'connect', url: 'http://localhost:22' })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Attica 84ae80d1 (2026-10-23): the device's probe manifest held no HTTP
// observation (a Compute export carries only publishable files), so the copier
// re-classified a delivered Node app as unsupported although the host's
// descriptor named its entry. A verified delivered copy now takes the host's
// classification; the entry must still be a usable file in the copy.
it('describes a verified delivered copy by the host classification, never by a missing device manifest', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-preview-described-')));
  const copy = root + '-copy';
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node control-server.js' } }));
    writeFileSync(join(root, 'control-server.js'), 'require("node:http").createServer().listen(8080)');
    const expected = artifactManifestHash(buildWorkspaceArtifactManifest({ workspaceRoot: root }).manifest);
    const delivered = { ...start, source: 'delivered' as const, artifactHash: expected };
    // Without the classification: the old answer, which refused this app.
    expect(() => copyComputePreview(delivered, root, copy)).toThrow('not runnable');
    rmSync(copy, { recursive: true, force: true });
    expect(copyComputePreview({ ...delivered, classification: { kind: 'node', entry: 'control-server.js' } }, root, copy))
      .toEqual({ kind: 'node', entry: 'control-server.js' });
    rmSync(copy, { recursive: true, force: true });
    // A described entry the copy does not hold, or cannot execute, is refused.
    expect(() => copyComputePreview({ ...delivered, classification: { kind: 'node', entry: 'server.js' } }, root, copy)).toThrow('not runnable');
    rmSync(copy, { recursive: true, force: true });
    expect(() => copyComputePreview({ ...delivered, classification: { kind: 'node', entry: 'package.json' } }, root, copy)).toThrow('not runnable');
    rmSync(copy, { recursive: true, force: true });
    // An in-flight snapshot has no saved delivery to bind the description to.
    expect(() => copyComputePreview({ ...start, classification: { kind: 'node', entry: 'control-server.js' } }, root, copy)).toThrow('not runnable');
    rmSync(copy, { recursive: true, force: true });
    // Changed bytes are refused before any description is read.
    writeFileSync(join(root, 'control-server.js'), 'changed');
    expect(() => copyComputePreview({ ...delivered, classification: { kind: 'node', entry: 'control-server.js' } }, root, copy)).toThrow('differs');
    // A malformed description is refused by the wire schema.
    expect(() => computePreviewCommandSchema.parse({ ...delivered, classification: { kind: 'static', entry: 'index.html' } })).toThrow();
  } finally { rmSync(copy, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

const images = ['ATOMA_TEST_WORKSPACE_IMAGE', 'ATOMA_TEST_WORKER_IMAGE', 'ATOMA_TEST_PREVIEW_IMAGE'];
it.skipIf(images.some(key => !process.env[key])).each(['static', 'node', 'terminal'] as const)('serves a real isolated %s copy through a bounded stream with no incoming port or arbitrary destination', async kind => {
  const exec = promisify(execFile);
  const docker = async (args: string[]) => (await exec('docker', args, { timeout: 30_000 })).stdout.trim();
  const [workspaceImage, workerImage, previewImage] = await Promise.all(images.map(key => docker(['image', 'inspect', '--format', '{{.Id}}', process.env[key]!])));
  const machineId = randomUUID(), allocationId = randomUUID(), identity = { runId: randomUUID(), generation: 1, instanceId: randomUUID() };
  const runtime = new DesktopCompute({ machineId, allocationId, workspaceImage: workspaceImage!, workerImage: workerImage! });
  const preview = new DesktopPreview(identity, { machineId, allocationId, workspaceImage: workspaceImage!, workerImage: workerImage!, previewImage: previewImage! });
  try {
    await runtime.open(); await runtime.command({ method: 'prepare', clean: false });
    await runtime.executor.execute('write_file', { path: 'index.html', content: '<h1>Remote preview</h1>' });
    await runtime.executor.execute('write_file', { path: 'docker-entrypoint.sh', content: '#!/bin/sh\nexit 0\n' });
    await runtime.executor.execute('run_shell', { command: 'chmod +x docker-entrypoint.sh' });
    if (kind === 'node') {
      await runtime.executor.execute('write_file', { path: 'custom.mjs', content: `import { createServer } from 'node:http'; const server=createServer((req,res)=>res.end('Remote Node preview')); server.listen(Number(process.env.PORT ?? 0),'0.0.0.0',()=>console.log('LISTENING_ON_PORT='+server.address().port));` });
      const started = await runtime.executor.execute('start_node_server', { entry: 'custom.mjs' }) as { ok: boolean; url: string };
      expect(started.ok).toBe(true);
      expect(await runtime.executor.execute('fetch_url', { url: started.url, record: true })).toMatchObject({ status: 200 });
      expect(await runtime.command({ method: 'classify-preview' })).toMatchObject({ value: { kind: 'node', entry: 'custom.mjs' } });
    }
    const artifacts = await runtime.command({ method: 'artifact-open', options: { allowEmpty: false } });
    if (artifacts.method !== 'artifact-open') throw new Error('Expected real delivery manifest');
    expect(artifacts.value.manifest.files.find(file => file.path === 'docker-entrypoint.sh')?.mode).toBe('100755');
    const artifactHash = artifactManifestHash(artifacts.value.manifest);
    await runtime.command({ method: 'checkpoint-close', handle: artifacts.value.handle });
    expect(await preview.execute(identity, { ...start, source: 'delivered', artifactHash, mode: kind === 'terminal' ? 'terminal' : 'app' })).toMatchObject({ method: 'start', value: { kind: kind === 'static' ? 'static' : 'node' } });
    await expect(preview.execute({ ...identity, generation: 2 }, { method: 'connect' })).rejects.toThrow('generation');
    const socket = await openComputePreviewStream(command => preview.execute(identity, command));
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const upstream = request({ path: '/', createConnection: () => socket }, res => {
          let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += String(chunk); }); res.on('end', () => resolve(body));
        }); upstream.once('error', reject); upstream.end();
      });
      if (kind === 'terminal') expect(result).toContain('terminal');
      else expect(result).toBe(kind === 'node' ? 'Remote Node preview' : '<h1>Remote preview</h1>');
    } finally { socket.destroy(); }
    const name = `atoma-compute-preview-${identity.instanceId}`;
    expect(await docker(['port', name])).toBe('');
    const settings = JSON.parse(await docker(['inspect', name])) as { HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; LogConfig: { Config: Record<string, string> } }; Mounts: { Type: string; Destination: string }[] }[];
    expect(settings[0]?.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true });
    expect(settings[0]?.HostConfig.LogConfig.Config['compress']).toBe('false');
    expect(settings[0]?.Mounts.every(m => m.Type !== 'bind')).toBe(true);
    await preview.close();
    await expect(preview.execute(identity, { method: 'connect' })).rejects.toThrow('unavailable');
    expect(JSON.stringify(await runtime.executor.execute('read_file', { path: 'index.html' }))).toContain('Remote preview');
  } finally {
    await preview.close(); await runtime.close(); await DesktopCompute.reconcile(machineId, workerImage);
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=dev.atoma.compute=${machineId}`])).split('\n').filter(Boolean);
    if (volumes.length) await docker(['volume', 'rm', ...volumes]);
  }
}, 90_000);

it('reclaims an abandoned relay slot on idle expiry and wakes a pending read', async () => {
  vi.useFakeTimers();
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const released = vi.fn();
  const pipe = new ComputePreviewPipe(child, released);
  try {
    const reading = pipe.read();
    await vi.advanceTimersByTimeAsync(120_001);
    expect(await reading).toBeNull();
    expect(released).toHaveBeenCalledTimes(1);
    pipe.close();
    expect(released).toHaveBeenCalledTimes(1);
    await expect(pipe.write(Buffer.from('later').toString('base64'))).rejects.toThrow('unavailable');
  } finally { pipe.close(); vi.useRealTimers(); }
});
