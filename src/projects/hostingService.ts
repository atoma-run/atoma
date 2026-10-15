import { readHostingManifest } from './hostingManifest.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Viewer } from '../auth/store.js';
import { hostingDeployInputSchema, type HostedDeployment, type HostingIdentity, type HostingLauncher, type HostingSummary } from '../contracts/projectHosting.js';
import { ProjectHttpError, roleAtLeast } from './service.js';
import { ProjectStateConflict, type ProjectStore } from './store.js';
import type { PreviewStore } from '../preview/store.js';
import { materializePreviewWorkspace } from '../preview/policy.js';
import { revalidateArtifactManifest } from './artifacts.js';
import { HostingStore } from './hostingStore.js';
import { ensureHostingSubdomain, type HostingSubdomainNamer } from './hostingSubdomain.js';

const identity = (row: HostedDeployment): HostingIdentity => ({ orgId: row.orgId, projectId: row.projectId, deploymentId: row.deploymentId });

export class HostingService {
  private healthBusy = false;
  private readonly mutating = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  constructor(readonly deps: { store: HostingStore; projects: ProjectStore; previews: PreviewStore;
    launcher: HostingLauncher; domain: string; maxDeployments: number; probe(port: number): Promise<boolean>;
    events?: PlatformEventSink;
    /** Proposes the project's address label; absent, the label is derived from its slug and name. */
    namer?: HostingSubdomainNamer;
    copyOwnership?: { uid: number; gid: number } | null }) {}
  private event(row: HostedDeployment, principalId?: string): void {
    this.deps.events?.({ kind: row.state === 'failed' ? 'project.hosting_failed' : 'project.hosting_changed',
      actorType: principalId ? 'principal' : 'system', ...(principalId ? { actorId: principalId } : {}),
      orgId: row.orgId, projectId: row.projectId, summary: `Project application ${row.state}`,
      detail: { deploymentId: row.deploymentId, runId: row.runId, state: row.state, commitSha: row.commitSha } });
  }
  private project(viewer: Viewer, projectId: string, write = false) {
    const project = this.deps.projects.getProject(viewer.orgId, projectId);
    if (!project) throw new ProjectHttpError(404, 'Project not found');
    if (write && !roleAtLeast(viewer.role, 'org:admin')) throw new ProjectHttpError(403, 'An organisation administrator is required');
    return project;
  }
  /** The project's assigned label; a project deployed before labels existed keeps `p-<uuid>` until it gets one. */
  private hostOf(orgId: string, projectId: string): string {
    const label = this.deps.projects.getProject(orgId, projectId)?.hostingSubdomain;
    return `${label ?? `p-${projectId}`}.${this.deps.domain}`;
  }
  host(row: HostedDeployment): string { return this.hostOf(row.orgId, row.projectId); }
  status(viewer: Viewer, projectId: string): HostingSummary {
    const project = this.project(viewer, projectId);
    const rows = this.deps.store.list(viewer.orgId, projectId); const row = rows[0];
    const active = rows.find(r => r.state === 'ready');
    const run = this.deps.projects.acceptedReference(viewer.orgId, projectId);
    const publication = run ? this.deps.projects.getPublicationForRun(viewer.orgId, run.projectRunId) : null;
    const descriptor = run ? this.deps.previews.getDescriptor(viewer.orgId, run.projectRunId) : null;
    let browser = false;
    try { browser = !!(run && readHostingManifest(run.hostPaths.workspacePath, run.artifactManifest)); } catch { /* invalid capability is not deployable */ }
    return { available: true, state: row?.state ?? 'not-deployed', deploymentId: row?.deploymentId ?? null,
      runId: active?.runId ?? row?.runId ?? null, commitSha: active?.commitSha ?? row?.commitSha ?? null,
      url: active ? `https://${this.host(active)}/` : null, error: row?.error ?? null,
      address: project.hostingSubdomain ? `https://${project.hostingSubdomain}.${this.deps.domain}/` : null,
      candidate: run?.artifactManifestHash && !run.bytesExpiredAt && (descriptor?.availability === 'available' || browser) && publication?.status === 'published' && publication.commitSha
        ? { runId: run.projectRunId, manifestHash: run.artifactManifestHash, commitSha: publication.commitSha } : null };
  }
  async deploy(viewer: Viewer, projectId: string, raw: unknown): Promise<HostingSummary> {
    const project = this.project(viewer, projectId, true);
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    if (project.deploymentDestination !== 'atoma') throw new ProjectHttpError(409, 'Save Deploy on Atoma first');
    const parsed = hostingDeployInputSchema.safeParse(raw);
    if (!parsed.success) throw new ProjectHttpError(400, 'Invalid deployment request');
    const input = parsed.data;
    const run = this.deps.projects.getProjectRun(viewer.orgId, input.runId);
    const acceptance = this.deps.projects.getDeliveryAcceptance(viewer.orgId, input.runId);
    const publication = this.deps.projects.getPublicationForRun(viewer.orgId, input.runId);
    const descriptor = this.deps.previews.getDescriptor(viewer.orgId, input.runId);
    let browserConfig;
    try { browserConfig = run ? readHostingManifest(run.hostPaths.workspacePath, run.artifactManifest) : null; }
    catch { throw new ProjectHttpError(409, 'Invalid hosting configuration in the accepted delivery'); }
    if (!run || run.projectId !== projectId || run.status !== 'delivered' || run.bytesExpiredAt || run.rerunOf ||
      !run.artifactManifest || run.artifactManifestHash !== input.manifestHash || acceptance?.manifestHash !== input.manifestHash ||
      publication?.status !== 'published' || publication.manifestHash !== input.manifestHash || !publication.commitSha || (!browserConfig && descriptor?.availability !== 'available')) {
      throw new ProjectHttpError(409, 'Deploy an accepted, published, retained application version');
    }
    // Normally chosen when the destination was saved; a project saved before
    // addresses existed, or whose choice is still in flight, gets it here.
    if (!project.hostingSubdomain) await ensureHostingSubdomain({ store: this.deps.projects, namer: this.deps.namer, events: this.deps.events }, viewer.orgId, projectId);
    const row: HostedDeployment = { orgId: viewer.orgId, projectId, deploymentId: randomUUID(), runId: input.runId,
      manifestHash: input.manifestHash, commitSha: publication.commitSha, state: 'starting', kind: browserConfig ? 'node' : descriptor!.kind!, browser: !!browserConfig,
      entry: browserConfig?.entry ?? descriptor?.entry ?? 'index.js', createdAt: new Date().toISOString(), error: null, hostPort: null, image: null };
    try { this.deps.store.reserve(row, input.expectedDeploymentId, this.deps.maxDeployments); }
    catch (e) { if (e instanceof ProjectStateConflict) throw new ProjectHttpError(409, e.message); throw e; }
    this.event(row, viewer.principalId);
    const job = (async () => {
      try {
        const destination = await this.deps.launcher.prepareHosting(identity(row));
        materializePreviewWorkspace({ sourceRoot: run.hostPaths.workspacePath, destinationRoot: destination, preserveExecutable: true,
          ...(this.deps.copyOwnership ? { ownership: this.deps.copyOwnership } : {}) });
        revalidateArtifactManifest({ workspaceRoot: destination, manifest: run.artifactManifest!, expectedHash: row.manifestHash });
        const handle = await this.deps.launcher.startHosting({ orgId: row.orgId, projectId, deploymentId: row.deploymentId, kind: row.kind, entry: row.entry, browser: row.browser });
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          if (await this.deps.probe(handle.hostPort).catch(() => false)) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!ready) throw new Error('Not ready');
        this.deps.store.update({ ...row, state: 'ready', ...handle }, 'starting');
        this.event({ ...row, state: 'ready' });
        // Static replacements have no application data writers. Node replacements require an explicit stop.
        for (const previous of this.deps.store.list(row.orgId, projectId)) {
          if (previous.state === 'ready' && previous.deploymentId !== row.deploymentId) {
            try {
              await this.deps.launcher.stopHosting(identity(previous));
              this.deps.store.update({ ...previous, state: 'stopped' }, 'ready');
            } catch {
              this.deps.store.update({ ...previous, state: 'failed', error: 'cleanup-failed' }, 'ready');
            }
          }
        }
      } catch {
        const clean = await this.deps.launcher.stopHosting(identity(row)).then(() => true, () => false);
        const current = this.deps.store.list(row.orgId, projectId).find(r => r.deploymentId === row.deploymentId);
        if (current?.state === 'starting') {
          const failed = { ...row, state: 'failed' as const, error: clean ? 'startup-failed' as const : 'cleanup-failed' as const };
          this.deps.store.update(failed, 'starting'); this.event(failed);
        }
      }
    })();
    this.jobs.add(job); void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return this.status(viewer, projectId);
  }
  async stop(viewer: Viewer, projectId: string, expectedId: unknown): Promise<HostingSummary> {
    this.project(viewer, projectId, true);
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    const rows = this.deps.store.list(viewer.orgId, projectId);
    if (rows[0]?.deploymentId !== expectedId || rows.some(r => r.state === 'starting')) throw new ProjectHttpError(409, 'Deployment changed or still starting');
    this.mutating.add(projectId);
    try {
    for (const row of rows.filter(r => r.state === 'ready' || r.deploymentId === expectedId || r.error === 'runtime-unavailable' || r.error === 'cleanup-failed')) {
      await this.deps.launcher.stopHosting(identity(row));
      this.deps.store.update({ ...row, state: 'stopped', hostPort: null, error: null }, row.state);
      this.event({ ...row, state: 'stopped' }, viewer.principalId);
    }
    } finally { this.mutating.delete(projectId); }
    return this.status(viewer, projectId);
  }
  async recover(): Promise<void> {
    for (const row of this.deps.store.list()) {
      if (row.state === 'starting') {
        await this.deps.launcher.stopHosting(identity(row));
        this.deps.store.update({ ...row, state: 'failed', error: 'interrupted' }, 'starting');
      } else if (row.error !== 'cleanup-failed') {
        const handle = await this.deps.launcher.inspectHosting(identity(row));
        if (handle && await this.deps.probe(handle.hostPort)) this.deps.store.update({ ...row, ...handle, state: 'ready', error: null }, row.state);
        else this.deps.store.update({ ...row, state: 'failed', error: 'runtime-unavailable', hostPort: null }, row.state);
      }
    }
  }
  async refreshHealth(): Promise<void> {
    if (this.healthBusy) return;
    this.healthBusy = true;
    try {
      for (const row of this.deps.store.list()) {
        if (this.mutating.has(row.projectId) || (row.state !== 'ready' && row.error !== 'runtime-unavailable')) continue;
        const handle = await this.deps.launcher.inspectHosting(identity(row)).catch(() => null);
        const healthy = handle && await this.deps.probe(handle.hostPort).catch(() => false);
        const current = this.deps.store.list(row.orgId, row.projectId).find(r => r.deploymentId === row.deploymentId);
        if (this.mutating.has(row.projectId) || current?.state !== row.state) continue;
        const next = healthy ? { ...row, ...handle, state: 'ready' as const, error: null }
          : { ...row, state: 'failed' as const, error: 'runtime-unavailable' as const, hostPort: null };
        if (next.state !== row.state) { this.deps.store.update(next, row.state); this.event(next); }
      }
    } finally { this.healthBusy = false; }
  }
  async idle(): Promise<void> { await Promise.all(this.jobs); }
}

/** Readiness must reach a successful application response, not a relay-generated 502. */
export function probeHostedApplication(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, res => {
      res.resume(); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); }); req.end();
  });
}
