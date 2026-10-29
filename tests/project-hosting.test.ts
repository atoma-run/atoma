import { runStatsSchema } from '../src/contracts/runStats.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AUTH_TABLES_DDL, type Viewer } from '../src/auth/store.js';
import { ProjectStore } from '../src/projects/store.js';
import { holdsApplicationData, HostingStore } from '../src/projects/hostingStore.js';
import { retentionPlan } from '../src/projects/retention.js';
import { HOSTING_HEALTH, HostingService, hostingHistory } from '../src/projects/hostingService.js';
import { PreviewStore } from '../src/preview/store.js';
import { recordDeliveredPreview } from '../src/preview/service.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { hostingConfig } from '../src/projects/hostingConfig.js';
import { HOSTING_HISTORY_MAX, type HostedDeployment, type HostingIdentity, type HostingLaunch } from '../src/contracts/projectHosting.js';

let root: string; let db: Database.Database; let projects: ProjectStore; let service: HostingService;
let viewer: Viewer; let projectId: string; let runId: string; let manifestHash: string;
let source: string;
const launcher = { prepareHosting: vi.fn(async (_id: HostingIdentity) => ''), createHosting: vi.fn(async (_spec: HostingLaunch) => {}), startHosting: vi.fn(async (_spec: HostingLaunch) => ({ hostPort: 12345, image: 'runtime@sha256:abc' })), inspectHosting: vi.fn(async () => ({ hostPort: 12345, image: 'runtime@sha256:abc' })), listHosting: vi.fn(async (): Promise<HostingIdentity[]> => []), stopHosting: vi.fn(async (_id: HostingIdentity) => {}) };
beforeEach(() => {
  vi.clearAllMocks(); launcher.startHosting.mockResolvedValue({ hostPort: 12345, image: 'runtime@sha256:abc' });
  launcher.createHosting.mockImplementation(async () => {}); launcher.stopHosting.mockImplementation(async () => {});
  launcher.listHosting.mockImplementation(async () => []);
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
  // The conversation narrates each deployment from these rows (2026-10-26).
  expect(recovered.status(viewer, projectId).history).toEqual([{ deploymentId: status.deploymentId, runId, title: null, traceId: 'trace',
    createdAt: expect.any(String), replaced: false, outcome: 'ended', keptOnline: false }]);
  expect(readFileSync(join(source, 'index.html'), 'utf8')).toContain('Accepted app');
});
it('gives a project its model-proposed address before the first deployment and serves it there', async () => {
  publish();
  expect(service.status(viewer, projectId).address).toBeNull();
  const namer = vi.fn(async () => ({ candidates: ['acme-site'], receipt: null }));
  const named = new HostingService({ ...service.deps, namer });
  await named.deploy(viewer, projectId, input()); await named.idle();
  expect(namer).toHaveBeenCalledExactlyOnceWith({ name: 'Site', brief: '' });
  expect(projects.getProject(viewer.orgId, projectId)!.hostingSubdomain).toBe('acme-site');
  expect(named.status(viewer, projectId)).toMatchObject({ state: 'ready', address: 'https://acme-site.app.atoma.run/', url: 'https://acme-site.app.atoma.run/' });
  expect(named.host(named.deps.store.list()[0]!)).toBe('acme-site.app.atoma.run');
  // Renamed while online: served at the new address, the old one redirects there.
  projects.renameHostingSubdomain(viewer.orgId, projectId, { subdomain: 'acme-shop', expectedSubdomain: 'acme-site' });
  expect(named.status(viewer, projectId)).toMatchObject({ address: 'https://acme-shop.app.atoma.run/', url: 'https://acme-shop.app.atoma.run/' });
  expect(named.movedHost('acme-site.app.atoma.run')).toBe('acme-shop.app.atoma.run');
  expect(named.movedHost('acme-shop.app.atoma.run')).toBeNull();
  expect(named.movedHost('acme-site.elsewhere.test')).toBeNull();
  // Every project surface links to where the application is online now, and only for projects asked about.
  expect(named.onlineUrls([projectId, randomUUID()])).toEqual(new Map([[projectId, 'https://acme-shop.app.atoma.run/']]));
  await named.stop(viewer, projectId, named.status(viewer, projectId).deploymentId);
  expect(named.onlineUrls([projectId]).size).toBe(0);
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
it('removes on recovery the engine objects of an update whose process died before its row was written', async () => {
  asNodeApplication();
  const { second, online } = await onlineWithNewerVersion();
  // The engine, as the launcher lists it: every deployment with objects.
  const engine = new Map<string, HostingIdentity>(
    service.deps.store.list().map(row => [row.deploymentId, { orgId: row.orgId, projectId: row.projectId, deploymentId: row.deploymentId }]));
  launcher.listHosting.mockImplementation(async () => [...engine.values()]);
  launcher.stopHosting.mockImplementation(async id => { engine.delete(id.deploymentId); });
  // The web process dies right after creating the new version's objects:
  // nothing after createHosting ever runs, so no row names them.
  launcher.createHosting.mockImplementation(spec => {
    engine.set(spec.deploymentId, { orgId: spec.orgId, projectId: spec.projectId, deploymentId: spec.deploymentId });
    return new Promise<void>(() => {});
  });
  void service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId });
  await vi.waitFor(() => expect(engine.size).toBe(2));
  const orphan = [...engine.keys()].find(id => id !== online.deploymentId)!;
  expect(service.deps.store.list(viewer.orgId, projectId).map(row => row.deploymentId)).not.toContain(orphan);
  launcher.stopHosting.mockClear();
  // The next process recovers: the orphan goes, the online version stays.
  const restarted = new HostingService({ ...service.deps, store: new HostingStore(db) });
  await restarted.recover();
  expect(launcher.stopHosting.mock.calls.map(([id]) => id.deploymentId)).toEqual([orphan]);
  expect([...engine.keys()]).toEqual([online.deploymentId]);
  expect(restarted.status(viewer, projectId)).toMatchObject({ state: 'ready', deploymentId: online.deploymentId });
});
it('recovers with a launcher that cannot list its objects yet, and leaves them for the next boot', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  launcher.listHosting.mockRejectedValue(new Error('Launcher invalid-request'));
  launcher.stopHosting.mockClear();
  await service.recover();
  expect(launcher.stopHosting).not.toHaveBeenCalled();
  expect(service.status(viewer, projectId).state).toBe('ready');
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
it('follows a relay republished on a new port while the application stays healthy', async () => {
  // A Docker restart (2026-10-16) republishes the relay's loopback port;
  // a ready row kept the old one and the gateway proxied to nothing.
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  launcher.inspectHosting.mockResolvedValueOnce({ hostPort: 23456, image: 'runtime@sha256:abc' });
  await service.refreshHealth();
  expect(service.deps.store.list().find(r => r.state === 'ready')?.hostPort).toBe(23456);
});
// 2026-10-25: the launcher now restarts on a release change while its
// applications keep serving. An unreachable launcher is no verdict on them.
it('keeps a ready application ready while its launcher cannot be reached', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const before = service.status(viewer, projectId);
  expect(before.state).toBe('ready');
  const events = vi.fn();
  service.deps.events = events;
  launcher.inspectHosting.mockRejectedValueOnce(new Error('connect ECONNREFUSED launcher.sock'));
  await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('ready');
  expect(events).not.toHaveBeenCalled();
  launcher.inspectHosting.mockResolvedValueOnce(null as never); // reachable launcher, application gone
  await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('failed');
  // A version that ran and was later lost did not fail to START: never "the new version did not start".
  expect(service.status(viewer, projectId).failed).toBeNull();
});
// 2026-10-26: a busy browser application missed single probes; its row
// flapped failed/ready every check and the gateway closed its own page.
it('keeps a running application ready through isolated slow answers, journaling nothing', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const events = vi.fn(); service.deps.events = events;
  const answers = [false, false, true, false, false, true];
  const probe = vi.fn(async () => answers.shift()!);
  service.deps.probe = probe;
  for (let check = 0; check < 6; check++) {
    await service.refreshHealth();
    expect(service.deps.store.list().find(r => r.state === 'ready')?.hostPort).toBe(12345);
  }
  expect(probe).toHaveBeenCalledTimes(6);
  expect(events).not.toHaveBeenCalled();
});
it(`marks an application unavailable after ${HOSTING_HEALTH.failures} consecutive failed checks, once, and ready on its first good one`, async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const events = vi.fn(); service.deps.events = events;
  // The periodic check uses its own probe (its longer timeout), never readiness's.
  let healthy = false; service.deps.healthProbe = async () => healthy; service.deps.probe = async () => true;
  for (let check = 1; check < HOSTING_HEALTH.failures; check++) await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('ready');
  await service.refreshHealth();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'failed', error: 'runtime-unavailable', url: null });
  expect(service.deps.store.list(viewer.orgId, projectId)[0]?.hostPort).toBeNull();
  await service.refreshHealth(); await service.refreshHealth();
  expect(events.mock.calls.map(([e]) => e.kind)).toEqual(['project.hosting_failed']);
  healthy = true; await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('ready');
  expect(events.mock.calls.map(([e]) => e.kind)).toEqual(['project.hosting_failed', 'project.hosting_changed']);
  // Recovery reset the count: one more slow answer is not a verdict.
  healthy = false; await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('ready');
});
it('adopts a republished relay port even while the application answers slowly', async () => {
  // Review 2026-10-26: a slow probe must not keep the gateway on a port the
  // launcher no longer maps to this deployment.
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  service.deps.healthProbe = async () => false;
  launcher.inspectHosting.mockResolvedValueOnce({ hostPort: 34567, image: 'runtime@sha256:abc' });
  await service.refreshHealth();
  const row = service.deps.store.list(viewer.orgId, projectId)[0];
  expect(row).toMatchObject({ state: 'ready', hostPort: 34567 });
});
it('marks an application whose container is gone unavailable at the first check, even mid-count', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const events = vi.fn(); service.deps.events = events;
  service.deps.probe = async () => false;
  await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('ready');
  launcher.inspectHosting.mockResolvedValueOnce(null as never);
  await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('failed');
  expect(events).toHaveBeenCalledOnce();
});
it('keeps a running ready application ready across a web restart that met one slow answer', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  // A lost container still fails at boot, and comes back on its first good check.
  launcher.inspectHosting.mockResolvedValueOnce(null as never);
  await new HostingService({ ...service.deps }).recover();
  expect(service.status(viewer, projectId).state).toBe('failed');
  await service.refreshHealth();
  expect(service.status(viewer, projectId).state).toBe('ready');
  const restarted = new HostingService({ ...service.deps, probe: async () => false });
  await restarted.recover();
  expect(restarted.status(viewer, projectId).state).toBe('ready');
  // The restart's miss counts: the remaining failed checks decide.
  for (let check = 2; check < HOSTING_HEALTH.failures; check++) await restarted.refreshHealth();
  expect(restarted.status(viewer, projectId).state).toBe('ready');
  await restarted.refreshHealth();
  expect(restarted.status(viewer, projectId).state).toBe('failed');
});
it('resolves the project at its current address only, for the gateway\'s grant check', async () => {
  const at = { orgId: viewer.orgId, projectId };
  expect(service.projectAt(`p-${projectId}.app.atoma.run`)).toEqual(at);
  projects.assignHostingSubdomain(viewer.orgId, projectId, ['acme-site'], null);
  expect(service.projectAt('acme-site.app.atoma.run')).toEqual(at);
  // The legacy address stops naming it once it has a label; a retired one only redirects.
  expect(service.projectAt(`p-${projectId}.app.atoma.run`)).toBeNull();
  projects.renameHostingSubdomain(viewer.orgId, projectId, { subdomain: 'acme-shop', expectedSubdomain: 'acme-site' });
  expect(service.projectAt('acme-site.app.atoma.run')).toBeNull();
  expect(service.projectAt('acme-shop.app.atoma.run')).toEqual(at);
  expect(service.projectAt('acme-shop.app.atoma.run.evil.test')).toBeNull();
  expect(service.projectAt('acme-shop.other.test')).toBeNull();
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
  writeFileSync(join(source, 'start.sh'), '#!/bin/sh\necho application\n');
  chmodSync(join(source, 'start.sh'), 0o755);
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
  const deployed = service.status(viewer, projectId);
  expect(statSync(join(root, deployed.deploymentId!, 'start.sh')).mode & 0o777).toBe(0o700);
  await service.stop(viewer, projectId, deployed.deploymentId);
  chmodSync(join(source, 'start.sh'), 0o644);
  await service.deploy(viewer, projectId, { ...input(), expectedDeploymentId: deployed.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId).state).toBe('failed');
  expect(launcher.startHosting).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// "Update the application" (owner decision 2026-10-25): one explicit action
// that stops a stateful application, then starts the accepted version.
// ---------------------------------------------------------------------------
let clock = 0;
/** A further accepted, published delivery of the project, in the canonical run layout retention reads. */
function deliver(key: string, sha: string, title: string | null = null) {
  const id = randomUUID();
  const runRoot = join(realpathSync(root), 'orgs', viewer.orgId, 'projects', projectId, 'runs', id);
  const workspace = join(runRoot, 'workspace'); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'index.html'), `<h1>${key}</h1>`);
  projects.createProjectRun({ orgId: viewer.orgId, principalId: viewer.principalId, projectId, projectRunId: id,
    request: { goal: `Version ${key}`, idempotencyKey: key },
    hostPaths: { workspacePath: workspace, runsPath: join(runRoot, 'traces'), logPath: join(runRoot, 'run.log') } });
  projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'queued', to: 'running' });
  projects.transitionProjectRun({ orgId: viewer.orgId, projectRunId: id, from: 'running', to: 'delivered', traceId: `trace-${key}`,
    stats: projects.getProjectRun(viewer.orgId, runId)!.stats! });
  const manifest = buildWorkspaceArtifactManifest({ workspaceRoot: workspace });
  projects.saveArtifactManifest(viewer.orgId, id, manifest.manifest);
  recordDeliveredPreview(service.deps.previews, { orgId: viewer.orgId, projectId, projectRunId: id, workspaceRoot: workspace });
  if (title) projects.recordRunTitle({ orgId: viewer.orgId, projectRunId: id, title,
    receipt: { model: 'title-model', inputTokens: 1, outputTokens: 1, costUsd: 0, generatedAt: new Date().toISOString() } });
  projects.acceptDelivery(viewer.orgId, id, viewer.principalId, { manifestHash: manifest.hash, review: `Accepted ${key}.` });
  const pub = projects.reservePublication({ orgId: viewer.orgId, projectRunId: id, idempotencyKey: `publish-${key}` })!.publication;
  projects.transitionPublication({ orgId: viewer.orgId, publicationId: pub.publicationId, from: 'pending', to: 'publishing' });
  projects.transitionPublication({ orgId: viewer.orgId, publicationId: pub.publicationId, from: 'publishing', to: 'published',
    receipt: { repositoryId: '1', fullName: 'acme/site', url: 'https://github.com/acme/site', defaultBranch: 'main', commitSha: sha, baseSha: null } });
  // The newest accepted run is the candidate: creation order must be strict.
  db.prepare('UPDATE project_runs SET created_at = ? WHERE project_run_id = ?').run(new Date(Date.now() + ++clock * 60_000).toISOString(), id);
  return { runId: id, manifestHash: manifest.hash, workspace };
}
/** What a request names: the version, never its paths. */
const ref = (version: { runId: string; manifestHash: string }) => ({ runId: version.runId, manifestHash: version.manifestHash });
/** The conversation's deployment history, newest first: run, title, outcome, replaced, kept online. */
const narrated = () => (service.status(viewer, projectId).history ?? []).map(entry => [entry.runId, entry.title, entry.outcome, entry.replaced, entry.keptOnline]);
/** A stateful Node application: its replacement may not run beside it. */
function asNodeApplication() {
  vi.spyOn(service.deps.previews, 'getDescriptor').mockImplementation(() => ({ availability: 'available', kind: 'node', entry: 'index.js' }) as never);
}
/** Version one online, version two accepted and published since. */
async function onlineWithNewerVersion() {
  const first = deliver('one', 'c'.repeat(40), 'First control page');
  await service.deploy(viewer, projectId, { ...ref(first), expectedDeploymentId: null }); await service.idle();
  const second = deliver('two', 'd'.repeat(40), 'Finish Attica control page repair');
  return { first, second, online: service.status(viewer, projectId) };
}

