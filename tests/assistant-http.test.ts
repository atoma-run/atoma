import { EXAMPLE_ACCOUNT_SUBSCRIPTIONS } from '../src/contracts/accountSubscriptions.js';
import { ConnectedAssistantModels } from '../src/viz/assistantModels.js';
import type { makeTransportClient } from '../src/run/providers.js';
import { TASKS_EXTENSION } from '../src/mcp/taskWire.js';
import { conversationReadResultSchema } from '../src/contracts/assistant.js';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../src/core/types.js';
import { Conversations } from '../src/projects/conversations.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { AssistantGrants } from '../src/auth/assistantGrants.js';
import type { AuthStore, Viewer } from '../src/auth/store.js';
import type { AssistantRequest, AssistantView } from '../src/contracts/assistant.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { GitHubStore } from '../src/github/store.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { acquireRunLease } from '../src/mcp/runLock.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import { ProjectRunCoordinator, type ProjectRunDriver } from '../src/projects/coordinator.js';
import { ProjectService } from '../src/projects/service.js';
import type { ProjectStore } from '../src/projects/store.js';
import { AssistantService } from '../src/viz/assistant.js';
import { assistantHttp } from '../src/viz/assistantHttp.js';
import { connectAssistantMcp } from '../src/viz/assistantMcp.js';
import { AssistantStore } from '../src/viz/assistantStore.js';
import { haystackTestEnvironment } from './helpers/haystack.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { ANTHROPIC_PINS } from './tier-pins.js';

const servers: Server[] = [], hosts: McpHttpHost[] = [], databases: Database.Database[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  databases.splice(0).forEach(db => db.close());
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  closeStoreHandles();
});

type Complete = (request?: LlmCompletionRequest) => Promise<LlmCompletionResponse>;

