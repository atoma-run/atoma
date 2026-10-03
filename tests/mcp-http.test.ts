import { PlatformEventLog } from '../src/platform/events.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { haystackTestEnvironment } from './helpers/haystack.js';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, sha256Hex, type Viewer } from '../src/auth/store.js';
import { closeStoreHandles, skillsDirPath } from '../src/core/stores.js';
import { readLedger } from '../src/core/ledger.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { resetRunsForTest, startRun, type RunDriver } from '../src/mcp/run.js';
import { operatorRunUri, projectRunUri } from '../src/mcp/resources.js';
import { McpHttpHost, type McpHttpHostOptions } from '../src/mcp/http.js';
import { callerTier, type McpCaller } from '../src/mcp/identity.js';
import { buildServer, mcpHostWiring } from '../src/mcp/server.js';
import { MCP_TOOL_NAMES, MCP_TOOLS, visibleTools, type McpToolDeps } from '../src/mcp/tools.js';
import { forgetJevCalibrationsForTest } from '../src/mcp/jevCalibrate.js';
import { JEV_ENDPOINT } from '../src/core/jev.js';
import { buildCompileSkillPrompt } from '../src/skills/compilePrompt.js';
import { CallerTasks, PROJECT_RUN_INPUT, ProjectRunTasks, forgetTasksForTest, projectRunTask, runSynchronously, type ProjectRunTaskDeps } from '../src/mcp/tasks.js';
import { MAX_CHECKLIST_BEHAVIOUR_CHARS } from '../src/contracts/acceptanceChecklist.js';
import { CallToolResultSchema, CreateTaskResultSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectStore } from '../src/projects/store.js';
import { ProjectRunCoordinator } from '../src/projects/coordinator.js';
import { ProjectHttpError, ProjectService } from '../src/projects/service.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { ANTHROPIC_PINS } from './tier-pins.js';
import { benchmarkRegistration } from './helpers/retrievalBenchmark.js';
import { summarizeRetrievalCampaign } from '../src/cli/retrievalCampaign.js';

/**
 * ONE MCP FOR EVERYONE, OVER HTTP. What these hold, through the real SDK
 * client against the real host on a real port:
 *   - the catalogue is filtered by tier: a viewer, a member, an org admin and
 *     the platform admin each see their ladder and nothing above it;
 *   - the ungated loopback operator sees the operator tools and nothing
 *     tenant-shaped, because the host has no organisations to honour;
 *   - no bearer is a 401, a session cannot be ridden by another caller, and a
 *     revoked token ends the session;
 *   - the API token store mints once, resolves to a fresh viewer, lists
 *     secret-free and revokes only its owner's tokens.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const hosts: McpHttpHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) {
    // The SDK client keeps its sockets alive; `close` alone would wait out
    // their idle timeout (~4s per server) before calling back.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  closeStoreHandles();
  forgetTasksForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function viewer(role: Viewer['role'], platformAdmin = false): Viewer {
  return {
    principalId: `p-${role}`,
    displayName: role,
    kind: 'human',
    orgId: 'org-1',
    orgName: 'Org One',
    role,
    platformAdmin,
    displayNameSource: 'provider',
  };
}

const NO_TENANT: McpToolDeps = { projects: null, auth: null, journal: null, operatorRuns: true };
/** A host that HAS the tenant runtime, as far as the catalogue's `needs` are concerned. */
const TENANT_HOST: McpToolDeps = {
  projects: { service: {} as never, store: {} as never },
  auth: {} as never,
  journal: { list: () => ({ events: [], nextBefore: null }) },
  operatorRuns: true,
};

async function listen(
  resolveCaller: (req: IncomingMessage) => McpCaller | null,
  deps: McpToolDeps,
  /** Ceilings and the origin pin, so a test can reach them without a hundred sessions. */
  extra: Partial<Pick<McpHttpHostOptions, 'allowedOrigins' | 'maxSessions' | 'maxSessionsPerCaller'>> = {}
): Promise<{ url: string; host: McpHttpHost }> {
  const server = createServer((req, res) => void host.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const host = new McpHttpHost({
    resolveCaller,
    ...mcpHostWiring(deps),
    allowedHosts: [`127.0.0.1:${port}`],
    ...extra,
  });
  hosts.push(host);
  return { url: `http://127.0.0.1:${port}/mcp`, host };
}

/** One `initialize` over plain fetch: the session id it opened, or the refusal's status. */
async function initialize(url: string, headers: Record<string, string> = {}): Promise<{ status: number; sessionId: string | null }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  });
  // Drain: an unread SSE body keeps the socket busy and the server's close waiting.
  await response.text();
  return { status: response.status, sessionId: response.headers.get('mcp-session-id') };
}

async function connect(url: string, bearer?: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {},
  });
  await client.connect(transport);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

it('reuses a project run across MCP sessions while its real lease is held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-idempotence-'));
  dirs.push(root);
  const dbPath = join(root, 'store.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin({
    provider: 'github', subject: 'owner', displayName: 'Owner',
    email: null, emailVerified: false,
  }, null)!;
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId, principalId: login.viewer.principalId,
    project: { name: 'Board', slug: 'board', repositoryTarget: {
      installationId: '123', owner: 'owner', name: 'board', visibility: 'private',
    } },
  });
  let launches = 0;
  let finish: (output: string) => void = () => undefined;
  const driven = new Promise<string>((resolve) => { finish = resolve; });
  const coordinator = new ProjectRunCoordinator({
    store, dbPath, projectsRoot: root,
    hostEnv: { ...haystackTestEnvironment(root), PATH: process.env['PATH'], ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'test-key' },
    acquireLease: (id) => acquireRunLease(id, join(root, 'lease.db')),
    driver: () => {
      launches++;
      return driven;
    },
  });
  const service = new ProjectService({ store, coordinator, github: null });
  const { url } = await listen(
    () => ({ kind: 'principal', viewer: login.viewer, tokenId: 'owner' }),
    { ...NO_TENANT, projects: { store, service }, auth },
  );
  const first = await connect(url);
  const second = await connect(url);
  const args = { projectId: project.projectId, goal: 'Build a board.', idempotencyKey: 'same-request' };
  const start = (client: Client, goal = args.goal, idempotencyKey = args.idempotencyKey) => client.request(
    { method: 'tools/call', params: { name: 'atoma_run_start', arguments: { ...args, goal, idempotencyKey } } },
    CreateTaskResultSchema, { task: { ttl: 60_000 } },
  );
  try {
    const original = await start(first);
    expect(original.task.status).toBe('working');
    const retry = await start(second);
    expect(retry.task.status).toBe('working');
    expect(retry.task.statusMessage).toBe(original.task.statusMessage);
    await vi.waitFor(() => expect(launches).toBe(1));
    expect(store.listProjectRuns(login.viewer.orgId, project.projectId)).toHaveLength(1);

    const conflict = await start(second, 'Different goal.');
    expect(conflict.task.status).toBe('failed');
    const conflictResult = await second.experimental.tasks.getTaskResult(conflict.task.taskId, CallToolResultSchema);
    expect(JSON.stringify(conflictResult.content)).toContain('different input');
    // A re-sent identical start under ANOTHER key (a keyless MCP start gets
    // a fresh one) re-attaches to the caller's live run: same task, no
    // second run, no refusal that would invite a duplicate later.
    const resent = await start(second, args.goal, 'new-request');
    expect(resent.task.status).toBe('working');
    expect(resent.task.taskId).toBe(original.task.taskId);
    // Another request while that run holds the place is refused naming it.
    const other = await start(second, 'Another board.', 'other-request');
    expect(other.task.status).toBe('failed');
    const otherResult = await second.experimental.tasks.getTaskResult(other.task.taskId, CallToolResultSchema);
    expect(JSON.stringify(otherResult.content)).toMatch(/your run [0-9a-f-]+ \(project/);
    expect(store.listProjectRuns(login.viewer.orgId, project.projectId)).toHaveLength(1);
  } finally {
    finish('--- run failed ---\n');
    await coordinator.waitForIdle();
    await first.close();
    await second.close();
  }
});

it('answers a project run task on a host that did not mint it — a restart — for the principal that started the run only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-durable-task-'));
  dirs.push(root);
  const dbPath = join(root, 'store.db');
  const auth = AuthStore.open(dbPath);
  const login = auth.completeLogin({
    provider: 'github', subject: 'owner', displayName: 'Owner',
    email: null, emailVerified: false,
  }, null)!;
  const store = ProjectStore.open(dbPath);
  const project = store.createProject({
    orgId: login.viewer.orgId, principalId: login.viewer.principalId,
    project: { name: 'Board', slug: 'board', repositoryTarget: {
      installationId: '123', owner: 'owner', name: 'board', visibility: 'private',
    } },
  });
  // Each launch waits on its own promise, which `finish` settles or the run's abort ends, as spawnRun's would.
  let finish: (output: string) => void = () => undefined;
  let launches = 0;
  const coordinator = new ProjectRunCoordinator({
    store, dbPath, projectsRoot: root,
    hostEnv: { ...haystackTestEnvironment(root), PATH: process.env['PATH'], ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'test-key' },
    acquireLease: (id) => acquireRunLease(id, join(root, 'lease.db')),
    driver: (input) => new Promise<string>((resolve) => {
      launches++;
      finish = resolve;
      input.signal?.addEventListener('abort', () => resolve('--- run cancelled ---\n'), { once: true });
    }),
  });
  const service = new ProjectService({ store, coordinator, github: null });
  const deps: McpToolDeps = { ...NO_TENANT, projects: { store, service }, auth };
  // A member of the same organisation who did not start the run: it may read the run, not follow its task.
  const colleague: Viewer = { ...login.viewer, principalId: '00000000-0000-4000-8000-000000000001', displayName: 'Colleague', role: 'org:member' };
  const resolveCaller = (req: IncomingMessage): McpCaller => req.headers.authorization === 'Bearer colleague'
    ? { kind: 'principal', viewer: colleague, tokenId: 'colleague' }
    : { kind: 'principal', viewer: login.viewer, tokenId: 'owner' };
  const before = await listen(resolveCaller, deps);
  const client = await connect(before.url);
  let after: Client | null = null;
  let other: Client | null = null;
  try {
    const created = await client.request(
      { method: 'tools/call', params: { name: 'atoma_run_start', arguments: { projectId: project.projectId, goal: 'Build a board.' } } },
      CreateTaskResultSchema, { task: { ttl: 60_000 } },
    );
    const [run] = store.listProjectRuns(login.viewer.orgId, project.projectId)!;
    expect(created.task.taskId).toBe(`project-run:${project.projectId}:${run!.projectRunId}`);
    // The host that minted the task is gone, and every session and task store with it.
    await client.close();
    await before.host.close();
    const restarted = await listen(resolveCaller, deps);
    after = await connect(restarted.url);
    expect(await after.experimental.tasks.getTask(created.task.taskId)).toMatchObject({ status: 'working' });
    expect((await after.experimental.tasks.listTasks()).tasks.map((task) => task.taskId)).toEqual([created.task.taskId]);
    other = await connect(restarted.url, 'colleague');
    await expect(other.experimental.tasks.getTask(created.task.taskId)).rejects.toThrow(/not found/i);
    await expect(other.experimental.tasks.cancelTask(created.task.taskId)).rejects.toThrow(/not found/i);
    expect((await other.experimental.tasks.listTasks()).tasks).toEqual([]);
    await vi.waitFor(() => expect(launches).toBe(1));
    finish('--- run failed ---\n');
    await coordinator.waitForIdle();
    const ended = store.getProjectRun(login.viewer.orgId, run!.projectRunId)!;
    expect(['delivered', 'partial', 'failed', 'cancelled']).toContain(ended.status);
    const result = await after.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema);
    expect(result.structuredContent).toMatchObject({ projectRunId: run!.projectRunId, status: ended.status });
    // tasks/cancel over the wire answers `cancelled`, as the spec requires, and reaches the run.
    const second = await after.request(
      { method: 'tools/call', params: { name: 'atoma_run_start', arguments: { projectId: project.projectId, goal: 'Build it again.' } } },
      CreateTaskResultSchema, { task: { ttl: 60_000 } },
    );
    expect(second.task.taskId).toMatch(/^project-run:/);
    expect(await after.experimental.tasks.cancelTask(second.task.taskId)).toMatchObject({ status: 'cancelled' });
    await coordinator.waitForIdle();
    expect(await after.experimental.tasks.getTask(second.task.taskId)).toMatchObject({ status: 'cancelled' });
  } finally {
    finish('--- run failed ---\n');
    await coordinator.waitForIdle();
    await after?.close();
    await other?.close();
  }
});