it('updates a stateful application in one request: the online version stops before the accepted one starts', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  expect(online).toMatchObject({ state: 'ready', runId: first.runId, updateStops: true, previous: null,
    version: { runId: first.runId, title: 'First control page', commitSha: 'c'.repeat(40) },
    candidate: { runId: second.runId, title: 'Finish Attica control page repair', commitSha: 'd'.repeat(40), manifestHash: second.manifestHash } });
  expect(online.candidate!.acceptedAt).toEqual(expect.any(String));
  const order: string[] = [];
  launcher.stopHosting.mockImplementation(async id => { order.push(`stop ${id.deploymentId}`); });
  launcher.startHosting.mockImplementation(async spec => {
    // Two versions never write the data: nothing that may hold it is left when the new one starts.
    expect(service.deps.store.list(viewer.orgId, projectId).filter(holdsApplicationData)).toEqual([]);
    order.push(`start ${spec.deploymentId}`); return { hostPort: 23456, image: 'runtime@sha256:abc' };
  });
  const events = vi.fn(); service.deps.events = events;
  const accepted = await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId });
  expect(accepted.state).toBe('starting');
  await service.idle();
  const updated = service.status(viewer, projectId);
  expect(order).toEqual([`stop ${online.deploymentId}`, `start ${updated.deploymentId}`]);
  expect(updated).toMatchObject({ state: 'ready', runId: second.runId, previous: null, version: { title: 'Finish Attica control page repair' } });
  expect(service.deps.store.list(viewer.orgId, projectId)[0]).toMatchObject({ runId: second.runId, previousRunId: first.runId });
  // The conversation tells the switch, and that the first version no longer serves.
  expect(narrated()).toEqual([[second.runId, 'Finish Attica control page repair', 'online', true, false], [first.runId, 'First control page', 'ended', false, false]]);
  // Journaled like Stop and Deploy, under the person's authority, and named as an update.
  expect(events.mock.calls.map(([event]) => [event.detail.state, event.detail.operation, event.actorType])).toEqual([
    ['stopped', 'update', 'principal'], ['starting', 'update', 'principal'], ['ready', undefined, 'system']]);
});

