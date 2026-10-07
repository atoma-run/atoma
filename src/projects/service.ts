import { summarizeTraceFile } from '../viz/runIndex.js';
import { isUtf8 } from 'node:buffer';
import { assertPublishableArtifactPath, normalizeArtifactPath, readManifestArtifact } from './artifacts.js';
import { MAX_WORKSPACE_PREVIEW_BYTES, type WorkspaceIndex, type WorkspaceFile } from '../contracts/workspaceBrowser.js';
import type { IncomingMessage } from 'node:http';
import type { Viewer } from '../auth/store.js';
import { roleAtLeast } from '../auth/store.js';
export { roleAtLeast } from '../auth/store.js';
import {
  createProjectInputSchema,
  projectIdSchema, projectRunIdSchema,
  projectShowcaseSchema,
  startProjectRunInputSchema,
  projectRunPublicSchema,
  type Project,
  type ProjectRun,
} from '../contracts/projects.js';
import { eventLabel, type CrossOrgRead, type CrossOrgReadSink, type PlatformEventSink } from '../contracts/platformEvents.js';
import { GitHubStore } from '../github/store.js';
import { PublicationSupersededError, type GitHubPublisher } from './publisher.js';
import { ProjectStateConflict, resolveProjectRunTraceFile } from './store.js';
import { projectRunHostRedactions, redactHostPaths } from './hostPaths.js';
import type { RunPayerLedger } from '../contracts/runPayers.js';
import {
  ProjectRunBusy,
  ProjectRunConfigurationError,
  ProjectRunCoordinator,
} from './coordinator.js';

/**
 * PROJECTS HTTP SERVICE — one boundary between the viz server and the
 * project control plane.
 *
 * Rules enforced HERE, once:
 * - Every read and write is scoped by the VIEWER's active organisation; an
 *   id supplied by the browser never selects the org.
 * - Write actions (create project, start run) require at least org:member;
 *   org:viewer can read but never execute (T9).
 * - Public projections omit host paths; the full ProjectRun stays internal.
 */

const MAX_JSON_BODY_BYTES = 64 * 1024;

export class ProjectHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ProjectHttpError';
  }
}


export interface ProjectServiceDeps {
  readonly store: import('./store.js').ProjectStore;
  readonly coordinator: ProjectRunCoordinator;
  readonly github: GitHubStore | null;
  readonly publisher?: Pick<GitHubPublisher, 'inspectTarget'>;
  /**
   * Optional audit sink, injected rather than imported: the project control
   * plane must not learn about the viz server's event log to be testable.
   * Absent means "no journal", never "broken".
   */
  readonly events?: PlatformEventSink;
  readonly auditRead?: CrossOrgReadSink;
  /**
   * Whether this host publishes the showcase (`ATOMA_PUBLIC_SHOWCASE`). Absent
   * means it does not: a project is then never reported as shown on it.
   */
  readonly showcaseEnabled?: () => boolean;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_JSON_BODY_BYTES) throw new ProjectHttpError(413, 'request body too large');
    chunks.push(bytes);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ProjectHttpError(400, 'request body is not valid JSON');
  }
}

