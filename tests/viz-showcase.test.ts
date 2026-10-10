import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type OrgRole, type Viewer } from '../src/auth/store.js';
import type { ArtifactManifest } from '../src/contracts/projects.js';
import type { RunStats } from '../src/contracts/runStats.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { repoRoot } from '../src/mcp/run.js';
import { ProjectHttpError, ProjectService } from '../src/projects/service.js';
import { ProjectStore } from '../src/projects/store.js';
import { platformEventInputSchema, type PlatformEventInput } from '../src/contracts/platformEvents.js';
import {
  buildShowcase,
  classifyShowcase,
  createShowcaseSource,
  servesShowcaseHome,
  titleFromGoal,
  SHOWCASE_TTL_MS,
  type ShowcaseEntry,
  type ShowcaseKind,
} from '../src/viz/showcase.js';
import { renderShowcaseEntry, renderShowcaseIndex, SHOWCASE_SECURITY_HEADERS } from '../src/viz/showcasePage.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

/**
 * THE PUBLIC SHOWCASE: who may be shown, what a visitor may read, and that the
 * real server serves it without a session and only when the host asked.
 */

vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.useRealTimers();
  closeStoreHandles();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve)));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STATS: RunStats = {
  outcome: 'delivered', costUsd: 0.3, llmCalls: 10, opusCalls: 0, sonnetCalls: 0, haikuCalls: 0, otherCalls: 10,
  deterministicPhases: 0, deepenings: 0, rootRemediations: 0, discardedLessons: 0, landingReasons: [], escalations: 0, learnedSkills: 0,
  learnedEventSkills: 0, promotions: 0, refusals: 0, compileErrors: 0, demotions: 0, dispatchFallbacks: 0,
  uncoveredObligations: 0,
};

function manifestOf(files: readonly string[], delivery?: 'text'): ArtifactManifest {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  return {
    version: 1,
    source: 'workspace',
    ...(delivery ? { delivery } : {}),
    files: sorted.map((path) => ({
      path, size: 100, sha256: createHash('sha256').update(path).digest('hex'), mode: '100644' as const,
    })),
    totalBytes: sorted.length * 100,
  };
}

interface World {
  readonly root: string;
  readonly dbPath: string;
  readonly store: ProjectStore;
  readonly admin: { orgId: string; principalId: string; projectId: string };
  readonly member: { orgId: string; principalId: string; projectId: string };
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'atoma-showcase-'));
  roots.push(root);
  const dbPath = join(root, 'atoma.db');
  const auth = AuthStore.open(dbPath);
  const store = ProjectStore.open(dbPath);
  const people = (['admin', 'member'] as const).map((name) => {
    const login = auth.completeLogin(
      { provider: 'github', subject: name, displayName: name, email: null, emailVerified: false },
      null
    );
    if (!login) throw new Error('bootstrap failed');
    const project = store.createProject({
      orgId: login.viewer.orgId,
      principalId: login.viewer.principalId,
      project: {
        name: `Secret ${name} project`,
        slug: `secret-${name}`,
        initialPrompt: 'x',
        repositoryTarget: { installationId: '123', owner: `secret-owner-${name}`, name: `secret-repo-${name}`, visibility: 'private' },
      },
    });
    return { orgId: login.viewer.orgId, principalId: login.viewer.principalId, projectId: project.projectId };
  });
  auth.grantPlatformAdmin(people[0]!.principalId);
  return { root, dbPath, store, admin: people[0]!, member: people[1]! };
}

/** One run of `who`, ended as `outcome`, with a trace file when `answer` is given. */
function seedRun(
  w: World,
  who: World['admin'],
  input: {
    goal: string;
    title?: string;
    files?: readonly string[];
    delivery?: 'text';
    outcome?: 'delivered' | 'failed' | 'partial';
    remediations?: number;
    answer?: string;
    /** A comparison rerun of this run, on other models; `goal` is then the origin's. */
    rerunOf?: string;
  }
): string {
  const projectRunId = randomUUID();
  const base = join(w.root, 'runs', projectRunId);
  const created = w.store.createProjectRun({
    orgId: who.orgId,
    principalId: who.principalId,
    projectId: who.projectId,
    projectRunId,
    ...(input.rerunOf
      ? {
        request: { idempotencyKey: `k-${projectRunId}`, rerunOf: input.rerunOf, models: {
          l1: ANTHROPIC_PINS.ATOMA_MODEL_L1, l2: ANTHROPIC_PINS.ATOMA_MODEL_L2, l3: ANTHROPIC_PINS.ATOMA_MODEL_L3,
        } },
        origin: { goal: input.goal, acceptance: null },
      }
      : { request: { idempotencyKey: `k-${projectRunId}`, goal: input.goal } }),
    hostPaths: {
      workspacePath: join(base, 'workspace'),
      runsPath: join(base, 'traces'),
      logPath: join(base, 'run.log'),
    },
  });
  if (!created) throw new Error('create refused');
  w.store.transitionProjectRun({ orgId: who.orgId, projectRunId, from: 'queued', to: 'running' });
  const outcome = input.outcome ?? 'delivered';
  const stats = { ...STATS, outcome, rootRemediations: input.remediations ?? 0 };
  if (outcome === 'failed') {
    w.store.transitionProjectRun({ orgId: who.orgId, projectRunId, from: 'running', to: 'failed', error: 'boom', stats });
  } else {
    if (input.answer !== undefined) {
      mkdirSync(join(base, 'traces'), { recursive: true });
      writeFileSync(
        join(base, 'traces', `${projectRunId}.json`),
        JSON.stringify({ id: projectRunId, endedAt: new Date().toISOString(), result: { output: input.answer } })
      );
    }
    w.store.completeProjectRun({
      orgId: who.orgId, projectRunId, traceId: projectRunId, stats,
      manifest: manifestOf(input.files ?? [], input.delivery),
      ...(outcome === 'partial' ? { to: 'partial' as const, error: 'partial' } : {}),
    });
  }
  if (input.title) {
    w.store.recordRunTitle({
      orgId: who.orgId, projectRunId, title: input.title,
      receipt: { model: 'api:zai:x', inputTokens: 1, outputTokens: 1, costUsd: 0, generatedAt: new Date().toISOString() },
    });
  }
  return projectRunId;
}

interface ClientOrganisation {
  /** Its founder and owner, by their first login; not a platform admin. */
  readonly owner: Viewer;
  /** The platform admin, admitted there by invitation at any role, owner included: never its founder. */
  readonly admin: Viewer;
  /** Where the platform admin's runs there are seeded: their principal, its organisation and project. */
  readonly asAdmin: World['admin'];
}

/**
 * A CLIENT ORGANISATION the platform admin was invited into with `role`, with
 * one project left at the default `listed`: exactly the shape the owner
 * decision of 2026-10-09 keeps off the public showcase, `org:owner` included,
 * since every invitation is minted by a platform admin or the host CLI.
 */