it('refuses a stale, foreign, unauthorised or superseded update before stopping anything', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  launcher.stopHosting.mockClear();
  const update = (overrides: object = {}, who: Viewer = viewer) =>
    service.update(who, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId, ...overrides });
  await expect(update({}, { ...viewer, role: 'org:member' })).rejects.toMatchObject({ status: 403 });
  await expect(update({}, { ...viewer, orgId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  await expect(update({ expectedDeploymentId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  // The version the person was shown is no longer the newest accepted one.
  await expect(update({ ...ref(first) })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/newer accepted version/) });
  await expect(update({ manifestHash: 'e'.repeat(64) })).rejects.toMatchObject({ status: 409 });
  await expect(update({ runId: 'not-a-run' })).rejects.toMatchObject({ status: 400 });
  // Restore offers nothing while the application is online.
  await expect(service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: online.deploymentId })).rejects.toMatchObject({ status: 409 });
  projects.setDeploymentDestination(viewer.orgId, projectId, { destination: 'none', expectedDestination: 'atoma' });
  await expect(update()).rejects.toMatchObject({ status: 409 });
  expect(launcher.stopHosting).not.toHaveBeenCalled();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId });
});

it('never starts the new version when stopping the online one fails', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  launcher.stopHosting.mockRejectedValueOnce(new Error('Engine unavailable'));
  await expect(service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId })).rejects.toThrow('Engine unavailable');
  await service.idle();
  expect(launcher.startHosting).toHaveBeenCalledTimes(1);
  expect(service.deps.store.list(viewer.orgId, projectId)).toHaveLength(1);
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId });
  // Released: the next attempt runs.
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: second.runId });
});