it('exposes the persisted Git destination over MCP without claiming a PR was merged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-publication-')); dirs.push(root);
  const f = projectRetrievalFixture(root);
  const { run } = f.makeRun({ 'index.html': '<h1>Published</h1>' });
  const reserved = f.projects.reservePublication({ orgId: f.viewer.orgId, projectRunId: run.projectRunId, idempotencyKey: 'receipt' })!;
  const transition = { orgId: f.viewer.orgId, publicationId: reserved.publication.publicationId };
  f.projects.transitionPublication({ ...transition, from: 'pending', to: 'publishing' });
  const git = { branch: 'atoma/run-test', baseBranch: 'release', defaultBranch: 'release',
    mode: 'pull-request', publishKind: 'created' } as const;
  f.projects.transitionPublication({ ...transition, from: 'publishing', to: 'published', receipt: {
    repositoryId: '777', fullName: 'owner/docs', url: 'https://github.com/owner/docs', defaultBranch: 'release',
    commitSha: 'c'.repeat(40), baseSha: 'b'.repeat(40), git, pullRequestUrl: 'https://github.com/owner/docs/pull/1',
  } });
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root });
  const service = new ProjectService({ store: f.projects, coordinator, github: null });
  const { url } = await listen(() => ({ kind: 'principal', viewer: f.viewer, tokenId: 'owner' }),
    { ...NO_TENANT, projects: { store: f.projects, service }, auth: f.auth });
  const client = await connect(url);
  try {
    const result = await client.callTool({ name: 'atoma_run_status', arguments: { projectId: f.project.projectId, runId: run.projectRunId } });
    expect(result.structuredContent).toMatchObject({ publication: { git, repositoryFullName: 'owner/docs',
      commitSha: 'c'.repeat(40), mergeStatus: 'unknown', remoteState: 'not-checked', error: null } });
    expect(JSON.parse((result.content as { type: string; text: string }[])[0]!.text)).toEqual(result.structuredContent);
    const listed = await client.callTool({ name: 'atoma_project_runs', arguments: { projectId: f.project.projectId } });
    expect(JSON.parse((listed.content as { type: string; text: string }[])[0]!.text)).toEqual([result.structuredContent]);
    // Both results LINK the run, and the link is a resource this caller can read.
    const link = { type: 'resource_link', uri: projectRunUri(f.project.projectId, run.projectRunId), mimeType: 'application/json' };
    expect(result.content).toEqual([expect.objectContaining({ type: 'text' }), expect.objectContaining(link)]);
    expect(listed.content).toEqual([expect.objectContaining({ type: 'text' }), expect.objectContaining(link)]);
    const read = await client.readResource({ uri: link.uri });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual(result.structuredContent);
    // A 2025 client names the server with its mark too.
    expect(client.getServerVersion()).toMatchObject({ name: 'atoma', icons: [expect.objectContaining({ mimeType: 'image/svg+xml' })] });
  } finally { await client.close(); }
});

it('tells a platform admin which protocol each client speaks, itself included', async () => {
  // 2026-09-30: the host counted `<version> <client>` pairs and nothing read
  // them, so nobody could say which protocol production clients speak.
  // The deps are built before the host that serves them, as in src/viz/server.ts.
  const counted: { host?: McpHttpHost } = {};
  const { url, host } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, mcpHealth: () => counted.host!.health() });
  counted.host = host;
  const client = await connect(url);
  try {
    const result = await client.callTool({ name: 'atoma_mcp_health', arguments: {} });
    const mcp = (result.structuredContent as { mcp: { sessions: number; clients: Record<string, number> } }).mcp;
    expect(mcp.sessions).toBe(1);
    expect(Object.entries(mcp.clients)).toEqual([[expect.stringMatching(/^\d{4}-\d{2}-\d{2} test$/), 1]]);
  } finally { await client.close(); }
});

describe('the catalogue by tier', () => {
  it('shows each caller its ladder and nothing above it', () => {
    const names = (caller: McpCaller, deps: McpToolDeps) => visibleTools(caller, deps).map((t) => t.name);
    const asViewer = names({ kind: 'principal', viewer: viewer('org:viewer'), tokenId: 't' }, TENANT_HOST);
    const asMember = names({ kind: 'principal', viewer: viewer('org:member'), tokenId: 't' }, TENANT_HOST);
    const asAdmin = names({ kind: 'principal', viewer: viewer('org:admin'), tokenId: 't' }, TENANT_HOST);
    const asPlatform = names({ kind: 'principal', viewer: viewer('org:viewer', true), tokenId: 't' }, TENANT_HOST);
    // The viewer ladder: the organisation's own readers plus the two platform
    // commons the viz shows every signed-in role — registry and skill catalog.
    expect(asViewer).toEqual([
      'atoma_projects_list', 'atoma_project_runs', 'atoma_run_status', 'atoma_run_trace', 'atoma_run_preview',
      'atoma_registry_list', 'atoma_registry_show', 'atoma_skills_list', 'atoma_registry_history', 'atoma_skills_show',
    ]);
    // Each rung adds exactly its own rows (the table interleaves the tiers).
    const above = (lower: string[], upper: string[]) => upper.filter((name) => !lower.includes(name));
    expect(asMember).toEqual(expect.arrayContaining(asViewer));
    expect(above(asViewer, asMember)).toEqual(['atoma_project_create', 'atoma_run_start', 'atoma_run_cancel', 'atoma_publication_retry']);
    expect(asAdmin).toEqual(expect.arrayContaining(asMember));
    expect(above(asMember, asAdmin)).toEqual(['atoma_org_members', 'atoma_org_models']);
    // Handing out the host's own login is operator spend, not organisation
    // self-service: an org admin never sees the row, a platform admin does.
    expect(asAdmin).not.toContain('atoma_subscription_delegates');
    expect(asPlatform).toContain('atoma_subscription_delegates');
    // Sending an organisation's recorded prompts to TypeSafe is the platform's call.
    expect(asAdmin).not.toContain('atoma_jev_calibrate');
    expect(asPlatform).toContain('atoma_jev_calibrate');
    // The tray needs the host's notification builder; this host has none, so
    // the platform ladder is the whole table minus that one row.
    expect(asPlatform).toEqual(MCP_TOOL_NAMES.filter((name) => !['atoma_notifications', 'atoma_benchmark_start'].includes(name)));
    const withTray = names({ kind: 'principal', viewer: viewer('org:viewer'), tokenId: 't' }, { ...TENANT_HOST, notifications: () => ({ notifications: [], nextBefore: null }) });
    expect(withTray).toContain('atoma_notifications');
    expect(callerTier({ kind: 'operator' })).toBe('platform');
    // The ungated operator: no organisations to honour, no journal.
    const asOperator = names({ kind: 'operator' }, NO_TENANT);
    expect(asOperator).not.toContain('atoma_projects_list');
    expect(asOperator).not.toContain('atoma_journal_tail');
    expect(asOperator).not.toContain('atoma_notifications');
    expect(asOperator).not.toContain('atoma_jev_calibrate');
    expect(asOperator).toContain('atoma_operator_run_start');
    expect(asOperator).toContain('atoma_registry_list');
    expect(asOperator).toContain('atoma_run_trace');
    // The operator-only readers and writes the roadmap owed, all platform-tier:
    // skill analytics and the four lifecycle writes included.
    for (const owed of ['atoma_ledger_tail', 'atoma_costs', 'atoma_skills_stats', 'atoma_skills_review', 'atoma_verdicts_list', 'atoma_verdict_show', 'atoma_sentinel_health', 'atoma_mcp_health', 'atoma_skill_reset', 'atoma_skill_drop', 'atoma_skill_merge', 'atoma_registry_rollback']) {
      expect(asOperator).toContain(owed);
      expect(asAdmin).not.toContain(owed);
    }
    // The commons readers reach the operator too: one table, one row each.
    for (const commons of ['atoma_registry_list', 'atoma_registry_show', 'atoma_registry_history', 'atoma_skills_list', 'atoma_skills_show']) {
      expect(asOperator).toContain(commons);
      expect(asViewer).toContain(commons);
    }
  });

  it('names every tool once and states a tier for each', () => {
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOLS.length);
    for (const tool of MCP_TOOLS) expect(['viewer', 'member', 'admin', 'platform']).toContain(tool.tier);
  });
});

