import { readHostingManifest } from './hostingManifest.js';
import type { PlatformEventSink } from '../contracts/platformEvents.js';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Viewer } from '../auth/store.js';
import { existsSync } from 'node:fs';
import { hostingDeployInputSchema, type HostedDeployment, type HostingHandle, type HostingIdentity, type HostingLauncher, type HostingSummary, type HostingVersion } from '../contracts/projectHosting.js';
import type { ProjectRun } from '../contracts/projects.js';
import { ProjectHttpError, roleAtLeast } from './service.js';
import { ProjectStateConflict, type ProjectStore } from './store.js';
import type { PreviewStore } from '../preview/store.js';
import { materializePreviewWorkspace } from '../preview/policy.js';
import { revalidateArtifactManifest } from './artifacts.js';
import { holdsApplicationData, HostingStore } from './hostingStore.js';
import { ensureHostingSubdomain, type HostingSubdomainNamer } from './hostingSubdomain.js';

const identity = (row: HostedDeployment): HostingIdentity => ({ orgId: row.orgId, projectId: row.projectId, deploymentId: row.deploymentId });
/** A project's update between stopping its online version and the new one's readiness or failure. */
interface Swap { orgId: string; projectId: string; browser: boolean; settled: Promise<void>; end(): void }
/**
 * How a RUNNING application is judged unavailable (incident 2026-10-26: a
 * browser application on one CPU, busy in Chromium, missed one 2 s probe; its
 * row flapped failed/ready every check and the gateway answered 404 to its own
 * page while it kept working). A check runs every `intervalMs`; its probe waits
 * `timeoutMs`, under the interval so a sweep of two deployments rarely skips a
 * tick (a skipped tick is dropped, never queued). Only `failures` consecutive
 * failed checks mark the row failed: about 30 s of an application not answering
 * within 10 s, three times. A dead process refuses at once, so it is declared
 * within three ticks; a container the launcher no longer has fails at once.
 * Readiness at start keeps its own 2 s probe and 30 s bound.
 */
export const HOSTING_HEALTH = { intervalMs: 15_000, timeoutMs: 10_000, failures: 3 };

