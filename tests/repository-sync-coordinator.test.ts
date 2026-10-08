import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubAppClient } from '../src/github/client.js';
import { GitHubStore } from '../src/github/store.js';
import { GitHubPublisher } from '../src/projects/publisher.js';
import { ProjectRunCoordinator, type ProjectRunDriver } from '../src/projects/coordinator.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../src/run/runner.js';
import { HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { FakeGitHub } from './github-api-fake.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); closeStoreHandles(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atoma-sync-')); roots.push(root);
  const f = projectRetrievalFixture(root);
  const fake = new FakeGitHub();
  const client = new GitHubAppClient({ appId: '123', appSlug: 'test',
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, apiBaseUrl: 'https://api.github.test' },
  { fetch: fake.fetch, now: () => Date.UTC(2026, 7, 23, 12) });
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '123', orgId: f.viewer.orgId, accountId: '701', accountLogin: 'owner',
    targetType: 'Organization', repositorySelection: 'all', permissions: { administration: 'write', contents: 'write' }, connectedByPrincipalId: f.viewer.principalId });
  const publisher = new GitHubPublisher({ client, github, store: f.projects, resolveUserAccessToken: async () => 'user-token' });
  let edit: (workspace: string) => void = () => {};
  const driver = vi.fn<ProjectRunDriver>(async options => {
    const workspace = options.env!['ATOMA_BUILD_WORKSPACE']!;
    const idx = options.extraArgs!.indexOf('--seed');
    if (idx >= 0) cpSync(options.extraArgs![idx + 1]!, workspace, { recursive: true });
    else mkdirSync(workspace, { recursive: true });
    edit(workspace);
    const id = options.env!['ATOMA_RUN_ID']!;
    const manifest = options.env![ARTIFACT_MANIFEST_PATH_ENV]!;
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: 1, runId: id, generatedAt: new Date().toISOString(), outputs: ['app.js'] }));
    const traces = options.env!['ATOMA_RUNS_DIR']!;
    mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${id}.json`), JSON.stringify({ id, endedAt: new Date().toISOString(), result: { summary: 'Verified' } }));
    return '✓ build finished';
  });
  const release = vi.fn();
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root,
    hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)), ATOMA_MODEL_L1: 'api:ollama:qwen3:8b',
      ATOMA_MODEL_L2: 'api:ollama:qwen3:8b', ATOMA_MODEL_L3: 'api:ollama:qwen3:8b', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
    publisher, driver, acquireLease: async () => ({ path: 'test', attachChild: vi.fn(), release }) });
  const start = async (change: typeof edit, baseRunId?: string) => {
    edit = change;
    const run = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { idempotencyKey: randomUUID(), goal: 'Improve the application.', ...(baseRunId ? { baseRunId } : {}) } });
    await coordinator.waitForIdle();
    const finished = f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)!;
    expect(finished.status, finished.error ?? '').toBe('delivered');
    f.projects.acceptDelivery(f.viewer.orgId, run.projectRunId, f.viewer.principalId, { manifestHash: finished.artifactManifestHash!, review: 'Client tested synced delivery.' });
    // Failure cases below assert the persisted publication error.
    await coordinator.retryPublication(f.viewer.orgId, run.projectRunId).catch(() => {});
    return finished;
  };
  return { ...f, client, fake, publisher, coordinator, start, release, setEdit: (change: typeof edit) => { edit = change; } };
}
it('syncs remote edits and additions before model work and protects concurrent edits at publication', async () => {
  const f = fixture();
  const first = await f.start(w => writeFileSync(join(w, 'app.js'), 'initial'));
  expect(f.projects.getPublicationForRun(f.viewer.orgId, first.projectRunId)?.status).toBe('published');
  f.fake.commitOutside('owner', 'docs', 'main', 'app.js', 'client');
  f.fake.commitOutside('owner', 'docs', 'main', 'notes.md', 'notes');
  const second = await f.start(w => {
    expect(readFileSync(join(w, 'app.js'), 'utf8')).toBe('client');
    expect(readFileSync(join(w, 'notes.md'), 'utf8')).toBe('notes');
    writeFileSync(join(w, 'app.js'), 'Atoma builds on client');
    writeFileSync(join(w, 'new.txt'), 'new');
    f.fake.commitOutside('owner', 'docs', 'main', 'app.js', 'concurrent');
  });
  expect(second.status).toBe('delivered');
  expect(f.projects.getPublicationForRun(f.viewer.orgId, second.projectRunId)?.status).toBe('published');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('app.js')?.text).toBe('concurrent');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('new.txt')?.text).toBe('new');
  expect(readFileSync(join(first.hostPaths.workspacePath, 'app.js'), 'utf8')).toBe('initial');
  const third = await f.start(w => {
    expect(readFileSync(join(w, 'app.js'), 'utf8')).toBe('concurrent');
    writeFileSync(join(w, 'app.js'), 'new work');
  });
  expect(third.status).toBe('delivered');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('app.js')?.text).toBe('new work');
});
it('carries failed publication work forward and refuses an older retry under the lease', async () => {
  const f = fixture();
  const first = await f.start(w => writeFileSync(join(w, 'app.js'), 'initial'));
  const publish = vi.spyOn(f.client, 'publishManifestCommit').mockRejectedValueOnce(new Error('offline'));
  const pending = await f.start(w => writeFileSync(join(w, 'app.js'), 'pending'));
  expect(f.projects.getPublicationForRun(f.viewer.orgId, pending.projectRunId)?.status).toBe('failed');
  publish.mockRestore();
  const next = await f.start(w => expect(readFileSync(join(w, 'app.js'), 'utf8')).toBe('pending'));
  expect(next.status).toBe('delivered');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('app.js')?.text).toBe('pending');
  const count = f.release.mock.calls.length;
  await expect(f.coordinator.retryPublication(f.viewer.orgId, pending.projectRunId)).rejects.toThrow(/later lineage|created before/);
  expect(f.release.mock.calls.length).toBe(count + 1);
  expect(existsSync(dirname(first.hostPaths.workspacePath))).toBe(true);
});

it('synchronises a large remote addition, preserves the previous seed, and publishes one changed file', async () => {
  const f = fixture();
  const first = await f.start(w => writeFileSync(join(w, 'app.js'), 'initial'));
  await f.client.publishManifestCommit({ token: 'installation-token', repository: { owner: 'owner', name: 'docs' },
    expectedHead: f.fake.refSha('owner', 'docs', 'main'), message: 'Remote large addition',
    files: Array.from({ length: 1200 }, (_, i) => ({ path: `src/file-${i}.js`, content: `export default ${i};` })) });
  const before = f.fake.calls.length;
  const next = await f.start(w => {
    expect(readFileSync(join(w, 'src/file-1199.js'), 'utf8')).toBe('export default 1199;');
    writeFileSync(join(w, 'app.js'), 'changed');
  });
  expect(f.projects.getRepositorySync(f.viewer.orgId, next.projectRunId)).toMatchObject({ status: 'synced', taken: 1200 });
  expect(next.artifactManifest?.files).toHaveLength(1201);
  expect(f.projects.getPublicationForRun(f.viewer.orgId, next.projectRunId)?.status).toBe('published');
  expect(f.fake.calls.slice(before).filter(c => c.startsWith('POST') && c.endsWith('/git/blobs'))).toHaveLength(1);
  expect(existsSync(join(first.hostPaths.workspacePath, 'src'))).toBe(false);
}, 30_000);
it('fails open on an unavailable sync and still protects remote edits', async () => {
  const f = fixture();
  await f.start(w => writeFileSync(join(w, 'app.js'), 'initial'));
  f.fake.commitOutside('owner', 'docs', 'main', 'app.js', 'client');
  vi.spyOn(f.client, 'readRepositoryTree').mockRejectedValueOnce(new Error('offline'));
  const next = await f.start(w => {
    expect(readFileSync(join(w, 'app.js'), 'utf8')).toBe('initial');
    writeFileSync(join(w, 'app.js'), 'stale work');
  });
  expect(next.status).toBe('delivered');
  expect(f.projects.getRepositorySync(f.viewer.orgId, next.projectRunId)?.status).toBe('unavailable');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('app.js')?.text).toBe('client');
});

it('retains the empty starting base until a first publication succeeds', async () => {
  const f = fixture();
  const publish = vi.spyOn(f.client, 'publishManifestCommit').mockRejectedValue(new Error('offline'));
  await f.start(w => writeFileSync(join(w, 'app.js'), 'unpublished'));
  const second = await f.start(() => {});
  expect(f.projects.getRepositorySync(f.viewer.orgId, second.projectRunId)?.base).toEqual({});
  publish.mockRestore();
  await f.start(() => {});
  expect(f.fake.filesOn('owner', 'docs', 'main').get('app.js')?.text).toBe('unpublished');
});

it('keeps the client deletion and preserves the unpublished version in its previous workspace', async () => {
  const f = fixture();
  await f.start(w => { writeFileSync(join(w, 'app.js'), 'initial'); writeFileSync(join(w, 'keep.txt'), 'keep'); });
  const publish = vi.spyOn(f.client, 'publishManifestCommit').mockRejectedValueOnce(new Error('offline'));
  const pending = await f.start(w => writeFileSync(join(w, 'app.js'), 'pending'));
  publish.mockRestore();
  f.fake.commitOutside('owner', 'docs', 'main', 'app.js', null);
  await f.start(w => expect(existsSync(join(w, 'app.js'))).toBe(false));
  expect(f.fake.filesOn('owner', 'docs', 'main').has('app.js')).toBe(false);
  expect(readFileSync(join(pending.hostPaths.workspacePath, 'app.js'), 'utf8')).toBe('pending');
});
it('reruns a materialised start, including a rerun of a rerun, without reading GitHub again', async () => {
  const f = fixture();
  await f.start(w => writeFileSync(join(w, 'app.js'), 'initial'));
  f.fake.commitOutside('owner', 'docs', 'main', 'app.js', 'client');
  const origin = await f.start(w => writeFileSync(join(w, 'app.js'), 'delivered'));
  f.fake.commitOutside('owner', 'docs', 'main', 'app.js', 'later');
  const sync = vi.spyOn(f.publisher, 'syncRun');
  f.setEdit(w => expect(readFileSync(join(w, 'app.js'), 'utf8')).toBe('client'));
  const rerun = async (id: string) => {
    const run = await f.coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: f.project.projectId,
      request: { idempotencyKey: randomUUID(), rerunOf: id,
        models: { l1: 'api:ollama:qwen3:8b', l2: 'api:ollama:qwen3:8b', l3: 'api:ollama:qwen3:8b' } } });
    await f.coordinator.waitForIdle();
    expect(f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)?.status).toBe('delivered');
    expect(f.projects.getRepositorySync(f.viewer.orgId, run.projectRunId)?.seedPath)
      .toBe(f.projects.getRepositorySync(f.viewer.orgId, origin.projectRunId)?.seedPath);
    return run.projectRunId;
  };
  await rerun(await rerun(origin.projectRunId));
  expect(sync).not.toHaveBeenCalled();
});


it('starts from the selected saved bytes while publication preserves newer remote edits', async () => {
  const f = fixture();
  const first = await f.start(w => writeFileSync(join(w, 'app.js'), 'reviewed'));
  f.fake.commitOutside('owner', 'docs', 'main', 'app.js', 'remote edit');
  const second = await f.start(w => {
    expect(readFileSync(join(w, 'app.js'), 'utf8')).toBe('reviewed');
    writeFileSync(join(w, 'app.js'), 'Atoma iteration');
    writeFileSync(join(w, 'iteration.txt'), 'new work');
  }, first.projectRunId);
  expect(second.seed).toEqual({ kind: 'run', runId: first.projectRunId });
  expect(second.baseRunId).toBe(first.projectRunId);
  expect(f.projects.getPublicationForRun(f.viewer.orgId, second.projectRunId)?.status).toBe('published');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('app.js')?.text).toBe('remote edit');
  expect(f.fake.filesOn('owner', 'docs', 'main').get('iteration.txt')?.text).toBe('new work');
  expect(readFileSync(join(first.hostPaths.workspacePath, 'app.js'), 'utf8')).toBe('reviewed');
});
