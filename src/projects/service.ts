import { projectRetrievalRequestSchema } from '../contracts/projectRetrieval.js';
import { searchSavedProjectCode } from './retrievalRead.js';
import { answerClientQuestionSchema, type ClientQuestionView } from '../contracts/clientQuestion.js';
import { projectContextReadSchema, projectContextUpdateSchema } from '../contracts/projectContext.js';
import { ProjectContextConflict } from './context.js';
import { PROJECT_RUN_WAITING_MESSAGE } from '../contracts/projects.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { artifactPageInputSchema, artifactReadInputSchema, pageCursorSchema, projectPageInputSchema, runPageInputSchema,
  runComparisonInputSchema, type RunComparisonResult, runReviewSchema, type RunReview,
  serviceProblem, type ServiceProblem, type ProjectPageInput, type RunPageInput, type PageCursor } from '../contracts/clientExperience.js';
import { projectRunProgress } from './runProgress.js';
import { artifactMime } from './artifactMedia.js';
import { summarizeTraceFile } from '../viz/runIndex.js';
import { isUtf8 } from 'node:buffer';
import { assertPublishableArtifactPath, normalizeArtifactPath, readManifestArtifact } from './artifacts.js';
import { MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_PREVIEW_BYTES, type WorkspaceIndex, type WorkspaceFile } from '../contracts/workspaceBrowser.js';
import type { IncomingMessage } from 'node:http';
import type { Viewer } from '../auth/store.js';
import { roleAtLeast } from '../auth/store.js';
export { roleAtLeast } from '../auth/store.js';
import {
  createProjectInputSchema,
  acceptDeliveryInputSchema,
  projectIdSchema, projectRunIdSchema,
  projectShowcaseSchema,
  startProjectRunInputSchema,
  projectRunPublicSchema,
  platformLiveRunSchema,
  type Project,
  type ProjectRun,
} from '../contracts/projects.js';
import { eventLabel, type CrossOrgRead, type CrossOrgReadSink, type PlatformEventSink } from '../contracts/platformEvents.js';
import { GitHubStore } from '../github/store.js';
import { GitHubAccessRequiredError, PublicationSupersededError, type GitHubPublisher } from './publisher.js';
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

function clientInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProjectHttpError(400, 'invalid reader arguments', {
    fields: [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))],
  });
  return parsed.data;
}

export class ProjectHttpError extends Error {
  readonly problem: ServiceProblem;
  constructor(
    readonly status: number,
    message: string,
    details?: Partial<ServiceProblem>
  ) {
    super(message);
    this.name = 'ProjectHttpError';
    this.problem = serviceProblem(status, message, details);
  }
}


