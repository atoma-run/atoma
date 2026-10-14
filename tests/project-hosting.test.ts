import { runStatsSchema } from '../src/contracts/runStats.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AUTH_TABLES_DDL, type Viewer } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { HostingStore } from '../src/projects/hostingStore.js';
import { HostingService } from '../src/projects/hostingService.js';
import { PreviewStore } from '../src/preview/store.js';
import { recordDeliveredPreview } from '../src/preview/service.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { hostingConfig } from '../src/projects/hostingConfig.js';
import type { HostingIdentity } from '../src/contracts/projectHosting.js';

let root: string; let db: Database.Database; let projects: ProjectStore; let service: HostingService;
let viewer: Viewer; let projectId: string; let runId: string; let manifestHash: string;
let source: string;
const launcher = { prepareHosting: vi.fn(async (_id: HostingIdentity) => ''), startHosting: vi.fn(async () => ({ hostPort: 12345, image: 'runtime@sha256:abc' })), inspectHosting: vi.fn(async () => ({ hostPort: 12345, image: 'runtime@sha256:abc' })), stopHosting: vi.fn(async () => {}) };
beforeEach(() => {
  vi.clearAllMocks(); launcher.startHosting.mockResolvedValue({ hostPort: 12345, image: 'runtime@sha256:abc' });
  root = mkdtempSync(join(tmpdir(), 'hosting-')); db = new Database(join(root, 'product.db')); db.exec(AUTH_TABLES_DDL);
  projects = new ProjectStore(db); const previews = new PreviewStore(db);
  const orgId = randomUUID(); const principalId = randomUUID(); const now = new Date().toISOString();
  db.prepare('INSERT INTO auth_organisations (org_id,name,created_at) VALUES (?,?,?)').run(orgId, 'Org', now);
  db.prepare("INSERT INTO auth_principals (principal_id,kind,display_name,created_at) VALUES (?,'human','Owner',?)").run(principalId, now);
  db.prepare("INSERT INTO auth_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'org:owner',?)").run(orgId, principalId, now);
  viewer = { orgId, principalId, role: 'org:owner', kind: 'human', displayName: 'Owner', orgName: 'Org', platformAdmin: false, displayNameSource: 'provider' };
  projectId = projects.createProject({ orgId, principalId, project: { name: 'Site', slug: 'site', repositoryTarget: { installationId: '1', owner: 'acme', name: 'site', visibility: 'private' } } }).projectId;
  projects.setDeploymentDestination(orgId, projectId, { destination: 'atoma', expectedDestination: 'none' });
  source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'index.html'), '<h1>Accepted app</h1>');
  runId = projects.createProjectRun({ orgId, principalId, projectId, request: { goal: 'Build a site', idempotencyKey: 'build' }, hostPaths: { workspacePath: source, runsPath: join(root, 'runs'), logPath: join(root, 'run.log') } })!.run.projectRunId;
  projects.transitionProjectRun({ orgId, projectRunId: runId, from: 'queued', to: 'running' });
  projects.transitionProjectRun({ orgId, projectRunId: runId, from: 'running', to: 'delivered', traceId: 'trace', stats: runStatsSchema.parse({ outcome: 'delivered', costUsd: 0, llmCalls: 0, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, otherCalls: 0, deterministicPhases: 0, deepenings: 0, rootRemediations: 0, discardedLessons: 0, landingReasons: [], escalations: 0, learnedSkills: 0, learnedEventSkills: 0, promotions: 0, refusals: 0, compileErrors: 0, demotions: 0, dispatchFallbacks: 0, uncoveredObligations: 0 }) });
  const manifest = buildWorkspaceArtifactManifest({ workspaceRoot: source }); manifestHash = manifest.hash;
  projects.saveArtifactManifest(orgId, runId, manifest.manifest);
  recordDeliveredPreview(previews, { orgId, projectId, projectRunId: runId, workspaceRoot: source });
  launcher.prepareHosting.mockImplementation(async id => join(root, id.deploymentId));
  service = new HostingService({ store: new HostingStore(db), projects, previews, launcher, domain: 'app.atoma.run', maxDeployments: 4, probe: async () => true });
});
afterEach(async () => { await service?.idle(); db.close(); rmSync(root, { recursive: true, force: true }); });
function publish() {
  projects.acceptDelivery(viewer.orgId, runId, viewer.principalId, { manifestHash, review: 'Client tested and accepted this application.' });
  const pub = projects.reservePublication({ orgId: viewer.orgId, projectRunId: runId, idempotencyKey: 'publish' })!.publication;
  projects.transitionPublication({ orgId: viewer.orgId, publicationId: pub.publicationId, from: 'pending', to: 'publishing' });
  projects.transitionPublication({ orgId: viewer.orgId, publicationId: pub.publicationId, from: 'publishing', to: 'published', receipt: { repositoryId: '1', fullName: 'acme/site', url: 'https://github.com/acme/site', defaultBranch: 'main', commitSha: 'a'.repeat(40), baseSha: null } });
}
const input = () => ({ runId, manifestHash, expectedDeploymentId: null });
it('status allocates nothing and deployment requires acceptance plus publication', async () => {
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'not-deployed', candidate: null });
  expect(launcher.prepareHosting).not.toHaveBeenCalled();
  await expect(service.deploy(viewer, projectId, input())).rejects.toMatchObject({ status: 409 });
  expect(service.deps.store.list()).toEqual([]);
});
it('deploys verified copied bytes, retains runtime through recovery, and stops without deleting data', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const status = service.status(viewer, projectId);
  expect(status).toMatchObject({ state: 'ready', runId, commitSha: 'a'.repeat(40) });
  expect(readFileSync(join(root, status.deploymentId!, 'index.html'), 'utf8')).toContain('Accepted app');
  const recovered = new HostingService({ ...service.deps, store: new HostingStore(db) }); await recovered.recover();
  expect(launcher.startHosting).toHaveBeenCalledTimes(1);
  expect(recovered.status(viewer, projectId).state).toBe('ready');
  await recovered.stop(viewer, projectId, status.deploymentId);
  expect(recovered.status(viewer, projectId).state).toBe('stopped');
  expect(readFileSync(join(source, 'index.html'), 'utf8')).toContain('Accepted app');
});
it('refuses foreign organisations, members, stale requests and a concurrent start', async () => {
  publish();
  await expect(service.deploy({ ...viewer, orgId: randomUUID(), platformAdmin: true }, projectId, input())).rejects.toMatchObject({ status: 404 });
  await expect(service.deploy({ ...viewer, role: 'org:member' }, projectId, input())).rejects.toMatchObject({ status: 403 });
  await service.deploy(viewer, projectId, input());
  await expect(service.deploy(viewer, projectId, input())).rejects.toMatchObject({ status: 409 });
});
it('refuses modified delivered bytes before launching and keeps the prior working static version', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const prior = service.status(viewer, projectId);
  writeFileSync(join(source, 'index.html'), '<h1>changed after acceptance</h1>');
  await service.deploy(viewer, projectId, { ...input(), expectedDeploymentId: prior.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'failed', url: prior.url });
  expect(launcher.startHosting).toHaveBeenCalledTimes(1);
});
it('marks interrupted startup failed on recovery and never converts it into a ready deployment', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const row = service.deps.store.list()[0]!;
  service.deps.store.update({ ...row, state: 'starting' }, 'ready');
  await service.recover(); expect(service.status(viewer, projectId)).toMatchObject({ state: 'failed', error: 'interrupted' });
});
it('rejects unsafe domains and invalid host configuration', () => {
  expect(hostingConfig({}, 'https://atoma.run')).toBeNull();
  expect(() => hostingConfig({ ATOMA_HOSTING_ENABLED: '1', ATOMA_HOSTING_DOMAIN: 'atoma.run' }, 'https://atoma.run')).toThrow();
  expect(hostingConfig({ ATOMA_HOSTING_ENABLED: '1', ATOMA_HOSTING_DOMAIN: 'app.atoma.run' }, 'https://atoma.run')?.domain).toBe('app.atoma.run');
});