export class HostingService {
  private healthBusy = false;
  /** Consecutive failed checks of each ready deployment; reset on success, on any state change, and when the row leaves the listing. */
  private readonly healthFailures = new Map<string, number>();
  private readonly mutating = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  constructor(readonly deps: { store: HostingStore; projects: ProjectStore; previews: PreviewStore;
    launcher: HostingLauncher; domain: string; maxDeployments: number; probe(port: number): Promise<boolean>;
    /** The periodic check's probe, with its longer timeout (`HOSTING_HEALTH`); absent, `probe`. */
    healthProbe?(port: number): Promise<boolean>;
    events?: PlatformEventSink;
    /** Proposes the project's address label; absent, the label is derived from its slug and name. */
    namer?: HostingSubdomainNamer;
    copyOwnership?: { uid: number; gid: number } | null }) {}
  private event(row: HostedDeployment, principalId?: string, operation?: 'update' | 'restore'): void {
    this.deps.events?.({ kind: row.state === 'failed' ? 'project.hosting_failed' : 'project.hosting_changed',
      actorType: principalId ? 'principal' : 'system', ...(principalId ? { actorId: principalId } : {}),
      orgId: row.orgId, projectId: row.projectId, summary: `Project application ${row.state}`,
      detail: { deploymentId: row.deploymentId, runId: row.runId, state: row.state, commitSha: row.commitSha, ...(operation ? { operation } : {}) } });
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
  /**
   * Where each listed project's application answers now, for lists the
   * caller already authorised: online deployments only, newest first.
   */
  onlineUrls(projectIds: readonly string[]): Map<string, string> {
    const wanted = new Set(projectIds); const urls = new Map<string, string>();
    for (const row of this.deps.store.list().filter(r => r.state === 'ready' && wanted.has(r.projectId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!urls.has(row.projectId)) urls.set(row.projectId, `https://${this.host(row)}/`);
    }
    return urls;
  }
  /**
   * The project whose CURRENT address is `host`, online or not: its label, or
   * `p-<id>` while it has none. The gateway asks it only to check a visitor's
   * grant when nothing serves there; it decides nothing else.
   */
  projectAt(host: string): { orgId: string; projectId: string } | null {
    const suffix = `.${this.deps.domain}`;
    return host.endsWith(suffix) ? this.deps.projects.projectAtHostingLabel(host.slice(0, -suffix.length)) : null;
  }
  /**
   * Where a retired address now lives: the project's CURRENT address, never
   * the next hop, so a twice-renamed project still answers in one redirect.
   * Null for anything that is not a retired label under this domain.
   */
  movedHost(host: string): string | null {
    const suffix = `.${this.deps.domain}`;
    if (!host.endsWith(suffix)) return null;
    const current = this.deps.projects.hostingAliasTarget(host.slice(0, -suffix.length));
    return current ? `${current}${suffix}` : null;
  }
  status(viewer: Viewer, projectId: string): HostingSummary {
    const project = this.project(viewer, projectId);
    const rows = this.deps.store.list(viewer.orgId, projectId); const row = rows[0];
    const active = rows.find(r => r.state === 'ready');
    const run = this.deps.projects.acceptedReference(viewer.orgId, projectId);
    const publication = run ? this.deps.projects.getPublicationForRun(viewer.orgId, run.projectRunId) : null;
    const descriptor = run ? this.deps.previews.getDescriptor(viewer.orgId, run.projectRunId) : null;
    let browser = false;
    try { browser = !!(run && readHostingManifest(run.hostPaths.workspacePath, run.artifactManifest)); } catch { /* invalid capability is not deployable */ }
    const shown = active ?? row;
    const previous = this.restorable(viewer.orgId, projectId, rows);
    return { available: true, state: row?.state ?? 'not-deployed', deploymentId: row?.deploymentId ?? null,
      runId: shown?.runId ?? null, commitSha: shown?.commitSha ?? null,
      url: active ? `https://${this.host(active)}/` : null, error: row?.error ?? null,
      address: project.hostingSubdomain ? `https://${project.hostingSubdomain}.${this.deps.domain}/` : null,
      candidate: run?.artifactManifestHash && !run.bytesExpiredAt && (descriptor?.availability === 'available' || browser) && publication?.status === 'published' && publication.commitSha
        ? { ...this.describe(viewer.orgId, run.projectRunId, publication.commitSha), manifestHash: run.artifactManifestHash } : null,
      version: shown ? this.describe(viewer.orgId, shown.runId, shown.commitSha) : null,
      previous: previous ? { ...this.describe(viewer.orgId, previous.runId, previous.commitSha), manifestHash: previous.manifestHash } : null,
      updateStops: rows.some(holdsApplicationData),
      failed: row?.state === 'failed' && row.error !== 'runtime-unavailable' ? { runId: row.runId } : null };
  }
  /** A version in words: the run's title and the client's acceptance date, never only its hash. */
  private describe(orgId: string, runId: string, commitSha: string): HostingVersion {
    return { runId, commitSha, title: this.deps.projects.getProjectRun(orgId, runId)?.title ?? null,
      acceptedAt: this.deps.projects.getDeliveryAcceptance(orgId, runId)?.acceptedAt ?? null };
  }
  /**
   * One deployable release: an accepted, published, retained delivery of this
   * project whose manifest is the one accepted. Every operation that puts a
   * version online goes through it, the put-back included.
   */
  private release(orgId: string, projectId: string, runId: string, manifestHash: string) {
    const run = this.deps.projects.getProjectRun(orgId, runId);
    const acceptance = this.deps.projects.getDeliveryAcceptance(orgId, runId);
    const publication = this.deps.projects.getPublicationForRun(orgId, runId);
    const descriptor = this.deps.previews.getDescriptor(orgId, runId);
    let browserConfig;
    try { browserConfig = run ? readHostingManifest(run.hostPaths.workspacePath, run.artifactManifest) : null; }
    catch { throw new ProjectHttpError(409, 'Invalid hosting configuration in the accepted delivery'); }
    if (!run || run.projectId !== projectId || run.status !== 'delivered' || run.bytesExpiredAt || run.rerunOf ||
      !run.artifactManifest || run.artifactManifestHash !== manifestHash || acceptance?.manifestHash !== manifestHash ||
      publication?.status !== 'published' || publication.manifestHash !== manifestHash || !publication.commitSha || (!browserConfig && descriptor?.availability !== 'available')) {
      throw new ProjectHttpError(409, 'Deploy an accepted, published, retained application version');
    }
    return { run, commitSha: publication.commitSha, browserConfig, descriptor };
  }
  /**
   * The version to put back: the one an update stopped, while that update's
   * new version failed to start and nothing is online. Offered only while it
   * is still deployable and its retained bytes are on disk (retention holds
   * them: src/projects/retention.ts).
   */
  private restorable(orgId: string, projectId: string, rows: HostedDeployment[]): { runId: string; manifestHash: string; commitSha: string } | null {
    const latest = rows[0];
    if (!latest?.previousRunId || latest.state !== 'failed' || latest.error === 'runtime-unavailable' ||
      rows.some(r => r.state === 'ready' || r.state === 'starting')) return null;
    const run = this.deps.projects.getProjectRun(orgId, latest.previousRunId);
    if (!run?.artifactManifestHash || !existsSync(run.hostPaths.workspacePath)) return null;
    try {
      const release = this.release(orgId, projectId, run.projectRunId, run.artifactManifestHash);
      return { runId: run.projectRunId, manifestHash: run.artifactManifestHash, commitSha: release.commitSha };
    } catch { return null; }
  }
  private parseInput(raw: unknown) {
    const parsed = hostingDeployInputSchema.safeParse(raw);
    if (!parsed.success) throw new ProjectHttpError(400, 'Invalid deployment request');
    return parsed.data;
  }
  private newRow(orgId: string, projectId: string, input: { runId: string; manifestHash: string },
    release: ReturnType<HostingService['release']>, previousRunId?: string): HostedDeployment {
    return { orgId, projectId, deploymentId: randomUUID(), runId: input.runId,
      manifestHash: input.manifestHash, commitSha: release.commitSha, state: 'starting', kind: release.browserConfig ? 'node' : release.descriptor!.kind!, browser: !!release.browserConfig,
      entry: release.browserConfig?.entry ?? release.descriptor?.entry ?? 'index.js', createdAt: new Date().toISOString(), error: null, hostPort: null, image: null,
      ...(previousRunId ? { previousRunId } : {}) };
  }
  private reserve(row: HostedDeployment, expected: string | null): void {
    try { this.deps.store.reserve(row, expected, this.deps.maxDeployments); }
    catch (e) { if (e instanceof ProjectStateConflict) throw new ProjectHttpError(409, e.message); throw e; }
  }
  async deploy(viewer: Viewer, projectId: string, raw: unknown): Promise<HostingSummary> {
    const project = this.project(viewer, projectId, true);
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    if (project.deploymentDestination !== 'atoma') throw new ProjectHttpError(409, 'Save Deploy on Atoma first');
    const input = this.parseInput(raw);
    const release = this.release(viewer.orgId, projectId, input.runId, input.manifestHash);
    // Normally chosen when the destination was saved; a project saved before
    // addresses existed, or whose choice is still in flight, gets it here.
    if (!project.hostingSubdomain) await ensureHostingSubdomain({ store: this.deps.projects, namer: this.deps.namer, events: this.deps.events }, viewer.orgId, projectId);
    // An update may have begun while the address was chosen: it owns the project until its reservation.
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    const row = this.newRow(viewer.orgId, projectId, input, release);
    this.reserve(row, input.expectedDeploymentId);
    this.event(row, viewer.principalId);
    this.launch(row, release.run);
    return this.status(viewer, projectId);
  }
  /**
   * "Update the application": the accepted candidate replaces what runs now,
   * in one request. A runtime that may write the project's data is stopped
   * first, under the same lock and compare-and-set as Stop, and the candidate
   * is reserved only after every such runtime stopped: the store refuses a
   * start beside one, so two versions never write the data at once. A static
   * application keeps its no-downtime replacement. If the new version then
   * fails to start, the status offers the stopped version back (`restore`).
   */
  async update(viewer: Viewer, projectId: string, raw: unknown): Promise<HostingSummary> {
    return this.replace(viewer, projectId, raw, 'update');
  }
  /** Puts back the version a failed update stopped: the same sequence, its target chosen by the host. */
  async restore(viewer: Viewer, projectId: string, raw: unknown): Promise<HostingSummary> {
    return this.replace(viewer, projectId, raw, 'restore');
  }
  private async replace(viewer: Viewer, projectId: string, raw: unknown, operation: 'update' | 'restore'): Promise<HostingSummary> {
    const project = this.project(viewer, projectId, true);
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    if (project.deploymentDestination !== 'atoma') throw new ProjectHttpError(409, 'Save Deploy on Atoma first');
    const input = this.parseInput(raw);
    const expectedRows = (rows: HostedDeployment[]) => {
      if ((rows[0]?.deploymentId ?? null) !== input.expectedDeploymentId || rows.some(r => r.state === 'starting')) {
        throw new ProjectHttpError(409, 'Deployment changed or still starting');
      }
    };
    const before = this.deps.store.list(viewer.orgId, projectId);
    expectedRows(before);
    if (operation === 'update') {
      // The version the person was shown must still be the one to put online.
      if (this.deps.projects.acceptedReference(viewer.orgId, projectId)?.projectRunId !== input.runId) {
        throw new ProjectHttpError(409, 'A newer accepted version exists; refresh before updating');
      }
    } else if (this.restorable(viewer.orgId, projectId, before)?.runId !== input.runId) {
      throw new ProjectHttpError(409, 'The previous version can no longer be put back');
    }
    const release = this.release(viewer.orgId, projectId, input.runId, input.manifestHash);
    if (!project.hostingSubdomain) await ensureHostingSubdomain({ store: this.deps.projects, namer: this.deps.namer, events: this.deps.events }, viewer.orgId, projectId);
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    this.mutating.add(projectId);
    const rows = this.deps.store.list(viewer.orgId, projectId);
    let row: HostedDeployment | undefined; let swap: Swap | undefined; let stopped = false; let reserved = false;
    try {
      expectedRows(rows);
      const online = rows.find(r => r.state === 'ready') ?? rows.find(holdsApplicationData);
      row = this.newRow(viewer.orgId, projectId, input, release, operation === 'update' ? online?.runId : undefined);
      // Everything that does not touch the online version happens before it
      // stops: bytes copied and revalidated, engine objects created. A failure
      // here stops nothing; the online version keeps serving.
      await this.prepare(row, release.run);
      expectedRows(this.deps.store.list(viewer.orgId, projectId));
      const holders = this.deps.store.list(viewer.orgId, projectId).filter(r => r.state === 'ready' || holdsApplicationData(r));
      if (holders.some(holdsApplicationData)) {
        // From here until the new version is ready (or failed), the gateway
        // holds this project's visitors instead of answering errors.
        swap = this.beginSwap(row);
        await this.stopRows(holders, viewer.principalId, operation);
        stopped = true;
      }
      try { this.reserve(row, input.expectedDeploymentId); reserved = true; }
      catch (error) {
        // The online version is already stopped: say so, and offer it back.
        if (stopped) this.recordNotStarted(row, viewer.principalId, operation);
        throw error;
      }
    } catch (error) {
      if (row && !reserved) await this.deps.launcher.stopHosting(identity(row)).catch(() => undefined);
      swap?.end();
      throw error;
    } finally { this.mutating.delete(projectId); }
    this.event(row, viewer.principalId, operation);
    this.launch(row, release.run, { prepared: true, ...(swap ? { swap } : {}) });
    return this.status(viewer, projectId);
  }
  private launchSpec(row: HostedDeployment) {
    return { orgId: row.orgId, projectId: row.projectId, deploymentId: row.deploymentId, kind: row.kind, entry: row.entry, browser: row.browser };
  }
  /**
   * Copies the release's retained bytes into the deployment's own directory,
   * revalidates them against the accepted manifest, and, when `engine`, creates
   * its engine objects without starting them. A launcher from before
   * `createHosting` answers `invalid-request`; its start then creates them.
   */
  private async prepare(row: HostedDeployment, run: ProjectRun, engine = true): Promise<void> {
    const destination = await this.deps.launcher.prepareHosting(identity(row));
    try {
      materializePreviewWorkspace({ sourceRoot: run.hostPaths.workspacePath, destinationRoot: destination, preserveExecutable: true,
        ...(this.deps.copyOwnership ? { ownership: this.deps.copyOwnership } : {}) });
      revalidateArtifactManifest({ workspaceRoot: destination, manifest: run.artifactManifest!, expectedHash: row.manifestHash });
    } catch (error) {
      if (!engine) throw error;
      throw new ProjectHttpError(409, 'The accepted version no longer matches its retained bytes; nothing was stopped');
    }
    if (!engine) return;
    try { await this.deps.launcher.createHosting(this.launchSpec(row)); }
    catch (error) { if (!(error instanceof Error && error.message === 'Launcher invalid-request')) throw error; }
  }
  /**
   * The online version stopped but the new one was never reserved: a failed
   * row that names the stopped version, so the put-back is offered. It holds
   * no data and no capacity. Best effort: the request already fails.
   */
  private recordNotStarted(row: HostedDeployment, principalId: string, operation: 'update' | 'restore'): void {
    const failed = { ...row, state: 'failed' as const, error: 'startup-failed' as const };
    try { this.deps.store.recordFailed(failed); this.event(failed, principalId, operation); } catch { /* the stop is journaled */ }
  }
  /** The swap window of each project being updated, for the gateway: see `swapping`. */
  private readonly swaps = new Map<string, Swap>();
  private beginSwap(row: HostedDeployment): Swap {
    let end!: () => void;
    const settled = new Promise<void>(resolve => { end = resolve; });
    const swap: Swap = { orgId: row.orgId, projectId: row.projectId, browser: !!row.browser, settled,
      end: () => { if (this.swaps.get(row.projectId) === swap) this.swaps.delete(row.projectId); end(); } };
    this.swaps.set(row.projectId, swap);
    return swap;
  }
  /**
   * The project answering at `host` while its update is between stopping the
   * online version and the new one's readiness or failure, or null. `settled`
   * resolves when that window closes, whatever its outcome.
   */
  swapping(host: string): Pick<Swap, 'orgId' | 'projectId' | 'browser' | 'settled'> | null {
    for (const swap of this.swaps.values()) if (this.hostOf(swap.orgId, swap.projectId) === host) return swap;
    return null;
  }
  private launch(row: HostedDeployment, run: ProjectRun, options: { prepared?: boolean; swap?: Swap } = {}): void {
    const projectId = row.projectId;
    const job = (async () => {
      try {
        if (!options.prepared) await this.prepare(row, run, false);
        const handle = await this.deps.launcher.startHosting(this.launchSpec(row));
        // Every quarter second, about thirty seconds as before: during an
        // update's swap, visitors wait for this answer.
        let ready = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          if (await this.deps.probe(handle.hostPort).catch(() => false)) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!ready) throw new Error('Not ready');
        this.deps.store.update({ ...row, state: 'ready', ...handle }, 'starting');
        options.swap?.end();
        this.event({ ...row, state: 'ready' });
        // Static replacements have no application data writers. A Node
        // replacement was reserved only after its predecessor stopped.
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
      } finally { options.swap?.end(); }
    })();
    this.jobs.add(job); void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
  }
  /** Stops each row, then records it stopped, in order; a launcher failure ends the sequence and propagates. */
  private async stopRows(rows: HostedDeployment[], principalId: string, operation?: 'update' | 'restore'): Promise<void> {
    for (const row of rows) {
      await this.deps.launcher.stopHosting(identity(row));
      this.deps.store.update({ ...row, state: 'stopped', hostPort: null, error: null }, row.state);
      this.event({ ...row, state: 'stopped' }, principalId, operation);
    }
  }
  async stop(viewer: Viewer, projectId: string, expectedId: unknown): Promise<HostingSummary> {
    this.project(viewer, projectId, true);
    if (this.mutating.has(projectId)) throw new ProjectHttpError(409, 'A deployment operation is still running');
    const rows = this.deps.store.list(viewer.orgId, projectId);
    if (rows[0]?.deploymentId !== expectedId || rows.some(r => r.state === 'starting')) throw new ProjectHttpError(409, 'Deployment changed or still starting');
    this.mutating.add(projectId);
    try {
      await this.stopRows(rows.filter(r => r.state === 'ready' || r.deploymentId === expectedId || r.error === 'runtime-unavailable' || r.error === 'cleanup-failed'), viewer.principalId);
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
        const healthy = handle && await this.deps.probe(handle.hostPort).catch(() => false);
        // A web restart (every deployment of Atoma) is no verdict on a busy
        // application: a running one that was ready stays so, one failure counted.
        if (handle && (healthy || row.state === 'ready')) this.deps.store.update({ ...row, ...handle, state: 'ready', error: null }, row.state);
        else this.deps.store.update({ ...row, state: 'failed', error: 'runtime-unavailable', hostPort: null }, row.state);
        if (handle && !healthy && row.state === 'ready') this.healthFailures.set(row.deploymentId, 1);
      }
    }
    await this.removeUnrecorded();
  }
  /**
   * Engine objects no running or unknown row names. An update creates its new
   * version before reserving it, so a web process that dies in between leaves
   * created containers and two networks with no row, holding address pools
   * forever. They are removed with the ordinary stop; data and release bytes
   * stay, as for every stopped deployment. Best effort: a launcher without the
   * listing, or an engine error, leaves them for the next boot.
   */
  private async removeUnrecorded(): Promise<void> {
    let found: HostingIdentity[];
    try { found = await this.deps.launcher.listHosting(); } catch { return; }
    const live = new Set(this.deps.store.list().map(row => row.deploymentId));
    for (const id of found) {
      if (!live.has(id.deploymentId)) await this.deps.launcher.stopHosting(id).catch(() => undefined);
    }
  }
  /**
   * One health check of every running or runtime-unavailable deployment. A
   * ready row survives `HOSTING_HEALTH.failures - 1` failed checks with its
   * port, so a busy application changes nothing and journals nothing; a
   * recovered one is ready again on its first good answer.
   */
  async refreshHealth(): Promise<void> {
    if (this.healthBusy) return;
    this.healthBusy = true;
    try {
      const rows = this.deps.store.list();
      const listed = new Set(rows.map(row => row.deploymentId));
      for (const id of this.healthFailures.keys()) if (!listed.has(id)) this.healthFailures.delete(id);
      for (const row of rows) {
        if (this.mutating.has(row.projectId) || (row.state !== 'ready' && row.error !== 'runtime-unavailable')) {
          this.healthFailures.delete(row.deploymentId); continue;
        }
        // An unreachable launcher says nothing about the application: it
        // restarts on a release change (src/launcher/releaseWatch.ts) while the
        // containers keep serving. Keep the state; the next check decides.
        let handle: HostingHandle | null;
        try { handle = await this.deps.launcher.inspectHosting(identity(row)); }
        catch { continue; }
        const healthy = !!handle && await (this.deps.healthProbe ? this.deps.healthProbe(handle.hostPort) : this.deps.probe(handle.hostPort)).catch(() => false);
        const current = this.deps.store.list(row.orgId, row.projectId).find(r => r.deploymentId === row.deploymentId);
        if (this.mutating.has(row.projectId) || current?.state !== row.state) { this.healthFailures.delete(row.deploymentId); continue; }
        if (healthy) {
          this.healthFailures.delete(row.deploymentId);
          const next = { ...row, ...handle!, state: 'ready' as const, error: null };
          if (row.state !== 'ready') { this.deps.store.update(next, row.state); this.event(next); }
          // A restarted engine republishes the relay on a new loopback port while
          // the application stays healthy: the gateway proxies to row.hostPort.
          else if (next.hostPort !== row.hostPort) this.deps.store.update(next, row.state);
          continue;
        }
        if (row.state !== 'ready') continue;
        // A container the launcher no longer has is gone now; a running one that
        // did not answer in time is one vote.
        const failures = handle ? (this.healthFailures.get(row.deploymentId) ?? 0) + 1 : HOSTING_HEALTH.failures;
        if (failures < HOSTING_HEALTH.failures) {
          this.healthFailures.set(row.deploymentId, failures);
          // The launcher's mapping is authoritative: a republished relay port is
          // adopted even while the probe misses, never kept stale for the gateway.
          if (handle && handle.hostPort !== row.hostPort) this.deps.store.update({ ...row, ...handle }, row.state);
          continue;
        }
        this.healthFailures.delete(row.deploymentId);
        const next = { ...row, state: 'failed' as const, error: 'runtime-unavailable' as const, hostPort: null };
        this.deps.store.update(next, row.state); this.event(next);
      }
    } finally { this.healthBusy = false; }
  }
  async idle(): Promise<void> { await Promise.all(this.jobs); }
}

/**
 * Readiness must reach a successful application response, not a relay-generated
 * 502. Two seconds at start; the periodic check passes `HOSTING_HEALTH.timeoutMs`.
 */
export function probeHostedApplication(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, res => {
      res.resume(); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400);
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); }); req.end();
  });
}