export interface ProjectServiceDeps {
  readonly store: import('./store.js').ProjectStore;
  readonly coordinator: ProjectRunCoordinator;
  readonly github: GitHubStore | null;
  readonly publisher?: Pick<GitHubPublisher, 'inspectTarget'> & Partial<Pick<GitHubPublisher, 'verifyGitHubAccess'>>;
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
    ...(run.status === 'queued' ? { statusMessage: PROJECT_RUN_WAITING_MESSAGE } : {}),
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
  runSummary: ReturnType<ProjectServiceDeps['store']['projectRunSummary']> = {
    costUsd: 0,
    runCount: 0,
    lastRunAt: null,
    hasRunningRun: false,
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

function pageCursor(raw: string | undefined, query: string): PageCursor | null {
  if (raw === undefined) return null;
  try {
    const parsed = pageCursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (parsed.query !== query) throw new Error('query changed');
    return parsed;
  } catch { throw new ProjectHttpError(400, 'invalid cursor or changed search; restart from the first page', { fields: ['cursor'] }); }
}

const encodeCursor = (at: string, id: string, query: string) => Buffer.from(JSON.stringify({ at, id, query })).toString('base64url');

export class ProjectService {
  private readonly store: import('./store.js').ProjectStore;
  private readonly coordinator: ProjectRunCoordinator;
  private readonly github: GitHubStore | null;
  private readonly events: PlatformEventSink;
  private readonly readAudit?: CrossOrgReadSink;
  private readonly publisher?: ProjectServiceDeps['publisher'];
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
    const clientAcceptance = this.store.getDeliveryAcceptance(run.orgId, run.projectRunId);
    const clientQuestion = this.coordinator.clientQuestion(run);
    return { ...publicRun(run, publication, this.store.getRunPayers(run.orgId, run.projectRunId)),
      clientAcceptance, clientQuestion,
      awaitingClientAnswer: Boolean(clientQuestion && !clientQuestion.answer && this.coordinator.checkpointStatus(run)?.state === 'paused'),
      acceptedReferenceRunId: this.store.acceptedReference(run.orgId, run.projectId)?.projectRunId ?? null,
      awaitingClientAcceptance: run.status === 'delivered' && !run.rerunOf && !run.bytesExpiredAt && Boolean(run.artifactManifestHash)
        && publication?.status !== 'published' && !clientAcceptance,
      checkpoint: this.coordinator.checkpointStatus(run) };
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

  /** GET /api/admin/live-runs — the same transactional live set as Sentinel. */
  listLiveRuns(viewer: Viewer) {
    if (!viewer.platformAdmin) throw new ProjectHttpError(403, 'platform admin required');
    const rows = this.store.listLiveRunTraces();
    for (const orgId of new Set(rows.map(row => row.orgId))) {
      this.auditRead(viewer, orgId, 'runs.index');
    }
    // The schema strips internal trace paths before anything reaches a browser.
    return rows.map(row => platformLiveRunSchema.parse(row));
  }

  /** Compact menus are shared by HTTP and MCP; legacy listings keep their shape. */
  projectPage(viewer: Viewer, raw: ProjectPageInput) {
    const input = clientInput(projectPageInputSchema, raw);
    const query = JSON.stringify(['projects', viewer.platformAdmin ? 'all' : viewer.orgId, input.search ?? '']);
    const rows = this.store.projectPage(viewer.platformAdmin ? undefined : viewer.orgId, input, pageCursor(input.cursor, query));
    const limit = input.limit ?? 20;
    const selected = rows.slice(0, limit);
    for (const orgId of new Set(selected.map(row => row.project.orgId))) this.auditRead(viewer, orgId, 'projects.index');
    const projects = selected.map(({ project, orgName, activityAt }) => ({
      projectId: project.projectId, name: project.name, slug: project.slug, status: project.status,
      repositoryStatus: project.repositoryStatus, repositoryUrl: project.repositoryUrl, lastActivityAt: activityAt,
      ...(viewer.platformAdmin ? { orgId: project.orgId, orgName } : {}),
    }));
    const last = selected.at(-1);
    return { projects, nextCursor: rows.length > limit && last ? encodeCursor(last.activityAt, last.project.projectId, query) : null };
  }

  projectRunsPage(viewer: Viewer, projectId: string, raw: RunPageInput) {
    const input = clientInput(runPageInputSchema, raw);
    const orgId = this.readOrgFor(viewer, projectId);
    if (!this.store.getProject(orgId, projectId)) throw new ProjectHttpError(404, 'project not found');
    const query = JSON.stringify(['runs', orgId, projectId, input.search ?? '', input.status ?? null]);
    const rows = this.store.projectRunPage(orgId, projectId, input, pageCursor(input.cursor, query));
    const limit = input.limit ?? 20;
    const runs = rows.slice(0, limit);
    const last = runs.at(-1);
    return { runs, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.projectRunId, query) : null };
  }

  projectContext(viewer: Viewer, projectId: string, raw: unknown = {}) {
    projectId = clientInput(projectIdSchema, projectId);
    const input = clientInput(projectContextReadSchema, raw);
    const orgId = this.readOrgFor(viewer, projectId);
    const context = this.store.getProjectContext(orgId, projectId, input.version);
    if (!context) throw new ProjectHttpError(404, 'project or context version not found');
    return { context, ...this.store.projectContextHistory(orgId, projectId, input.beforeVersion, input.limit ?? 20) };
  }

  async updateProjectContext(req: IncomingMessage, viewer: Viewer, projectId: string) {
    return this.updateProjectContextFromInput(viewer, projectId, await readJsonBody(req));
  }

  updateProjectContextFromInput(viewer: Viewer, projectId: string, raw: unknown) {
    if (!roleAtLeast(viewer.role, 'org:member')) throw new ProjectHttpError(403, 'org:member role or above is required');
    projectId = clientInput(projectIdSchema, projectId);
    const input = clientInput(projectContextUpdateSchema, raw);
    try {
      const result = this.store.updateProjectContext(viewer.orgId, projectId, viewer.principalId, input);
      if (!result) throw new ProjectHttpError(404, 'project not found');
      if (result.created) this.events({ kind: 'project.context_updated', actorType: 'principal',
        actorId: viewer.principalId, orgId: viewer.orgId, projectId, summary: 'Project context revision recorded',
        detail: { version: result.context.version, change: input.change.kind } });
      return result;
    } catch (error) {
      if (error instanceof ProjectContextConflict) throw new ProjectHttpError(409, error.message);
      throw error;
    }
  }

  /** Configuration inspection is not admission and never starts or reserves work. */
  projectReadiness(viewer: Viewer, projectId: string) {
    const orgId = this.readOrgFor(viewer, projectId);
    const project = this.store.getProject(orgId, projectId);
    if (!project) throw new ProjectHttpError(404, 'project not found');
    const problems: ServiceProblem[] = [];
    const mayStart = orgId === viewer.orgId && roleAtLeast(viewer.role, 'org:member');
    if (!mayStart) problems.push(serviceProblem(403, 'Starting work requires membership in the active organisation.'));
    const capacity = this.store.runCapacity(orgId);
    if (capacity.active >= capacity.maxConcurrent) problems.push(serviceProblem(409, capacity.maxConcurrent === 0
      ? 'New runs are suspended for this organisation.' : 'The organisation already has its allowed outstanding work.',
    { code: 'busy', retryable: capacity.maxConcurrent > 0, nextAction: capacity.maxConcurrent === 0
      ? 'Ask the organisation administrator to enable runs.' : 'Follow the current run, then retry the same request.' }));
    const installation = this.github?.listInstallations(orgId).find(row => row.installationId === project.repositoryTarget.installationId);
    if (!installation || installation.status !== 'active') problems.push(serviceProblem(409, 'An active GitHub installation is required.',
      { code: 'github_required', nextAction: 'Ask an organisation administrator to connect GitHub in Atoma Settings.' }));
    let configuration: ReturnType<ProjectRunCoordinator['configurationReadiness']> | null = null;
    if (mayStart) {
      try { configuration = this.coordinator.configurationReadiness(orgId, viewer.principalId, projectId); }
      catch { problems.push(serviceProblem(400, 'The configured models or host prerequisites cannot support this run.',
        { code: 'configuration_required', nextAction: 'Check your model selections and provider connection in Settings. Ask the instance administrator to check host prerequisites if they are already configured.' })); }
    }
    return { projectId, acceptedReferenceRunId: this.store.acceptedReference(orgId, projectId)?.projectRunId ?? null, organisation: { orgId, name: orgId === viewer.orgId ? viewer.orgName : null },
      canRequest: mayStart, configured: problems.length === 0, capacity, configuration, problems,
      liveChecks: 'not-performed', note: 'Configuration only: credentials, repository access, live capacity and personal model availability are checked again at launch. No price estimate or reservation.' };
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
  workspace(viewer: Viewer, projectId: string, runId: string, filePath: string, format: 'bytes'): Buffer;
  workspace(viewer: Viewer, projectId: string, runId: string, filePath?: string): WorkspaceIndex | WorkspaceFile;
  workspace(viewer: Viewer, projectId: string, runId: string, filePath?: string, format?: 'bytes'): WorkspaceIndex | WorkspaceFile | Buffer {
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
    const maxBytes = format === 'bytes' ? MAX_WORKSPACE_FILE_BYTES : MAX_WORKSPACE_PREVIEW_BYTES;
    if (format === 'bytes' && file.size > maxBytes) throw new ProjectHttpError(413, 'file is too large to preview');
    if (file.size > maxBytes) return { path: file.path, size: file.size, kind: 'too_large', text: null };
    try {
      const bytes = readManifestArtifact({ workspaceRoot: run.hostPaths.workspacePath, expected: file,
        limits: { maxFileBytes: maxBytes } });
      if (format === 'bytes') return bytes;
      const text = isUtf8(bytes) && !bytes.includes(0) ? bytes.toString('utf8') : null;
      return { path: file.path, size: file.size, kind: text === null ? 'binary' : 'text', text };
    } catch { throw new ProjectHttpError(409, 'file is unavailable or differs from the saved workspace'); }
  }

  async searchCode(viewer: Viewer, projectId: string, runId: string, raw: unknown) {
    const input = clientInput(projectRetrievalRequestSchema, raw);
    this.workspace(viewer, projectId, runId);
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, runId)!;
    return searchSavedProjectCode({ run, principalId: viewer.principalId, query: input,
      read: path => this.workspace(viewer, projectId, runId, path, 'bytes'),
      authorize: () => {
        try { this.workspace(viewer, projectId, runId); return this.store.canReadProjectNow(viewer.principalId, orgId, projectId, viewer.orgId) && this.store.getProjectRun(orgId, runId)?.artifactManifestHash === run.artifactManifestHash; }
        catch { return false; }
      },
    });
  }

  artifacts(viewer: Viewer, projectId: string, runId: string, raw: unknown = {}) {
    const input = clientInput(artifactPageInputSchema, raw);
    const index = this.workspace(viewer, projectId, runId) as WorkspaceIndex;
    const files = index.files.filter(file => !input.search || file.path.toLowerCase().includes(input.search.toLowerCase()));
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 30;
    return { projectId, runId, status: index.status, files: files.slice(offset, offset + limit), total: files.length,
      nextOffset: offset + limit < files.length ? offset + limit : null };
  }

  /** Compare immutable delivery inventories, never a live workspace or GitHub head. */
  compareRuns(viewer: Viewer, projectId: string, runId: string, raw: unknown): RunComparisonResult {
    const input = clientInput(runComparisonInputSchema, raw);
    // Reuse the file reader's project binding, retention and publishable path policy.
    const before = this.workspace(viewer, projectId, input.baseRunId) as WorkspaceIndex;
    const after = this.workspace(viewer, projectId, runId) as WorkspaceIndex;
    const orgId = this.readOrgFor(viewer, projectId);
    const base = this.store.getProjectRun(orgId, input.baseRunId)!;
    const target = this.store.getProjectRun(orgId, runId)!;
    const snapshot = createHash('sha256').update(JSON.stringify([
      projectId, base.projectRunId, base.artifactManifestHash, target.projectRunId, target.artifactManifestHash,
      input.search ?? '',
    ])).digest('hex');
    if (input.snapshot && input.snapshot !== snapshot) throw new ProjectHttpError(409, 'comparison snapshot changed; restart paging');
    const allowedBefore = new Set(before.files.map(file => file.path));
    const allowedAfter = new Set(after.files.map(file => file.path));
    const left = new Map(base.artifactManifest!.files.filter(file => allowedBefore.has(file.path)).map(file => [file.path, file]));
    const right = new Map(target.artifactManifest!.files.filter(file => allowedAfter.has(file.path)).map(file => [file.path, file]));
    const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
    const files: RunComparisonResult['files'] = [];
    for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const a = left.get(path), b = right.get(path);
      const change = !a ? 'added' : !b ? 'removed' : a.sha256 !== b.sha256 || a.size !== b.size ? 'modified' : 'unchanged';
      counts[change]++;
      if (change === 'unchanged' || (input.search && !path.toLowerCase().includes(input.search.toLowerCase()))) continue;
      files.push({ path, change, before: a ? { size: a.size, sha256: a.sha256 } : null, after: b ? { size: b.size, sha256: b.sha256 } : null });
    }
    const offset = input.offset ?? 0, limit = input.limit ?? 30;
    return { projectId, baseRunId: input.baseRunId, runId, snapshot, evidence: 'saved_manifests', untrusted: true,
      base: { status: before.status, coverage: base.artifactManifest!.source === 'workspace' ? 'workspace' : 'declared' },
      target: { status: after.status, coverage: target.artifactManifest!.source === 'workspace' ? 'workspace' : 'declared' },
      counts, files: files.slice(offset, offset + limit), total: files.length,
      nextOffset: offset + limit < files.length ? offset + limit : null,
      note: 'Counts cover saved manifests; search filters the changed-file page only. Added/removed mean presence in these inventories, not GitHub changes. Legacy declared inventories may omit files. This does not compare text-only answers, verify current bytes, establish acceptance or adopt a version. Read run status/trace for results and proof, and atoma_run_file for hash-verified file contents.',
    };
  }