/** The browser door and the loopback MCP in front of a project service; inference is `complete`. */
async function serve(viewer: Viewer, projects: { service: ProjectService; store: ProjectStore; auth: AuthStore | null },
  complete: Mock<Complete>) {
  const db = new Database(':memory:'); databases.push(db);
  let session: Viewer | null = viewer;
  const grants = new AssistantGrants();
  const store = new AssistantStore(db);
  const conversations = new Conversations(store, projects.service);
  const transport = vi.fn<typeof makeTransportClient>(() => ({ complete }));
  const orgKey = vi.fn((): string | null => 'customer-key');
  const subscriptions = {
    status: vi.fn(async () => EXAMPLE_ACCOUNT_SUBSCRIPTIONS),
    codexProfileForRun: () => null,
    codexModels: async () => ({ state: 'unavailable' as const, checkedAt: null, models: [] }),
    claudeProfileForRun: vi.fn((principal: string) => principal === viewer.principalId
      ? { profileId: 'generation', profilesRoot: '/private', homePath: '/private/alice/claude', oauthToken: 'customer-claude' } : null),
  };
  const models = new ConnectedAssistantModels({
    host: { ATOMA_ASSISTANT_MODEL: 'api:anthropic:claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'host-key' },
    auth: { listOrgProviderKeys: () => [{ provider: 'anthropic', configuredAt: new Date().toISOString() }] },
    subscriptions, orgKey, transport, active: principal => store.hasActiveRequestForPrincipal(principal),
  });
  const service = new AssistantService(store, models);
  const server = createServer((req, res) => {
    if (req.url === '/mcp') { void mcp.handle(req, res); return; }
    void assistantHttp(req, res, {
      resolve: () => req.headers.cookie === 'session=test' ? session : null,
      sameOrigin: () => {
        if (req.headers.origin === url) return true;
        res.writeHead(403); res.end(); return false;
      },
      readBody: async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); },
      service,
      connect: async () => {
        const grant = grants.issue(() => session);
        const client = await connectAssistantMcp(new URL(`${url}/mcp`), 'atoma.test', grant.token);
        return { signal: client.signal, call: client.call,
          close: async () => { try { await client.close(); } finally { grant.release(); } } };
      },
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const url = `http://127.0.0.1:${address.port}`;
  const mcp = new McpHttpHost({ allowedHosts: ['atoma.test', new URL(url).host],
    resolveCaller: req => {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (token === 'external-test') return { kind: 'principal', viewer, tokenId: 'external' };
      const resolved = grants.resolve(token);
      return resolved ? { kind: 'principal', ...resolved } : null;
    }, ...mcpHostWiring({ conversations, projects: { service: projects.service, store: projects.store }, auth: projects.auth, journal: null, operatorRuns: false }),
  }); hosts.push(mcp);
  const post = (input: AssistantRequest, headers: Record<string, string> = {}) => fetch(`${url}/api/assistant`, {
    method: 'POST', headers: { cookie: 'session=test', origin: url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  return { db, store, models, transport, orgKey, subscriptions, url, post,
    external: () => connectAssistantMcp(new URL(`${url}/mcp`), 'atoma.test', 'external-test'), setSession: (value: Viewer | null) => { session = value; } };
}

async function fixture(otherProjectId?: string) {
  const viewer: Viewer = { principalId: randomUUID(), orgId: randomUUID(), role: 'org:owner', platformAdmin: true,
    displayName: 'Alice', orgName: 'A', kind: 'human', displayNameSource: 'provider' };
  const projectId = randomUUID(), runId = randomUUID();
  const run = { projectId, projectRunId: runId, orgId: viewer.orgId, requestedByPrincipalId: viewer.principalId,
    status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null };
  const start = vi.fn(async () => run);
  const create = vi.fn(async () => ({ projectId }));
  const projectService = {
    createProjectFromInput: create,
    projectPage: vi.fn((caller: Viewer) => {
      expect(caller.platformAdmin).toBe(false); expect(caller.orgId).toBe(viewer.orgId);
      return { projects: [{ projectId, name: 'Stock tracker' },
        ...(otherProjectId ? [{ projectId: otherProjectId, name: 'Minesweeper' }] : [])], nextCursor: null };
    }),
    listInstallations: () => [{ installationId: '123', accountLogin: 'example', status: 'active' }],
    projectContext: (_caller: Viewer, id: string) => ({ context: { projectId: id, version: 0, brief: null, decisions: [], change: null }, history: [], nextBeforeVersion: null }),
    projectReadiness: () => ({ ready: true }),
    projectRunsPage: () => ({ runs: [], nextCursor: null }),
    startProjectRunFromInput: start, runTaskBudgetMs: () => 60_000,
    projectRunStatus: () => run, projectRunState: () => run,
    runsRequestedBy: () => [run],
  } as unknown as ProjectService;
  const complete = vi.fn<Complete>(async () => ({ text: JSON.stringify({ message: 'Review this goal.',
    proposal: { kind: 'start_run', projectId, goal: 'Build stock alerts', acceptanceCriteria: [] } }),
    stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 } }));
  const served = await serve(viewer, { service: projectService, store: {} as ProjectStore, auth: null }, complete);
  const message: AssistantRequest = { kind: 'message', version: 0, projectId: null, text: 'Build stock alerts', requestId: randomUUID() };
  return { ...served, viewer, projectId, runId, complete, start, create, message };
}

/**
 * The same doors over the REAL project service: its coordinator and SQLite
 * store, runs saved as a delivery saves them, the MCP's own readers. The run
 * child is replaced at the driver seam; inference is mocked.
 */
async function storeFixture() {
  // Retention refuses a symlinked ancestor; macOS aliases tmpdir() through /private.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-assistant-store-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const f = projectRetrievalFixture(root);
  const driver = vi.fn<ProjectRunDriver>(async () => 'must not launch');
  const coordinator = new ProjectRunCoordinator({ store: f.projects, dbPath: f.dbPath, projectsRoot: root, driver,
    hostEnv: { ...haystackTestEnvironment(root), ...ANTHROPIC_PINS, ANTHROPIC_API_KEY: 'private-test-key' },
    acquireLease: id => acquireRunLease(id, join(root, 'lease.db')) });
  cleanups.push(async () => { await coordinator.waitForIdle(); coordinator.stopQueue(); });
  const github = GitHubStore.open(f.dbPath);
  github.linkInstallation({ installationId: '123', orgId: f.viewer.orgId, accountId: '123', accountLogin: 'owner',
    targetType: 'Organization', repositorySelection: 'all', permissions: { contents: 'write', administration: 'write' },
    connectedByPrincipalId: f.viewer.principalId });
  const service = new ProjectService({ store: f.projects, coordinator, github });
  const complete = vi.fn<Complete>(async () => ({ text: JSON.stringify({ message: 'Noted.', proposal: null }),
    stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 } }));
  const served = await serve(f.viewer, { service, store: f.projects, auth: f.auth }, complete);
  const message = (text: string, version = 0): AssistantRequest => ({ kind: 'message', version, projectId: f.project.projectId,
    text, requestId: randomUUID() });
  /** What the model was shown on its `call`th request: the recorded context, before the conversation. */
  const context = (call = 0) => complete.mock.calls[call]![0]!.userContent.split('\nConversation (oldest first):\n')[0]!;
  return { ...f, ...served, root, driver, coordinator, service, complete, message, context };
}

it('drives the actual HTTP MCP with a delegated member bearer and starts a task only on browser confirmation', async () => {
  const f = await fixture();
  const response = await f.post(f.message);
  expect(response.status).toBe(200);
  const view = await response.json() as AssistantView;
  expect(view.conversation.proposal?.state).toBe('pending');
  expect(f.start).not.toHaveBeenCalled();
  const confirm: AssistantRequest = { kind: 'confirm', version: view.conversation.version, projectId: null,
    conversationId: view.conversation.id!, proposalId: view.conversation.proposal!.id, requestId: randomUUID() };
  const launched = await f.post(confirm);
  expect(launched.status).toBe(200);
  expect((await launched.json() as AssistantView).conversation.lastRun).toEqual({ projectId: f.projectId, runId: f.runId });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect((await f.post(confirm)).status).toBe(200);
  expect(f.start).toHaveBeenCalledTimes(1);
  const reloaded = await fetch(`${f.url}/api/assistant?conversationId=${view.conversation.id}`, { headers: { cookie: 'session=test' } });
  expect((await reloaded.json() as AssistantView).run?.status).toBe('running');
  expect(f.complete).toHaveBeenCalledTimes(1);
});

it('keeps project chats and model context separate through browser and MCP round trips', async () => {
  const otherProjectId = randomUUID();
  const f = await fixture(otherProjectId);
  f.complete.mockResolvedValue({ text: JSON.stringify({ message: 'Scoped reply.', proposal: null }),
    stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 } });
  const external = await f.external();
  try {
    await external.call('atoma_conversation_update', { projectId: otherProjectId, expectedVersion: 0, requestId: randomUUID(),
      messages: [{ role: 'assistant', text: 'Minesweeper shared exchange' }] });
  } finally { await external.close(); }

  const first = await f.post({ ...f.message, projectId: f.projectId, text: 'Stock alerts discussion' });
  expect(first.status).toBe(200);
  const stock = (await first.json() as AssistantView).conversation;
  const second = await f.post({ ...f.message, projectId: otherProjectId, version: 1, requestId: randomUUID(), text: 'Minesweeper board discussion' });
  expect(second.status).toBe(200);
  const minesweeper = (await second.json() as AssistantView).conversation;
  expect(minesweeper.id).not.toBe(stock.id);

  // Resuming by stable conversation ID must retain its project, even without a projectId in the request.
  const resumed = await f.post({ ...f.message, conversationId: stock.id!, version: stock.version, requestId: randomUUID(), text: 'Continue stock alerts' });
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as AssistantView).conversation.projectId).toBe(f.projectId);
  for (const index of [0, 2]) {
    const prompt = f.complete.mock.calls[index]![0]!.userContent;
    expect(prompt).toContain('Stock alerts discussion');
    expect(prompt).toContain('Stock tracker');
    expect(prompt).not.toContain(otherProjectId);
    expect(prompt).not.toContain('Minesweeper');
  }
  const otherPrompt = f.complete.mock.calls[1]![0]!.userContent;
  expect(otherPrompt).toContain('Minesweeper shared exchange');
  expect(otherPrompt).toContain('Minesweeper board discussion');
  expect(otherPrompt).not.toContain(f.projectId);
  expect(otherPrompt).not.toContain('Stock');

  for (const [projectId, ownText, otherText] of [[f.projectId, 'Stock alerts discussion', 'Minesweeper'],
    [otherProjectId, 'Minesweeper shared exchange', 'Stock']]) {
    const reloaded = await fetch(`${f.url}/api/assistant?projectId=${projectId}`, { headers: { cookie: 'session=test' } });
    expect(reloaded.status).toBe(200);
    const history = JSON.stringify((await reloaded.json() as AssistantView).conversation.messages);
    expect(history).toContain(ownText);
    expect(history).not.toContain(otherText);
  }
  const mismatch = await f.post({ ...f.message, projectId: otherProjectId, conversationId: stock.id!, requestId: randomUUID() });
  expect(mismatch.status).toBe(409);
  expect(f.complete).toHaveBeenCalledTimes(3);
  expect(f.start).not.toHaveBeenCalled();
});

it('reads the refusal from an immediately failed MCP task instead of claiming a run started', async () => {
  const f = await fixture();
  const view = await (await f.post(f.message)).json() as AssistantView;
  f.start.mockRejectedValue(new Error('Run admission is full'));
  const response = await f.post({ kind: 'confirm', version: view.conversation.version, projectId: null,
    conversationId: view.conversation.id!, proposalId: view.conversation.proposal!.id, requestId: randomUUID() });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('Run admission is full') });
  const state = await (await fetch(`${f.url}/api/assistant?conversationId=${view.conversation.id}`, { headers: { cookie: 'session=test' } })).json() as AssistantView;
  expect(state.conversation.lastRun).toBeNull();
  expect(state.conversation.proposal?.state).toBe('uncertain');
});

