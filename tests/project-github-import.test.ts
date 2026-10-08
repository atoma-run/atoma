import { zipSync } from 'fflate';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubAppClient, GitHubApiError } from '../src/github/client.js';
import { GitHubStore } from '../src/github/store.js';
import { GitHubPublisher } from '../src/projects/publisher.js';
import { ProjectRunCoordinator, type ProjectRunDriver } from '../src/projects/coordinator.js';
import { ProjectService } from '../src/projects/service.js';
import { parseGitHubRepository, type Project } from '../src/contracts/projects.js';
import { HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { ARTIFACT_MANIFEST_PATH_ENV } from '../src/run/runner.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { FakeGitHub } from './github-api-fake.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); closeStoreHandles(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

async function fixture(mode: 'pull-request' | 'fork', transform?: (fake: FakeGitHub) => typeof fetch, apiBaseUrl = 'https://api.github.test') {
  const root = mkdtempSync(join(tmpdir(), 'atoma-import-')); roots.push(root);
  const f = projectRetrievalFixture(root);
  const fake = new FakeGitHub({ existing: ['upstream/app'] });
  fake.commitOutside('upstream', 'app', 'main', 'index.html', '<h1>Original</h1>');
  fake.commitOutside('upstream', 'app', 'main', 'keep.txt', 'Unchanged');
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '501', orgId: f.viewer.orgId, accountId: '701',
    accountLogin: mode === 'fork' ? 'alice' : 'upstream', targetType: 'User', repositorySelection: 'all',
    permissions: { administration: 'write', contents: 'write', pull_requests: 'write' }, connectedByPrincipalId: f.viewer.principalId });
  const client = new GitHubAppClient({ appId: '123', appSlug: 'test',
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, apiBaseUrl },
  { fetch: transform?.(fake) ?? fake.fetch, now: () => Date.UTC(2026, 7, 23, 12) });
  const publisher = new GitHubPublisher({ client, github, store: f.projects, resolveUserAccessToken: async () => 'user-token' });
  const seeds: string[] = [];
  let nextContent = '<h1>Changed</h1>';
  const driver = vi.fn<ProjectRunDriver>(async options => {
    const seedIndex = options.extraArgs!.indexOf('--seed');
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    const seed = options.extraArgs![seedIndex + 1]!;
    seeds.push(readFileSync(join(seed, 'index.html'), 'utf8'));
    const env = options.env!;
    expect(Object.values(env)).not.toContain('user-token');
    const workspace = env['ATOMA_BUILD_WORKSPACE']!;
    cpSync(seed, workspace, { recursive: true });
    writeFileSync(join(workspace, 'index.html'), nextContent);
    const manifest = env[ARTIFACT_MANIFEST_PATH_ENV]!;
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: 1, runId: env['ATOMA_RUN_ID'], generatedAt: new Date().toISOString(), outputs: ['index.html'] }));
    const traces = env['ATOMA_RUNS_DIR']!; mkdirSync(traces, { recursive: true });
    writeFileSync(join(traces, `${env['ATOMA_RUN_ID']}.json`), JSON.stringify({ id: env['ATOMA_RUN_ID'], endedAt: new Date().toISOString(), result: { summary: 'Verified' } }));
    return '✓ build finished';
  });
  const runTitler = vi.fn(async () => null);
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root, runTitler,
    hostEnv: { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(haystackTestRuntime(root)), ATOMA_MODEL_L1: 'api:ollama:test',
      ATOMA_MODEL_L2: 'api:ollama:test', ATOMA_MODEL_L3: 'api:ollama:test', OLLAMA_BASE_URL: 'http://127.0.0.1:1' },
    publisher, driver, acquireLease: async () => ({ path: 'test', attachChild: vi.fn(), release: vi.fn() }) });
  const service = new ProjectService({ store: f.projects, github, coordinator, publisher });
  const created = await service.createProjectFromInput(f.viewer, { name: 'Imported', slug: 'imported', repositoryTarget: {
    installationId: '501', owner: mode === 'fork' ? 'alice' : 'upstream', name: 'app',
    source: { owner: 'upstream', name: 'app', mode },
  } }) as { projectId: string };
  const project = f.projects.getProject(f.viewer.orgId, created.projectId)!;
  const start = async (content = '<h1>Changed</h1>', baseRunId?: string) => {
    nextContent = content;
    const run = await coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId, projectId: project.projectId,
      request: { idempotencyKey: randomUUID(), goal: 'Change the heading.', ...(baseRunId ? { baseRunId } : {}) } });
    await coordinator.waitForIdle();
    const delivered = f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)!;
    if (delivered.status === 'delivered') {
      // This publication fixture represents a client who reviewed the result.
      await service.acceptDelivery(f.viewer, project.projectId, run.projectRunId, {
        manifestHash: delivered.artifactManifestHash, review: 'Client tested imported delivery.' }).catch(() => {});
    }
    return f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)!;
  };
  return { ...f, project, fake, client, publisher, service, coordinator, driver, runTitler, start, seeds };
}