describe('the HTTP host', () => {
  it('serves the operator on loopback without a token, tools filtered by what the host honours', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await connect(url);
    const names = await toolNames(client);
    expect(names).toContain('atoma_operator_run_start');
    expect(names).not.toContain('atoma_projects_list');
    // A reader tool answers through the session.
    const registry = await client.callTool({ name: 'atoma_registry_list', arguments: {} });
    const text = (registry.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toHaveProperty('types');
    // The prompt surface rides the platform tier.
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(3);
    await client.close();
  });

  it('refuses a caller without identity with a 401 and a WWW-Authenticate header', async () => {
    const { url, host } = await listen(() => null, TENANT_HOST);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(host.health().refused).toBe(1);
  });

  it('gives a member the member ladder, and refuses a tool call above it even by name', async () => {
    const callers: Record<string, McpCaller> = {
      'member-token': { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' },
    };
    const { url } = await listen((req) => {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      return bearer ? callers[bearer] ?? null : null;
    }, TENANT_HOST);
    const client = await connect(url, 'member-token');
    const names = await toolNames(client);
    expect(names).toContain('atoma_run_start');
    expect(names).toContain('atoma_registry_list');
    expect(names).not.toContain('atoma_org_members');
    expect(names).not.toContain('atoma_skills_stats');
    // Not registered on this session at all: the server answers "unknown tool",
    // never the skill analytics.
    // A tool this session does not hold is unknown to it: the protocol's -32602, not a tool result.
    const refused = await client.callTool({ name: 'atoma_skills_stats', arguments: {} }).then(() => null, (error: Error) => error);
    expect(refused?.message).toMatch(/-32602.*not found/i);
    expect(refused?.message).not.toContain('threshold');
    await client.close();
  });

  it('refuses a different caller without destroying the original session', async () => {
    let current: McpCaller | null = { kind: 'principal', viewer: viewer('org:admin'), tokenId: 'a' };
    const { url, host } = await listen(() => current, TENANT_HOST);
    const client = await connect(url);
    expect(await toolNames(client)).toContain('atoma_org_members');
    expect(host.health().sessions).toBe(1);
    // The token was revoked: the resolver now says nobody.
    current = null;
    await expect(client.listTools()).rejects.toThrow();
    // Re-minted as a lesser role: the old session id is not honoured either.
    current = { kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'b' };
    await expect(client.listTools()).rejects.toThrow();
    expect(host.health().sessions).toBe(1);
    current = { kind: 'principal', viewer: viewer('org:admin'), tokenId: 'a' };
    expect(await toolNames(client)).toContain('atoma_org_members');
    await client.close();
  });
});

describe('API tokens in the auth store', () => {
  function storeWithPrincipal(): { store: AuthStore; founder: Viewer } {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-tokens-'));
    dirs.push(dir);
    const store = AuthStore.open(join(dir, 'atoma.db'));
    const founder = store.completeLogin(
      { provider: 'github', subject: 'founder', displayName: 'Founder', email: null, emailVerified: false },
      null
    )!.viewer;
    return { store, founder };
  }

  it('mints once, resolves to a fresh viewer, lists secret-free and revokes only its owner’s', () => {
    const { store, founder } = storeWithPrincipal();
    const minted = store.createApiToken({ principalId: founder.principalId, orgId: founder.orgId, label: '  my  laptop ' });
    expect(minted.token).toMatch(/^atoma_[A-Za-z0-9_-]{40,}$/);
    const resolved = store.resolveApiToken(minted.token)!;
    expect(resolved).toMatchObject({ principalId: founder.principalId, orgId: founder.orgId, role: 'org:owner', tokenId: minted.tokenId, platformAdmin: false });
    // The flag is read NOW, not at minting.
    store.grantPlatformAdmin(founder.principalId);
    expect(store.resolveApiToken(minted.token)!.platformAdmin).toBe(true);
    const listed = store.listApiTokens(founder.principalId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tokenId: minted.tokenId, label: 'my laptop', revokedAt: null });
    expect(JSON.stringify(listed)).not.toContain(minted.token.slice(6, 20));
    expect(JSON.stringify(listed)).not.toContain(sha256Hex(minted.token));
    // A stranger cannot revoke it; the owner can, once.
    expect(store.revokeApiToken('someone-else', minted.tokenId)).toBe(false);
    expect(store.revokeApiToken(founder.principalId, minted.tokenId)).toBe(true);
    expect(store.revokeApiToken(founder.principalId, minted.tokenId)).toBe(false);
    expect(store.resolveApiToken(minted.token)).toBeNull();
    expect(store.resolveApiToken('atoma_not-a-token')).toBeNull();
    expect(store.resolveApiToken('')).toBeNull();
  });

  it('refuses to mint for an organisation the principal is not a member of', () => {
    const { store, founder } = storeWithPrincipal();
    expect(() => store.createApiToken({ principalId: founder.principalId, orgId: 'other-org', label: 'x' })).toThrow(/not a member/);
  });
});



describe('organisation model audit across MCP', () => {
  it('emits one attributed journal event after a successful update and none for a read', async () => {
    const events: unknown[] = [];
    const models = { l1: null, l2: null, l3: null };
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:admin'), tokenId: 'a' }), {
      ...TENANT_HOST,
      auth: { orgTierModels: () => models, setOrgTierModels: () => models } as never,
      emit: (event) => { events.push(event); },
    });
    const client = await connect(url);
    await client.callTool({ name: 'atoma_org_models', arguments: {} });
    expect(events).toEqual([]);
    const result = await client.callTool({ name: 'atoma_org_models', arguments: { models } });
    expect(result.isError).not.toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'org.models_updated', actorType: 'principal',
      actorId: viewer('org:admin').principalId, orgId: viewer('org:admin').orgId });
    await client.close();
  });
});

describe('operator writes over MCP — attributed and journaled', () => {
  const saved: Record<string, string | undefined> = {};
  function skillsFixture(): { dir: string; l1: string } {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-writes-'));
    dirs.push(dir);
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR', 'ATOMA_LEDGER_DB', 'ATOMA_TRUST_THRESHOLD']) saved[k] = process.env[k];
    process.env['ATOMA_DB_PATH'] = join(dir, 'atoma.db');
    process.env['ATOMA_LEDGER_DB'] = join(dir, 'atoma.db');
    process.env['ATOMA_SKILLS_DIR'] = join(dir, 'skills');
    const reg = new SkillRegistry(join(dir, 'skills'));
    reg.save('mol-1', { id: 'keep-me', description: 'keep', whenToUse: 'when keeping', kind: 'llm', body: 'body A' });
    reg.save('mol-1', { id: 'absorb-me', description: 'absorb', whenToUse: 'when absorbing', kind: 'llm', body: 'body B' });
    reg.recordSuccess('mol-1', 'absorb-me');
    return { dir, l1: 'mol-1' };
  }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses to drop or absorb proven knowledge without force, and journals the actor when it does act', async () => {
    const { l1 } = skillsFixture();
    const events: unknown[] = [];
    const admin = viewer('org:owner', true);
    const { url } = await listen(() => ({ kind: 'principal', viewer: admin, tokenId: 'a' }), { ...TENANT_HOST, emit: (event) => { events.push(event); } });
    const client = await connect(url);
    const refused = await client.callTool({ name: 'atoma_skill_drop', arguments: { l1, id: 'absorb-me' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/proven knowledge/);
    const mergeRefused = await client.callTool({ name: 'atoma_skill_merge', arguments: { l1, keep: 'keep-me', absorb: 'absorb-me' } });
    expect(mergeRefused.isError).toBe(true);
    expect(events).toEqual([]);
    const reset = await client.callTool({ name: 'atoma_skill_reset', arguments: { l1, id: 'absorb-me' } });
    expect(reset.isError).not.toBe(true);
    expect(reset.structuredContent).toMatchObject({ before: { successes: 1 }, after: { successes: 0 }, journaled: true, actor: `mcp:${admin.principalId}` });
    const merged = await client.callTool({ name: 'atoma_skill_merge', arguments: { l1, keep: 'keep-me', absorb: 'absorb-me' } });
    expect(merged.isError).not.toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'skill.reset', actorType: 'principal', actorId: admin.principalId, orgId: admin.orgId });
    expect(events[1]).toMatchObject({ kind: 'skill.merged', actorType: 'principal', actorId: admin.principalId });
    expect(JSON.stringify(events)).not.toContain('body A');
    expect(new SkillRegistry(process.env['ATOMA_SKILLS_DIR']).loadFor(l1).map((s) => s.id)).toEqual(['keep-me']);
    await client.close();
  });

  it('a member cannot even see the writes, and a rollback of a missing type is a refusal, not a fault', async () => {
    skillsFixture();
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' }), TENANT_HOST);
    const client = await connect(url);
    expect(await toolNames(client)).not.toContain('atoma_skill_drop');
    await client.close();
    const { url: opUrl } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const operator = await connect(opUrl);
    const rollback = await operator.callTool({ name: 'atoma_registry_rollback', arguments: { name: 'Nobody', toVersion: 1 } });
    expect(rollback.isError).toBe(true);
    expect(JSON.stringify(rollback.content)).toMatch(/refused/);
    await operator.close();
  });

  it('reports recovered trust and resets only its streak on an attributed rollback', async () => {
    const { dir } = skillsFixture();
    process.env['ATOMA_TRUST_THRESHOLD'] = '4';
    const db = openDb(join(dir, 'atoma.db'));
    const registry = new AtomRegistry(db);
    const type = registry.create(1, { description: 'fixture', systemPrompt: 'original behavior', tools: [], params: {}, createdBy: 'test' });
    registry.recordFailure(type.name);
    registry.recordSuccess(type.name);
    registry.patch(type.name, { systemPromptReplace: 'revised behavior' }, 'test');
    for (let i = 0; i < 4; i++) registry.recordSuccess(type.name);
    registry.patch(type.name, { descriptionReplace: 'clearer capability label' }, 'test');
    db.close();

    const events: unknown[] = [];
    const admin = viewer('org:owner', true);
    const { url } = await listen(() => ({ kind: 'principal', viewer: admin, tokenId: 'a' }), { ...TENANT_HOST, emit: (event) => { events.push(event); } });
    const client = await connect(url);
    try {
      const earned = { successes: 5, failures: 1, consecutiveSuccesses: 4, trusted: true };
      const list = await client.callTool({ name: 'atoma_registry_list', arguments: {} });
      expect(list.structuredContent).toMatchObject({ trustThreshold: 4, types: [expect.objectContaining({ name: type.name, ...earned })] });
      const show = await client.callTool({ name: 'atoma_registry_show', arguments: { name: type.name } });
      expect(show.structuredContent).toMatchObject({ trustThreshold: 4, atom: earned });

      const rollback = await client.callTool({ name: 'atoma_registry_rollback', arguments: { name: type.name, toVersion: 1 } });
      expect(rollback.isError).not.toBe(true);
      expect(rollback.structuredContent).toMatchObject({
        noop: false,
        trustThreshold: 4,
        trustBefore: { successes: 5, failures: 1, consecutiveSuccesses: 4 },
        trustAfter: { successes: 5, failures: 1, consecutiveSuccesses: 0 },
        journaled: true,
        note: expect.stringMatching(/historical success\/failure totals preserved/),
      });
      expect(events).toEqual([expect.objectContaining({
        kind: 'registry.rolled_back', actorId: admin.principalId,
        detail: expect.objectContaining({ trustBefore: { successes: 5, failures: 1, consecutiveSuccesses: 4 } }),
      })]);
      // The LIFECYCLE row the registry appended names the same principal (T7):
      // the write ran under the request's ledger scope in a process that
      // serves every organisation and therefore has no process-wide one.
      {
        const store = openDb(join(dir, 'atoma.db'));
        try {
          // The fixture's own `patch` above also reset trust; only the rollback ran under the request.
          const reset = readLedger(store).filter((event) => event.kind === 'type-trust-reset' && event.detail?.['reason'] === 'rollback');
          expect(reset).toEqual([expect.objectContaining({
            entity: type.name,
            detail: expect.objectContaining({ reason: 'rollback' }),
            scope: { orgId: admin.orgId, actorType: 'principal', actorId: admin.principalId },
          })]);
        } finally { store.close(); }
      }
      const history = await client.callTool({ name: 'atoma_registry_history', arguments: { name: type.name } });
      expect(history.structuredContent).toMatchObject({ trustThreshold: 4, trust: { successes: 5, failures: 1, consecutiveSuccesses: 0, trusted: false } });
    } finally {
      await client.close();
    }
  });
});