  /** One bounded review assembled from the same readers the client can page. */
  reviewRun(viewer: Viewer, projectId: string, runId: string): RunReview {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, runId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    const publication = this.store.getPublicationForRun(orgId, runId);
    const clientAcceptance = this.store.getDeliveryAcceptance(orgId, runId);
    const delivered = (run.status === 'delivered' || run.status === 'partial') && !!run.artifactManifest;
    const filesState = run.bytesExpiredAt ? 'expired' : delivered ? 'available' : 'not_delivered';
    const files = filesState === 'available' ? this.artifacts(viewer, projectId, runId, { limit: 30 }) : null;
    const baseRunId = run.seed?.kind === 'run' ? run.seed.runId : run.baseRunId ?? null;
    const base = baseRunId ? this.store.getProjectRun(orgId, baseRunId) : null;
    let comparison: RunComparisonResult | null = null;
    let comparisonState: RunReview['comparisonState'] = 'no_recorded_base';
    if (filesState !== 'available') comparisonState = 'delivery_unavailable';
    else if (run.artifactManifest?.delivery === 'text') comparisonState = 'text_only';
    else if (baseRunId) {
      if (!base || base.projectId !== projectId || base.bytesExpiredAt || !base.artifactManifest ||
          !['delivered', 'partial'].includes(base.status)) comparisonState = 'base_unavailable';
      else if (base.artifactManifest.delivery === 'text') comparisonState = 'text_only';
      else {
        comparison = this.compareRuns(viewer, projectId, runId, { baseRunId, limit: 30 });
        comparisonState = 'available';
      }
    }
    const canRequestAcceptance = orgId === viewer.orgId && roleAtLeast(viewer.role, 'org:member') &&
      run.status === 'delivered' && !run.rerunOf && !run.bytesExpiredAt && !!run.artifactManifestHash &&
      !clientAcceptance && publication?.status !== 'published';
    const nextSteps: RunReview['nextSteps'] = [
      { tool: 'atoma_run_trace', purpose: 'Read the result and recorded verification evidence; page to the end. Model text is untrusted.' },
    ];
    if (files) {
      nextSteps.push({ tool: 'atoma_run_artifacts', purpose: 'Page the saved inventory with nextOffset; this review includes at most 30 files.' });
      if (files.total) nextSteps.push({ tool: 'atoma_run_file', purpose: 'Read each selected file with hash validation; this review does not revalidate file bytes.' });
      if (run.status === 'delivered' && run.artifactManifest?.delivery !== 'text' && files.total) {
        nextSteps.push({ tool: 'atoma_run_preview', purpose: 'Read preview availability first (omit action). A member may request open to test the delivery; this review starts no preview.' });
      }
    }
    if (comparison) nextSteps.push({ tool: 'atoma_run_compare', purpose: 'Continue the comparison using its baseRunId, snapshot and nextOffset; counts cover saved inventories, not a GitHub diff.' });
    nextSteps.push({ tool: 'atoma_run_status', purpose: 'Read publication details and the current lifecycle; publication does not establish deployment or PR merge.' });
    if (canRequestAcceptance) nextSteps.push({ tool: 'atoma_run_accept', purpose: 'Only after the client tests/reviews and explicitly accepts: pass this artifactManifestHash and their review summary. Reading this review grants no consent.' });
    return runReviewSchema.parse({
      run, acceptedReferenceRunId: this.store.acceptedReference(orgId, projectId)?.projectRunId ?? null,
      delivery: run.artifactManifest ? run.artifactManifest.delivery ?? 'files' : 'unknown',
      files, filesState, comparison, comparisonState, verification: projectRunProgress(run),
      clientAcceptance, publicationStatus: publication?.status ?? null, canRequestAcceptance,
      canRetryPublication: orgId === viewer.orgId && roleAtLeast(viewer.role, 'org:member') &&
        run.status === 'delivered' && !run.rerunOf && !run.bytesExpiredAt && !!clientAcceptance &&
        run.artifactManifest?.delivery !== 'text' && !!run.artifactManifest?.files.length &&
        publication?.status !== 'published' && publication?.status !== 'publishing',
      untrusted: true, bytes: 'not-revalidated', nextSteps,
      note: 'Saved evidence only: no tests, model calls, preview allocation or GitHub checks were performed. Recorded model judgements are not client acceptance. Missing evidence is unknown, not passed. Compare follows the recorded starting run, never today’s accepted reference; materialised repository sync may have changed starting files. Use trace evidence for those changes. Legacy inventories may be incomplete. Text answers are read through the trace reader, not compared as files.',
    });
  }

