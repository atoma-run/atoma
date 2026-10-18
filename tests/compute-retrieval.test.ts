import { mkdtempSync, realpathSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { closeStoreHandles, openStoreHandle } from '../src/core/stores.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { computeRetrievalService } from '../src/projects/computeRetrievalService.js';
import { openProjectRunComputeRetrieval } from '../src/projects/computeRetrieval.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import type { ComputeRetrievalCommand, ComputeRetrievalReply } from '../src/contracts/computeRetrieval.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'compute-retrieval-'))); });
afterEach(() => { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });

async function fixture(tamper?: (reply: ComputeRetrievalReply) => unknown,
  remoteRuntime?: { config: ReturnType<typeof haystackTestRuntime>; send: (command: ComputeRetrievalCommand) => Promise<ComputeRetrievalReply> }) {
  const f = projectRetrievalFixture(root);
  const source = f.makeRun({ 'pricing.pdf': readFileSync(new URL('./fixtures/retrieval-documents/pricing.pdf', import.meta.url)),
    'broken.pdf': 'not a PDF', 'docs/terms.md': '# Terms\nAnnual price: 190 euros.\n' });
  openStoreHandle(f.dbPath, '').prepare('UPDATE projects SET execution_target_json=? WHERE project_id=?')
    .run(JSON.stringify({ kind: 'customer-device', deviceId: randomUUID() }), f.project.projectId);
  const current = f.makeRun(), launches = ProjectRetrievalLaunchStore.open(f.dbPath);
  const receipt = await launches.prepare(current.run.projectRunId, source.run.projectRunId, retrievalContext());
  const runtime = remoteRuntime?.config ?? haystackTestRuntime(root), remote = join(root, 'remote'); mkdirSync(remote);
  const service = computeRetrievalService({ root: remote, python: runtime.python,
    cachePath: join(remote, 'cache.db'), embeddingPath: '/models/embedding', rerankerPath: '/models/reranker' });
  const calls: unknown[] = [];
  const prepared = openProjectRunComputeRetrieval({ dbPath: f.dbPath, runId: current.run.projectRunId,
    workspacePath: current.layout.workspacePath, runsPath: current.layout.runsPath, skillsPath: current.layout.skillsPath }, runtime,
  async command => { calls.push(command); const reply = await (remoteRuntime ? remoteRuntime.send(command) : service.execute(command)); return tamper ? tamper(reply) : reply; });
  return { ...f, current, launches, receipt, service, prepared, calls };
}

it('extracts remotely, reports unreadable documents, and returns host-validated citations through the production tool', async () => {
  const f = await fixture();
  // Admission archives all selected bytes without attempting host extraction.
  expect(f.receipt.manifest.documents.map(d => d.path)).toContain('broken.pdf');
  const tool = createProjectRetrievalTool(f.prepared.binding, retrievalContext());
  try {
    await f.prepared.prepare(retrievalContext());
    const result = await tool.execute({ query: 'annual price' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.passages.some(p => p.path === 'pricing.pdf' && p.extraction)).toBe(true);
      expect(result.passages.some(p => p.path === 'broken.pdf')).toBe(false);
      expect(result.coverage?.omitted).toBe(1);
      expect(result.generation).toBe(f.receipt.scope.generation);
    }
    expect(JSON.stringify(f.calls)).not.toContain(f.dbPath);
    expect(JSON.stringify(f.calls)).not.toContain(f.receipt.sourceRoot);
    expect(JSON.stringify(f.calls)).not.toContain('haystack-test-runtime');
    f.launches.revoke(f.current.run.projectRunId);
    expect(await tool.execute({ query: 'annual price' })).toMatchObject({ ok: false, status: 'denied' });
  } finally { await tool.close(); await f.service.close(); }
}, 30_000);

it('rejects a well-shaped remote citation to an unauthorized document', async () => {
  const f = await fixture(reply => reply.method === 'search' && reply.value.ok
    ? { ...reply, value: { ...reply.value, passages: reply.value.passages.map(p => ({ ...p, path: 'foreign.md', extraction: undefined })) } } : reply);
  const tool = createProjectRetrievalTool(f.prepared.binding, retrievalContext());
  try {
    await f.prepared.prepare(retrievalContext());
    expect(await tool.execute({ query: 'annual price' })).toMatchObject({ ok: false, status: 'unavailable' });
  } finally { await tool.close(); await f.service.close(); }
}, 30_000);

it('refuses search before preparation and cannot rebind after an invalid command', async () => {
  const runtime = haystackTestRuntime(root);
  const service = computeRetrievalService({ root, python: runtime.python, cachePath: join(root, 'cache.db'), embeddingPath: '/models/embedding', rerankerPath: '/models/reranker' });
  await expect(service.execute({ method: 'prepare' })).rejects.toThrow('unavailable');
  await expect(service.execute({ method: 'prepare' })).rejects.toThrow('unavailable');
  await service.close();
});