describe('the platform commons over MCP — registry and skill catalog', () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves a viewer the platform registry with host paths redacted, and the platform the whole payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-commons-'));
    dirs.push(dir);
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR']) saved[k] = process.env[k];
    const dbPath = join(dir, 'atoma.db');
    process.env['ATOMA_DB_PATH'] = dbPath;
    process.env['ATOMA_SKILLS_DIR'] = join(dir, 'skills');
    // ONE platform registry (docs/platform-trust-2026-09-15.md): one molecule
    // with a recipe under it, read by whoever asks.
    const seed = { tools: [], params: {}, createdBy: 'seed' };
    const shared = (() => {
      const db = openDb(dbPath);
      try {
        return new AtomRegistry(db).create(1, { ...seed, description: 'Shared capability', systemPrompt: 'Shared routing guidance' });
      } finally { db.close(); }
    })();
    new SkillRegistry(join(dir, 'skills')).save(shared.atomId, { id: 'verify-browser-behaviour', description: 'Verify browser behaviour', whenToUse: 'When a browser interaction needs proof', kind: 'llm', body: 'Inspect the resulting state.' });

    const callers: Record<string, McpCaller> = {
      'viewer-token': { kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'v' },
      'platform-token': { kind: 'principal', viewer: viewer('org:owner', true), tokenId: 'p' },
    };
    const { url } = await listen((req) => {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      return bearer ? callers[bearer] ?? null : null;
    }, TENANT_HOST);
    const asViewer = await connect(url, 'viewer-token');
    const asPlatform = await connect(url, 'platform-token');
    try {
      const names = await toolNames(asViewer);
      for (const commons of ['atoma_registry_list', 'atoma_registry_show', 'atoma_registry_history', 'atoma_skills_list', 'atoma_skills_show']) expect(names).toContain(commons);
      for (const operatorOnly of ['atoma_skills_stats', 'atoma_skills_review', 'atoma_registry_rollback', 'atoma_skill_drop']) expect(names).not.toContain(operatorOnly);

      // The store is named by basename only: the host's filesystem layout is
      // operator information. (The path is JSON-escaped, hence the slice.)
      const hostPath = JSON.stringify(dir).slice(1, -1);
      const list = await asViewer.callTool({ name: 'atoma_registry_list', arguments: {} });
      expect(list.structuredContent).toMatchObject({ store: 'atoma.db', types: [expect.objectContaining({ name: shared.name, description: 'Shared capability' })] });
      expect(JSON.stringify(list)).not.toContain(hostPath);
      const show = await asViewer.callTool({ name: 'atoma_registry_show', arguments: { name: shared.name } });
      expect(show.structuredContent).toMatchObject({ store: 'atoma.db', atom: { name: shared.name, systemPrompt: 'Shared routing guidance' } });
      const history = await asViewer.callTool({ name: 'atoma_registry_history', arguments: { name: shared.name } });
      expect(history.structuredContent).toMatchObject({ store: 'atoma.db' });
      const skills = await asViewer.callTool({ name: 'atoma_skills_list', arguments: {} });
      expect(skills.structuredContent).toMatchObject({ skillsDir: 'skills', namespaces: [{ l1: shared.name, l1Key: shared.atomId, skills: [expect.objectContaining({ id: 'verify-browser-behaviour' })] }] });
      const skill = await asViewer.callTool({ name: 'atoma_skills_show', arguments: { l1: shared.name, id: 'verify-browser-behaviour' } });
      expect(skill.structuredContent).toMatchObject({ skillsDir: 'skills' });
      expect(JSON.stringify(skill.structuredContent)).toContain('Inspect the resulting state.');
      expect(JSON.stringify(skill.structuredContent)).not.toContain(hostPath);

      // The platform payload is the old one, host path included.
      const whole = await asPlatform.callTool({ name: 'atoma_registry_list', arguments: {} });
      expect(whole.structuredContent).toMatchObject({ store: dbPath });
      const wholeSkills = await asPlatform.callTool({ name: 'atoma_skills_list', arguments: {} });
      expect(wholeSkills.structuredContent).toMatchObject({ skillsDir: join(dir, 'skills') });
    } finally { await asViewer.close(); await asPlatform.close(); }
  });

  it('validates every declared operator output schema through the SDK client', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await connect(url);
    try {
      const tools = (await client.listTools()).tools.filter((tool) => tool.outputSchema);
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['atoma_costs', 'atoma_sentinel_health']));
      for (const tool of tools) {
        const result = await client.callTool({ name: tool.name, arguments: {} });
        expect(result.isError, tool.name).toBeFalsy();
        expect(result.structuredContent, tool.name).toBeDefined();
      }
    } finally { await client.close(); }
  });

  it('answers atoma_ledger_tail through the SDK client, which validates every field against the output schema', async () => {
    // The reader states `scanned` and `returned` beside the events; the schema
    // once omitted both, and the SDK client (additionalProperties:false) then
    // refused the whole result — observed live on 2026-10-01, while the reader
    // called directly kept passing. Exercise the boundary the client applies.
    const dir = mkdtempSync(join(tmpdir(), 'atoma-mcp-ledger-'));
    dirs.push(dir);
    for (const k of ['ATOMA_DB_PATH', 'ATOMA_SKILLS_DIR']) saved[k] = process.env[k];
    process.env['ATOMA_DB_PATH'] = join(dir, 'atoma.db');
    process.env['ATOMA_SKILLS_DIR'] = join(dir, 'skills');
    const reg = new SkillRegistry(join(dir, 'skills'));
    reg.save('mol-1', { id: 's1', description: 'd', whenToUse: 'w', kind: 'llm', body: 'b' });
    reg.recordSuccess('mol-1', 's1');
    closeStoreHandles();

    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await connect(url);
    try {
      // listTools caches the output schemas the client validates against.
      expect(await toolNames(client)).toContain('atoma_ledger_tail');
      const all = await client.callTool({ name: 'atoma_ledger_tail', arguments: { limit: 5 } });
      expect(all.isError).toBeFalsy();
      expect(all.structuredContent).toMatchObject({ total: 2, scanned: 2, returned: 2, events: [{ kind: 'skill-success' }, { kind: 'skill-save' }] });
      const filtered = await client.callTool({ name: 'atoma_ledger_tail', arguments: { kind: 'skill-save' } });
      expect(filtered.structuredContent).toMatchObject({ returned: 1, events: [{ kind: 'skill-save', entity: 'mol-1/s1' }] });
    } finally { await client.close(); }
  });
});