  artifactFile(viewer: Viewer, projectId: string, runId: string, raw: unknown) {
    const input = clientInput(artifactReadInputSchema, raw);
    const bytes = this.workspace(viewer, projectId, runId, input.path, 'bytes');
    const snapshot = createHash('sha256').update(bytes).digest('hex');
    if (input.snapshot && input.snapshot !== snapshot) throw new ProjectHttpError(409, 'file snapshot changed; restart at offset zero');
    const text = isUtf8(bytes) && !bytes.includes(0) ? bytes.toString('utf8') : null;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 12000;
    if (text !== null && offset > text.length) throw new ProjectHttpError(400, 'offset is beyond the file text', { fields: ['offset'] });
    return { projectId, runId, path: input.path, size: bytes.length, snapshot, mimeType: artifactMime(bytes, input.path),
      kind: text === null ? 'binary' as const : 'text' as const, text: text?.slice(offset, offset + limit) ?? null,
      textOffset: offset, nextTextOffset: text !== null && offset + limit < text.length ? offset + limit : null,
      untrusted: true as const };
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
   * without its full presentation: no payer or publication reads. Progress
   * caches a bounded trace projection and reparses only when the file changes.
   * A synchronous MCP start re-reads its task every poll interval for up to
   * an hour, and presenting the run each time parsed the whole trace file
   * (~1,800 times per hour-long run, 2026-10-03); the task needs only the
   * status, the binding, timestamps and a small activity projection.
   */
  projectRunState(viewer: Viewer, projectId: string, projectRunId: string): {
    readonly projectId: string; readonly projectRunId: string; readonly orgId: string;
    readonly requestedByPrincipalId: string; readonly status: string;
    readonly createdAt: string; readonly updatedAt: string; readonly endedAt: string | null;
    readonly progress: import('../contracts/clientExperience.js').RunProgress;
  } {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    return {
      projectId: run.projectId, projectRunId: run.projectRunId, orgId: run.orgId,
      requestedByPrincipalId: run.requestedByPrincipalId, status: run.status,
      createdAt: run.createdAt, updatedAt: run.updatedAt, endedAt: run.endedAt ?? null, progress: projectRunProgress(run),
    };
  }

  projectRunStatus(viewer: Viewer, projectId: string, projectRunId: string): unknown {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    return { ...this.present(run, this.store.getPublicationForRun(orgId, run.projectRunId)), progress: projectRunProgress(run),
      actions: { canCancel: orgId === viewer.orgId && roleAtLeast(viewer.role, 'org:member') && (run.status === 'queued' || run.status === 'running') } };
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
    if (!input.success) throw new ProjectHttpError(400, 'invalid run payload', {
      fields: [...new Set(input.error.issues.map(issue => issue.path.join('.')))],
    });
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
        summary: run.status === 'queued' ? `Run queued: ${eventLabel(run.goal, 120)}` : run.rerunOf
          ? `Comparison rerun started: ${eventLabel(run.goal, 100)}`
          : `Run started: ${eventLabel(run.goal, 120)}`,
        ...(run.rerunOf ? { detail: { rerunOf: run.rerunOf } } : {}),
      });
      const publication = this.store.getPublicationForRun(viewer.orgId, run.projectRunId);
      return this.present(run, publication);
    } catch (error) {
      if (error instanceof ProjectRunBusy) throw new ProjectHttpError(409, error.message,
        { code: 'busy', retryable: true, nextAction: 'Follow the active run or wait for the instance update, then retry the same request.' });
      if (error instanceof ProjectRunConfigurationError) throw new ProjectHttpError(400, error.message,
        { code: 'configuration_required', nextAction: 'Check project readiness and your provider/model settings before starting again.' });
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

  runQuestion(viewer: Viewer, projectId: string, runId: string): ClientQuestionView {
    const orgId = this.readOrgFor(viewer, projectId);
    const run = this.store.getProjectRun(orgId, runId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    const question = this.coordinator.clientQuestion(run);
    const paused = this.coordinator.checkpointStatus(run)?.state === 'paused';
    const mayAct = orgId === viewer.orgId && run.requestedByPrincipalId === viewer.principalId && roleAtLeast(viewer.role, 'org:member') &&
      this.store.getProject(orgId, projectId)?.status === 'active' && !run.bytesExpiredAt;
    const waitingForClient = Boolean(question && !question.answer && paused);
    const continuation = this.store.latestContinuation(orgId, runId);
    return { projectId, runId, question, waitingForClient,
      continuation: continuation?.projectId === projectId ? { runId: continuation.projectRunId, status: continuation.status } : null,
      canAnswer: mayAct && waitingForClient, canResume: mayAct && paused && Boolean(question?.answer),
      nextAction: waitingForClient ? 'answer' : paused && question?.answer ? 'resume' : 'none' };
  }

  async answerRunQuestion(req: IncomingMessage, viewer: Viewer, projectId: string, runId: string) {
    return this.answerRunQuestionFromInput(viewer, projectId, runId, await readJsonBody(req));
  }

  answerRunQuestionFromInput(viewer: Viewer, projectId: string, runId: string, raw: unknown) {
    if (!roleAtLeast(viewer.role, 'org:member')) throw new ProjectHttpError(403, 'org:member role or above is required');
    const input = clientInput(answerClientQuestionSchema, raw);
    const run = this.store.getProjectRun(viewer.orgId, runId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    if (run.requestedByPrincipalId !== viewer.principalId) throw new ProjectHttpError(403, 'Only the original requester can answer this question');
    if (run.status !== 'partial') throw new ProjectHttpError(409, 'The run has not finalized a safe pause');
    if (run.bytesExpiredAt || this.store.getProject(viewer.orgId, projectId)?.status !== 'active') throw new ProjectHttpError(409, 'This project cannot be continued');
    try {
      const result = this.coordinator.answerClientQuestion(run, input);
      return { ...result, nextAction: 'atoma_run_resume', note: 'Answer recorded. Resume this source run to continue with its remaining budget. This answer is not a permanent project decision or delivery acceptance.' };
    } catch (error) {
      if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message);
      throw error;
    }
  }

  async controlCheckpoint(viewer: Viewer, projectId: string, projectRunId: string, action: 'pause' | 'resume'): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) throw new ProjectHttpError(403, 'org:member role or above is required');
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    if (run.requestedByPrincipalId !== viewer.principalId) throw new ProjectHttpError(403, 'Only the requester can pause or resume this run');
    if (action === 'pause') {
      try { this.coordinator.pause(run); }
      catch (error) { if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message); throw error; }
      return this.present(run, this.store.getPublicationForRun(viewer.orgId, projectRunId));
    }
    const acceptance = this.store.getRunAcceptanceSpec(viewer.orgId, projectRunId);
    return this.startProjectRunFromInput(viewer, projectId, {
      resumeOf: projectRunId, goal: run.goal, depth: run.depth, idempotencyKey: this.coordinator.continuationRequestKey(run),
      ...(acceptance ? { acceptanceChecklist: acceptance.items.map(({ behaviour, check }) => ({ behaviour, check })) } : {}),
    });
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

  /** Resume only a host-recorded GitHub access interruption, never arbitrary failed work. */
  async continueGitHubAccess(viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) throw new ProjectHttpError(403, 'org:member role or above is required');
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    const project = this.store.getProject(viewer.orgId, projectId);
    if (!run || !project || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    const access = run.githubAccess;
    if (!access) throw new ProjectHttpError(409, 'This run is not waiting for GitHub access');
    if (access.phase === 'publication') return this.retryPublication(viewer, projectId, projectRunId);
    if (run.requestedByPrincipalId !== viewer.principalId) throw new ProjectHttpError(403, 'Only the person who requested this run can continue it');
    if (access.resumedRunId) return this.projectRunStatus(viewer, projectId, access.resumedRunId);
    if (run.status !== 'failed' || run.stats || run.traceId || run.rerunOf) throw new ProjectHttpError(409, 'This run cannot be resumed before model work');
    if (!this.publisher?.verifyGitHubAccess) throw new ProjectHttpError(503, 'GitHub access verification is unavailable');
    try { await this.publisher.verifyGitHubAccess(project, access); }
    catch (error) {
      if (error instanceof GitHubAccessRequiredError) {
        this.store.setGitHubAccess(viewer.orgId, projectRunId, error.access);
        throw new ProjectHttpError(409, error.message);
      }
      throw new ProjectHttpError(502, 'GitHub access could not be checked. Please try again.');
    }
    const acceptance = this.store.getRunAcceptanceSpec(viewer.orgId, projectRunId);
    const resumed = await this.startProjectRunFromInput(viewer, projectId, {
      goal: run.goal, depth: run.depth, idempotencyKey: `github-access:${projectRunId}`,
      ...(run.baseRunId ? { baseRunId: run.baseRunId } : {}),
      ...(acceptance ? { acceptanceChecklist: acceptance.items.map(({ behaviour, check }) => ({ behaviour, check })) } : {}),
    }) as { projectRunId: string };
    this.store.setGitHubAccess(viewer.orgId, projectRunId, { ...access, resumedRunId: resumed.projectRunId });
    return resumed;
  }

  async acceptDelivery(viewer: Viewer, projectId: string, projectRunId: string, raw: unknown): Promise<unknown> {
    if (!roleAtLeast(viewer.role, 'org:member')) throw new ProjectHttpError(403, 'org:member role or above is required to accept a delivery');
    const run = this.store.getProjectRun(viewer.orgId, projectRunId);
    if (!run || run.projectId !== projectId) throw new ProjectHttpError(404, 'project run not found');
    const input = clientInput(acceptDeliveryInputSchema, raw);
    try {
      const accepted = this.store.acceptDelivery(viewer.orgId, projectRunId, viewer.principalId, input);
      if (accepted.created) this.events({ kind: 'run.client_accepted', actorType: 'principal', actorId: viewer.principalId,
        orgId: viewer.orgId, projectId, runId: projectRunId, summary: 'Client accepted the saved delivery for publication',
        detail: { manifestHash: input.manifestHash } });
    }
    catch (error) { if (error instanceof ProjectStateConflict) throw new ProjectHttpError(409, error.message); throw error; }
    if (run.artifactManifest?.delivery === 'text' || !run.artifactManifest?.files.length) return this.projectRunStatus(viewer, projectId, projectRunId);
    // Approval survives a publishing failure; retry never asks the client to accept twice.
    return this.retryPublication(viewer, projectId, projectRunId);
  }

  async acceptDeliveryRequest(req: IncomingMessage, viewer: Viewer, projectId: string, projectRunId: string): Promise<unknown> {
    return this.acceptDelivery(viewer, projectId, projectRunId, await readJsonBody(req));
  }

  /** POST /api/projects/:id/runs/:runId/publish — accepted deliveries only. */
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
      // The run slot was taken: nothing was attempted, and the message is
      // already the tenant's redaction of the lease holder.
      if (error instanceof ProjectRunBusy) {
        throw new ProjectHttpError(409, error.message,
          { code: 'busy', retryable: true, nextAction: 'Wait for the current work on the instance to finish, then retry the publication.' });
      }
      // Anything else came from the publisher, which recorded it on the
      // publication row; surface a bounded message so the caller sees why.
      throw new ProjectHttpError(
        502,
        `publication retry failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`
      );
    }
  }
}