function joinClientOrganisation(w: World, role: OrgRole = 'org:admin'): ClientOrganisation {
  const auth = AuthStore.open(w.dbPath);
  const founded = auth.completeLogin(
    { provider: 'github', subject: `client-${role}`, displayName: `Client ${role}`, email: null, emailVerified: false },
    null
  );
  if (!founded) throw new Error('client bootstrap failed');
  const invitation = auth.createInvitation({ orgId: founded.viewer.orgId, token: `admin-joins-as-${role}`, role, ttlMs: 60_000 });
  nextMillisecond();
  const joined = auth.completeLogin(
    { provider: 'github', subject: 'admin', displayName: 'admin', email: null, emailVerified: false },
    invitation.tokenHash
  );
  if (!joined || joined.viewer.role !== role || !joined.viewer.platformAdmin) throw new Error('admin admission failed');
  const slug = `client-${role.slice('org:'.length)}`;
  const project = w.store.createProject({
    orgId: founded.viewer.orgId,
    principalId: founded.viewer.principalId,
    project: {
      name: `Client ${role} project`, slug, initialPrompt: 'x',
      repositoryTarget: { installationId: '123', owner: 'client-owner', name: slug, visibility: 'private' },
    },
  });
  return {
    owner: founded.viewer,
    admin: joined.viewer,
    asAdmin: { orgId: founded.viewer.orgId, principalId: w.admin.principalId, projectId: project.projectId },
  };
}

/**
 * Spin to the next millisecond, the resolution of a membership's `created_at`,
 * so the next membership is strictly later than every one before it: who came
 * FIRST to an organisation is what the showcase asks.
 */
function nextMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // Busy for under a millisecond.
  }
}