describe('preview, notifications and the tray over MCP', () => {
  it('reads preview state as a viewer, refuses to open one below member, opens as a member', async () => {
    const calls: string[] = [];
    const preview = {
      status: (_v: Viewer, p: string, r: string) => { calls.push(`status ${p}/${r}`); return { state: 'idle' }; },
      open: async (_v: Viewer, p: string, r: string, o: { inFlight?: boolean }) => { calls.push(`open ${p}/${r} ${o.inFlight}`); return { status: 200, body: { summary: { state: 'ready' }, url: 'https://preview/x#claim' } }; },
      stop: async () => ({ state: 'stopped' }),
    } as never;
    const callers: Record<string, McpCaller> = {
      v: { kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'v' },
      m: { kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' },
    };
    const { url } = await listen((req) => callers[/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''] ?? null, { ...TENANT_HOST, preview: () => preview });
    const asViewer = await connect(url, 'v');
    const state = await asViewer.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1' } });
    expect(state.structuredContent).toEqual({ state: 'idle' });
    const refused = await asViewer.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1', action: 'open' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/403/);
    await asViewer.close();
    const asMember = await connect(url, 'm');
    const opened = await asMember.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1', action: 'open', inFlight: true } });
    expect(opened.structuredContent).toMatchObject({ httpStatus: 200, url: 'https://preview/x#claim' });
    expect(calls).toEqual(['status p1/r1', 'open p1/r1 true']);
    await asMember.close();
  });

  it('answers "not available" when the host has no preview runtime, like the HTTP route', async () => {
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' }), { ...TENANT_HOST, preview: () => null });
    const client = await connect(url);
    const result = await client.callTool({ name: 'atoma_run_preview', arguments: { projectId: 'p1', runId: 'r1' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/503/);
    await client.close();
  });

  it('the tray is the host builder’s answer for THIS principal, with structured content', async () => {
    const seen: unknown[] = [];
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:viewer'), tokenId: 'v' }), {
      ...TENANT_HOST,
      notifications: (input) => { seen.push(input); return { notifications: [{ seq: 7, at: 'now', kind: 'run.finished', severity: 'info', title: 'Run finished', body: 'b', orgId: 'org-1', projectId: null, runId: null, traceId: null }], nextBefore: null }; },
    });
    const client = await connect(url);
    const result = await client.callTool({ name: 'atoma_notifications', arguments: { locale: 'fr', limit: 5 } });
    expect(seen).toEqual([{ principalId: viewer('org:viewer').principalId, locale: 'fr', limit: 5 }]);
    expect(result.structuredContent).toMatchObject({ notifications: [{ seq: 7 }], nextBefore: null });
    await client.close();
  });
});

describe('resources — addressable state with subscriptions', () => {
  afterEach(() => resetRunsForTest());

  it('lists the operator corpus only for the platform tier, and reads through the readers', async () => {
    const { url } = await listen(() => ({ kind: 'principal', viewer: viewer('org:member'), tokenId: 'm' }), TENANT_HOST);
    const member = await connect(url);
    const caps = member.getServerCapabilities();
    expect(caps?.resources).toMatchObject({ subscribe: true, listChanged: true });
    const templates = (await member.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain('atoma://projects/{projectId}/runs/{runId}');
    expect(templates).not.toContain('atoma://runs/{file}');
    await member.close();
    const { url: opUrl } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const operator = await connect(opUrl);
    const opTemplates = (await operator.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(opTemplates).toContain('atoma://runs/{file}');
    expect(opTemplates).toContain('atoma://operator-runs/{runId}');
    const traversal = await operator.readResource({ uri: 'atoma://runs/..%2F..%2Fetc%2Fpasswd' });
    expect((traversal.contents[0] as { text: string }).text).toMatch(/refused/);
    await operator.close();
  });

  it('tells a subscribed session when an operator run finishes', async () => {
    let settle: (log: string) => void = () => {};
    const driver: RunDriver = () => new Promise<string>((resolve) => { settle = resolve; });
    const record = await startRun({ goal: 'a goal for the resource test' }, driver, async () => ({ path: '<test>', attachChild() {}, release() {} }));
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const client = await connect(url);
    const updated: string[] = [];
    client.setNotificationHandler(
      (await import('@modelcontextprotocol/sdk/types.js')).ResourceUpdatedNotificationSchema,
      (notification) => { updated.push(notification.params.uri); }
    );
    const uri = operatorRunUri(record.runId);
    await client.subscribeResource({ uri });
    const before = await client.readResource({ uri });
    expect(JSON.parse((before.contents[0] as { text: string }).text)).toMatchObject({ runId: record.runId, status: 'running' });
    settle('no epilogue');
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(updated).toEqual([uri]);
    const after = await client.readResource({ uri });
    expect(JSON.parse((after.contents[0] as { text: string }).text)).toMatchObject({ runId: record.runId, status: 'finished' });
    await client.close();
  });
});

describe('the stream — SSE frames and replay', () => {
  afterEach(() => resetRunsForTest());

  it('stamps every SSE frame with an event id the store can replay from', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const body = await response.text();
    expect(body).toMatch(/^id: /m);
    expect(body).toMatch(/"result"/);
  });

  it('replays the frames after a cursor on the same stream, and nothing for a lost cursor', async () => {
    const { SessionEventStore } = await import('../src/mcp/eventStore.js');
    const store = new SessionEventStore(4);
    const note = (n: number) => ({ jsonrpc: '2.0' as const, method: 'notifications/progress', params: { progressToken: 't', progress: n } });
    const a1 = await store.storeEvent('A', note(1));
    await store.storeEvent('B', note(10));
    await store.storeEvent('A', note(2));
    await store.storeEvent('A', note(3));
    expect(await store.getStreamIdForEventId(a1)).toBe('A');
    const replayed: number[] = [];
    const stream = await store.replayEventsAfter(a1, { send: async (_id, message) => { replayed.push((message as unknown as { params: { progress: number } }).params.progress); } });
    expect(stream).toBe('A');
    expect(replayed).toEqual([2, 3]);
    // The ring evicts the oldest: a cursor that fell off replays nothing.
    await store.storeEvent('A', note(4));
    expect(store.size()).toBe(4);
    expect(await store.replayEventsAfter(a1, { send: async () => {} })).toBe('');
    expect(await store.replayEventsAfter('never', { send: async () => {} })).toBe('');
  });

  it('evicts the LONGEST stream, so a run log cannot drop the response of a quiet call', async () => {
    const { SessionEventStore } = await import('../src/mcp/eventStore.js');
    const store = new SessionEventStore(4);
    // One response on its own stream, then the run log floods the standalone
    // one. Under a globally-FIFO ring the response is the FIRST frame out —
    // the one the replay exists to preserve.
    const answer = await store.storeEvent('request-7', { jsonrpc: '2.0', id: 7, result: { ok: true } });
    for (let n = 0; n < 6; n += 1) {
      await store.storeEvent('standalone', { jsonrpc: '2.0', method: 'notifications/message', params: { n } });
    }
    expect(await store.getStreamIdForEventId(answer)).toBe('request-7');
    const replayed: unknown[] = [];
    expect(await store.replayEventsAfter(answer, { send: async (_id, message) => { replayed.push(message); } })).toBe('request-7');
    expect(replayed).toEqual([]);
    expect(store.size()).toBe(4);
    expect(store.evictions()).toBe(3);
  });

  it('holds a byte budget too, because a log frame carries the child chunk verbatim', async () => {
    const { SessionEventStore } = await import('../src/mcp/eventStore.js');
    const store = new SessionEventStore(512, 2048);
    for (let n = 0; n < 5; n += 1) {
      await store.storeEvent('standalone', { jsonrpc: '2.0', method: 'notifications/message', params: { chunk: 'x'.repeat(900), n } });
    }
    // Far inside the 512-frame count, and still bounded: ~970 bytes a frame.
    expect(store.size()).toBe(2);
    expect(store.evictions()).toBe(3);
  });

  it('says whether a stream still owes its response, and since when, until its last frame goes', async () => {
    const { SessionEventStore } = await import('../src/mcp/eventStore.js');
    let clock = 1_000;
    const store = new SessionEventStore(3, 1 << 20, () => clock);
    const primed = await store.storeEvent('call', { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
    clock = 5_000;
    expect(store.streamState(primed)).toEqual({ streamId: 'call', firstStoredMs: 1_000, answered: false });
    await store.storeEvent('call', { jsonrpc: '2.0', id: 2, result: { content: [] } });
    expect(store.streamState(primed)).toEqual({ streamId: 'call', firstStoredMs: 1_000, answered: true });
    for (let n = 0; n < 4; n += 1) await store.storeEvent('log', { jsonrpc: '2.0', method: 'notifications/message', params: { n } });
    // The cursor fell off the ring: nothing to say about it, as for replay.
    expect(store.streamState(primed)).toBeUndefined();
  });
});

describe('session ceilings, and what a refused initialize leaves behind', () => {
  afterEach(() => resetRunsForTest());

  it("drops a caller's stalest session rather than the host's newest", async () => {
    const { url, host } = await listen(() => ({ kind: 'operator' }), NO_TENANT, { maxSessionsPerCaller: 2 });
    const first = await initialize(url);
    const second = await initialize(url);
    const third = await initialize(url);
    expect(first.sessionId).toBeTruthy();
    expect(third.status).toBe(200);
    expect(host.health().sessions).toBe(2);
    expect(host.health().evicted).toBe(1);
    // The stalest is gone and says so; the newest two are untouched.
    const reused = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': first.sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(reused.status).toBe(404);
    await reused.text();
    expect([second.sessionId, third.sessionId].every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('refuses a new session past the host ceiling with 503, and counts it', async () => {
    const { url, host } = await listen(() => ({ kind: 'operator' }), NO_TENANT, { maxSessions: 2, maxSessionsPerCaller: 8 });
    await initialize(url);
    await initialize(url);
    const refused = await initialize(url);
    expect(refused.status).toBe(503);
    expect(host.health().sessions).toBe(2);
    expect(host.health().overflowed).toBe(1);
  });

  it('closes the server it built for a caller when the initialize throws', async () => {
    let closed = 0;
    const server = createServer((req, res) =>
      void host.handle(req, res).catch(() => {
        // The viz server's own shape: the throw reaches a catch, never the client.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
      })
    );
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const host = new McpHttpHost({
      resolveCaller: () => ({ kind: 'operator' }),
      buildServer: () => ({
        connect: () => Promise.reject(new Error('transport refused')),
        close: () => { closed += 1; return Promise.resolve(); },
      }) as unknown as ReturnType<typeof buildServer>,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    hosts.push(host);
    const answered = await initialize(`http://127.0.0.1:${port}/mcp`);
    expect(answered.status).toBe(500);
    // Nothing holds this server: it never entered `sessions`, so the idle
    // sweeper would never have reached it either.
    expect(closed).toBe(1);
    expect(host.health().sessions).toBe(0);
  });

  it('reports the replay depth its live sessions lost, so a flood is visible', async () => {
    const { url, host } = await listen(() => ({ kind: 'operator' }), NO_TENANT);
    await initialize(url);
    // A fresh session has a ring it has barely filled: nothing dropped yet.
    expect(host.health().sessions).toBe(1);
    expect(host.health().replayEvictions).toBe(0);
  });

  it('refuses a foreign Origin and ignores an absent one', async () => {
    const { url } = await listen(() => ({ kind: 'operator' }), NO_TENANT, { allowedOrigins: ['https://atoma.example'] });
    expect((await initialize(url, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await initialize(url, { origin: 'https://atoma.example' })).status).toBe(200);
    // A CLI client sends no Origin at all, and the pin must not touch it.
    expect((await initialize(url)).status).toBe(200);
  });
});

describe('runs as tasks, and the run log', () => {
  afterEach(() => resetRunsForTest());

  const lease = async () => ({ path: '<test>', attachChild() {}, release() {} });
  /** A driver the test feeds: chunks on demand, a settle to end, and an abort that ends it as cancelled. */
  function scriptedDriver() {
    const handle = { chunk: (_text: string) => {}, settle: (_log: string) => {}, aborted: false };
    const driver: RunDriver = (opts) =>
      new Promise<string>((resolve) => {
        handle.settle = resolve;
        handle.chunk = (text) => opts.onChunk?.(text);
        opts.signal?.addEventListener('abort', () => { handle.aborted = true; resolve('cancelled'); }, { once: true });
      });
    return { driver, handle };
  }
  const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * The task is a second door onto the SAME run: `createTask` starts it the way
   * the start tool does, `tasks/get` carries the output tail as the status
   * line, `tasks/result` returns the status payload when the run ends, and
   * `tasks/cancel` reaches the run's abort. All through the real SDK client.
   */
  it('drives atoma_operator_run_start as an MCP task: working with a status line, the status payload as the result, cancel reaching the run', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const client = await connect(url);
    const caps = client.getServerCapabilities();
    expect(caps?.tasks).toMatchObject({ list: {}, cancel: {}, requests: { tools: { call: {} } } });
    expect(caps?.logging).toEqual({});
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'atoma_operator_run_start');
    expect(listed?.execution).toEqual({ taskSupport: 'optional' });

    const created = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a goal driven as a task' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    expect(created.task.status).toBe('working');
    expect(created.task.statusMessage).toMatch(/^run mcp-.* started$/);
    handle.chunk('alpha');
    await tick(20);
    const working = await client.experimental.tasks.getTask(created.task.taskId);
    expect(working.status).toBe('working');
    expect(working.statusMessage).toMatch(/1 chunks — untrusted model output: alpha$/);
    handle.settle('no epilogue');
    await tick(100);
    const result = await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema);
    const payload = result.structuredContent as { runId: string; status: string; progress: { chunks: number } };
    expect(payload.status).toBe('finished');
    expect(payload.progress.chunks).toBe(1);
    expect(payload.runId).toMatch(/^mcp-/);

    // A second run, cancelled through tasks/cancel: the run's abort fires and the record ends cancelled.
    const second = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a goal to cancel' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    const cancelled = await client.experimental.tasks.cancelTask(second.task.taskId);
    expect(cancelled.status).toBe('cancelled');
    await tick(100);
    expect(handle.aborted).toBe(true);
    const runs = (await client.experimental.tasks.listTasks()).tasks;
    expect(runs.map((task) => task.status).sort()).toEqual(['cancelled', 'completed']);
    const status = await client.callTool({ name: 'atoma_operator_run_status', arguments: {} });
    const seen = (status.structuredContent as { runs: { status: string }[] }).runs.map((run) => run.status);
    expect(seen).toEqual(['cancelled', 'finished']);
    // Each run is linked to its resource, and the link reads back the same run.
    const links = (status.content as { type: string; uri?: string }[]).filter((block) => block.type === 'resource_link');
    const ids = (status.structuredContent as { runs: { runId: string }[] }).runs.map((run) => run.runId);
    expect(links.map((link) => link.uri)).toEqual(ids.map((runId) => operatorRunUri(runId)));
    const read = await client.readResource({ uri: links[0]!.uri! });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toMatchObject({ runId: ids[0] });
    await client.close();
  });

  it('answers a non-augmented start with the terminal result, as a synchronous run', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const client = await connect(url);
    const progress: { progress: number; message?: string }[] = [];
    const pending = client.callTool({ name: 'atoma_operator_run_start', arguments: { goal: 'a synchronous goal' } }, undefined,
      { onprogress: (update) => { progress.push(update); } });
    await tick(50);
    handle.chunk('one');
    handle.settle('done');
    const result = await pending;
    expect((result.structuredContent as { status: string }).status).toBe('finished');
    // Over the real transport, on the call's own stream: the caller hears the run started.
    expect(progress[0]).toMatchObject({ progress: 1, message: expect.stringMatching(/^run .+ started/) });
    // A refused start is a task that fails at once, never a hung call.
    const refused = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: '--clean-workspace x' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    expect(refused.task.status).toBe('failed');
    const failure = await client.experimental.tasks.getTaskResult(refused.task.taskId, CallToolResultSchema);
    expect(failure.isError).toBe(true);
    expect((failure.content as { text: string }[])[0]!.text).toMatch(/refused/);
    await client.close();
  });

  /**
   * A project run as `ProjectService.projectRunStatus` presents it: the binding
   * fields are what a task is checked against. Run ids are unique per test,
   * because a `tasks/cancel` is remembered process-wide.
   */
  const projectRun = (status: string, projectRunId: string, extra: Record<string, unknown> = {}) => ({
    projectId: 'p-1', projectRunId, status, orgId: 'org-1', requestedByPrincipalId: 'p-org:member',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null, ...extra,
  });

  /** One caller's tasks with `atoma_run_start`'s start, as `buildServerForCaller` gives a member. */
  function projectTaskSession(service: ProjectRunTaskDeps['service'], options: { as?: Viewer; pollMs?: number } = {}) {
    const as = options.as ?? viewer('org:member');
    const deps: ProjectRunTaskDeps = { viewer: () => as, service, pollMs: options.pollMs ?? 10 };
    const tasks = new CallerTasks(`${as.principalId}:${as.orgId}`, new ProjectRunTasks(deps));
    return { tasks, start: projectRunTask(tasks, deps) };
  }

  /** A tenant service over a map of run statuses: every read is a read of the map. */
  function projectRunsService(prefix: string, extra: Partial<ProjectRunTaskDeps['service']> = {}) {
    const runs = new Map<string, Record<string, unknown>>();
    let next = 0;
    const cancelled: string[] = [];
    const service: ProjectRunTaskDeps['service'] = {
      startProjectRunFromInput: async () => {
        const run = projectRun('queued', `${prefix}-${++next}`);
        runs.set(run.projectRunId, run);
        return run;
      },
      projectRunStatus: (_v: unknown, projectId: string, runId: string) => {
        const run = runs.get(runId);
        if (!run || projectId !== 'p-1') throw new ProjectHttpError(404, 'project run not found');
        return { ...run, updatedAt: new Date().toISOString() };
      },
      runTaskBudgetMs: () => 2 * 60 * 60 * 1000,
      cancelProjectRun: async (_v: unknown, _p: string, runId: string) => { cancelled.push(runId); return {}; },
      runsRequestedBy: () => [...runs.values()].reverse(),
      ...extra,
    };
    const set = (runId: string, status: string, fields: Record<string, unknown> = {}) => runs.set(runId, { ...runs.get(runId)!, status, ...fields });
    return { service, runs, set, cancelled };
  }

  const PROJECT_ARGS = { projectId: 'p-1', goal: 'ship it' };

  it('answers atoma_run_start as a task that IS the run: every read goes to the tenant store', async () => {
    const tenant = projectRunsService('is-run');
    const { tasks, start } = projectTaskSession(tenant.service);
    const created = await start.start(PROJECT_ARGS);
    expect(created).toMatchObject({
      taskId: 'project-run:p-1:is-run-1', status: 'working', statusMessage: 'run is-run-1 queued',
      ttl: 2 * 60 * 60 * 1000 + 10 * 60 * 1000, pollInterval: 10,
    });
    tenant.set('is-run-1', 'running');
    expect(tasks.get(created.taskId)).toMatchObject({ status: 'working', statusMessage: 'run is-run-1 running' });
    expect(tasks.result(created.taskId)).toBeNull();
    tenant.set('is-run-1', 'delivered', { endedAt: new Date().toISOString() });
    expect(tasks.get(created.taskId)).toMatchObject({ status: 'completed', statusMessage: 'run is-run-1 delivered' });
    expect(tasks.result(created.taskId)).toMatchObject({ structuredContent: { status: 'delivered', projectRunId: 'is-run-1' } });
    // A run the cancel tool (or the console) cancelled is a cancelled task, with the status payload as its result.
    await start.start(PROJECT_ARGS);
    tenant.set('is-run-2', 'cancelled', { endedAt: new Date().toISOString() });
    expect(tasks.get('project-run:p-1:is-run-2')).toMatchObject({ status: 'cancelled' });
    expect(tasks.result('project-run:p-1:is-run-2')).toMatchObject({ structuredContent: { status: 'cancelled' } });
    // The listing names every task a read answers, newest first.
    expect(tasks.list().map((task) => task.taskId)).toEqual(['project-run:p-1:is-run-2', 'project-run:p-1:is-run-1']);
  });

  it('cancels a project run on tasks/cancel, refuses in the cancel tool’s words, and keeps the task cancelled whatever the run does next', async () => {
    let refuse = true;
    const tenant = projectRunsService('cancel-run');
    tenant.service.cancelProjectRun = async (_v: unknown, _p: string, runId: string) => {
      if (refuse) throw new ProjectHttpError(403, 'org:member role or above is required to cancel runs');
      tenant.cancelled.push(runId);
      return {};
    };
    const { tasks, start } = projectTaskSession(tenant.service);
    const created = await start.start(PROJECT_ARGS);
    tenant.set('cancel-run-1', 'running');
    await expect(tasks.cancel(created.taskId)).rejects.toThrow(/refused \(403\)/);
    expect(tasks.get(created.taskId)).toMatchObject({ status: 'working' });
    refuse = false;
    // `cancelled` in the answer, though the run's abort is still going through.
    expect(await tasks.cancel(created.taskId)).toMatchObject({
      status: 'cancelled', statusMessage: 'run cancel-run-1 cancellation requested, running',
    });
    expect(tenant.cancelled).toEqual(['cancel-run-1']);
    expect(tasks.result(created.taskId)).toMatchObject({ structuredContent: { status: 'running' } });
    await expect(tasks.cancel(created.taskId)).rejects.toThrow(/terminal status: cancelled/);
    // And for good, even for another session of the caller, even if the run lands otherwise.
    tenant.set('cancel-run-1', 'delivered', { endedAt: new Date().toISOString() });
    expect(projectTaskSession(tenant.service).tasks.get(created.taskId)).toMatchObject({ status: 'cancelled', statusMessage: 'run cancel-run-1 delivered' });
  });

  it('answers a project run task in a session that did not start it, for its own principal in its own organisation only', async () => {
    const tenant = projectRunsService('bound-run');
    const created = await projectTaskSession(tenant.service).start.start(PROJECT_ARGS);
    tenant.set('bound-run-1', 'running');
    // A new session of the same caller — a reconnect, a restart, a 2026 request with no session at all.
    const later = projectTaskSession(tenant.service).tasks;
    expect(later.get(created.taskId)).toMatchObject({ taskId: 'project-run:p-1:bound-run-1', status: 'working' });
    expect(later.list().map((task) => task.taskId)).toEqual([created.taskId]);
    // The binding is the principal AND the organisation, whoever else may read the run.
    for (const as of [{ ...viewer('org:member'), principalId: 'p-someone-else' }, { ...viewer('org:member'), orgId: 'org-2' }]) {
      const other = projectTaskSession(tenant.service, { as }).tasks;
      expect(other.get(created.taskId)).toBeNull();
      expect(other.list()).toEqual([]);
      await expect(other.cancel(created.taskId)).rejects.toThrow(/not found/);
      expect(() => other.result(created.taskId)).toThrow(/not found/);
    }
    expect(tenant.cancelled).toEqual([]);
    // A missing binding fails closed, and a shape this host never mints is simply unknown.
    const unbound = projectTaskSession({ ...tenant.service, projectRunStatus: () => ({ projectRunId: 'bound-run-1', status: 'running' }) }).tasks;
    expect(unbound.get(created.taskId)).toBeNull();
    for (const id of ['project-run:p-1', 'project-run:p-1:bound-run-1:extra', 'project-run::bound-run-1', 'project-run:p-2:bound-run-1']) {
      expect(later.get(id)).toBeNull();
    }
    // A caller that may not start project runs answers none.
    expect(new CallerTasks('viewer', null).get(created.taskId)).toBeNull();
  });

  it('tells a caller waiting on atoma_run_start that the run is alive, when it sent a progressToken (2026-09-26)', async () => {
    // Claude Code aborts a call that sends "no response or progress for 300s";
    // every production run past five minutes was cut that way while it ran on.
    const tenant = projectRunsService('alive-run');
    const reads = vi.fn(tenant.service.projectRunStatus);
    tenant.service.projectRunStatus = reads;
    const { tasks, start } = projectTaskSession(tenant.service);
    const sent: { progressToken: string | number; progress: number; message?: string }[] = [];
    const channel = { progressToken: 'tok-1', notify: async (n: { params: (typeof sent)[number] }) => { sent.push(n.params); } };
    const waiting = runSynchronously(tasks, await start.start(PROJECT_ARGS), channel, 15);
    tenant.set('alive-run-1', 'running');
    await tick(60);
    tenant.set('alive-run-1', 'delivered', { endedAt: new Date().toISOString() });
    expect(await waiting).toMatchObject({ structuredContent: { status: 'delivered' } });
    const settled = sent.length;
    await tick(60);
    expect(sent[0]).toEqual({ progressToken: 'tok-1', progress: 1, message: 'run alive-run-1 queued' });
    expect(sent.map((entry) => entry.message)).toContain('run alive-run-1 running');
    // Heartbeats between status changes, strictly increasing, and silence once the run ended.
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every((entry, index) => entry.progress === index + 1)).toBe(true);
    expect(sent.length).toBe(settled);
    // No token, no notification.
    const quiet: unknown[] = [];
    const untokened = runSynchronously(tasks, await start.start(PROJECT_ARGS), { notify: async (n: unknown) => { quiet.push(n); } }, 15);
    tenant.set('alive-run-2', 'delivered', { endedAt: new Date().toISOString() });
    await untokened;
    expect(quiet).toEqual([]);
    // A task answered as a task reads nothing of its own: its reads are the caller's.
    await start.start(PROJECT_ARGS);
    const before = reads.mock.calls.length;
    await tick(60);
    expect(reads.mock.calls.length).toBe(before);
    // A cancelled call hears nothing more, though its run goes on.
    const cancelled = new AbortController();
    const afterCancel: unknown[] = [];
    const cut = runSynchronously(tasks, await start.start(PROJECT_ARGS),
      { progressToken: 'tok-2', signal: cancelled.signal, notify: async (n: unknown) => { afterCancel.push(n); } }, 15);
    tenant.set('alive-run-4', 'running');
    await tick(40);
    cancelled.abort();
    await expect(cut).rejects.toThrow(/cancelled/);
    const atCancel = afterCancel.length;
    await tick(60);
    expect(atCancel).toBeGreaterThan(0);
    expect(afterCancel.length).toBe(atCancel);
    expect(tenant.cancelled).toEqual([]);
  });

  it('parses atoma_run_start acceptanceCriteria with the console grammar, and refuses a bad entry before any run', async () => {
    const bodies: unknown[] = [];
    const tenant = projectRunsService('criteria-run');
    const startRun = tenant.service.startProjectRunFromInput;
    tenant.service.startProjectRunFromInput = async (v, p, body) => { bodies.push(body); return startRun(v, p, body); };
    const { tasks, start } = projectTaskSession(tenant.service);
    await start.start({ projectId: 'p-1', goal: 'notes API', idempotencyKey: 'k-1',
      acceptanceCriteria: ['GET /api/notes/:id 404 — unknown id is refused', 'The README explains how to start it'] });
    expect(bodies).toEqual([{ goal: 'notes API', idempotencyKey: 'k-1', acceptanceChecklist: [
      { behaviour: 'unknown id is refused', check: { kind: 'http', method: 'GET', path: '/api/notes/:id', status: 404 } },
      { behaviour: 'The README explains how to start it', check: { kind: 'review' } },
    ] }]);
    const refused = await start.start({ projectId: 'p-1', goal: 'notes API', idempotencyKey: 'k-2', acceptanceCriteria: ['fine', 'two\ncriteria'] });
    expect(bodies).toHaveLength(1);
    expect(refused.status).toBe('failed');
    expect(tasks.result(refused.taskId)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('entry 2: must hold exactly one criterion') }] });
    // The advertised entry bound (400) covers an http line's method and path; the TEXT bound is 160,
    // and both the description and the refusal say so (a client following the schema was refused, 2026-10-03).
    expect(PROJECT_RUN_INPUT.acceptanceCriteria.description).toContain(`at most ${MAX_CHECKLIST_BEHAVIOUR_CHARS} characters`);
    const tooLong = await start.start({ projectId: 'p-1', goal: 'notes API', idempotencyKey: 'k-3',
      acceptanceCriteria: ['fine', `The UI ${'x'.repeat(MAX_CHECKLIST_BEHAVIOUR_CHARS)}`] });
    expect(bodies).toHaveLength(1);
    expect(tasks.result(tooLong.taskId)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(
      `entry 2: this criterion's text is ${MAX_CHECKLIST_BEHAVIOUR_CHARS + 7} characters; at most ${MAX_CHECKLIST_BEHAVIOUR_CHARS}`) }] });
  });

  it.each(['delivered', 'partial', 'failed', 'cancelled'] as const)('keeps a finished two-hour project task one ttl after its run ends, without a poll of its own (%s)', async terminal => {
    vi.useFakeTimers();
    try {
      const tenant = projectRunsService(`long-${terminal}`, { runTaskBudgetMs: () => 133 * 60_000 });
      const read = vi.fn(tenant.service.projectRunStatus);
      tenant.service.projectRunStatus = read;
      const { tasks, start } = projectTaskSession(tenant.service, { pollMs: 60_000 });
      const ttl = 133 * 60_000 + 10 * 60_000;
      const created = await start.start(PROJECT_ARGS);
      tenant.set(`long-${terminal}-1`, 'running');
      const reads = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(131 * 60_000);
      expect(read).toHaveBeenCalledTimes(reads);
      expect(tasks.get(created.taskId)).toMatchObject({ status: 'working' });
      tenant.set(`long-${terminal}-1`, terminal, { endedAt: new Date().toISOString() });
      const status = terminal === 'cancelled' ? 'cancelled' : ['delivered', 'partial'].includes(terminal) ? 'completed' : 'failed';
      expect(tasks.get(created.taskId)).toMatchObject({ status });
      // One ttl after the run ENDED, as the SDK v1 store renewed it at terminal — not after it began.
      await vi.advanceTimersByTimeAsync(ttl - 60_000);
      expect(tasks.result(created.taskId)).toMatchObject({ structuredContent: { status: terminal } });
      expect(tasks.list().map((task) => task.taskId)).toEqual([created.taskId]);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(tasks.get(created.taskId)).toBeNull();
      expect(() => tasks.result(created.taskId)).toThrow(/not found/);
      expect(tasks.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the output of a run this session started as notifications/message, and one notice when it ends', async () => {
    const { driver, handle } = scriptedDriver();
    const { url } = await listen(() => ({ kind: 'operator' }), { ...NO_TENANT, operatorRunDriver: driver, operatorRunLease: lease });
    const client = await connect(url);
    const messages: { level: string; logger?: string | undefined; data: unknown }[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { messages.push({ level: n.params.level, logger: n.params.logger, data: n.params.data }); });
    await client.setLoggingLevel('info');
    // A run this session did NOT start is not followed.
    const foreign = await startRun({ goal: 'a goal started elsewhere' }, driver, lease);
    handle.chunk('unfollowed');
    handle.settle('done');
    await tick(100);
    expect(messages).toEqual([]);
    // A run started through the session IS followed, chunk by chunk, then the notice.
    const started = await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a followed goal' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    const runId = started.task.statusMessage!.match(/^run (mcp-\S+) started/)![1]!;
    expect(runId).not.toBe(foreign.runId);
    handle.chunk('alpha');
    handle.chunk('beta');
    handle.settle('done');
    await tick(150);
    expect(messages.map((m) => m.level)).toEqual(['info', 'info', 'notice']);
    expect(messages.every((m) => m.logger === `atoma.run.${runId}`)).toBe(true);
    expect(messages[0]!.data).toEqual({ runId, chunk: 'alpha', chunks: 1, untrusted: true });
    expect(messages[2]!.data).toMatchObject({ runId, status: 'finished' });
    // Below the level the client asked for, nothing is sent.
    await client.setLoggingLevel('warning');
    await client.request(
      { method: 'tools/call', params: { name: 'atoma_operator_run_start', arguments: { goal: 'a quiet goal' } } },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } }
    );
    handle.chunk('gamma');
    handle.settle('done');
    await tick(100);
    expect(messages).toHaveLength(3);
    await client.close();
  });
});