it('says when the new version did not start and puts the previous version back as one action', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  launcher.startHosting.mockRejectedValueOnce(new Error('crashed on start'));
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  const failed = service.status(viewer, projectId);
  expect(failed).toMatchObject({ state: 'failed', error: 'startup-failed', url: null, runId: second.runId, updateStops: false,
    failed: { runId: second.runId }, previous: { runId: first.runId, manifestHash: first.manifestHash, title: 'First control page', commitSha: 'c'.repeat(40) } });
  // A tried switch that never served; the version it replaced was stopped first, so nothing stayed online.
  expect(narrated()).toEqual([[second.runId, 'Finish Attica control page repair', 'not-started', true, false], [first.runId, 'First control page', 'ended', false, false]]);
  // Only the version the update stopped can be put back, and only against the state that was shown.
  await expect(service.restore(viewer, projectId, { ...ref(second), expectedDeploymentId: failed.deploymentId })).rejects.toMatchObject({ status: 409 });
  await expect(service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: online.deploymentId })).rejects.toMatchObject({ status: 409 });
  await expect(service.restore({ ...viewer, role: 'org:member' }, projectId, { ...ref(first), expectedDeploymentId: failed.deploymentId })).rejects.toMatchObject({ status: 403 });
  await service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: failed.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId, previous: null,
    candidate: { runId: second.runId } });
  // Put back while nothing served: a plain put-online, not a switch.
  expect(narrated()[0]).toEqual([first.runId, 'First control page', 'online', false, false]);
});