it('rejects unauthenticated, cross-origin and viewer requests before any MCP/model work', async () => {
  const f = await fixture();
  expect((await f.post(f.message, { cookie: '' })).status).toBe(401);
  expect((await f.post(f.message, { origin: 'https://attacker.test' })).status).toBe(403);
  f.setSession({ ...f.viewer, role: 'org:viewer' });
  expect((await f.post(f.message)).status).toBe(403);
  expect(f.complete).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});

it('does not expose an old organisation response after the browser session switches during inference', async () => {
  const f = await fixture();
  const original = f.complete.getMockImplementation()!;
  f.complete.mockImplementation(async () => {
    f.setSession({ ...f.viewer, orgId: randomUUID() });
    return original();
  });
  const response = await f.post(f.message);
  expect([401, 503]).toContain(response.status);
  expect(JSON.stringify(await response.json())).not.toContain('Build stock alerts');
  expect(f.start).not.toHaveBeenCalled();
});


it('continues a browser proposal through a second MCP client, then returns its receipt to the browser', async () => {
  const f = await fixture(); const client = await f.external();
  try {
    const view = await (await f.post(f.message)).json() as AssistantView;
    const read = conversationReadResultSchema.parse(await client.call('atoma_conversation', { conversationId: view.conversation.id }));
    const proposal = read.conversation.proposal!;
    expect(proposal.action.kind).toBe('start_run');
    const { kind: _kind, ...action } = proposal.action;
    const conversationApproval = { conversationId: read.conversation.id, proposalId: proposal.id, version: read.conversation.version,
      requestId: randomUUID(), confirmation: 'Yes, start these stock alerts.' };
    await client.call('atoma_run_start', { ...action, conversationApproval }, true);
    const browser = await (await fetch(`${f.url}/api/assistant?projectId=${f.projectId}`, { headers: { cookie: 'session=test' } })).json() as AssistantView;
    expect(browser.conversation.id).toBe(view.conversation.id);
    expect(browser.conversation.lastRun?.runId).toBe(f.runId);
    expect((await f.post({ kind: 'confirm', projectId: f.projectId, conversationId: view.conversation.id!,
      proposalId: proposal.id, version: read.conversation.version, requestId: randomUUID() })).status).toBe(200);
    expect(f.start).toHaveBeenCalledOnce(); expect(f.complete).toHaveBeenCalledOnce();
  } finally { await client.close(); }
});

