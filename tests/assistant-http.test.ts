import { EXAMPLE_ACCOUNT_SUBSCRIPTIONS } from '../src/contracts/accountSubscriptions.js';
import { ConnectedAssistantModels } from '../src/viz/assistantModels.js';
import type { makeTransportClient } from '../src/run/providers.js';
import { TASKS_EXTENSION } from '../src/mcp/taskWire.js';
import { conversationReadResultSchema } from '../src/contracts/assistant.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import { Conversations } from '../src/projects/conversations.js';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantGrants } from '../src/auth/assistantGrants.js';
import type { Viewer } from '../src/auth/store.js';
import type { AssistantRequest, AssistantView } from '../src/contracts/assistant.js';
import { McpHttpHost } from '../src/mcp/http.js';
import { mcpHostWiring } from '../src/mcp/server.js';
import type { ProjectService } from '../src/projects/service.js';
import type { ProjectStore } from '../src/projects/store.js';
import { AssistantService } from '../src/viz/assistant.js';
import { assistantHttp } from '../src/viz/assistantHttp.js';
import { connectAssistantMcp } from '../src/viz/assistantMcp.js';
import { AssistantStore } from '../src/viz/assistantStore.js';

const servers: Server[] = [], hosts: McpHttpHost[] = [], databases: Database.Database[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  databases.splice(0).forEach(db => db.close());
});

async function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  const viewer: Viewer = { principalId: randomUUID(), orgId: randomUUID(), role: 'org:owner', platformAdmin: true,
    displayName: 'Alice', orgName: 'A', kind: 'human', displayNameSource: 'provider' };
  let session: Viewer | null = viewer;
  const projectId = randomUUID(), runId = randomUUID();
  const grants = new AssistantGrants();
  const run = { projectId, projectRunId: runId, orgId: viewer.orgId, requestedByPrincipalId: viewer.principalId,
    status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null };
  const start = vi.fn(async () => run);
  const create = vi.fn(async () => ({ projectId }));
  const projectService = {
    createProjectFromInput: create,
    projectPage: vi.fn((caller: Viewer) => {
      expect(caller.platformAdmin).toBe(false); expect(caller.orgId).toBe(viewer.orgId);
      return { projects: [{ projectId, name: 'Stock tracker' }], nextCursor: null };
    }),
    listInstallations: () => [{ installationId: '123', accountLogin: 'example', status: 'active' }],
    projectContext: () => ({ context: { projectId, version: 0, brief: null, decisions: [], change: null }, history: [], nextBeforeVersion: null }),
    projectReadiness: () => ({ ready: true }),
    projectRunsPage: () => ({ runs: [], nextCursor: null }),
    startProjectRunFromInput: start, runTaskBudgetMs: () => 60_000,
    projectRunStatus: () => run, projectRunState: () => run,
    runsRequestedBy: () => [run],
  } as unknown as ProjectService;
  const complete = vi.fn(async (_request?: LlmCompletionRequest) => ({ text: JSON.stringify({ message: 'Review this goal.',
    proposal: { kind: 'start_run', projectId, goal: 'Build stock alerts', acceptanceCriteria: [] } }),
    stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 100 } }));
  const store = new AssistantStore(db);
  const conversations = new Conversations(store, projectService);
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
    }, ...mcpHostWiring({ conversations, projects: { service: projectService, store: {} as ProjectStore }, auth: null, journal: null, operatorRuns: false }),
  }); hosts.push(mcp);
  const post = (input: AssistantRequest, headers: Record<string, string> = {}) => fetch(`${url}/api/assistant`, {
    method: 'POST', headers: { cookie: 'session=test', origin: url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  const message: AssistantRequest = { kind: 'message', version: 0, projectId: null, text: 'Build stock alerts', requestId: randomUUID() };
  return { db, store, models, transport, orgKey, subscriptions, url, viewer, projectId, runId, complete, start, create, message, post,
    external: () => connectAssistantMcp(new URL(`${url}/mcp`), 'atoma.test', 'external-test'), setSession: (value: Viewer | null) => { session = value; } };
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