it('offers the previous version back only while its retained bytes exist', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  launcher.startHosting.mockRejectedValueOnce(new Error('crashed on start'));
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId).previous?.runId).toBe(first.runId);
  // Retention holds it: the version a failed update stopped is what the put-back reads.
  db.prepare("UPDATE project_runs SET ended_at = '2025-01-02T00:00:00.000Z' WHERE project_run_id IN (?, ?)").run(first.runId, second.runId);
  const plan = retentionPlan(db, realpathSync(root), undefined, new Date('2026-10-25T00:00:00Z'));
  expect(plan.find(row => row.runId === first.runId)?.held).toBe('hosted application version');
  rmSync(first.workspace, { recursive: true, force: true });
  const failed = service.status(viewer, projectId);
  expect(failed.previous).toBeNull();
  await expect(service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: failed.deploymentId })).rejects.toMatchObject({ status: 409 });
});

it('keeps the no-downtime path for a static application: the new version starts before the old one stops', async () => {
  const { second, online } = await onlineWithNewerVersion();
  expect(online.updateStops).toBe(false);
  const order: string[] = [];
  launcher.stopHosting.mockImplementation(async id => { order.push(`stop ${id.deploymentId}`); });
  launcher.startHosting.mockImplementation(async spec => {
    expect(service.status(viewer, projectId).url).toBe(online.url);
    order.push(`start ${spec.deploymentId}`); return { hostPort: 23456, image: 'runtime@sha256:abc' };
  });
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  const updated = service.status(viewer, projectId);
  expect(order).toEqual([`start ${updated.deploymentId}`, `stop ${online.deploymentId}`]);
  expect(updated).toMatchObject({ state: 'ready', runId: second.runId });
  expect(narrated().map(([, , outcome, replaced]) => [outcome, replaced])).toEqual([['online', true], ['ended', false]]);
});

it('names the version that failed, so a newer accepted one beside a static version online is not called failed', async () => {
  const { first, second, online } = await onlineWithNewerVersion();
  expect(online.failed).toBeNull();
  launcher.startHosting.mockRejectedValueOnce(new Error('crashed on start'));
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  const beside = service.status(viewer, projectId);
  // Still online with the first version; the second, the candidate, failed.
  expect(beside).toMatchObject({ state: 'failed', runId: first.runId, failed: { runId: second.runId }, candidate: { runId: second.runId } });
  expect(beside.url).not.toBeNull();
  // The tried switch says the version already online stayed online, and that one is still the one serving.
  expect(narrated()).toEqual([[second.runId, 'Finish Attica control page repair', 'not-started', true, true], [first.runId, 'First control page', 'online', false, false]]);
  const third = deliver('three', 'e'.repeat(40), 'Third control page');
  // A newer accepted version since: the failure still names the second.
  expect(service.status(viewer, projectId)).toMatchObject({ failed: { runId: second.runId }, candidate: { runId: third.runId } });
  // Stop rewrites both rows `stopped`: the attempt is still told as never started, the first as no longer online.
  expect((await service.stop(viewer, projectId, beside.deploymentId)).state).toBe('stopped');
  expect(narrated()).toEqual([[second.runId, 'Finish Attica control page repair', 'not-started', true, false], [first.runId, 'First control page', 'ended', false, false]]);
});

it('holds the online version from retention', async () => {
  asNodeApplication();
  const { first, second } = await onlineWithNewerVersion();
  db.prepare("UPDATE project_runs SET ended_at = '2025-01-02T00:00:00.000Z' WHERE project_run_id IN (?, ?)").run(first.runId, second.runId);
  const plan = retentionPlan(db, realpathSync(root), undefined, new Date('2026-10-25T00:00:00Z'));
  expect(plan.find(row => row.runId === first.runId)?.held).toBe('hosted application version');
  expect(plan.find(row => row.runId === second.runId)?.held).toBe('accepted project reference');
});

// ---------------------------------------------------------------------------
// Prepare before stop, hold visitors meanwhile (owner decisions 2026-10-25).
// ---------------------------------------------------------------------------
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