function publicRun(
  run: ProjectRun,
  publication: import('../contracts/projects.js').Publication | null,
  models: RunPayerLedger | null
) {
  const base = projectRunPublicSchema.parse(run);
  // The projection omits `hostPaths`, and an error must not carry them back:
  // a spawn failure or a publication's staging error names the run's
  // directories (2026-09-25 adversarial review).
  const redactions = projectRunHostRedactions(run);
  const redacted = (text: string | null) => (text === null ? null : redactHostPaths(text, redactions));
  // Persisted project lifecycle time, including host finalization, not the
  // narrower trace duration. Missing launch/end times remain unknown.
  const elapsedMs = run.startedAt && run.endedAt
    ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
    : NaN;
  const traceFile = resolveProjectRunTraceFile({
    projectRunId: run.projectRunId,
    runsPath: run.hostPaths.runsPath,
    traceId: run.traceId,
  });
  const trace = traceFile ? summarizeTraceFile(traceFile) : null;
  return {
    ...base,
    error: redacted(base.error),
    traceId: run.traceId ?? (traceFile ? run.projectRunId : null),
    costUsd: run.stats?.costUsd ?? trace?.costUsd ?? null,
    tokens: trace?.tokens ?? null,
    llmCalls: run.stats?.llmCalls ?? trace?.calls ?? null,
    jevCalls: trace?.jevCalls ?? null,
    jevCallsLowerBound: trace?.jevCallsLowerBound ?? false,
    // The per-tier selectors this run was RESOLVED to, from the immutable payer
    // ledger written at start: what a relaunch on other models is compared
    // against. Null for a run started before the ledger existed.
    models,
    durationS: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs / 1000 : null,
    publication: publication
      ? {
          status: publication.status,
          repositoryFullName: publication.repositoryFullName,
          repositoryUrl: publication.repositoryUrl,
          git: publication.git ?? null,
          // Publication receipts do not establish today's branch head or PR merge state.
          remoteState: 'not-checked',
          mergeStatus: publication.pullRequestUrl || publication.git?.mode === 'pull-request'
            ? 'unknown' : publication.git?.mode === 'direct' ? 'not-applicable' : 'unknown',
          baseSha: publication.baseSha,
          error: redacted(publication.error),
          publishedAt: publication.publishedAt,
          updatedAt: publication.updatedAt,
          commitSha: publication.commitSha,
          ...(publication.pullRequestUrl ? { pullRequestUrl: publication.pullRequestUrl } : {}),
        }
      : null,
  };
}