it('exposes registered benchmarks only to platform callers and drives cancellation through MCP tasks', async () => {
  const registration = benchmarkRegistration();
  let aborted = false;
  let finish: (() => void) | undefined;
  const deps: McpToolDeps = { ...TENANT_HOST, benchmarkStart: async (input, signal, progress) => {
    expect(input).toEqual(registration);
    progress('attempt 1: frontier-direct');
    await new Promise<void>(resolve => {
      finish = resolve;
      signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    });
    return summarizeRetrievalCampaign(input, [], signal.aborted ? 'cancelled' : 'completed');
  } };
  const { url } = await listen(req => ({ kind: 'principal', tokenId: 't',
    viewer: viewer('org:owner', req.headers.authorization === 'Bearer platform'),
  }), deps);
  const member = await connect(url, 'member');
  const platform = await connect(url, 'platform');
  try {
    expect(await toolNames(member)).not.toContain('atoma_benchmark_start');
    await expect(member.callTool({ name: 'atoma_benchmark_start', arguments: { registration } })).rejects.toThrow(/-32602.*not found/i);
    expect(await toolNames(platform)).toContain('atoma_benchmark_start');
    const start = () => platform.request({ method: 'tools/call', params: {
      name: 'atoma_benchmark_start', arguments: { registration },
    } }, CreateTaskResultSchema, { task: { ttl: 60_000 } });
    const first = await start();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await platform.experimental.tasks.getTask(first.task.taskId)).statusMessage).toContain('frontier-direct');
    finish!();
    const result = await platform.experimental.tasks.getTaskResult(first.task.taskId, CallToolResultSchema);
    expect(result.structuredContent).toMatchObject({ campaignId: registration.spec.id, reason: 'completed' });
    finish = undefined;
    const second = await start();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await platform.experimental.tasks.cancelTask(second.task.taskId);
    await vi.waitFor(() => expect(aborted).toBe(true));
  } finally { finish?.(); await member.close(); await platform.close(); }
});