async function modernCall(url: string, name: string, args: Record<string, unknown>, task = false) {
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer external-test',
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': name }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
    params: { name, arguments: args, ...(task ? { resultType: 'task' } : {}), _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'continuity-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION]: {} } },
    } } }) });
  const body = await response.text();
  const frame = body.startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data:') && line.includes('"id"'))!.slice(5);
  const parsed = JSON.parse(frame) as { result: Record<string, unknown>; error?: unknown };
  expect(parsed.error).toBeUndefined(); expect(response.status).toBe(200);
  return parsed.result;
}

it('shares a modern-client draft before any project exists, creates in Atoma, and resumes the same thread through modern tasks', async () => {
  const f = await fixture();
  const draft = await modernCall(f.url, 'atoma_conversation_update', { requestId: randomUUID(), expectedVersion: 0,
    clientLabel: 'Claude Code', messages: [{ role: 'assistant', text: 'Agreed: stock alerts for a small shop.' }], proposal: {
      kind: 'create_project', project: { name: 'Stock', slug: 'stock', initialPrompt: 'Build stock alerts',
        repositoryTarget: { installationId: '123', owner: 'example', name: 'stock' } },
    } });
  expect(draft['isError']).not.toBe(true);
  const shared = conversationReadResultSchema.parse(draft['structuredContent']);
  const response = await f.post({ kind: 'confirm', projectId: null, conversationId: shared.conversation.id!,
    requestId: randomUUID(), version: shared.conversation.version, proposalId: shared.conversation.proposal!.id });
  expect(response.status).toBe(200);
  const browser = await response.json() as AssistantView;
  expect(browser.conversation).toMatchObject({ id: shared.conversation.id, projectId: f.projectId });
  expect(browser.conversation.messages[0]).toMatchObject({ origin: 'mcp', clientLabel: 'Claude Code' });
  expect(f.create).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  const next = conversationReadResultSchema.parse((await modernCall(f.url, 'atoma_conversation', { projectId: f.projectId }))['structuredContent']);
  const proposal = next.conversation.proposal!; const { kind: _kind, ...action } = proposal.action;
  const conversationApproval = { conversationId: next.conversation.id, version: next.conversation.version, proposalId: proposal.id,
    requestId: randomUUID(), confirmation: 'Approved: build the stock alerts.' };
  const task = await modernCall(f.url, 'atoma_run_start', { ...action, conversationApproval }, true);
  expect(task).toMatchObject({ resultType: 'task', taskId: `project-run:${f.projectId}:${f.runId}` });
  await modernCall(f.url, 'atoma_run_start', { ...action, conversationApproval }, true);
  expect(f.start).toHaveBeenCalledOnce();
  const current = conversationReadResultSchema.parse((await modernCall(f.url, 'atoma_conversation', { projectId: f.projectId }))['structuredContent']);
  const updated = conversationReadResultSchema.parse((await modernCall(f.url, 'atoma_conversation_update', {
    projectId: f.projectId, expectedVersion: current.conversation.version, requestId: randomUUID(),
    messages: [{ role: 'assistant', text: 'Agreed in Claude: add supplier phone numbers next.' }],
  }))['structuredContent']);
  const continued = await f.post({ kind: 'message', projectId: f.projectId, conversationId: current.conversation.id!,
    version: updated.conversation.version, requestId: randomUUID(), text: 'Continue with that next step.' });
  expect(continued.status).toBe(200);
  expect(f.complete.mock.calls.at(-1)![0]!.userContent).toContain('Agreed in Claude: add supplier phone numbers next.');
  expect(f.start).toHaveBeenCalledOnce();
});