it('prepares the new version completely before stopping the online one', async () => {
  asNodeApplication();
  const { second, online } = await onlineWithNewerVersion();
  const order: string[] = [];
  launcher.prepareHosting.mockImplementation(async id => { order.push(`prepare ${id.deploymentId}`); return join(root, id.deploymentId); });
  launcher.createHosting.mockImplementation(async spec => {
    // The bytes are already copied and revalidated when the engine objects are made.
    expect(readFileSync(join(root, spec.deploymentId, 'index.html'), 'utf8')).toBe('<h1>two</h1>');
    order.push(`create ${spec.deploymentId}`);
  });
  launcher.stopHosting.mockImplementation(async id => { order.push(`stop ${id.deploymentId}`); });
  launcher.startHosting.mockImplementation(async spec => { order.push(`start ${spec.deploymentId}`); return { hostPort: 23456, image: 'runtime@sha256:abc' }; });
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  const next = service.status(viewer, projectId).deploymentId;
  // After the stop, only the start (and readiness) remains.
  expect(order).toEqual([`prepare ${next}`, `create ${next}`, `stop ${online.deploymentId}`, `start ${next}`]);
});

it('stops nothing when the new version cannot be prepared: the online version keeps serving', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  launcher.stopHosting.mockClear();
  writeFileSync(join(second.workspace, 'index.html'), '<h1>changed after acceptance</h1>');
  await expect(service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }))
    .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing was stopped/) });
  writeFileSync(join(second.workspace, 'index.html'), '<h1>two</h1>');
  launcher.createHosting.mockRejectedValueOnce(new Error('engine refused the network'));
  await expect(service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId })).rejects.toThrow('engine refused');
  await service.idle();
  // Only the half-prepared candidates were cleaned up; never the online version.
  expect(launcher.stopHosting.mock.calls.map(([id]) => id.deploymentId)).not.toContain(online.deploymentId);
  expect(service.deps.store.list(viewer.orgId, projectId)).toHaveLength(1);
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId });
  expect(launcher.startHosting).toHaveBeenCalledTimes(1);
});

it.each(['unreadable', 'changed-capability'] as const)('keeps the online application when the published source is %s', async failure => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  launcher.stopHosting.mockClear();
  service = new HostingService({ ...service.deps, materializePublishedSource: async (_row, destinationRoot) => {
    if (failure === 'unreadable') throw new Error('GitHub snapshot unavailable');
    writeFileSync(join(destinationRoot, 'index.js'), 'console.log("accepted entry")');
    writeFileSync(join(destinationRoot, 'browser.js'), 'console.log("different capability")');
    writeFileSync(join(destinationRoot, 'atoma.hosting.json'), JSON.stringify({ version: 1, runtime: 'node-browser', entry: 'browser.js' }));
  } });
  await expect(service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }))
    .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nothing was stopped/) });
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId });
  expect(launcher.stopHosting.mock.calls.map(([id]) => id.deploymentId)).not.toContain(online.deploymentId);
  expect(launcher.startHosting).toHaveBeenCalledTimes(1);
});

it('still updates through a launcher from before createHosting: its start creates the objects', async () => {
  asNodeApplication();
  const { second, online } = await onlineWithNewerVersion();
  launcher.createHosting.mockRejectedValueOnce(new Error('Launcher invalid-request'));
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: second.runId });
});

it('refuses every concurrent click while an update is stopping the online version, and reserves exactly one version', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  const gate = deferred();
  launcher.stopHosting.mockImplementationOnce(async () => gate.promise);
  launcher.startHosting.mockImplementation(async () => {
    // Never a start while the online row is not recorded stopped.
    expect(service.deps.store.list(viewer.orgId, projectId).find(r => r.deploymentId === online.deploymentId)?.state).toBe('stopped');
    return { hostPort: 23456, image: 'runtime@sha256:abc' };
  });
  const startsBefore = launcher.startHosting.mock.calls.length;
  const body = { ...ref(second), expectedDeploymentId: online.deploymentId };
  const updating = service.update(viewer, projectId, body);
  await vi.waitFor(() => expect(launcher.stopHosting).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: online.deploymentId })));
  await expect(service.update(viewer, projectId, body)).rejects.toMatchObject({ status: 409 });
  await expect(service.deploy(viewer, projectId, body)).rejects.toMatchObject({ status: 409 });
  await expect(service.stop(viewer, projectId, online.deploymentId)).rejects.toMatchObject({ status: 409 });
  await expect(service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: online.deploymentId })).rejects.toMatchObject({ status: 409 });
  expect(launcher.startHosting.mock.calls.length).toBe(startsBefore);
  gate.resolve(); await updating; await service.idle();
  const rows = service.deps.store.list(viewer.orgId, projectId);
  expect(rows.map(r => [r.runId, r.state])).toEqual([[second.runId, 'ready'], [first.runId, 'stopped']]);
  expect(launcher.startHosting.mock.calls.length).toBe(startsBefore + 1);
});

it('offers the stopped version back when the new one cannot be reserved after the stop', async () => {
  asNodeApplication();
  const { first, second, online } = await onlineWithNewerVersion();
  const { ProjectStateConflict } = await import('../src/projects/store.js');
  vi.spyOn(service.deps.store, 'reserve').mockImplementationOnce(() => { throw new ProjectStateConflict('Hosting capacity is full'); });
  await expect(service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId })).rejects.toMatchObject({ status: 409 });
  const failed = service.status(viewer, projectId);
  expect(failed).toMatchObject({ state: 'failed', error: 'startup-failed', url: null, previous: { runId: first.runId } });
  expect(service.swapping('acme-site.app.atoma.run')).toBeNull();
  await service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: failed.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId });
});