it('journals a platform-admin MCP trace read under the foreign organisation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-cross-read-'));
  dirs.push(root);
  const a = projectRetrievalFixture(root, { subject: 'admin', slug: 'admin' });
  const b = projectRetrievalFixture(root, { subject: 'foreign', slug: 'foreign' });
  const run = b.makeRun();
  mkdirSync(run.layout.runsPath, { recursive: true });
  writeFileSync(join(run.layout.runsPath, `${run.run.projectRunId}.json`), JSON.stringify({
    id: run.run.projectRunId, label: 'Foreign trace', startedAt: '2026-09-20T12:00:00Z', events: [],
  }));
  const journal = PlatformEventLog.open(a.dbPath);
  const service = new ProjectService({ store: a.projects, github: null,
    coordinator: {} as ProjectRunCoordinator, auditRead: read => journal.recordCrossOrgRead(read) });
  const { url } = await listen(() => ({ kind: 'principal', viewer: { ...a.viewer, platformAdmin: true }, tokenId: 'admin' }),
    { ...NO_TENANT, auth: a.auth, projects: { store: a.projects, service }, journal });
  const client = await connect(url);
  try {
    const response = await client.callTool({ name: 'atoma_run_trace', arguments: { runId: run.run.projectRunId } });
    expect(response.isError).not.toBe(true);
    const events = journal.list({ kind: 'admin.cross_org_read' }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: a.viewer.principalId, orgId: b.viewer.orgId, detail: { surface: 'mcp.trace' } });
  } finally { await client.close(); }
});
it('calibrates Jev over MCP on every organisation, and reads its answers again for free', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-jev-calibrate-'));
  dirs.push(root);
  const a = projectRetrievalFixture(root, { subject: 'admin', slug: 'admin' });
  const b = projectRetrievalFixture(root, { subject: 'second', slug: 'second' });
  const c = projectRetrievalFixture(root, { subject: 'third', slug: 'third' });
  const writeTrace = (fixture: typeof a, task: string, startedAt: string) => {
    const run = fixture.makeRun();
    mkdirSync(run.layout.runsPath, { recursive: true });
    writeFileSync(join(run.layout.runsPath, `${run.run.projectRunId}.json`), JSON.stringify({
      id: run.run.projectRunId, label: task, startedAt,
      events: [{ id: `${fixture.viewer.orgId}-prefilter`, kind: 'llm', ts: 1, role: 'prefilter', actor: { name: 'Idioblast', tier: 2 },
        systemPrompt: 'You pre-filter catalog lookups.',
        userContent: [`Task: ${task}`, '', 'Catalog:', '  - Water: builds web pages', '  - Methane: builds JSON APIs'].join('\n'),
        response: JSON.stringify({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'x' }) }],
    }));
  };
  writeTrace(a, 'Build the admin page.', '2026-09-27T10:00:00.000Z');
  writeTrace(b, 'Build the second page.', '2026-09-27T11:00:00.000Z');
  writeTrace(c, 'Build the third page.', '2026-09-27T12:00:00.000Z');
  // A run Jev decided in: its decisions stay out of the corpus, its audit does not.
  const jevRun = c.makeRun();
  mkdirSync(jevRun.layout.runsPath, { recursive: true });
  writeFileSync(join(jevRun.layout.runsPath, `${jevRun.run.projectRunId}.json`), JSON.stringify({
    id: jevRun.run.projectRunId, label: 'Jev run', startedAt: '2026-09-27T13:00:00.000Z',
    events: [
      { id: 'jev-1', kind: 'jev', ts: 1, role: 'validate-result', outcome: 'approved' },
      { id: 'audit-1', kind: 'llm', ts: 2, role: 'jev-audit', subject: 'RESULT', actor: { name: 'Idioblast', tier: 2 },
        child: { name: 'Water', tier: 1 }, systemPrompt: 'sys', userContent: 'prompt',
        response: JSON.stringify({ approved: false, reasoning: 'no proof' }) },
    ],
  }));
  const journal = PlatformEventLog.open(a.dbPath);
  const service = new ProjectService({ store: a.projects, github: null,
    coordinator: {} as ProjectRunCoordinator, auditRead: read => journal.recordCrossOrgRead(read) });
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (href !== JEV_ENDPOINT) return realFetch(url, init);
    bodies.push(init!.body as string);
    const questions = (JSON.parse(init!.body as string) as { questions: Record<string, { type: string; criteria?: object }> }).questions;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'semantic_judgment' ? 0.85 : id === 'fits::agent_1' ? 0.9 : 0.05 }];
      const first = Object.keys(question.criteria!)[0]!;
      return [id, { type: 'choice', choice: first, confidence: 0.9, probabilities: { [first]: 0.9 } }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 });
  });
  vi.stubEnv('TYPESAFE_API_KEY', 'ts-key');
  const { url } = await listen(() => ({ kind: 'principal', viewer: { ...a.viewer, platformAdmin: true }, tokenId: 'admin' }),
    { ...NO_TENANT, auth: a.auth, projects: { store: a.projects, service }, journal });
  const client = await connect(url);
  type Payload = { resultId: string; orgs: string[]; window: { decisions: number; nextOffset: number | null };
    report: { prefilter: { documented: { agree: number; deferred: number } }[] } };
  try {
    const asked = await client.callTool({ name: 'atoma_jev_calibrate', arguments: { since: '2026-09-26', until: '2026-09-29' } });
    expect(asked.isError).not.toBe(true);
    const payload = asked.structuredContent as Payload;
    // Every organisation on the instance, none named anywhere (owner decision 2026-09-30).
    const everyOrg = [a.viewer.orgId, b.viewer.orgId, c.viewer.orgId].sort();
    expect([...payload.orgs].sort()).toEqual(everyOrg);
    expect(payload.window).toMatchObject({ decisions: 3, nextOffset: null });
    expect(payload.report.prefilter[0]!.documented.agree).toBe(3);
    // Both designs on three decisions: six requests.
    expect(bodies).toHaveLength(6);
    expect(bodies.join(' ')).toContain('Build the third page.');
    // Each foreign organisation's read is journaled; the caller's own is not a cross-organisation read.
    const reads = journal.list({ kind: 'admin.cross_org_read' }).events.map((event) => event.orgId).sort();
    expect(reads).toEqual([b.viewer.orgId, c.viewer.orgId].sort());
    const again = await client.callTool({ name: 'atoma_jev_calibrate', arguments: { resultIds: [payload.resultId], thresholds: { fit: 0.95 } } });
    expect(again.isError).not.toBe(true);
    expect(bodies).toHaveLength(6);
    expect((again.structuredContent as Payload).report.prefilter[0]!.documented.deferred).toBe(3);
    const recipe = {
      skillId: 'replay-probes', description: 'Replay recorded checks', whenToUse: 'Verify a delivered API',
      body: 'Read the probe manifest and replay its recorded expectations.', hostTools: ['fetch_url'],
      subTaskDescription: 'Recheck the API', resultSummary: 'Recorded probes passed', expected: true,
    };
    const compilation = await client.callTool({ name: 'atoma_jev_calibrate', arguments: {
      compilations: { cases: [recipe], repeats: 2 }, details: { limit: 10 }, sweep: true,
    } });
    expect(compilation.isError).not.toBe(true);
    const compiled = compilation.structuredContent as { resultId: string; report: Record<string, unknown> };
    expect(compiled.report).toMatchObject({ compilation: { cases: 2, falsePostponements: 2 } });
    expect(bodies).toHaveLength(8); // only two compilation evaluations, no trace replay
    const compilationRequest = JSON.parse(bodies[6]!) as { state: Record<string, unknown> };
    expect(compilationRequest.state).toMatchObject({
      compile_request: buildCompileSkillPrompt({ skillId: recipe.skillId, skillDescription: recipe.description,
        skillWhenToUse: recipe.whenToUse, skillBody: recipe.body,
        subTaskDescription: recipe.subTaskDescription, resultSummary: recipe.resultSummary }),
      runtime: { direct_loopback_network: true },
    });
    expect(compilationRequest.state).not.toHaveProperty('expected');
    expect(journal.list({ kind: 'admin.cross_org_read' }).events).toHaveLength(2);
    const recalculated = await client.callTool({ name: 'atoma_jev_calibrate', arguments: {
      resultIds: [compiled.resultId], thresholds: { compilationObstacle: 0.9 },
    } });
    expect(recalculated.isError).not.toBe(true);
    expect(recalculated.structuredContent).toMatchObject({ report: { compilation: { falsePostponements: 0, deferred: 2 } } });
    for (const extra of [{ auditsOnly: true }, { since: '2026-09-26' }, { resultIds: [compiled.resultId] }]) {
      const invalid = await client.callTool({ name: 'atoma_jev_calibrate', arguments: { compilations: { cases: [recipe] }, ...extra } });
      expect(invalid.isError).toBe(true);
    }
    const overBudget = await client.callTool({ name: 'atoma_jev_calibrate', arguments: { compilations: { cases: [recipe], repeats: 6 } } });
    expect(overBudget.isError).toBe(true);
    expect(bodies).toHaveLength(8);
    // The platform switch turns it off, as it turns Jev off in every run.
    vi.stubEnv('ATOMA_JEV', '0');
    const refused = await client.callTool({ name: 'atoma_jev_calibrate', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('Jev is off on this host');
    // The audit sample reads without the key and sends nothing.
    const audits = await client.callTool({ name: 'atoma_jev_calibrate', arguments: { auditsOnly: true, since: '2026-09-26' } });
    expect(audits.isError).not.toBe(true);
    expect(bodies).toHaveLength(8);
    expect((audits.structuredContent as { audits: { subjects: unknown[] } }).audits.subjects).toEqual([
      expect.objectContaining({ subject: 'PLAN', audited: 0 }),
      expect.objectContaining({ subject: 'RESULT', audited: 1, refusedByModel: 1, falseApprovalShare: 1 }),
    ]);
  } finally {
    await client.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    forgetJevCalibrationsForTest();
  }
});