it('refuses run overrides on a shared approval before any side effect', async () => {
  const f = await fixture(); const client = await f.external();
  try {
    const view = await (await f.post(f.message)).json() as AssistantView;
    const action = view.conversation.proposal!.action;
    const conversationApproval = { conversationId: view.conversation.id, version: view.conversation.version,
      proposalId: view.conversation.proposal!.id, requestId: randomUUID(), confirmation: 'Approved.' };
    await expect(client.call('atoma_run_start', { ...action, conversationApproval, depth: 'deep' }, true)).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
  } finally { await client.close(); }
});


it.each([
  ['api:anthropic:claude-haiku-4-5-20251001', 'org-key', 'anthropic-api'],
  ['own:anthropic:haiku', 'principal-subscription', 'claude-cli'],
])('uses the browser-selected %s through HTTP and records its payer', async (modelChoice, payer, transportName) => {
  const f = await fixture();
  const response = await f.post({ ...f.message, modelChoice });
  expect(response.status).toBe(200);
  const view = await response.json() as AssistantView;
  expect(view.conversation.modelChoice).toBe(modelChoice);
  expect(f.transport).toHaveBeenCalledWith(transportName, expect.any(Object));
  expect(f.db.prepare('SELECT payer, model FROM assistant_calls').get()).toEqual({ payer, model: modelChoice });
  expect(f.complete.mock.calls[0]![0]?.executor).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain('customer-key');
  expect(JSON.stringify(view)).not.toContain('customer-claude');
  expect(f.start).not.toHaveBeenCalled();
  f.orgKey.mockReturnValue(null);
  f.subscriptions.claudeProfileForRun.mockReturnValue(null);
  const refused = await f.post({ ...f.message, modelChoice, version: view.conversation.version, requestId: randomUUID() });
  expect(refused.status).toBe(409);
  expect(f.complete).toHaveBeenCalledOnce();
});