it('keeps a healthy replacement when retiring its predecessor fails', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const prior = service.status(viewer, projectId);
  launcher.stopHosting.mockRejectedValueOnce(new Error('Engine unavailable'));
  await service.deploy(viewer, projectId, { ...input(), expectedDeploymentId: prior.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId).state).toBe('ready');
  expect(service.deps.store.list().find(row => row.deploymentId === prior.deploymentId)?.error).toBe('cleanup-failed');
});
it('does not resurrect a stopped application from an in-flight health probe', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  let complete!: (value: boolean) => void;
  service.deps.probe = () => new Promise(resolve => { complete = resolve; });
  const check = service.refreshHealth();
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  await service.stop(viewer, projectId, service.status(viewer, projectId).deploymentId);
  complete(true); await check;
  expect(service.status(viewer, projectId).state).toBe('stopped');
});
it('deploys a declared hosted browser application without requiring a static preview classification', async () => {
  writeFileSync(join(source, 'server.js'), 'console.log("application")');
  writeFileSync(join(source, 'atoma.hosting.json'), JSON.stringify({ version: 1, runtime: 'node-browser', entry: 'server.js' }));
  const prior = projects.getProjectRun(viewer.orgId, runId)!;
  runId = projects.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId, request: { goal: 'Hosted browser', idempotencyKey: 'browser' }, hostPaths: prior.hostPaths })!.run.projectRunId;
  projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: runId, from: 'queued', to: 'running' });
  projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: runId, from: 'running', to: 'delivered', traceId: 'browser', stats: prior.stats! });
  const manifest = buildWorkspaceArtifactManifest({ workspaceRoot: source }); manifestHash = manifest.hash;
  projects.saveArtifactManifest(viewer.orgId, runId, manifest.manifest);
  vi.spyOn(service.deps.previews, 'getDescriptor').mockReturnValue(null);
  publish();
  expect(service.status(viewer, projectId).candidate?.runId).toBe(runId);
  await service.deploy(viewer, projectId, input()); await service.idle();
  expect(service.status(viewer, projectId).state).toBe('ready');
  expect(launcher.startHosting).toHaveBeenCalledWith(expect.objectContaining({ browser: true, kind: 'node', entry: 'server.js' }));
});