it('marks the swap window for the gateway from the stop until the new version is ready, and only for a stopping update', async () => {
  asNodeApplication();
  const { second, online } = await onlineWithNewerVersion();
  const host = service.host(service.deps.store.list(viewer.orgId, projectId)[0]!);
  expect(service.swapping(host)).toBeNull();
  const seen: string[] = [];
  launcher.stopHosting.mockImplementationOnce(async () => { seen.push(`stop ${service.swapping(host)?.projectId}`); });
  const ready = deferred();
  service.deps.probe = async () => { await ready.promise; return true; };
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId });
  const swap = service.swapping(host)!;
  expect(seen).toEqual([`stop ${projectId}`]);
  expect(swap).toMatchObject({ orgId: viewer.orgId, projectId });
  expect(service.swapping('other.app.atoma.run')).toBeNull();
  let settled = false; void swap.settled.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  ready.resolve(); await service.idle();
  expect(settled).toBe(true);
  expect(service.swapping(host)).toBeNull();
  expect(service.status(viewer, projectId).state).toBe('ready');
});

it('closes the swap window when the new version fails to start', async () => {
  asNodeApplication();
  const { second, online } = await onlineWithNewerVersion();
  const host = service.host(service.deps.store.list(viewer.orgId, projectId)[0]!);
  launcher.startHosting.mockRejectedValueOnce(new Error('crashed on start'));
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId });
  const swap = service.swapping(host);
  await service.idle(); await swap?.settled;
  expect(service.swapping(host)).toBeNull();
  expect(service.status(viewer, projectId).state).toBe('failed');
});

it('opens no swap window for a static update, which keeps serving the old version until the new one is ready', async () => {
  const { second, online } = await onlineWithNewerVersion();
  const host = service.host(service.deps.store.list(viewer.orgId, projectId)[0]!);
  launcher.startHosting.mockImplementation(async () => { expect(service.swapping(host)).toBeNull(); return { hostPort: 23456, image: 'runtime@sha256:abc' }; });
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: second.runId });
});

it('reads a row carrying a field a later release added instead of failing every listing', async () => {
  publish(); await service.deploy(viewer, projectId, input()); await service.idle();
  const row = service.deps.store.list()[0]!;
  db.prepare('UPDATE project_hosted_deployments SET record = ? WHERE deployment_id = ?').run(JSON.stringify({ ...row, laterField: 'x' }), row.deploymentId);
  expect(service.deps.store.list()).toEqual([row]);
  expect(service.status(viewer, projectId).state).toBe('ready');
});

/**
 * The conversation tells only what a deployment row proves (2026-10-26): a
 * row that never served is never "no longer online", a failure after serving
 * is not "did not start", and a row written before `readyAt` falls back on
 * what its state, its error or a later update's `previousRunId` proves.
 */
it('narrates each deployment only from what its row proves', () => {
  let n = 0;
  const row = (overrides: Partial<HostedDeployment>): HostedDeployment => ({ orgId: viewer.orgId, projectId, deploymentId: randomUUID(), runId: randomUUID(),
    manifestHash: 'h', commitSha: 'c', state: 'ready', kind: 'static', entry: 'index.html', createdAt: `2026-10-26T10:${String(59 - n++).padStart(2, '0')}:00.000Z`,
    error: null, hostPort: null, image: null, ...overrides });
  const runOf = vi.fn((id: string) => ({ title: `title ${id.slice(0, 4)}`, traceId: `trace-${id}` }));
  const outcomes = (rows: HostedDeployment[]) => hostingHistory(rows, runOf).map(entry => [entry.outcome, entry.replaced, entry.keptOnline]);
  const at = '2026-10-26T09:00:00.000Z';
  // A failure after serving is not "did not start"; one that never served is.
  expect(outcomes([row({ state: 'failed', error: 'runtime-unavailable', readyAt: at, replacedRunId: null })])).toEqual([['unavailable', false, false]]);
  expect(outcomes([row({ state: 'failed', error: 'cleanup-failed', readyAt: at, replacedRunId: null })])).toEqual([['ended', false, false]]);
  expect(outcomes([row({ state: 'failed', error: 'cleanup-failed', replacedRunId: null })])).toEqual([['not-started', false, false]]);
  // cleanup-failed over `ready` keeps the stored port; over `starting` it has none: the port tells them apart, even on an older row.
  expect(outcomes([row({ state: 'failed', error: 'cleanup-failed', hostPort: 23456 })])).toEqual([['ended', false, false]]);
  expect(outcomes([row({ state: 'failed', error: 'cleanup-failed' })])).toEqual([['not-started', false, false]]);
  expect(outcomes([row({ state: 'failed', error: 'interrupted', replacedRunId: null })])).toEqual([['not-started', false, false]]);
  // Stopped: "no longer online" only when it served. A failed attempt Stop rewrote `stopped` still never served.
  expect(outcomes([row({ state: 'stopped', readyAt: at, replacedRunId: null })])).toEqual([['ended', false, false]]);
  expect(outcomes([row({ state: 'stopped', replacedRunId: null })])).toEqual([['not-started', false, false]]);
  expect(outcomes([row({ state: 'stopped', replacedRunId: randomUUID() })])).toEqual([['not-started', true, false]]);
  // Two ready rows during a static swap: only the newest serves.
  expect(outcomes([row({ readyAt: at, replacedRunId: randomUUID() }), row({ readyAt: at, replacedRunId: null })])).toEqual([['online', true, false], ['ended', false, false]]);
  // "Replaced" names a serving version, not an update's predecessor that was not serving.
  expect(outcomes([row({ state: 'starting', replacedRunId: null, previousRunId: randomUUID() })])).toEqual([['starting', false, false]]);
  // Rows written before these facts claim nothing they cannot prove: a stopped one may or may not have
  // served, and an update's previousRunId named a predecessor serving or not, so no switch is told.
  const legacy = row({ state: 'stopped' }); const legacyFailed = row({ state: 'failed', error: 'startup-failed', runId: legacy.runId });
  expect(outcomes([row({ state: 'ready', previousRunId: legacy.runId }), legacyFailed, legacy])).toEqual([['online', false, false], ['not-started', false, false], ['stopped', false, false]]);
  // One read per run, however often it was deployed, and at most the cap.
  runOf.mockClear();
  const same = randomUUID();
  const many = Array.from({ length: HOSTING_HISTORY_MAX + 3 }, () => row({ state: 'stopped', runId: same, readyAt: at, replacedRunId: null }));
  const told = hostingHistory(many, runOf);
  expect(told).toHaveLength(HOSTING_HISTORY_MAX);
  expect(runOf).toHaveBeenCalledTimes(1);
  expect(told[0]).toMatchObject({ title: `title ${same.slice(0, 4)}`, traceId: `trace-${same}` });
});