it('shows the model the newest run\'s acceptance, publication and progress beside a delivery-sized manifest', async () => {
  const f = await storeFixture();
  // Attica's newest delivery listed 148 files in 21,733 characters of manifest
  // (2026-10-17), more than the model's 20,000-character context on its own:
  // the cut fell inside it, before the facts atoma_run_status lists after it.
  const files = Object.fromEntries(Array.from({ length: 170 }, (_, i) =>
    [`tests/attica-control-${String(i).padStart(3, '0')}-regression.test.js`, `case ${i}\n`]));
  const { run } = f.makeRun(files);
  expect(JSON.stringify(run.artifactManifest).length).toBeGreaterThan(21_733);
  const response = await f.post(f.message('What should the next run change?'));
  expect(response.status, await response.clone().text()).toBe(200);
  const shown = f.context();
  expect(shown).not.toContain('[Context truncated');
  const latest = (JSON.parse(shown.replace(/^Recorded Atoma context:\n/, '')) as { latestRun: Record<string, unknown> }).latestRun;
  expect(latest).toMatchObject({ projectRunId: run.projectRunId, status: 'delivered', awaitingClientAcceptance: true,
    clientAcceptance: null, publication: null, awaitingClientAnswer: false,
    progress: { stage: 'finished', message: 'Run delivered.' }, goal: run.goal });
  // The decisive facts come first, the goal next, the saved files last.
  const keys = Object.keys(latest);
  expect(keys.indexOf('awaitingClientAcceptance')).toBeLessThan(keys.indexOf('goal'));
  expect(keys.at(-1)).toBe('savedFiles');
  // Counts and the first paths, never the hashes.
  const saved = latest['savedFiles'] as { count: number; bytes: number; paths: string[]; pathsOmitted: number };
  expect(saved).toMatchObject({ count: 170, bytes: run.artifactManifest!.totalBytes });
  expect(saved.paths).toEqual(run.artifactManifest!.files.slice(0, saved.paths.length).map(file => file.path));
  expect(saved.paths.length + saved.pathsOmitted).toBe(170);
  expect(saved.paths.join('').length).toBeLessThanOrEqual(3_000);
  expect(shown).not.toContain(run.artifactManifest!.files[0]!.sha256);
  // Every other reader still gets the whole manifest.
  const external = await f.external();
  try {
    const status = await external.call('atoma_run_status', { projectId: f.project.projectId, runId: run.projectRunId }) as {
      artifactManifest: { files: unknown[] } };
    expect(status.artifactManifest.files).toHaveLength(170);
  } finally { await external.close(); }
});