it('bounds the disposable client embedding database and isolates project/model namespaces', async () => {
  const { ProjectEmbeddingCache } = await import('../src/projects/retrievalEmbeddingCache.js');
  const path = join(root, 'local-cache.db'), key = 'a'.repeat(64), vector = Buffer.alloc(4096);
  const cache = new ProjectEmbeddingCache(path, 'org', 'project', 'model', { maxDatabaseBytes: 65536 });
  try {
    cache.putMany([{ inputHash: key, vector, dimension: 1024 }]);
    expect(cache.get(key)?.vector).toEqual(vector);
    const other = new ProjectEmbeddingCache(path, 'org', 'other-project', 'model', { maxDatabaseBytes: 65536 });
    try { expect(other.get(key)).toBeNull(); } finally { other.close(); }
    let full = false;
    for (let i = 0; i < 100; i++) {
      try { cache.putMany([{ inputHash: String(i), vector, dimension: 1024 }]); }
      catch { full = true; break; }
    }
    expect(full).toBe(true);
  } finally { cache.close(); }
  const { statSync } = await import('node:fs');
  expect(statSync(path).size).toBeLessThanOrEqual(65536);
});

for (const mode of ['bm25', 'hybrid-rerank'] as const) it.skipIf(!process.env['ATOMA_TEST_RETRIEVAL_IMAGE'] || !process.env['ATOMA_TEST_WORKSPACE_IMAGE'] || !process.env['ATOMA_TEST_WORKER_IMAGE'] ||
  (mode === 'hybrid-rerank' && !process.env['ATOMA_TEST_RETRIEVAL_HYBRID_IMAGE']))(
  `extracts and indexes with ${mode} through the packaged private Docker service with no server Python or product database`, async () => {
    const { execFileSync } = await import('node:child_process');
    const { DesktopCompute } = await import('../src/launcher/desktopCompute.js');
    const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
    const image = (key: string) => docker(['image', 'inspect', '--format', '{{.Id}}', process.env[key]!]);
    const retrievalImage = image(mode === 'hybrid-rerank' ? 'ATOMA_TEST_RETRIEVAL_HYBRID_IMAGE' : 'ATOMA_TEST_RETRIEVAL_IMAGE'), machineId = randomUUID();
    const identity = JSON.parse(docker(['run', '--rm', '--network', 'none', '--entrypoint', '/opt/haystack/bin/python',
      retrievalImage, '-I', '/scripts/retrieval-haystack.py', '--identity'])) as { sha256: string };
    const runtime = new DesktopCompute({ machineId, retrievalImage,
      workspaceImage: image('ATOMA_TEST_WORKSPACE_IMAGE'), workerImage: image('ATOMA_TEST_WORKER_IMAGE') });
    try {
      await runtime.open();
      const settings = mode === 'bm25' ? { mode } : { ...JSON.parse(docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', retrievalImage,
        '-e', "process.stdout.write(require('node:fs').readFileSync('/models/models.json','utf8'))"])) as { mode: 'hybrid-rerank'; embeddingRevision: string; rerankerRevision: string; queryPrefix: string },
        embeddingPath: '/no-host-embedding', rerankerPath: '/no-host-reranker' };
      const f = await fixture(undefined, { config: { python: '/no-host-python', runtimeSha256: identity.sha256, settings },
        send: command => runtime.retrievalCommand(command) });
      const tool = createProjectRetrievalTool(f.prepared.binding, { signal: new AbortController().signal, deadlineAt: Date.now() + 120_000 });
      try {
        await f.prepared.prepare({ signal: new AbortController().signal, deadlineAt: Date.now() + 120_000 });
        const result = await tool.execute({ query: 'annual price' });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.passages.some(p => p.path === 'pricing.pdf')).toBe(true);
        const containers = docker(['ps', '-q', '--filter', `label=dev.atoma.compute=${machineId}`, '--filter', 'label=dev.atoma.compute.kind=retrieval']);
        const inspect = JSON.parse(docker(['inspect', containers])) as { HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean }; Mounts: { Destination: string; Type: string }[] }[];
        expect(inspect[0]?.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true });
        expect(inspect[0]?.Mounts.every(m => m.Type !== 'bind')).toBe(true);
        expect(inspect[0]?.Mounts.map(m => m.Destination)).not.toContain('/workspace');
      } finally { await tool.close(); await f.service.close(); }
    } finally {
      await runtime.close();
      expect(docker(['ps', '-aq', '--filter', `label=dev.atoma.compute=${machineId}`])).toBe('');
      const volumes = docker(['volume', 'ls', '-q', '--filter', `label=dev.atoma.compute=${machineId}`]).split('\n').filter(Boolean);
      if (volumes.length) docker(['volume', 'rm', ...volumes]);
    }
  }, 180_000);