function publicProject(
  project: Project,
  runSummary: { runCount: number; lastRunAt: string | null; costUsd: number | null } = {
    costUsd: 0,
    runCount: 0,
    lastRunAt: null,
  },
  showcaseShown = false
) {
  return {
    projectId: project.projectId,
    name: project.name,
    slug: project.slug,
    status: project.status,
    showcase: project.showcase,
    followUpstream: project.followUpstream,
    /**
     * Whether a visitor of the public showcase sees this project NOW: the host
     * publishes it, and one of its runs is in `listShowcaseRuns` — the very
     * read the page makes. A listed project with no such run is only eligible.
     */
    showcaseShown,
    repositoryTarget: project.repositoryTarget,
    repositoryStatus: project.repositoryStatus,
    repositoryFullName: project.repositoryFullName,
    repositoryUrl: project.repositoryUrl,
    repositoryDefaultBranch: project.defaultBranch,
    repositoryError: project.repositoryError,
    ...runSummary,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/** A run, or creation before the first run, is the activity visible on a project card. */
function newestActivityFirst(a: ReturnType<typeof publicProject>, b: ReturnType<typeof publicProject>): number {
  return (b.lastRunAt ?? b.createdAt).localeCompare(a.lastRunAt ?? a.createdAt)
    || b.createdAt.localeCompare(a.createdAt)
    || a.projectId.localeCompare(b.projectId);
}

export class ProjectService {
  private readonly store: import('./store.js').ProjectStore;
  private readonly coordinator: ProjectRunCoordinator;
  private readonly github: GitHubStore | null;
  private readonly events: PlatformEventSink;
  private readonly readAudit?: CrossOrgReadSink;
  private readonly publisher?: Pick<GitHubPublisher, 'inspectTarget'>;
  private readonly showcaseEnabled: () => boolean;

  constructor(deps: ProjectServiceDeps) {
    this.store = deps.store;
    this.readAudit = deps.auditRead;
    this.coordinator = deps.coordinator;
    this.github = deps.github;
    this.publisher = deps.publisher;
    // A no-op default keeps every emission site free of `?.` noise.
    this.events = deps.events ?? (() => undefined);
    this.showcaseEnabled = deps.showcaseEnabled ?? (() => false);
  }

  /** The projects a showcase visitor sees now, from the page's own read. */
  private shownOnShowcase(): ReadonlySet<string> {
    if (!this.showcaseEnabled()) return new Set();
    return new Set(this.store.listShowcaseRuns().map((run) => run.projectId));
  }

  private present(run: ProjectRun, publication: import('../contracts/projects.js').Publication | null) {
    return publicRun(run, publication, this.store.getRunPayers(run.orgId, run.projectRunId));
  }

  /** GET /api/github/installations — org-scoped. */
  listInstallations(viewer: Viewer): unknown {
    if (!this.github) return [];
    return this.github.listInstallations(viewer.orgId).map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
      targetType: installation.targetType,
      status: installation.status,
      repositorySelection: installation.repositorySelection,
    }));
  }

  /** GET /api/projects — a platform admin reads ALL organisations' projects. */
  listProjects(viewer: Viewer): unknown {
    const shown = this.shownOnShowcase();
    if (viewer.platformAdmin) {
      return this.store.listAllProjects().map((project) => {
        this.auditRead(viewer, project.orgId, 'projects.index');
        return {
          ...publicProject(project, this.store.projectRunSummary(project.orgId, project.projectId), shown.has(project.projectId)),
          orgId: project.orgId,
          orgName: project.orgName,
        };
      }).sort(newestActivityFirst);
    }
    return this.store.listProjects(viewer.orgId).map((project) =>
      publicProject(
        project,
        this.store.projectRunSummary(viewer.orgId, project.projectId),
        shown.has(project.projectId)
      )
    ).sort(newestActivityFirst);
  }

  /**
   * The organisation whose rows this viewer may read for `projectId`: their
   * own — or, for a platform admin, whichever organisation owns the project.
   * Reads only; writes stay bound to the viewer's active organisation.
   */
  private readOrgFor(viewer: Viewer, projectId: string): string {
    if (!viewer.platformAdmin) return viewer.orgId;
    const orgId = this.store.getProjectAnyOrg(projectId)?.orgId ?? viewer.orgId;
    this.auditRead(viewer, orgId, 'projects.detail');
    return orgId;
  }

  /** Audit an existing widening; this method never grants platform-admin power. */
  auditRead(viewer: Viewer, orgId: string, surface: CrossOrgRead['surface']): void {
    if (orgId === viewer.orgId) return;
    if (!viewer.platformAdmin) throw new ProjectHttpError(403, 'cross-organisation read denied');
    try {
      if (!this.readAudit) throw new Error('audit unavailable');
      if (this.readAudit({ actorId: viewer.principalId, orgId, surface }) !== true) throw new Error('audit not acknowledged');
    } catch {
      throw new ProjectHttpError(503, 'cross-organisation audit unavailable');
    }
  }
  /** POST /api/projects — org:member or above. */
  async createProject(req: IncomingMessage, viewer: Viewer): Promise<unknown> {
    return this.createProjectFromInput(viewer, await readJsonBody(req));
  }

  /**
   * Put a project of the viewer's organisation on, or take it off, the public
   * showcase. An organisation admin's decision, journaled; never another
   * organisation's project, platform admin or not (writes stay in the active
   * organisation).
   */
  async setFollowUpstream(req: IncomingMessage, viewer: Viewer, projectId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:admin')) throw new ProjectHttpError(403, 'org:admin role or above is required');
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || !('followUpstream' in body) ||
      typeof body.followUpstream !== 'boolean' || Object.keys(body).length !== 1) throw new ProjectHttpError(400, 'followUpstream must be a boolean');
    const before = this.store.getProject(viewer.orgId, projectId);
    if (!before) throw new ProjectHttpError(404, 'project not found');
    if (before.repositoryTarget.source?.mode !== 'fork') throw new ProjectHttpError(400, 'followUpstream requires a fork');
    const project = this.store.setFollowUpstream(viewer.orgId, projectId, body.followUpstream)!;
    if (before.followUpstream !== project.followUpstream) this.events({ kind: 'project.upstream_follow_changed',
      actorType: 'principal', actorId: viewer.principalId, orgId: viewer.orgId, projectId,
      summary: `Upstream following ${project.followUpstream ? 'enabled' : 'disabled'} for ${eventLabel(project.name, 80)}`,
      detail: { from: before.followUpstream, to: project.followUpstream } });
    return publicProject(project);
  }

  setProjectShowcase(viewer: Viewer, projectId: string, showcaseInput: unknown): unknown {
    if (!roleAtLeast(viewer.role, 'org:admin')) {
      throw new ProjectHttpError(403, 'org:admin role or above is required to change what the showcase shows');
    }
    const showcase = projectShowcaseSchema.safeParse(showcaseInput);
    if (!showcase.success) throw new ProjectHttpError(400, 'showcase must be listed or hidden');
    const before = this.store.getProject(viewer.orgId, projectId);
    if (!before) throw new ProjectHttpError(404, 'project not found');
    const project = this.store.setProjectShowcase(viewer.orgId, projectId, showcase.data);
    if (!project) throw new ProjectHttpError(404, 'project not found');
    if (before.showcase !== project.showcase) {
      this.events({
        kind: 'project.showcase_changed',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        projectId,
        summary: `Project "${eventLabel(project.name)}" ${project.showcase === 'hidden' ? 'taken off' : 'put on'} the public showcase`,
        detail: { from: before.showcase, to: project.showcase },
      });
    }
    return publicProject(project, this.store.projectRunSummary(viewer.orgId, projectId),
      this.shownOnShowcase().has(projectId));
  }

  /**
   * The same creation from an already-parsed payload: the MCP's door. The
   * HTTP route is a body reader in front of this; the checks live once.
   */
  async createProjectFromInput(viewer: Viewer, body: unknown): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to create projects');
    }
    const input = createProjectInputSchema.safeParse(body);
    if (!input.success) throw new ProjectHttpError(400, 'invalid project payload');
    if (this.github) {
      const installation = this.github.getInstallation(input.data.repositoryTarget.installationId);
      if (!installation || installation.orgId !== viewer.orgId || installation.status !== 'active') {
        throw new ProjectHttpError(
          400,
          'repository target must reference an active GitHub installation linked to this organisation'
        );
      }
    } else {
      throw new ProjectHttpError(503, 'GitHub App is not configured on this deployment');
    }
    if (input.data.repositoryTarget.source) {
      if (!this.publisher) throw new ProjectHttpError(503, 'GitHub repository import is unavailable');
      try {
        input.data.repositoryTarget = await this.publisher.inspectTarget(input.data.repositoryTarget, viewer.orgId, viewer.principalId);
      } catch (error) {
        throw new ProjectHttpError(400, (error instanceof Error ? error.message : String(error)).slice(0, 500));
      }
    }
    try {
      const project = this.store.createProject({
        orgId: viewer.orgId,
        principalId: viewer.principalId,
        project: input.data,
      });
      this.events({
        kind: 'project.created',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        projectId: project.projectId,
        summary: `Project "${eventLabel(project.name)}" created`,
        detail: { slug: project.slug },
      });
      return publicProject(project);
    } catch (error) {
      // The store says WHICH identity collided — a slug or a repository — and
      // both are 409. This used to depend on matching a driver's own prose for
      // one constraint, which said nothing about the other and would have gone
      // on saying "slug" for a repository collision.
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      if (error instanceof Error && /UNIQUE constraint failed: projects\./.test(error.message)) {
        // Backstop only: reachable if something bypasses the checks above.
        throw new ProjectHttpError(409, 'a project identity in this organisation is already taken');
      }
      throw error;
    }
  }

  /** Read-only browser over the run's saved, publishable inventory. */
  workspace(viewer: Viewer, projectId: string, runId: string, filePath?: string): WorkspaceIndex | WorkspaceFile {
    if (!projectIdSchema.safeParse(projectId).success || !projectRunIdSchema.safeParse(runId).success) throw new ProjectHttpError(404, 'run not found');
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, runId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'run not found');
    if (run.bytesExpiredAt) throw new ProjectHttpError(410, 'workspace expired');
    if ((run.status !== 'delivered' && run.status !== 'partial') || !run.artifactManifest) {
      throw new ProjectHttpError(409, 'workspace is not available for this run');
    }
    const allowed = (p: string) => {
      try { assertPublishableArtifactPath(p); return normalizeArtifactPath(p) === p; }
      catch { return false; }
    };
    const files = run.artifactManifest.files.filter(f => allowed(f.path));
    if (filePath === undefined) return { runId, createdAt: run.createdAt, status: run.status,
      files: files.map(({ path, size }) => ({ path, size })) };
    const file = files.find(f => f.path === filePath);
    if (!file) throw new ProjectHttpError(404, 'file not found');
    if (file.size > MAX_WORKSPACE_PREVIEW_BYTES) return { path: file.path, size: file.size, kind: 'too_large', text: null };
    try {
      const bytes = readManifestArtifact({ workspaceRoot: run.hostPaths.workspacePath, expected: file,
        limits: { maxFileBytes: MAX_WORKSPACE_PREVIEW_BYTES } });
      const text = isUtf8(bytes) && !bytes.includes(0) ? bytes.toString('utf8') : null;
      return { path: file.path, size: file.size, kind: text === null ? 'binary' : 'text', text };
    } catch { throw new ProjectHttpError(409, 'file is unavailable or differs from the saved workspace'); }
  }

  /** GET /api/projects/:id/runs */
  listProjectRuns(viewer: Viewer, projectId: string): unknown {
    const orgId = this.readOrgFor(viewer, projectId);
    const runs = this.store.listProjectRuns(orgId, projectId);
    if (!runs) throw new ProjectHttpError(404, 'project not found');
    return runs.map((run) => {
      const publication = this.store.getPublicationForRun(orgId, run.projectRunId);
      return this.present(run, publication);
    });
  }

  /** POST /api/projects/:id/runs — org:member or above; idempotent by key. */
  async startProjectRun(req: IncomingMessage, viewer: Viewer, projectId: string): Promise<unknown> {
    return this.startProjectRunFromInput(viewer, projectId, await readJsonBody(req));
  }

  /** One project run, for a poller: the MCP's `atoma_run_status`. */
  /**
   * The run's ROW state under the same authorization as projectRunStatus,
   * without its presentation: no trace parse, no payer or publication reads.
   * A synchronous MCP start re-reads its task every poll interval for up to
   * an hour, and presenting the run each time parsed the whole trace file
   * (~1,800 times per hour-long run, 2026-10-03); the task needs only the
   * status, the binding and the timestamps.
   */
  projectRunState(viewer: Viewer, projectId: string, projectRunId: string): {
    readonly projectId: string; readonly projectRunId: string; readonly orgId: string;
    readonly requestedByPrincipalId: string; readonly status: string;
    readonly createdAt: string; readonly updatedAt: string; readonly endedAt: string | null;
  } {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    return {
      projectId: run.projectId, projectRunId: run.projectRunId, orgId: run.orgId,
      requestedByPrincipalId: run.requestedByPrincipalId, status: run.status,
      createdAt: run.createdAt, updatedAt: run.updatedAt, endedAt: run.endedAt ?? null,
    };
  }

  projectRunStatus(viewer: Viewer, projectId: string, projectRunId: string): unknown {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    return this.present(run, this.store.getPublicationForRun(orgId, run.projectRunId));
  }

  /**
   * The runs this viewer STARTED in its organisation that are live or ended
   * at or after `endedSince`, newest first: the MCP's `tasks/list`, which must
   * name every run task the principal can follow. Never another principal's
   * and never another organisation's — a platform admin's included, because
   * a task belongs to the context that started it, not to whoever may read
   * the run.
   */
  runsRequestedBy(viewer: Viewer, endedSince: string, limit: number): unknown[] {
    return this.store.listRunsRequestedBy(viewer.orgId, viewer.principalId, endedSince, limit)
      .map((run) => this.present(run, this.store.getPublicationForRun(viewer.orgId, run.projectRunId)));
  }

  /** The coordinator owns the budget; MCP only adds result retention. */
  runTaskBudgetMs(): number {
    return this.coordinator.runTaskBudgetMs();
  }

  /** The same start from an already-parsed payload: the MCP's door. */
  async startProjectRunFromInput(viewer: Viewer, projectId: string, body: unknown): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to start runs');
    }
    // ONE schema for both doors: a new run, or a comparison rerun of one.
    const input = startProjectRunInputSchema.safeParse(body);
    if (!input.success) throw new ProjectHttpError(400, 'invalid run payload');
    try {
      const { run, created } = await this.coordinator.startOutcome({
        orgId: viewer.orgId,
        principalId: viewer.principalId,
        projectId,
        request: input.data,
      });
      // The GOAL is model-facing prose of arbitrary length and content; only
      // its bounded label reaches the journal, and never the whole prompt.
      // A retry or a re-sent start returns the existing run: journaled once.
      if (created) this.events({
        kind: 'run.started',
        actorType: 'principal',
        actorId: viewer.principalId,
        orgId: viewer.orgId,
        projectId,
        runId: run.projectRunId,
        summary: run.rerunOf
          ? `Comparison rerun started: ${eventLabel(run.goal, 100)}`
          : `Run started: ${eventLabel(run.goal, 120)}`,
        ...(run.rerunOf ? { detail: { rerunOf: run.rerunOf } } : {}),
      });
      const publication = this.store.getPublicationForRun(viewer.orgId, run.projectRunId);
      return this.present(run, publication);
    } catch (error) {
      if (error instanceof ProjectRunBusy) throw new ProjectHttpError(409, error.message);
      if (error instanceof ProjectRunConfigurationError) throw new ProjectHttpError(400, error.message);
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      if (error instanceof Error && error.message === 'project not found') {
        throw new ProjectHttpError(404, 'project not found');
      }
      if (error instanceof Error && error.message === 'project run not found') {
        throw new ProjectHttpError(404, 'project run not found');
      }
      throw error;
    }
  }

  /** POST /api/projects/:id/runs/:runId/cancel */
  async cancelProjectRun(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to cancel runs');
    }
    // Bind the run to the project NAMED IN THE PATH, like the publish-retry
    // route: a run under another project of the same org must be a 404, or
    // the REST hierarchy lies.
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) {
      throw new ProjectHttpError(404, 'project run not found');
    }
    const cancelled = this.coordinator.cancel(viewer.orgId, projectRunId);
    if (!cancelled) throw new ProjectHttpError(404, 'project run not found');
    // WHO asked is the point of this one: `coordinator.cancel` takes only an
    // org and a run id, so the requesting principal is knowable here and
    // nowhere downstream.
    this.events({
      kind: 'run.cancelled',
      actorType: 'principal',
      actorId: viewer.principalId,
      orgId: viewer.orgId,
      projectId,
      runId: projectRunId,
      summary: `Run cancellation requested: ${eventLabel(cancelled.goal, 120)}`,
    });
    const publication = this.store.getPublicationForRun(viewer.orgId, cancelled.projectRunId);
    return this.present(cancelled, publication);
  }

  /** POST /api/projects/:id/runs/:runId/publish — org:member or above. */
  async retryPublication(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) {
      throw new ProjectHttpError(403, 'org:member role or above is required to retry publication');
    }
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    try {
      const retried = await this.coordinator.retryPublication(viewer.orgId, projectRunId);
      if (!retried) throw new ProjectHttpError(404, 'project run not found');
      const publication = this.store.getPublicationForRun(viewer.orgId, projectRunId);
      return this.present(retried, publication);
    } catch (error) {
      if (error instanceof ProjectHttpError) throw error;
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      // A POLICY refusal, not a transport failure: this run is older than the
      // one already published, and no retry converges.
      if (error instanceof PublicationSupersededError) {
        throw new ProjectHttpError(409, error.message);
      }
      if (error instanceof ProjectRunConfigurationError) {
        throw new ProjectHttpError(503, error.message);
      }
      // The publisher already recorded the failure on the publication row;
      // surface a bounded message so the operator can see why it failed.
      throw new ProjectHttpError(
        502,
        `publication retry failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`
      );
    }
  }
}