describe('existing GitHub projects through service, coordinator and publication', () => {
  it.each(['fork', 'pull-request'] as const)('checks live installation access before model work in %s mode and recovers after approval', async mode => {
    const f = await fixture(mode);
    if (mode === 'fork') await f.client.createFork({ token: 'user-token', owner: 'upstream', name: 'app', targetName: 'app' });
    // The stored installation still says all; GitHub's fresh token says selected.
    f.fake.repositorySelection = 'selected';
    const snapshot = vi.spyOn(f.client, 'readRepositoryFiles');
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain(`does not include ${mode === 'fork' ? 'alice' : 'upstream'}/app`);
    expect(run.error).toContain('https://github.com/settings/installations/501, then retry the run');
    expect(f.driver).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)).toBeNull();
    f.fake.selectedRepositories.add(`${mode === 'fork' ? 'alice' : 'upstream'}/app`);
    const retried = await f.start();
    expect(retried.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, retried.projectRunId)?.status).toBe('published');
    expect(f.driver).toHaveBeenCalledOnce();
    expect(f.fake.calls.filter(call => call.endsWith('/forks'))).toHaveLength(mode === 'fork' ? 1 : 0);
  });

  it('checks the refreshed token after creating a fork before spending model quota', async () => {
    const f = await fixture('fork', fake => async (url, init) => {
      const response = await fake.fetch(url, init);
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (target.endsWith('/forks')) fake.repositorySelection = 'selected';
      return response;
    });
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('does not include alice/app');
    expect(f.driver).not.toHaveBeenCalled();
    f.fake.selectedRepositories.add('alice/app');
    expect((await f.start()).status).toBe('delivered');
    expect(f.fake.calls.filter(call => call.endsWith('/forks'))).toHaveLength(1);
  });

  it('resumes the saved request and criteria once, even after a new service instance or repeated clicks', async () => {
    const f = await fixture('pull-request');
    f.fake.repositorySelection = 'selected';
    const requested = await f.coordinator.start({ orgId: f.viewer.orgId, principalId: f.viewer.principalId,
      projectId: f.project.projectId, request: { goal: 'Keep my original request.', depth: 'short', idempotencyKey: randomUUID(),
        acceptanceChecklist: [{ behaviour: 'The heading changes.', check: { kind: 'review' } }] } });
    await f.coordinator.waitForIdle();
    const run = f.projects.getProjectRun(f.viewer.orgId, requested.projectRunId)!;
    expect(run.githubAccess).toMatchObject({ phase: 'run', fullName: 'upstream/app' });
    expect(f.runTitler).not.toHaveBeenCalled();
    expect(f.projects.listUntitledEndedRuns()).toEqual([]);
    const service = new ProjectService({ store: f.projects, github: GitHubStore.open(f.dbPath), coordinator: f.coordinator, publisher: f.publisher });
    await expect(service.continueGitHubAccess(f.viewer, f.project.projectId, run.projectRunId)).rejects.toMatchObject({ status: 409 });
    expect(f.driver).not.toHaveBeenCalled();
    expect(f.projects.listProjectRuns(f.viewer.orgId, f.project.projectId)).toHaveLength(1);
    await expect(service.continueGitHubAccess({ ...f.viewer, role: 'org:viewer' }, f.project.projectId, run.projectRunId)).rejects.toMatchObject({ status: 403 });
    await expect(service.continueGitHubAccess({ ...f.viewer, principalId: randomUUID() }, f.project.projectId, run.projectRunId)).rejects.toMatchObject({ status: 403 });
    await expect(service.continueGitHubAccess({ ...f.viewer, orgId: randomUUID() }, f.project.projectId, run.projectRunId)).rejects.toMatchObject({ status: 404 });
    await expect(service.continueGitHubAccess(f.viewer, randomUUID(), run.projectRunId)).rejects.toMatchObject({ status: 404 });
    f.fake.selectedRepositories.add('upstream/app');
    const [first, simultaneous] = await Promise.all([
      service.continueGitHubAccess(f.viewer, f.project.projectId, run.projectRunId),
      service.continueGitHubAccess(f.viewer, f.project.projectId, run.projectRunId),
    ]) as { projectRunId: string }[];
    expect(simultaneous!.projectRunId).toBe(first!.projectRunId);
    await f.coordinator.waitForIdle();
    const again = await service.continueGitHubAccess(f.viewer, f.project.projectId, run.projectRunId) as { projectRunId: string };
    expect(again.projectRunId).toBe(first!.projectRunId);
    expect(f.driver).toHaveBeenCalledOnce();
    expect(f.projects.getProjectRun(f.viewer.orgId, first!.projectRunId)).toMatchObject({ goal: run.goal, depth: 'short' });
    expect(f.projects.getRunAcceptanceSpec(f.viewer.orgId, first!.projectRunId)).toEqual(f.projects.getRunAcceptanceSpec(f.viewer.orgId, run.projectRunId));
    expect(f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)?.githubAccess?.resumedRunId).toBe(first!.projectRunId);
  });

  it('preserves a delivered result and retries only publication after access is removed mid-run', async () => {
    const f = await fixture('pull-request');
    const driver = f.driver.getMockImplementation()!;
    f.driver.mockImplementationOnce(async options => {
      const result = await driver(options);
      f.fake.repositorySelection = 'selected';
      return result;
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(run.githubAccess).toMatchObject({ phase: 'publication' });
    f.fake.selectedRepositories.add('upstream/app');
    await f.service.continueGitHubAccess(f.viewer, f.project.projectId, run.projectRunId);
    expect(f.driver).toHaveBeenCalledOnce();
    expect(f.projects.getProjectRun(f.viewer.orgId, run.projectRunId)?.githubAccess).toBeUndefined();
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
  });

  it('does not interpret an installation repository lookup failure as access', async () => {
    const f = await fixture('pull-request');
    f.fake.repositorySelection = 'selected';
    vi.spyOn(f.client, 'installationIncludesRepository').mockRejectedValue(new Error('GitHub unavailable'));
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('GitHub unavailable');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it.each([409, 422, 503])('continues from the fork when optional upstream sync refuses with %s', async status => {
    const f = await fixture('fork');
    expect(f.project.followUpstream).toBe(false);
    const merge = vi.spyOn(f.client, 'mergeUpstream').mockRejectedValue(new GitHubApiError({ status, method: 'POST', path: '/merge-upstream', code: 'http' }));
    f.projects.setFollowUpstream(f.viewer.orgId, f.project.projectId, true);
    expect((await f.start()).status).toBe('delivered');
    expect(merge).not.toHaveBeenCalled(); // Creating the fork already captures upstream.
    expect((await f.start('<h1>Next</h1>')).status).toBe('delivered');
    expect(merge).toHaveBeenCalledOnce();
    expect(f.seeds[1]).toBe('<h1>Changed</h1>');
  });

  it('uses an explicit source selection to omit workflows and oversized evidence before model work', async () => {
    const f = await fixture('pull-request');
    f.fake.commitOutside('upstream', 'app', 'main', '.atoma-import.json', JSON.stringify({
      version: 1, excludePrefixes: ['.github/workflows/', 'benchmark/'],
    }));
    f.fake.commitOutside('upstream', 'app', 'main', '.github/workflows/ci.yml', 'name: CI');
    f.fake.commitOutside('upstream', 'app', 'main', 'benchmark/evidence.tar.gz', 'x'.repeat(11 * 1024 * 1024));
    const driver = f.driver.getMockImplementation()!;
    f.driver.mockImplementationOnce(async options => {
      const seed = options.extraArgs![options.extraArgs!.indexOf('--seed') + 1]!;
      expect(existsSync(join(seed, '.atoma-import.json'))).toBe(false);
      expect(existsSync(join(seed, '.github/workflows/ci.yml'))).toBe(false);
      expect(existsSync(join(seed, 'benchmark/evidence.tar.gz'))).toBe(false);
      expect(readFileSync(join(seed, 'index.html'), 'utf8')).toBe('<h1>Original</h1>');
      return driver(options);
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.fake.filesOn('upstream', 'app', 'main').get('.github/workflows/ci.yml')?.text).toBe('name: CI');
  });

  it('refuses workflow import without an explicit selection', async () => {
    const f = await fixture('pull-request');
    f.fake.commitOutside('upstream', 'app', 'main', '.github/workflows/ci.yml', 'name: CI');
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('workflow files');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it('refuses unsafe import selection prefixes before model work', async () => {
    const f = await fixture('pull-request');
    f.fake.commitOutside('upstream', 'app', 'main', '.atoma-import.json', JSON.stringify({
      version: 1, excludePrefixes: ['../'],
    }));
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('invalid value');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it('still refuses an excluded symbolic link before model work', async () => {
    const f = await fixture('pull-request', fake => async (url, init) => {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const response = await fake.fetch(url, init);
      if (!target.includes('?recursive=1')) return response;
      const tree = await response.json() as { truncated: boolean; tree: unknown[] };
      tree.tree.push({ path: 'benchmark/linked', type: 'blob', mode: '120000', sha: 'a'.repeat(40) });
      return new Response(JSON.stringify(tree), { status: 200 });
    });
    f.fake.commitOutside('upstream', 'app', 'main', '.atoma-import.json', JSON.stringify({
      version: 1, excludePrefixes: ['benchmark/'],
    }));
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('symbolic links');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it.each(['fork', 'pull-request'] as const)('includes child-created assets omitted from the root plan in %s mode', async mode => {
    const f = await fixture(mode);
    const driver = f.driver.getMockImplementation()!;
    f.driver.mockImplementationOnce(async options => {
      const log = await driver(options);
      const workspace = options.env!['ATOMA_BUILD_WORKSPACE']!;
      mkdirSync(join(workspace, 'assets'));
      writeFileSync(join(workspace, 'assets', 'app.js'), 'document.title="Complete";');
      return log;
    });
    const run = await f.start('<script src="assets/app.js"></script>');
    expect(run.status).toBe('delivered');
    expect(run.artifactManifest?.source).toBe('workspace');
    const owner = mode === 'fork' ? 'alice' : 'upstream';
    const branch = mode === 'fork' ? 'main' : `atoma/run-${run.projectRunId}`;
    expect(f.fake.filesOn(owner, 'app', branch).get('assets/app.js')?.text).toBe('document.title="Complete";');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
  });

  it('seeds current main, creates one PR per delivered change and leaves main intact', async () => {
    const f = await fixture('pull-request');
    const original = f.fake.refSha('upstream', 'app', 'main');
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(run.repositoryBase?.commitSha).toBe(original);
    expect(f.seeds).toEqual(['<h1>Original</h1>']);
    expect(f.fake.refSha('upstream', 'app', 'main')).toBe(original);
    expect(f.fake.filesOn('upstream', 'app', `atoma/run-${run.projectRunId}`).get('keep.txt')?.text).toBe('Unchanged');
    const publication = f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)!;
    expect(publication).toMatchObject({ status: 'published', pullRequestUrl: 'https://github.com/upstream/app/pull/1',
      git: { branch: `atoma/run-${run.projectRunId}`, baseBranch: 'main', defaultBranch: 'main', mode: 'pull-request' } });
    await f.coordinator.retryPublication(f.viewer.orgId, run.projectRunId);
    expect(f.fake.pullRequests).toHaveLength(1);
    f.fake.commitOutside('upstream', 'app', 'main', 'index.html', '<h1>Merged externally</h1>');
    const second = await f.start('<h1>Second</h1>');
    expect(second.status).toBe('delivered');
    expect(f.seeds[1]).toBe('<h1>Merged externally</h1>');
    expect(f.fake.pullRequests).toHaveLength(2);
    expect(f.fake.forcedUpdates).toBe(0);
  });

  it('forks once, publishes directly there and seeds the next run from the fork', async () => {
    const f = await fixture('fork');
    const original = f.fake.refSha('upstream', 'app', 'main');
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
    expect(f.fake.filesOn('alice', 'app', 'main').get('index.html')?.text).toBe('<h1>Changed</h1>');
    expect(f.fake.refSha('upstream', 'app', 'main')).toBe(original);
    await f.start('<h1>Second</h1>');
    expect(f.seeds).toEqual(['<h1>Original</h1>', '<h1>Changed</h1>']);
    expect(f.fake.calls.filter(call => call.endsWith('/forks'))).toHaveLength(1);
    expect(f.fake.pullRequests).toHaveLength(0);
    expect(f.fake.calls).not.toContain('GET /installation/repositories');
  });

  it('retries a failed PR creation without a second branch or commit', async () => {
    let fail = true;
    const f = await fixture('pull-request', fake => async (url, init) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/pulls') && init?.method === 'POST' && fail) {
        fail = false; return new Response('{}', { status: 503 });
      }
      return fake.fetch(url, init);
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('failed');
    const head = f.fake.refSha('upstream', 'app', `atoma/run-${run.projectRunId}`);
    await f.coordinator.retryPublication(f.viewer.orgId, run.projectRunId);
    expect(f.fake.refSha('upstream', 'app', `atoma/run-${run.projectRunId}`)).toBe(head);
    expect(f.fake.pullRequests).toHaveLength(1);
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
  });

  it('does not open an empty PR', async () => {
    const f = await fixture('pull-request');
    const run = await f.start('<h1>Original</h1>');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
    expect(f.fake.pullRequests).toHaveLength(0);
    expect(f.fake.refSha('upstream', 'app', `atoma/run-${run.projectRunId}`)).toBeNull();
  });

  it('refuses an unrelated fork destination before any model work', async () => {
    const f = await fixture('fork');
    f.fake.createRepository('alice', 'app');
    f.fake.commitOutside('alice', 'app', 'main', 'other.txt', 'Other project');
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('fork parent');
    expect(f.driver).not.toHaveBeenCalled();
    expect(f.fake.filesOn('alice', 'app', 'main').has('index.html')).toBe(false);
  });

  it('keeps a concurrent human edit when publishing a fork', async () => {
    const f = await fixture('fork');
    const driver = f.driver.getMockImplementation()!;
    f.driver.mockImplementationOnce(async options => {
      const log = await driver(options);
      f.fake.commitOutside('alice', 'app', 'main', 'index.html', '<h1>Human edit</h1>');
      return log;
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
    expect(f.fake.filesOn('alice', 'app', 'main').get('index.html')?.text).toBe('<h1>Human edit</h1>');
  });

  it.each(['../escape', '.git/config', 'safe/../../escape'])('refuses unsafe repository path %s before running', async unsafePath => {
    const f = await fixture('pull-request', fake => async (url, init) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('?recursive=1')) return new Response(JSON.stringify({ truncated: false,
        tree: [{ path: unsafePath, type: 'blob', mode: '100644', sha: 'a'.repeat(40) }] }));
      return fake.fetch(url, init);
    });
    const run = await f.start();
    expect(run.status).toBe('failed');
    expect(f.driver).not.toHaveBeenCalled();
  });

  it('walks subtrees when the recursive source tree is truncated', async () => {
    const f = await fixture('pull-request', fake => async (url, init) => {
      if ((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes('?recursive=1')) return new Response(JSON.stringify({ truncated: true, tree: [] }));
      return fake.fetch(url, init);
    });
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(f.driver).toHaveBeenCalledOnce();
  });

  it.each(['fork', 'pull-request'] as const)('delivers 1502 files in %s mode, uploads only the change, and resumes', async mode => {
    let archiveDownloads = 0;
    const f = await fixture(mode, fake => async (url, init) => {
      const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      if (target.pathname.includes('/zipball/')) return new Response(null, { status: 302,
        headers: { location: 'https://codeload.github.com/snapshot?token=signed-secret' } });
      if (target.hostname === 'codeload.github.com') {
        archiveDownloads++;
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        expect(init?.redirect).toBe('error');
        const tree = fake.filesOn(mode === 'fork' ? 'alice' : 'upstream', 'app', 'main');
        return new Response(Buffer.from(zipSync(Object.fromEntries([...tree].map(([path, value]) =>
          [`snapshot/${path}`, Buffer.from(value.text)])))));
      }
      return fake.fetch(url, init);
    }, 'https://api.github.com');
    const many = Array.from({ length: 1500 }, (_, i) => ({ path: `src/file-${i}.js`, content: `export default ${i};` }));
    await f.client.publishManifestCommit({ token: 'installation-token', repository: { owner: 'upstream', name: 'app' },
      expectedHead: f.fake.refSha('upstream', 'app', 'main'), files: many, message: 'Large source fixture' });
    const before = f.fake.calls.length;
    const run = await f.start();
    expect(run.status).toBe('delivered');
    expect(run.artifactManifest?.files).toHaveLength(1502);
    expect(archiveDownloads).toBe(1);
    expect(f.fake.calls.slice(before).filter(c => c.startsWith('GET') && c.includes('/git/blobs/'))).toHaveLength(0);
    expect(f.projects.getPublicationForRun(f.viewer.orgId, run.projectRunId)?.status).toBe('published');
    expect(f.fake.calls.slice(before).filter(c => c.endsWith('/git/blobs') && c.startsWith('POST'))).toHaveLength(1);
    if (mode === 'fork') {
      expect(Object.keys(f.projects.getRepositorySync(f.viewer.orgId, run.projectRunId)!.base)).toHaveLength(1502);
      const again = await f.start('<h1>Changed again</h1>');
      expect(again.status).toBe('delivered');
      expect(f.projects.getPublicationForRun(f.viewer.orgId, again.projectRunId)?.status).toBe('published');
      expect(f.fake.filesOn('alice', 'app', 'main').size).toBe(1502);
    }
  }, 30_000);

  it('refuses a foreign organisation installation before downloading files or invoking the driver', async () => {
    const f = await fixture('pull-request');
    const foreign = { ...f.project, orgId: randomUUID() } satisfies Project;
    await expect(f.publisher.prepareRun(foreign, {} as never, new AbortController().signal)).rejects.toThrow('not linked');
    expect(f.driver).not.toHaveBeenCalled();
  });
});

describe('GitHub source entry', () => {
  it.each(['owner/repo', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git'])('parses %s', value => {
    expect(parseGitHubRepository(value)).toEqual({ owner: 'owner', name: 'repo' });
  });
  it.each(['https://evil.test/owner/repo', 'https://github.com/owner/repo/tree/main', 'https://u:p@github.com/owner/repo', '../repo', 'git@github.com:owner/repo'])('refuses %s', value => {
    expect(() => parseGitHubRepository(value)).toThrow();
  });
});


it.each(['fork', 'pull-request'] as const)('iterates a selected imported delivery without replacing its bytes from GitHub (%s)', async mode => {
  const f = await fixture(mode);
  const first = await f.start('<h1>Accepted</h1>');
  const owner = mode === 'fork' ? 'alice' : 'upstream';
  f.fake.commitOutside(owner, 'app', 'main', 'index.html', '<h1>Remote after acceptance</h1>');
  const prepare = vi.spyOn(f.publisher, 'prepareRun');
  const second = await f.start('<h1>Iteration</h1>', first.projectRunId);
  expect(second.status, second.error ?? '').toBe('delivered');
  expect(f.seeds.at(-1)).toBe('<h1>Accepted</h1>');
  expect(prepare).not.toHaveBeenCalled();
  expect(second.repositoryBase).toEqual(first.repositoryBase);
  expect(second.seed).toEqual({ kind: 'run', runId: first.projectRunId });
  expect(f.projects.getPublicationForRun(f.viewer.orgId, second.projectRunId)?.status).toBe('published');
  if (mode === 'pull-request') {
    expect(f.fake.filesOn(owner, 'app', `atoma/run-${second.projectRunId}`).get('index.html')?.text).toBe('<h1>Iteration</h1>');
  } else {
    expect(f.fake.filesOn(owner, 'app', 'main').get('index.html')?.text).toBe('<h1>Remote after acceptance</h1>');
  }
});
