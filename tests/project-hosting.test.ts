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
import { HostingService } from '../src/projects/hostingService.js';
import { PreviewStore } from '../src/preview/store.js';
import { recordDeliveredPreview } from '../src/preview/service.js';
import { buildWorkspaceArtifactManifest } from '../src/projects/artifacts.js';
import { hostingConfig } from '../src/projects/hostingConfig.js';
import type { HostingIdentity, HostingLaunch } from '../src/contracts/projectHosting.js';

let root: string; let db: Database.Database; let projects: ProjectStore; let service: HostingService;
let viewer: Viewer; let projectId: string; let runId: string; let manifestHash: string;
let source: string;
const launcher = { prepareHosting: vi.fn(async (_id: HostingIdentity) => ''), startHosting: vi.fn(async (_spec: HostingLaunch) => ({ hostPort: 12345, image: 'runtime@sha256:abc' })), inspectHosting: vi.fn(async () => ({ hostPort: 12345, image: 'runtime@sha256:abc' })), stopHosting: vi.fn(async (_id: HostingIdentity) => {}) };
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
    previous: { runId: first.runId, manifestHash: first.manifestHash, title: 'First control page', commitSha: 'c'.repeat(40) } });
  // Only the version the update stopped can be put back, and only against the state that was shown.
  await expect(service.restore(viewer, projectId, { ...ref(second), expectedDeploymentId: failed.deploymentId })).rejects.toMatchObject({ status: 409 });
  await expect(service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: online.deploymentId })).rejects.toMatchObject({ status: 409 });
  await expect(service.restore({ ...viewer, role: 'org:member' }, projectId, { ...ref(first), expectedDeploymentId: failed.deploymentId })).rejects.toMatchObject({ status: 403 });
  await service.restore(viewer, projectId, { ...ref(first), expectedDeploymentId: failed.deploymentId }); await service.idle();
  expect(service.status(viewer, projectId)).toMatchObject({ state: 'ready', runId: first.runId, previous: null,
    candidate: { runId: second.runId } });
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
});

it('holds the online version from retention', async () => {
  asNodeApplication();
  const { first, second } = await onlineWithNewerVersion();
  db.prepare("UPDATE project_runs SET ended_at = '2025-01-02T00:00:00.000Z' WHERE project_run_id IN (?, ?)").run(first.runId, second.runId);
  const plan = retentionPlan(db, realpathSync(root), undefined, new Date('2026-10-25T00:00:00Z'));
  expect(plan.find(row => row.runId === first.runId)?.held).toBe('hosted application version');
  expect(plan.find(row => row.runId === second.runId)?.held).toBe('accepted project reference');
});