/** The refusal `act` throws; fails the test when it throws none. */
function refusalOf(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('who may be shown', () => {
  it('is exactly the delivered runs of a platform admin, in an organisation they founded and still own', () => {
    const w = world();
    const shown = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    seedRun(w, w.admin, { goal: 'Admin failed', outcome: 'failed' });
    seedRun(w, w.admin, { goal: 'Admin partial', outcome: 'partial', files: ['a.md'] });
    seedRun(w, w.member, { goal: 'Member delivered, not an admin', files: ['README.md'] });
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([shown]);
  });

  it('never shows a platform admin\'s run in a client organisation they joined, at any role, owner included', () => {
    const w = world();
    const own = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    const clients = (['org:admin', 'org:member', 'org:owner'] as const).map((role) => joinClientOrganisation(w, role));
    for (const client of clients) seedRun(w, client.asAdmin, { goal: 'Client work', files: ['README.md'] });
    // Listed, as every new project is: who founded the organisation keeps them off, not the flag or the role.
    for (const client of clients) {
      expect(w.store.getProject(client.asAdmin.orgId, client.asAdmin.projectId)!.showcase).toBe('listed');
    }
    const ids = () => new Set(w.store.listShowcaseRuns().map((run) => run.projectRunId));
    expect(ids()).toEqual(new Set([own]));
    expect(w.store.showcaseOrganisations()).toEqual(new Set([w.admin.orgId]));
    // The first member decides, never the earliest remaining owner: the
    // client's founder stepping down (no product path does) promotes nobody.
    const invitedOwner = clients[2]!;
    const db = new Database(w.dbPath);
    try {
      db.prepare('UPDATE auth_memberships SET role = ? WHERE org_id = ? AND principal_id = ?')
        .run('org:admin', invitedOwner.asAdmin.orgId, invitedOwner.owner.principalId);
      expect(ids()).toEqual(new Set([own]));
      expect(w.store.showcaseOrganisations()).toEqual(new Set([w.admin.orgId]));
    } finally {
      db.close();
    }
  });

  it('never takes an admission stamped before its organisation existed, by a clock stepped back, for the founding', () => {
    const w = world();
    const own = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    const auth = AuthStore.open(w.dbPath);
    // The client founds an organisation while the host clock runs an hour fast...
    const wall = Date.now;
    const fast = vi.spyOn(Date, 'now').mockImplementation(() => wall() + 3_600_000);
    let founded: ReturnType<AuthStore['completeLogin']>;
    try {
      founded = auth.completeLogin(
        { provider: 'github', subject: 'client', displayName: 'Client', email: null, emailVerified: false }, null);
    } finally {
      fast.mockRestore();
    }
    if (!founded) throw new Error('client bootstrap failed');
    // ...then the clock steps back, and the platform admin joins as an owner:
    // later in fact, yet an hour EARLIER on the clock than the founding.
    const invitation = auth.createInvitation({ orgId: founded.viewer.orgId, token: 'admin-after-the-step', role: 'org:owner', ttlMs: 60_000 });
    const joined = auth.completeLogin(
      { provider: 'github', subject: 'admin', displayName: 'admin', email: null, emailVerified: false }, invitation.tokenHash);
    expect(joined?.viewer).toMatchObject({ orgId: founded.viewer.orgId, role: 'org:owner', platformAdmin: true });
    const project = w.store.createProject({
      orgId: founded.viewer.orgId, principalId: founded.viewer.principalId,
      project: { name: 'Client project', slug: 'client-stepped', initialPrompt: 'x',
        repositoryTarget: { installationId: '123', owner: 'client-owner', name: 'client-stepped', visibility: 'private' } },
    });
    seedRun(w, { orgId: founded.viewer.orgId, principalId: w.admin.principalId, projectId: project.projectId },
      { goal: 'Client work', files: ['README.md'] });
    expect(w.store.showcaseOrganisations()).toEqual(new Set([w.admin.orgId]));
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([own]);
  });

  it('fails closed on a tie: two first members stamped in one millisecond found nothing', () => {
    const w = world();
    const own = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    // A member-less organisation (a converged pre-release store) whose two
    // owner invitations, the client's and the platform admin's, were consumed
    // within one millisecond: one `created_at` for both memberships.
    const tied = randomUUID();
    const joinedAt = new Date().toISOString();
    const db = new Database(w.dbPath);
    try {
      db.prepare('INSERT INTO auth_organisations (org_id, name, created_at) VALUES (?, ?, ?)')
        .run(tied, 'Primary', new Date(Date.parse(joinedAt) - 60_000).toISOString());
      const membership = db.prepare('INSERT INTO auth_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)');
      membership.run(tied, w.member.principalId, 'org:owner', joinedAt);
      membership.run(tied, w.admin.principalId, 'org:owner', joinedAt);
    } finally {
      db.close();
    }
    const project = w.store.createProject({
      orgId: tied, principalId: w.member.principalId,
      project: { name: 'Tied project', slug: 'tied', initialPrompt: 'x',
        repositoryTarget: { installationId: '123', owner: 'client-owner', name: 'tied', visibility: 'private' } },
    });
    seedRun(w, { orgId: tied, principalId: w.admin.principalId, projectId: project.projectId }, { goal: 'Tied work', files: ['README.md'] });
    expect(w.store.showcaseOrganisations()).toEqual(new Set([w.admin.orgId]));
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([own]);
  });

  it('asks whether the requester founded the run\'s organisation, not only whether they own it', () => {
    const w = world();
    const own = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    // A second platform admin, invited into the first one's organisation as an owner.
    const auth = AuthStore.open(w.dbPath);
    auth.grantPlatformAdmin(w.member.principalId);
    const invitation = auth.createInvitation({ orgId: w.admin.orgId, token: 'second-admin-joins', role: 'org:owner', ttlMs: 60_000 });
    nextMillisecond();
    const joined = auth.completeLogin(
      { provider: 'github', subject: 'member', displayName: 'member', email: null, emailVerified: false },
      invitation.tokenHash
    );
    expect(joined?.viewer).toMatchObject({ orgId: w.admin.orgId, role: 'org:owner', platformAdmin: true });
    seedRun(w, { ...w.admin, principalId: w.member.principalId }, { goal: 'Not the founder here', files: ['README.md'] });
    const theirOwn = seedRun(w, w.member, { goal: 'In their own organisation', files: ['README.md'] });
    expect(new Set(w.store.listShowcaseRuns().map((run) => run.projectRunId))).toEqual(new Set([own, theirOwn]));
  });

  it('keeps a comparison rerun off it', () => {
    const w = world();
    const origin = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'], rerunOf: origin });
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([origin]);
  });

  it('keeps a project created hidden off it, lists one that predates the flag, and hides any other value', () => {
    const w = world();
    const shown = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    const measured = w.store.createProject({
      orgId: w.admin.orgId,
      principalId: w.admin.principalId,
      project: {
        name: 'Effort batch', slug: 'effort-batch', showcase: 'hidden',
        repositoryTarget: { installationId: '123', owner: 'secret-owner-admin', name: 'effort-batch', visibility: 'private' },
      },
    });
    expect(measured.showcase).toBe('hidden');
    expect(w.store.getProject(w.admin.orgId, w.admin.projectId)!.showcase).toBe('listed');
    seedRun(w, { ...w.admin, projectId: measured.projectId }, { goal: 'Measurement run', files: ['README.md'] });
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([shown]);
    const db = new Database(w.dbPath);
    try {
      // A project created before 2026-10-06 carries no value: listed, as it was.
      db.prepare('UPDATE projects SET showcase = NULL WHERE project_id = ?').run(w.admin.projectId);
      expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([shown]);
      expect(w.store.getProject(w.admin.orgId, w.admin.projectId)!.showcase).toBe('listed');
      // Anything but `listed` hides: exposure fails closed.
      db.prepare("UPDATE projects SET showcase = 'Listed' WHERE project_id = ?").run(w.admin.projectId);
      expect(w.store.listShowcaseRuns()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('lets an organisation admin hide or re-list a project of their own, journaled, and nobody else', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-showcase-setter-'));
    roots.push(root);
    const dbPath = join(root, 'atoma.db');
    const auth = AuthStore.open(dbPath);
    const store = ProjectStore.open(dbPath);
    const [owner, other] = (['owner', 'other'] as const).map((name) => {
      const login = auth.completeLogin({ provider: 'github', subject: name, displayName: name, email: null, emailVerified: false }, null);
      if (!login) throw new Error('bootstrap failed');
      return login.viewer;
    });
    auth.grantPlatformAdmin(owner!.principalId);
    const project = store.createProject({
      orgId: owner!.orgId, principalId: owner!.principalId,
      project: { name: 'L3 experiment', slug: 'l3-experiment', repositoryTarget: { installationId: '1', owner: 'o', name: 'l3', visibility: 'private' } },
    });
    const w = { root, dbPath, store, admin: { orgId: owner!.orgId, principalId: owner!.principalId, projectId: project.projectId } } as World;
    const run = seedRun(w, w.admin, { goal: 'A contrived puzzle', files: ['report.md'] });
    const events: PlatformEventInput[] = [];
    const service = new ProjectService({
      store, github: null, coordinator: {} as never,
      events: (event) => {
        expect(platformEventInputSchema.safeParse(event).success).toBe(true);
        events.push(event);
      },
    });
    expect(store.listShowcaseRuns().map((row) => row.projectRunId)).toEqual([run]);

    expect(service.setProjectShowcase(owner!, project.projectId, 'hidden')).toMatchObject({ projectId: project.projectId, showcase: 'hidden' });
    expect(store.listShowcaseRuns()).toEqual([]);
    expect(events).toEqual([expect.objectContaining({
      kind: 'project.showcase_changed', actorId: owner!.principalId, orgId: owner!.orgId, projectId: project.projectId,
      summary: 'Project "L3 experiment" taken off the public showcase', detail: { from: 'listed', to: 'hidden' },
    })]);
    // Asking for what already holds changes nothing and journals nothing.
    service.setProjectShowcase(owner!, project.projectId, 'hidden');
    expect(events).toHaveLength(1);

    // Writes stay in the caller's organisation, and need an organisation admin.
    expect(() => service.setProjectShowcase(other!, project.projectId, 'listed')).toThrow(/project not found/);
    expect(() => service.setProjectShowcase({ ...owner!, role: 'org:member' }, project.projectId, 'listed')).toThrow(/org:admin/);
    expect(() => service.setProjectShowcase(owner!, project.projectId, 'public')).toThrow(/listed or hidden/);
    expect(store.listShowcaseRuns()).toEqual([]);

    service.setProjectShowcase(owner!, project.projectId, 'listed');
    expect(store.listShowcaseRuns().map((row) => row.projectRunId)).toEqual([run]);
    expect(events.map((event) => event.summary)).toEqual([
      'Project "L3 experiment" taken off the public showcase', 'Project "L3 experiment" put on the public showcase',
    ]);
  });

  it('tells the project list which projects a visitor sees now, from the page\'s own read', () => {
    const w = world();
    const shownRun = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    const project = (slug: string, showcase: 'listed' | 'hidden') => w.store.createProject({
      orgId: w.admin.orgId, principalId: w.admin.principalId,
      project: { name: slug, slug, showcase, repositoryTarget: { installationId: '1', owner: 'o', name: slug, visibility: 'private' } },
    }).projectId;
    const eligible = project('eligible', 'listed');
    const hidden = project('hidden', 'hidden');
    seedRun(w, { ...w.admin, projectId: hidden }, { goal: 'Hidden delivery', files: ['README.md'] });
    const viewer = { orgId: w.admin.orgId, principalId: w.admin.principalId, role: 'org:owner', platformAdmin: false } as never;
    const states = (enabled?: boolean) => {
      const service = new ProjectService({ store: w.store, github: null, coordinator: {} as never,
        ...(enabled === undefined ? {} : { showcaseEnabled: () => enabled }) });
      const rows = service.listProjects(viewer) as { projectId: string; showcase: string; showcaseShown: boolean }[];
      return Object.fromEntries(rows.map((row) => [row.projectId, [row.showcase, row.showcaseShown]]));
    };
    expect(states(true)).toEqual({
      [w.admin.projectId]: ['listed', true], [eligible]: ['listed', false], [hidden]: ['hidden', false],
    });
    // A host that does not publish the showcase shows nothing on it, listed or not.
    for (const off of [false, undefined]) expect(Object.values(states(off)).every(([, shown]) => shown === false)).toBe(true);
    expect(w.store.listShowcaseRuns().map((run) => run.projectRunId)).toEqual([shownRun]);
  });

  it('never marks a client organisation\'s project eligible, for its owner or a platform admin, and refuses to set it', () => {
    const w = world();
    seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    // Invited as an owner, the highest role an invitation carries: still not theirs.
    const client = joinClientOrganisation(w, 'org:owner');
    seedRun(w, client.asAdmin, { goal: 'Client work', files: ['README.md'] });
    // A client project created hidden gets no badge either, not even "Hidden".
    const hidden = w.store.createProject({
      orgId: client.owner.orgId, principalId: client.owner.principalId,
      project: { name: 'Client hidden', slug: 'client-hidden', showcase: 'hidden',
        repositoryTarget: { installationId: '123', owner: 'client-owner', name: 'client-hidden', visibility: 'private' } },
    }).projectId;
    const events: PlatformEventInput[] = [];
    const service = new ProjectService({ store: w.store, github: null, coordinator: {} as never,
      showcaseEnabled: () => true, auditRead: () => true, events: (event) => events.push(event) });
    // As JSON carries it: an omitted key, never a null one ('none' when both are absent).
    const states = (viewer: Viewer) => Object.fromEntries(
      (JSON.parse(JSON.stringify(service.listProjects(viewer))) as Record<string, unknown>[]).map((row) => [row['projectId'],
        'showcase' in row || 'showcaseShown' in row ? [row['showcase'], row['showcaseShown']] : 'none'])
    );
    expect(states(client.owner)).toEqual({ [client.asAdmin.projectId]: 'none', [hidden]: 'none' });
    // The platform admin's cross-organisation list: only their own organisation's project says anything.
    expect(states(client.admin)).toEqual({
      [w.admin.projectId]: ['listed', true], [w.member.projectId]: 'none', [client.asAdmin.projectId]: 'none', [hidden]: 'none',
    });

    // Neither the client's founder nor the platform admin who co-owns it may set what cannot show.
    for (const viewer of [client.owner, client.admin]) {
      for (const projectId of [client.asAdmin.projectId, hidden]) {
        for (const value of ['hidden', 'listed']) {
          const refused = refusalOf(() => service.setProjectShowcase(viewer, projectId, value));
          expect(refused).toBeInstanceOf(ProjectHttpError);
          expect(refused).toMatchObject({
            status: 409, message: expect.stringMatching(/no platform admin founded and still owns this one/),
            // Nothing the caller can change makes a retry succeed, and the guidance says so.
            problem: { code: 'conflict', retryable: false, nextAction: expect.stringMatching(/^Nothing to retry: /) },
          });
        }
      }
    }
    expect(events).toEqual([]);
    expect(w.store.getProject(client.asAdmin.orgId, client.asAdmin.projectId)!.showcase).toBe('listed');
    expect(w.store.getProject(client.asAdmin.orgId, hidden)!.showcase).toBe('hidden');
    // Another organisation's project is still not found first.
    expect(refusalOf(() => service.setProjectShowcase(client.owner, w.admin.projectId, 'hidden'))).toMatchObject({ status: 404 });

    // The flag is read per call: revoked, the admin's own organisation is no longer eligible either.
    AuthStore.open(w.dbPath).revokePlatformAdmin(w.admin.principalId);
    const ownOwner: Viewer = { ...client.admin, orgId: w.admin.orgId, role: 'org:owner', platformAdmin: false };
    expect(states(ownOwner)).toEqual({ [w.admin.projectId]: 'none' });
  });

  it('follows the admin flag and the ownership at read time, and the page\'s own source within one TTL', () => {
    const w = world();
    const own = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    seedRun(w, w.member, { goal: 'Member run', files: ['README.md'] });
    const ids = () => w.store.listShowcaseRuns().map((run) => run.projectRunId);
    const auth = AuthStore.open(w.dbPath);
    expect(ids()).toEqual([own]);
    auth.revokePlatformAdmin(w.admin.principalId);
    expect(ids()).toEqual([]);
    expect(w.store.showcaseOrganisations().size).toBe(0);
    auth.grantPlatformAdmin(w.admin.principalId);
    expect(ids()).toEqual([own]);

    let clock = 0;
    const source = createShowcaseSource(w.store, () => clock);
    expect(source.entry(own)).not.toBeNull();
    // No product path changes a role, and a run's foreign key keeps its
    // requester's membership: an owner stepping down is this UPDATE.
    const db = new Database(w.dbPath);
    try {
      const role = db.prepare('UPDATE auth_memberships SET role = ? WHERE org_id = ? AND principal_id = ?');
      role.run('org:admin', w.admin.orgId, w.admin.principalId);
      expect(ids()).toEqual([]);
      expect(w.store.showcaseOrganisations().size).toBe(0);
      // The page reuses its read for one TTL, then the run is gone from it.
      expect(source.entry(own)).not.toBeNull();
      clock += SHOWCASE_TTL_MS;
      expect(source.entry(own)).toBeNull();
      expect(source.entries()).toEqual([]);
      expect(source.answer(own, own)).toBeNull();
      role.run('org:owner', w.admin.orgId, w.admin.principalId);
      expect(ids()).toEqual([own]);
      clock += SHOWCASE_TTL_MS;
      expect(source.entry(own)).not.toBeNull();
      // A clock that steps back expires the read at once, never stretches it.
      role.run('org:admin', w.admin.orgId, w.admin.principalId);
      clock -= 10 * SHOWCASE_TTL_MS;
      expect(source.entry(own)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('counts its TTL in elapsed time, so the wall clock stepping back never stretches it', () => {
    const w = world();
    const own = seedRun(w, w.admin, { goal: 'Admin delivered', files: ['README.md'] });
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    // The server's own source: no clock injected.
    const source = createShowcaseSource(w.store);
    expect(source.entry(own)).not.toBeNull();
    AuthStore.open(w.dbPath).revokePlatformAdmin(w.admin.principalId);
    // Built while the wall clock ran ten minutes fast; it is then stepped
    // back, and ten and a half minutes on it reads half a TTL past the build.
    vi.setSystemTime(Date.now() - 10 * 60_000);
    vi.advanceTimersByTime(10 * 60_000 + SHOWCASE_TTL_MS / 2);
    expect(source.entry(own)).toBeNull();
    expect(source.entries()).toEqual([]);
  });

  it('answers nothing, without throwing, unless the store holds all three auth tables', () => {
    const w = world();
    closeStoreHandles();
    const bare = ProjectStore.open(join(w.root, 'other.db'));
    expect(bare.listShowcaseRuns()).toEqual([]);
    expect(bare.showcaseOrganisations().size).toBe(0);
    // A partial store missing any one of them: GET / and every project list read it, so no throw.
    const tables = {
      auth_platform_admins: ['CREATE TABLE auth_platform_admins (principal_id TEXT PRIMARY KEY, granted_at TEXT NOT NULL, granted_by TEXT NOT NULL)',
        "INSERT INTO auth_platform_admins VALUES ('p', 'now', 'test')"],
      auth_memberships: ['CREATE TABLE auth_memberships (org_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (org_id, principal_id))',
        "INSERT INTO auth_memberships VALUES ('o', 'p', 'org:owner', 'now')"],
      auth_organisations: ['CREATE TABLE auth_organisations (org_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
        "INSERT INTO auth_organisations VALUES ('o', 'Org', 'now')"],
    } as const;
    for (const missing of [...Object.keys(tables), null]) {
      const db = new Database(':memory:');
      try {
        const partial = new ProjectStore(db);
        for (const [name, [table, row]] of Object.entries(tables)) {
          if (name === missing) continue;
          db.exec(table);
          db.exec(row);
        }
        expect(partial.listShowcaseRuns()).toEqual([]);
        // The same rows make a founder once all three tables hold them.
        expect([...partial.showcaseOrganisations()]).toEqual(missing === null ? ['o'] : []);
      } finally {
        db.close();
      }
    }
  });
});

describe('classification and grouping', () => {
  const kind = (files: readonly string[], delivery?: 'text') =>
    classifyShowcase({ artifactManifest: manifestOf(files, delivery) });

  it('reads the kind from the deliverable alone', () => {
    expect(kind([], 'text')).toBe('answers');
    expect(kind(['index.html', 'README.md'])).toBe('software');
    expect(kind(['server.js', 'README.md'])).toBe('software');
    expect(kind(['sos.wav', 'verify_sos.py'])).toBe('media');
    expect(kind(['plate.svg', 'verify_geometry.py'])).toBe('media');
    expect(kind(['report.md', 'summary.csv'])).toBe('reports');
    expect(classifyShowcase({ artifactManifest: null })).toBe('answers');
  });

  it('classifies the delivered Signal Orchard typeface ahead of its specimen image', () => {
    expect(kind([
      'signal-orchard.bdf', 'signal-orchard-specimen.svg', 'signal-orchard-glyphs.json',
      'build-signal-orchard.js', 'check-bdf.js', 'render-specimen.js', 'README.md', 'VERIFICATION.md',
    ])).toBe('typefaces');
  });

  it('classifies the delivered Shuttle Bloom weaving pattern ahead of its diagrams', () => {
    expect(kind([
      'opening-flowers.wif', 'drawdown.svg', 'printable-threading-treadling.svg',
      'check_sampler.py', 'generate_sampler.py', 'measured-results.json', 'README.md',
    ])).toBe('textiles');
    expect(kind(['opening-flowers.wif', 'preview.stl', 'labels.ttf', 'drawdown.svg'])).toBe('textiles');
    expect(kind(['opening-flowers.wif.json', 'README.md'])).toBe('reports');
    expect(kind(['weaving-pattern.svg', 'threading.md'])).toBe('media');
  });

  it('classifies the delivered Futures Cabinet EPUB ahead of its cover and source files', () => {
    expect(kind([
      'build_epub.py', 'futures-cabinet.epub', 'inventory.json', 'README.md', 'scene-graph.json',
      'source/EPUB/container.xml', 'source/EPUB/cover.svg', 'source/EPUB/cover.xhtml',
      'source/EPUB/nav.xhtml', 'source/EPUB/navigation.xhtml', 'source/EPUB/package.opf',
      'source/EPUB/story.xhtml', 'source/EPUB/style.css', 'source/META-INF/container.xml',
      'source/mimetype', 'validate_epub.py', 'verification.md',
    ])).toBe('books');
    expect(kind(['book.epub', 'pattern.wif', 'model.stl', 'labels.ttf', 'cover.svg'])).toBe('books');
    expect(kind(['book.epub.json', 'story.xhtml'])).toBe('reports');
    expect(kind(['book-cover.svg', 'story.md'])).toBe('media');
  });

  it('classifies the delivered Touchmarks models ahead of their contact sheet', () => {
    expect(kind([
      'concentric-squares.stl', 'contact-sheet.svg', 'cross.stl', 'design-spec.json', 'dots.stl',
      'generate_tokens.py', 'inventory.sha256', 'mesh-report.json', 'parallel-bars.stl',
      'README.md', 'spiral.stl', 'validate_mesh.py', 'verify_delivery.py', 'zigzag.stl',
    ])).toBe('models');
    expect(kind(['model.stl', 'labels.ttf', 'contact-sheet.svg'])).toBe('models');
    expect(kind(['mesh.obj', 'part.stl.json', 'model.3mf.md', 'assembly.step.txt', 'part.stp.csv'])).toBe('reports');
    expect(kind(['model.svg', 'mesh.obj', 'design.md'])).toBe('media');
  });

  it.each([
    ['bdf', 'typefaces'], ['wif', 'textiles'],
    ['epub', 'books'],
    ['stl', 'models'], ['3mf', 'models'], ['step', 'models'], ['stp', 'models'],
  ])('recognizes .%s artifacts without relabelling software that bundles them', (extension, expectedKind) => {
    const artifact = `artifacts/Example.${extension.toUpperCase()}`;
    expect(kind([artifact, 'specimen.png'])).toBe(expectedKind);
    for (const marker of ['index.html', 'server.js', 'package.json', 'app.py', 'main.py']) {
      expect(kind([`app/${marker}`, artifact, 'specimen.svg'])).toBe('software');
    }
    expect(kind([artifact], 'text')).toBe('answers');
  });

  it('treats an outline font as a typeface only beside the sources it was built from', () => {
    // Alone, OTF/TTF are what a report, a poster or an app bundles, as WOFF is.
    expect(kind(['report.pdf', 'fonts/Body.ttf'])).toBe('reports');
    expect(kind(['poster.svg', 'fonts/Display.OTF'])).toBe('media');
    expect(kind(['artifacts/Example.TTF', 'specimen.png'])).toBe('media');
    for (const source of ['sources/Orchard.glyphs', 'sources/Orchard.designspace', 'Orchard.sfd', 'features.fea',
      'sources/Orchard-Regular.ufo/fontinfo.plist', 'sources/Orchard.glyphspackage/fontinfo.plist']) {
      expect(kind(['fonts/ttf/Orchard-Regular.ttf', source, 'specimen.pdf'])).toBe('typefaces');
      expect(kind(['fonts/otf/Orchard-Regular.otf', source, 'specimen.png'])).toBe('typefaces');
      // Sources without a compiled font deliver no typeface; software keeps its bundled fonts.
      expect(kind([source, 'README.md'])).toBe('reports');
      expect(kind(['app/package.json', 'fonts/ttf/Orchard-Regular.ttf', source])).toBe('software');
    }
    // A name ending like a source directory is not one unless it is a directory.
    expect(kind(['notes.ufo', 'fonts/Body.ttf'])).toBe('reports');
  });

  it('does not treat webfont assets, font prose or misleading suffixes as a typeface delivery', () => {
    expect(kind(['fonts/example.woff', 'fonts/example.woff2', 'README.md'])).toBe('reports');
    expect(kind(['font.bdf.json', 'font.otf.txt', 'font.ttf.md'])).toBe('reports');
    expect(kind(['typeface.svg', 'font-design.md'])).toBe('media');
  });

  it('cuts an unnamed goal to one short line', () => {
    expect(titleFromGoal('  A  short\n goal ')).toBe('A short goal');
    const long = titleFromGoal('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('groups a project\'s runs into one entry anchored on its first run', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'));
    const w = world();
    const first = seedRun(w, w.admin, { goal: 'Build a guestbook', title: 'A guestbook', files: ['index.html'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:01.000Z'));
    const second = seedRun(w, w.admin, { goal: 'Add delete', title: 'Delete messages', files: ['index.html'], remediations: 1 });
    const entries = buildShowcase(w.store.listShowcaseRuns());
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(first);
    expect(entries[0]!.episodes.map((episode) => episode.id)).toEqual([first, second]);
    expect(entries[0]!.episodes.map((episode) => episode.title)).toEqual(['A guestbook', 'Delete messages']);
    expect(entries[0]!.episodes[1]!.sentBack).toBe(1);
    expect(entries[0]!.kind).toBe('software');
    expect(entries[0]!.totalCostUsd).toBeCloseTo(0.6);
  });

  it.each([
    { category: 'typefaces', label: 'Typefaces', noun: 'Typeface', artifact: 'signal-orchard.bdf' },
    { category: 'textiles', label: 'Weaving patterns', noun: 'Weaving pattern', artifact: 'opening-flowers.wif' },
    { category: 'books', label: 'Books', noun: 'Book', artifact: 'futures-cabinet.epub' },
    { category: 'models', label: '3D models', noun: '3D model', artifact: 'concentric-squares.stl' },
  ])('counts a $category project once and uses its latest delivered format on the index and story', ({ category, label, noun, artifact }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T10:00:00.000Z'));
    const w = world();
    const first = seedRun(w, w.admin, { goal: 'Draw the design', files: ['specimen.svg'] });
    vi.setSystemTime(new Date('2026-10-09T10:01:00.000Z'));
    const second = seedRun(w, w.admin, { goal: 'Package the design', files: [artifact, 'specimen.svg'] });
    const source = createShowcaseSource(w.store);
    const entries = source.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: first, kind: category });
    expect(entries[0]!.episodes.map((episode) => episode.id)).toEqual([first, second]);

    const index = renderShowcaseIndex(entries, null);
    const story = renderShowcaseEntry(source.entry(first)!, new Map(), null);
    expect(index).toContain('Everything <small>1</small>');
    expect(index).toContain(`data-filter="${category}" aria-pressed="false">${label} <small>1</small>`);
    expect(index).not.toContain('data-filter="media"');
    expect(index).toContain(`href="/showcase/${first}" data-kind="${category}"`);
    for (const page of [index, story]) {
      expect(page).toContain(`>${noun}</span>`);
      expect(page).not.toContain('undefined');
    }
    expect(renderShowcaseIndex([], null)).not.toContain(`data-filter="${category}"`);
  });

  it('keeps recent software in order while bringing every available kind into the first cards', () => {
    const entry = (id: string, kind: ShowcaseKind, day: number): ShowcaseEntry => {
      const endedAt = `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
      return {
        id, kind, endedAt, totalDurationS: 1, totalCostUsd: 0,
        episodes: [{ id, title: id, request: id, endedAt, durationS: 1, costUsd: 0,
          sentBack: 0, files: [], textDelivery: kind === 'answers' }],
      };
    };
    const software = Array.from({ length: 18 }, (_, index) => entry(`s${index + 1}`, 'software', 7));
    const entries = [
      ...software,
      entry('a1', 'answers', 3),
      entry('r1', 'reports', 2),
      entry('m1', 'media', 2),
      entry('b1', 'books', 2),
      entry('w1', 'textiles', 2),
      entry('d1', 'models', 2),
      entry('t1', 'typefaces', 2),
      entry('m2', 'media', 2),
      entry('r2', 'reports', 2),
    ];
    const html = renderShowcaseIndex(entries, null);
    const cards = [...html.matchAll(/<a class="card" href="\/showcase\/([^"]+)" data-kind="([^"]+)">/g)]
      .map((match) => ({ id: match[1], kind: match[2] }));

    expect(cards).toHaveLength(entries.length);
    expect(new Set(cards.slice(0, 9).map((card) => card.kind))).toEqual(
      new Set(['software', 'answers', 'reports', 'media'])
    );
    expect(new Set(cards.slice(0, 21).map((card) => card.kind))).toEqual(
      new Set(['software', 'answers', 'reports', 'media', 'books', 'textiles', 'models', 'typefaces'])
    );
    expect(cards.filter((card) => card.kind === 'software').map((card) => card.id))
      .toEqual(software.map((item) => item.id));
    expect(cards.filter((card) => card.kind !== 'software').map((card) => card.id))
      .toEqual(['a1', 'r1', 'm1', 'b1', 'w1', 'd1', 't1', 'm2', 'r2']);
    expect(cards.slice(0, 3).map((card) => card.id)).toEqual(['s1', 's2', 'a1']);
    expect(html).toContain('Everything <small>27</small>');
  });

  it('rebuilds at most once per TTL', () => {
    const calls: number[] = [];
    let clock = 1_000;
    const source = createShowcaseSource({ listShowcaseRuns: () => (calls.push(clock), []) }, () => clock);
    source.entries();
    source.entries();
    expect(calls).toHaveLength(1);
    clock += SHOWCASE_TTL_MS + 1;
    source.entries();
    expect(calls).toHaveLength(2);
  });

  it('reads an answer\'s trace once per TTL, with the list', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Answer', delivery: 'text', answer: 'first' });
    const trace = join(w.root, 'runs', id, 'traces', `${id}.json`);
    let clock = 1_000;
    const source = createShowcaseSource(w.store, () => clock);
    expect(source.answer(id, id)).toBe('first');
    // A trace rewritten within the TTL is not read again: the answer is cached.
    writeFileSync(trace, JSON.stringify({ id, result: { output: 'second' } }));
    expect(source.answer(id, id)).toBe('first');
    clock += SHOWCASE_TTL_MS + 1;
    expect(source.answer(id, id)).toBe('second');
  });
});

describe('what a visitor can read', () => {
  it('carries no identity, path, repository or project name, on either page', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Explain the urn puzzle', title: 'The urn puzzle', delivery: 'text', answer: 'Posterior is 3/4.' });
    const source = createShowcaseSource(w.store);
    const entry = source.entry(id)!;
    const pages = [
      renderShowcaseIndex(source.entries(), new URL('https://atoma.example.com')),
      renderShowcaseEntry(entry, new Map([[id, source.answer(id, id)]]), new URL('https://atoma.example.com')),
    ].join('\n');
    for (const secret of [
      w.admin.orgId, w.admin.principalId, w.admin.projectId, w.root, 'Secret admin project',
      'secret-owner-admin', 'secret-repo-admin', 'secret-admin', w.member.orgId,
    ]) {
      expect(pages).not.toContain(secret);
    }
    expect(pages).toContain('The urn puzzle');
    expect(pages).toContain('Posterior is 3/4.');
  });

  it('shows a text delivery\'s answer, bounded, and no answer for a file delivery', () => {
    // Equal timestamps must not make this answer test depend on random UUID order.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'));
    const w = world();
    const text = seedRun(w, w.admin, { goal: 'Answer', delivery: 'text', answer: 'x'.repeat(20_000) });
    const files = seedRun(w, w.admin, { goal: 'Files', files: ['a.md'], answer: 'internal summary' });
    const source = createShowcaseSource(w.store);
    const entries = source.entries();
    expect(entries).toHaveLength(1);
    const entryId = entries[0]!.id;
    expect(source.answer(entryId, text)).toBe(`${'x'.repeat(8_000)}…`);
    expect(source.answer(entryId, files)).toBeNull();
    expect(source.answer(entryId, 'not-an-episode')).toBeNull();
  });

  it('withholds a host path the answer names', () => {
    const w = world();
    const install = join(repoRoot(), 'dist', 'cli', 'run.js');
    const home = join(homedir(), '.atoma', 'workspaces', 'build');
    const id = seedRun(w, w.admin, { goal: 'Where', delivery: 'text', answer: `Built by ${install} in ${home}.` });
    const answer = createShowcaseSource(w.store).answer(id, id);
    expect(answer).toBe('Built by <atoma>/dist/cli/run.js in ~/.atoma/workspaces/build.');
  });

  it('escapes every tenant- and model-authored value', () => {
    const w = world();
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const id = seedRun(w, w.admin, { goal: payload, title: payload, delivery: 'text', answer: payload });
    const source = createShowcaseSource(w.store);
    const html = [
      renderShowcaseIndex(source.entries(), null),
      renderShowcaseEntry(source.entry(id)!, new Map([[id, source.answer(id, id)]]), null),
    ].join('\n');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The only script on the page is the pinned filter bar.
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it('pins its inline script by hash, loads only this site\'s modules, and allows no network', () => {
    const csp = SHOWCASE_SECURITY_HEADERS['content-security-policy'];
    // `'self'` is the crystal module; nothing inline runs without its hash.
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*;\s*img|script-src[^;]*unsafe-inline/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/connect-src|unsafe-eval/);
    const html = renderShowcaseIndex([], null);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  it('puts the real crystal on every page when the build has it', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Goal', title: 'A title', files: ['a.md'] });
    const source = createShowcaseSource(w.store);
    const assets = { markScript: '/showcase-assets/atoma-mark.js?v=0123456789abcdef' };
    const pages = [
      renderShowcaseIndex(source.entries(), new URL('https://atoma.example.com'), assets),
      renderShowcaseEntry(source.entry(id)!, new Map(), new URL('https://atoma.example.com'), assets),
    ];
    for (const html of pages) {
      expect(html).toContain('<script type="module" src="/showcase-assets/atoma-mark.js?v=0123456789abcdef"></script>');
      expect(html.match(/data-atoma-mark="/g)!.length).toBeGreaterThanOrEqual(3);
    }
    // Exactly one section per page receives the lit crystal's light and caustics.
    for (const html of pages) expect(html.match(/data-atoma-receiver/g)).toHaveLength(1);
    expect(pages[0]).toContain('<main><section class="hero" data-atoma-receiver>');
    expect(pages[1]).toContain('<main class="story" data-atoma-receiver>');
    expect(SHOWCASE_SECURITY_HEADERS['content-security-policy']).toMatch(/script-src 'self' 'sha256-/);
    // Without a built bundle (a source checkout, these tests) there is no module to load.
    expect(renderShowcaseIndex([], null)).not.toContain('type="module"');
  });

  it('never shows a static crystal before or instead of the real one', () => {
    const assets = { markScript: '/showcase-assets/atoma-mark.js?v=0123456789abcdef' };
    for (const html of [renderShowcaseIndex([], null, assets), renderShowcaseIndex([], null)]) {
      // Every crystal host is empty until the Pixi canvas mounts in it: no SVG
      // placeholder for the 3D crystal to replace (removed twice, 936d00cc and here).
      const hosts = html.match(/data-atoma-mark="[a-z]+">.{0,8}/g)!;
      expect(hosts.length).toBeGreaterThanOrEqual(2);
      for (const host of hosts) expect(host).toMatch(/">(<\/div>|<\/span>)/);
      expect(html).not.toContain('aria-label="The Atoma crystal"');
    }
  });

  it('writes clean head metadata on every page, and nothing stray before the header', () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Goal', title: 'A title', files: ['a.md'] });
    const source = createShowcaseSource(w.store);
    const story = renderShowcaseEntry(source.entry(id)!, new Map(), new URL('https://atoma.example.com'));
    const home = renderShowcaseIndex(source.entries(), new URL('https://atoma.example.com'));
    for (const html of [story, home]) {
      // The production regression: a mangled join separator printed `"""+B+"""n` at the top.
      expect(html).not.toMatch(/"{3}|\+B\+/);
      const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
      expect(head.split('\n').every((line) => line === '' || /^\s*</.test(line) || /^[^<]*[{}:;]/.test(line))).toBe(true);
      expect(html.slice(html.indexOf('<body>') + '<body>'.length).trimStart().startsWith('<header')).toBe(true);
    }
    expect(story).toContain('<meta property="og:title" content="A title — Atoma">');
    expect(story).toContain(`<meta property="og:url" content="https://atoma.example.com/showcase/${id}">`);
  });

  it('keeps the header within a phone screen', () => {
    // Measured 2026-10-03: the full header was 481px wide on a 390px phone and
    // dragged the whole page sideways. On a phone it keeps the brand and the
    // two ways in, and its links never wrap.
    const html = renderShowcaseIndex([], null);
    const phone = [...html.matchAll(/@media \(max-width:640px\)\{([^@]*)\}/g)].map((match) => match[1]).join('');
    expect(phone).toContain('.brand .pill,nav.top a.secondary{display:none}');
    expect(html).toContain('<a class="secondary" href="/#feed">Finished work</a>');
    expect(html).toMatch(/nav\.top a\{[^}]*white-space:nowrap/);
  });

  it('says so when there is nothing to show, and uses plain words', () => {
    const html = renderShowcaseIndex([], null);
    expect(html).toContain('Nothing to show yet');
    expect(html).not.toMatch(/\b(agent|molecule|tissue|tier|L[123])\b/i);
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

async function boot(w: World, extra: Record<string, string>): Promise<string> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ATOMA_AUTH_') || key.startsWith('ATOMA_GITHUB_')) delete env[key];
  }
  for (const key of ['ATOMA_VIZ_AUTH', 'ATOMA_VIZ_PUBLIC_ORIGIN', 'ATOMA_VIZ_DEV_URL', 'ATOMA_DB_PATH',
    'ATOMA_RUNS_DIR', 'ATOMA_VIZ_SENTINEL', 'ATOMA_PUBLIC_SHOWCASE']) delete env[key];
  const profiles = mkdtempSync(join(tmpdir(), 'atoma-showcase-profiles-'));
  roots.push(profiles);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/viz/server.ts', '--host', '127.0.0.1', '--port', String(port),
      '--dir', join(w.root, 'runs'), '--db', w.dbPath, '--skills-dir', join(w.root, 'skills')],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        ATOMA_ACCOUNT_PROFILES_ROOT: profiles,
        ATOMA_VIZ_AUTH: '1',
        ATOMA_VIZ_PUBLIC_ORIGIN: origin,
        ATOMA_VIZ_SENTINEL: '0',
        ATOMA_AUTH_GITHUB_CLIENT_ID: 'test-client',
        ATOMA_AUTH_GITHUB_CLIENT_SECRET: 'test-secret',
        ATOMA_AUTH_GITHUB_AUTHORIZE_URL: 'http://127.0.0.1:9/authorize',
        ATOMA_AUTH_GITHUB_TOKEN_URL: 'http://127.0.0.1:9/token',
        ATOMA_AUTH_GITHUB_USERINFO_URL: 'http://127.0.0.1:9/userinfo',
        ATOMA_PROJECTS_ROOT: join(w.root, 'projects'),
        ...extra,
      },
    }
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
  children.push(child);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr.join('')}`);
    try {
      await fetch(`${origin}/robots.txt`);
      return origin;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server not ready\n${stderr.join('')}`);
}

describe('the home page', () => {
  const home = { enabled: true, pathname: '/', search: '', hasSession: false };

  it('is the showcase only for a bare / from a visitor with no session', () => {
    expect(servesShowcaseHome(home)).toBe(true);
    expect(servesShowcaseHome({ ...home, hasSession: true })).toBe(false);
    expect(servesShowcaseHome({ ...home, enabled: false })).toBe(false);
    expect(servesShowcaseHome({ ...home, pathname: '/index.html' })).toBe(false);
    expect(servesShowcaseHome({ ...home, pathname: '/app' })).toBe(false);
  });

  it('leaves every query string to the app shell, which reads them', () => {
    for (const search of ['?authNotice=providerRefused', '?invite=abc', '?atomaHandheld=1', '?x=']) {
      expect(servesShowcaseHome({ ...home, search })).toBe(false);
    }
  });

  it('sends a visitor in through /app, and carries the product identity', () => {
    const html = renderShowcaseIndex([], new URL('https://atoma.example.com'));
    expect(html).toContain('<title>Atoma — Watch a request turn into finished work</title>');
    expect(html).toContain('rel="canonical" href="https://atoma.example.com/"');
    expect(html).toContain('property="og:image" content="https://atoma.example.com/og-card.png"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('href="/app"');
    expect(html).not.toContain('href="/auth/login"');
    expect(html).not.toContain('href="/showcase"');
  });
});

describe('the real server', () => {
  it('serves the showcase as the home page to anyone, without a session', async () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Admin goal', title: 'An admin title', files: ['README.md'] });
    seedRun(w, w.member, { goal: 'MEMBER SECRET GOAL', title: 'Member secret title', files: ['README.md'] });
    // The platform admin's own deliveries in client organisations they were
    // invited into, as an admin and as an owner.
    const clients = (['org:admin', 'org:owner'] as const).map((role) => joinClientOrganisation(w, role));
    const leaked = clients.map((client) => seedRun(w, client.asAdmin, {
      goal: 'CLIENT SECRET GOAL', title: 'Client secret title', delivery: 'text', answer: 'CLIENT SECRET ANSWER',
    }));
    const auth = AuthStore.open(w.dbPath);
    const sessionOf = (viewer: Viewer) => {
      const token = randomBytes(32).toString('base64url');
      auth.createSession({ principalId: viewer.principalId, orgId: viewer.orgId, token, ttlMs: 600_000 });
      return token;
    };
    const sessions = clients.map((client) => ({ owner: sessionOf(client.owner), admin: sessionOf(client.admin) }));
    closeStoreHandles();
    const origin = await boot(w, { ATOMA_PUBLIC_SHOWCASE: '1' });

    const home = await fetch(`${origin}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(home.headers.get('set-cookie')).toBeNull();
    expect(home.headers.get('cache-control')).toBe('no-store');
    const html = await home.text();
    expect(html).toContain('An admin title');
    expect(html).toContain(`rel="canonical" href="${origin}/"`);
    expect(html).not.toContain('MEMBER SECRET GOAL');
    expect(html).not.toContain('Member secret title');
    for (const secret of ['CLIENT SECRET', 'Client secret title', ...leaked.map((run) => `/showcase/${run}`)]) {
      expect(html).not.toContain(secret);
    }
    expect(html).toContain('Everything <small>1</small>');
    expect(html).toContain(`href="/showcase/${id}"`);
    // A stale or forged cookie is just no session.
    const forged = await fetch(`${origin}/`, { headers: { cookie: 'atoma_session=forged' } });
    expect(await forged.text()).toContain('An admin title');

    // The app shell stays reachable, and a query string always means the shell.
    for (const path of ['/app', '/index.html', '/?authNotice=providerRefused', '/?invite=abc']) {
      expect(await (await fetch(`${origin}${path}`)).text()).not.toContain('Finished and checked');
    }

    const redirect = await fetch(`${origin}/showcase`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/');
    const story = await fetch(`${origin}/showcase/${id}`);
    expect(story.status).toBe(200);
    expect(await story.text()).toContain('An admin title');
    const unknown = await fetch(`${origin}/showcase/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    // A client organisation's story is no story at all: the same 404 as a made-up id.
    const unknownBody = await unknown.text();
    for (const run of leaked) {
      const clientStory = await fetch(`${origin}/showcase/${run}`);
      expect(clientStory.status).toBe(404);
      expect(await clientStory.text()).toBe(unknownBody);
    }
    expect((await fetch(`${origin}/showcase`, { method: 'POST' })).status).toBe(405);

    const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
    expect(sitemap).toContain(`/showcase/${id}</loc>`);
    for (const run of leaked) expect(sitemap).not.toContain(run);
    expect(sitemap).toContain(`<loc>${origin}/?lang=en</loc>`);
    expect(sitemap).toContain(`hreflang="fr" href="${origin}/?lang=fr"`);
    const frenchApp = await (await fetch(`${origin}/?lang=fr`)).text();
    expect(frenchApp).toContain(`<link rel="canonical" href="${origin}/?lang=fr" />`);
    expect(frenchApp).toContain(`hreflang="en" href="${origin}/?lang=en"`);
    // The control plane is untouched: runs still need a session.
    expect((await fetch(`${origin}/api/runs`)).status).toBe(401);

    // The project list over HTTP: no showcase field on a client's project, for
    // its own founder or for the platform admin's list of every organisation.
    const listed = async (token: string) => {
      const response = await fetch(`${origin}/api/projects`, { headers: { cookie: `atoma_session=${token}` } });
      expect(response.status).toBe(200);
      return new Map(((await response.json()) as Record<string, unknown>[]).map((row) => [row['projectId'], row]));
    };
    for (const [index, client] of clients.entries()) {
      const asOwner = await listed(sessions[index]!.owner);
      const asAdmin = await listed(sessions[index]!.admin);
      for (const rows of [asOwner, asAdmin]) {
        expect(rows.get(client.asAdmin.projectId)).toBeDefined();
        expect(rows.get(client.asAdmin.projectId)).not.toHaveProperty('showcase');
        expect(rows.get(client.asAdmin.projectId)).not.toHaveProperty('showcaseShown');
      }
      expect(asAdmin.get(w.admin.projectId)).toMatchObject({ showcase: 'listed', showcaseShown: true });
    }
  });

  it('keeps the app as the home page, and answers 404 for stories, unless the host opted in', async () => {
    const w = world();
    const id = seedRun(w, w.admin, { goal: 'Admin goal', title: 'An admin title', files: ['README.md'] });
    closeStoreHandles();
    const origin = await boot(w, {});
    expect(await (await fetch(`${origin}/`)).text()).not.toContain('Finished and checked');
    expect((await fetch(`${origin}/showcase`)).status).toBe(404);
    expect((await fetch(`${origin}/showcase/${id}`)).status).toBe(404);
    expect(await (await fetch(`${origin}/sitemap.xml`)).text()).not.toContain('/showcase');
  });
});