it('reads complete diagnostics over HTTP with lossless pages and organisation isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-detail-'));
  dirs.push(root);
  const a = projectRetrievalFixture(root, { subject: 'reader', slug: 'reader' });
  const b = projectRetrievalFixture(root, { subject: 'other', slug: 'other' });
  const own = a.makeRun();
  const foreign = b.makeRun();
  const verdict = { id: 'acceptance-final', kind: 'acceptance', ts: 42, approved: false,
    reasoning: 'Missing restart evidence. ' + 'é🧪'.repeat(12_000) };
  const trace = { id: own.run.projectRunId, label: 'diagnostic', startedAt: '2026-09-24T15:00:00Z',
    error: 'Root acceptance failed: exact cause', result: { refusal: 'not verified' },
    events: [verdict, { id: 'tool-1', kind: 'tool', ts: 43, name: 'fetch_url', durationMs: 123,
      args: { url: 'http://localhost:3000/health' }, result: { status: 500, body: 'exact response' } }] };
  mkdirSync(own.layout.runsPath, { recursive: true });
  const path = join(own.layout.runsPath, `${own.run.projectRunId}.json`);
  writeFileSync(path, JSON.stringify(trace));
  writeFileSync(own.run.hostPaths.logPath, 'runner stderr: fatal\n' + 'x'.repeat(30_000));
  const service = new ProjectService({ store: a.projects, github: null, coordinator: {} as ProjectRunCoordinator });
  const { url } = await listen(() => ({ kind: 'principal', viewer: a.viewer, tokenId: 'reader' }),
    { ...NO_TENANT, auth: a.auth, projects: { store: a.projects, service } });
  const client = await connect(url);
  type DetailPage = { text: string; snapshot: string; nextTextOffset: number | null; changed?: boolean };
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'atoma_run_trace', arguments: { runId: own.run.projectRunId, ...args } });
  try {
    const summary = await call({});
    expect(summary.structuredContent).toMatchObject({ error: trace.error, provenance: null,
      events: [{ id: verdict.id, approved: false }, { durationMs: 123 }] });
    const header = await call({ section: 'metadata' });
    expect(JSON.parse((header.structuredContent as DetailPage).text)).toEqual({
      id: trace.id, label: trace.label, startedAt: trace.startedAt, error: trace.error, result: trace.result,
    });
    let offset = 0;
    let snapshot: string | undefined;
    let text = '';
    for (;;) {
      const response = await call({ section: 'event', eventId: verdict.id, textOffset: offset, textLimit: 999_999, ...(snapshot ? { snapshot } : {}) });
      expect(response.isError).not.toBe(true);
      const page = response.structuredContent as DetailPage;
      expect(page.text.length).toBeLessThanOrEqual(24_000);
      text += page.text;
      snapshot = page.snapshot;
      if (page.nextTextOffset === null) break;
      offset = page.nextTextOffset;
    }
    expect(JSON.parse(text)).toEqual(verdict);
    const event = await call({ section: 'event', eventId: 'tool-1' });
    expect(JSON.parse((event.structuredContent as DetailPage).text)).toEqual(trace.events[1]);
    const log = await call({ section: 'log' });
    expect((log.structuredContent as DetailPage).text).toContain('runner stderr: fatal');
    expect((log.structuredContent as DetailPage).nextTextOffset).not.toBeNull();
    trace.events[0] = { ...verdict, reasoning: 'new verdict' };
    writeFileSync(path, JSON.stringify(trace));
    expect((await call({ section: 'event', eventId: verdict.id, textOffset: 24_000, snapshot })).structuredContent).toMatchObject({ changed: true });
    expect((await call({ section: 'event' })).isError).toBe(true);
    for (const section of ['summary', 'metadata', 'event', 'log']) {
      expect((await call({ runId: foreign.run.projectRunId, section, eventId: verdict.id })).isError).toBe(true);
      expect((await call({ file: 'any.json', section, eventId: verdict.id })).isError).toBe(true);
    }
  } finally { await client.close(); }
});

it('serves a tenant the runner log without the host layout (2026-09-25 review, 2.2)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-mcp-log-paths-'));
  dirs.push(root);
  const a = projectRetrievalFixture(root, { subject: 'reader', slug: 'reader' });
  const own = a.makeRun();
  const seedPath = join(dirname(dirname(own.run.hostPaths.workspacePath)), 'previous-run', 'workspace');
  mkdirSync(dirname(own.run.hostPaths.logPath), { recursive: true });
  writeFileSync(own.run.hostPaths.logPath, [
    `> node dist/cli/build-app.js --clean-workspace --container --seed ${seedPath} Build a dashboard.`,
    `workspace seeded from ${seedPath} (3 entries)`,
    `workspace: ${own.run.hostPaths.workspacePath}`,
    `skills root: ${skillsDirPath()}`,
    'runner stderr: fatal',
  ].join('\n'));
  const service = new ProjectService({ store: a.projects, github: null, coordinator: {} as ProjectRunCoordinator });
  const { url } = await listen(() => ({ kind: 'principal', viewer: a.viewer, tokenId: 'reader' }),
    { ...NO_TENANT, auth: a.auth, projects: { store: a.projects, service } });
  const client = await connect(url);
  try {
    const log = await client.callTool({ name: 'atoma_run_trace', arguments: { runId: own.run.projectRunId, section: 'log' } });
    const text = JSON.parse((log.structuredContent as { text: string }).text) as string;
    expect(text).toContain('runner stderr: fatal');
    expect(text).toContain('workspace seeded from <project>');
    expect(text).toContain('skills root: <platform-skills>');
    expect(text).not.toContain(root);
    expect(text).not.toContain(skillsDirPath());
  } finally { await client.close(); }
});