it('retires a predecessor that stopped answering while the new version started', async () => {
  const { second, online } = await onlineWithNewerVersion();
  launcher.startHosting.mockImplementation(async () => {
    // A health check fails the online version while the new one starts.
    const row = service.deps.store.list(viewer.orgId, projectId).find(r => r.deploymentId === online.deploymentId)!;
    service.deps.store.update({ ...row, state: 'failed', error: 'runtime-unavailable', hostPort: null }, 'ready');
    return { hostPort: 23456, image: 'runtime@sha256:abc' };
  });
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  expect(launcher.stopHosting).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: online.deploymentId }));
  expect(service.deps.store.list(viewer.orgId, projectId).map(r => [r.runId, r.state])).toEqual([[second.runId, 'ready'], [online.runId, 'stopped']]);
  expect(narrated().map(([, , outcome]) => outcome)).toEqual(['online', 'ended']);
});

it('never stops the version it just started when a concurrent check changes its predecessor during the clean-up', async () => {
  const { second, online } = await onlineWithNewerVersion();
  launcher.stopHosting.mockImplementation(async id => {
    if (id.deploymentId !== online.deploymentId) return;
    // The predecessor's container is already gone: a health check marks it unavailable mid-stop.
    const row = service.deps.store.list(viewer.orgId, projectId).find(r => r.deploymentId === online.deploymentId)!;
    service.deps.store.update({ ...row, state: 'failed', error: 'runtime-unavailable', hostPort: null }, 'ready');
  });
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId }); await service.idle();
  const updated = service.status(viewer, projectId);
  expect(updated).toMatchObject({ state: 'ready', runId: second.runId });
  expect(launcher.stopHosting).not.toHaveBeenCalledWith(expect.objectContaining({ deploymentId: updated.deploymentId }));
  expect(service.deps.store.list(viewer.orgId, projectId).map(r => r.state)).toEqual(['ready', 'stopped']);
});

it('lets Stop finish when the clean-up of a just-started version recorded the same predecessor stopped first', async () => {
  const { second, online } = await onlineWithNewerVersion();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let retiring!: () => void; const retireStarted = new Promise<void>(resolve => { retiring = resolve; });
  let calls = 0;
  launcher.startHosting.mockImplementation(async () => {
    const row = service.deps.store.list(viewer.orgId, projectId).find(r => r.deploymentId === online.deploymentId)!;
    service.deps.store.update({ ...row, state: 'failed', error: 'runtime-unavailable', hostPort: null }, 'ready');
    return { hostPort: 23456, image: 'runtime@sha256:abc' };
  });
  const predecessorState = () => service.deps.store.list(viewer.orgId, projectId).find(r => r.deploymentId === online.deploymentId)!.state;
  launcher.stopHosting.mockImplementation(async id => {
    if (id.deploymentId !== online.deploymentId) return;
    // The clean-up's stop of the predecessor is held until Stop has listed it; Stop's own stop
    // of it then waits until the clean-up recorded it stopped, so Stop's write comes second.
    if (++calls === 1) { retiring(); await held; return; }
    release();
    await vi.waitFor(() => expect(predecessorState()).toBe('stopped'));
  });
  await service.update(viewer, projectId, { ...ref(second), expectedDeploymentId: online.deploymentId });
  await retireStarted;
  const updated = service.status(viewer, projectId);
  expect(updated).toMatchObject({ state: 'ready', runId: second.runId });
  const stopping = service.stop(viewer, projectId, updated.deploymentId);
  await expect(stopping).resolves.toMatchObject({ state: 'stopped' });
  await service.idle();
  expect(service.deps.store.list(viewer.orgId, projectId).map(r => r.state)).toEqual(['stopped', 'stopped']);
});
