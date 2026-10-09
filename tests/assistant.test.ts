import { Conversations } from '../src/projects/conversations.js';
import { conversationApprovalSchema, assistantActionSchema } from '../src/contracts/assistant.js';
import type { ProjectService } from '../src/projects/service.js';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '../src/auth/store.js';
import { AssistantGrants } from '../src/auth/assistantGrants.js';
import { assistantRequestSchema, type AssistantAction, type AssistantRequest } from '../src/contracts/assistant.js';
import { withPartialUsage } from '../src/core/metrics.js';
import type { LlmCompletionRequest, LlmCompletionResponse } from '../src/core/types.js';
import { AssistantService } from '../src/viz/assistant.js';
import { AssistantStore } from '../src/viz/assistantStore.js';
import type { AssistantMcp } from '../src/viz/assistantMcp.js';

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
const projectId = randomUUID(), runId = randomUUID();
const member = (): Viewer => ({ principalId: randomUUID(), orgId: randomUUID(), orgName: 'Example', displayName: 'Alice',
  role: 'org:member', kind: 'human', platformAdmin: false, displayNameSource: 'provider' });
const project = { name: 'Stock tracker', slug: 'stock-tracker', initialPrompt: 'Build a stock tracker',
  repositoryTarget: { installationId: '123', owner: 'example', name: 'stock-tracker', visibility: 'private' as const },
  followUpstream: false, showcase: 'listed' as const };
const start: AssistantAction = { kind: 'start_run', projectId, goal: 'Add stock alerts', acceptanceCriteria: ['Low stock items are highlighted'] };
function fixture(action: AssistantAction | null = { kind: 'create_project', project }) {
  const db = new Database(':memory:'); databases.push(db);
  const store = new AssistantStore(db);
  const viewer = member();
  const conversations = new Conversations(store, {
    projectContext: () => ({}), projectReadiness: () => ({}),
    listInstallations: () => [{ installationId: '123', accountLogin: 'example', status: 'active' }],
  } as unknown as ProjectService);
  const execute = vi.fn(async () => ({}));
  const complete = vi.fn(async (_request: LlmCompletionRequest): Promise<LlmCompletionResponse> => ({
    text: JSON.stringify({ message: 'Here is a proposal for your review.', proposal: action }),
    usage: { inputTokens: 1000, outputTokens: 100 }, stopReason: 'end_turn',
  }));
  const call = vi.fn(async (name: string, _args: Record<string, unknown>, _task?: boolean): Promise<unknown> => {
    switch (name) {
      case 'atoma_projects_list': return { projects: [{ projectId, name: 'Existing' }], nextCursor: null };
      case 'atoma_github_installations': return { installations: [{ installationId: '123', accountLogin: 'example', status: 'active' }] };
      case 'atoma_project_create': {
        await conversations.approve(viewer, conversationApprovalSchema.parse(_args['conversationApproval']),
          assistantActionSchema.parse({ kind: 'create_project', project: _args['project'] }), async () => { await execute(); return { createdProjectId: projectId }; });
        return { projectId };
      }
      case 'atoma_project_context': return { brief: { text: 'Saved project brief' } };
      case 'atoma_project_readiness': return { ready: true };
      case 'atoma_project_runs': return { runs: [{ projectRunId: runId }] };
      case 'atoma_run_status': return { projectId, projectRunId: runId, status: 'running', costUsd: 0.02, traceId: 'trace', error: null };
      case 'atoma_run_start': {
        await conversations.approve(viewer, conversationApprovalSchema.parse(_args['conversationApproval']),
          assistantActionSchema.parse({ kind: 'start_run', projectId: _args['projectId'], goal: _args['goal'], acceptanceCriteria: _args['acceptanceCriteria'] }),
          async () => { await execute(); return { run: { projectId, runId } }; });
        return { task: { taskId: `project-run:${projectId}:${runId}` } };
      }
      default: throw new Error(`Unexpected tool: ${name}`);
    }
  });
  const mcp: AssistantMcp = { call, close: async () => {} };
  const choice = { id: 'platform:api:anthropic:claude-haiku-4-5-20251001', model: 'api:anthropic:claude-haiku-4-5-20251001', label: 'Haiku', payer: 'host-key' as const };
  const service = new AssistantService(store, { choices: async () => [choice], subscriptions: async () => [], resolve: async () => ({ choice, llm: { complete } }) });
  const scope = service.scope(viewer, null);
  const message = (text = 'Build a stock tracker'): AssistantRequest => ({ kind: 'message', requestId: randomUUID(),
    version: store.read(scope).conversation.version, projectId: null, text });
  const confirm = (): AssistantRequest => {
    scope.conversationId = store.read(scope).conversation.id!;
    return { kind: 'confirm', requestId: randomUUID(), version: store.read(scope).conversation.version,
      projectId: null, proposalId: store.read(scope).conversation.proposal!.id };
  };
  return { db, store, service, scope, complete, call, mcp, viewer, message, confirm, execute };
}

describe('the integrated assistant', () => {
  it('prepares, creates, and starts through separate explicit confirmations, using MCP tasks', async () => {
    const f = fixture();
    await f.service.request(f.scope, f.message(), f.mcp);
    expect(f.call.mock.calls.every(([name]) => !['atoma_project_create', 'atoma_run_start'].includes(name))).toBe(true);
    expect(f.store.read(f.scope).conversation.proposal?.state).toBe('pending');
    const create = f.confirm();
    await f.service.request(f.scope, create, f.mcp);
    await f.service.request(f.scope, create, f.mcp); // a lost HTTP response / double click
    expect(f.call.mock.calls.filter(([name]) => name === 'atoma_project_create')).toHaveLength(1);
    expect(f.call.mock.calls.filter(([name]) => name === 'atoma_run_start')).toHaveLength(0);
    const run = f.confirm();
    const id = f.store.read(f.scope).conversation.proposal!.id;
    await f.service.request(f.scope, run, f.mcp);
    await f.service.request(f.scope, run, f.mcp);
    expect(f.call).toHaveBeenCalledWith('atoma_run_start', expect.objectContaining({ projectId, goal: project.initialPrompt, idempotencyKey: `assistant:${id}` }), true);
    expect(f.call.mock.calls.filter(([name]) => name === 'atoma_run_start')).toHaveLength(1);
    expect((await f.service.view(f.scope, f.mcp)).run).toMatchObject({ status: 'running', costUsd: 0.02 });
    expect(f.complete).toHaveBeenCalledTimes(1); // no model call for approval or tracking
  });

  it('uses the saved brief and latest run as context, and carries the approved criteria verbatim', async () => {
    const f = fixture(start);
    const scope = f.service.scope(f.viewer, projectId);
    const message = { ...f.message(), projectId };
    await f.service.request(scope, message, f.mcp);
    expect(f.complete.mock.calls[0]![0].userContent).toContain('Saved project brief');
    expect(f.call).toHaveBeenCalledWith('atoma_run_status', { projectId, runId });
    const saved = f.store.read(scope).conversation;
    await f.service.request(scope, { kind: 'confirm', requestId: randomUUID(), version: saved.version, projectId, proposalId: saved.proposal!.id }, f.mcp);
    expect(f.call).toHaveBeenCalledWith('atoma_run_start', expect.objectContaining({ acceptanceCriteria: start.acceptanceCriteria }), true);
  });

  it('limits selected-project context to its own catalogue entry, brief and runs', async () => {
    const f = fixture(start);
    const otherId = randomUUID();
    const call = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args, task) => name === 'atoma_projects_list'
      ? { projects: [{ projectId, name: 'Stock tracker', repositoryUrl: 'https://github.com/example/stock-tracker' },
        { projectId: otherId, name: 'Minesweeper', repositoryUrl: 'https://github.com/example/minesweeper' }], nextCursor: 'foreign-catalogue-cursor' }
      : call(name, args, task));
    const scope = f.service.scope(f.viewer, projectId);
    await f.service.request(scope, { ...f.message(), projectId }, f.mcp);
    const { userContent, systemPrompt } = f.complete.mock.calls[0]![0];
    expect(userContent).toContain('Stock tracker');
    expect(userContent).toContain('https://github.com/example/stock-tracker');
    expect(userContent).toContain('Saved project brief');
    expect(userContent).toContain(runId);
    for (const foreign of [otherId, 'Minesweeper', 'example/minesweeper', 'foreign-catalogue-cursor']) {
      expect(userContent).not.toContain(foreign);
    }
    expect(f.call).not.toHaveBeenCalledWith('atoma_github_installations', {});
    expect(systemPrompt).toContain(`exclusively to project ${projectId}`);
    expect(f.store.read(scope).conversation.proposal?.projectName).toBe('Stock tracker');
  });

  it('names a selected project beyond the first catalogue page, by following its cursor', async () => {
    const f = fixture(start);
    const otherId = randomUUID();
    const call = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (name, args, task) => {
      if (name !== 'atoma_projects_list') return call(name, args, task);
      if (args['cursor'] === undefined) {
        return { projects: [{ projectId: otherId, name: 'Minesweeper', repositoryUrl: 'https://github.com/example/minesweeper' }], nextCursor: 'page-2' };
      }
      return args['cursor'] === 'page-2'
        ? { projects: [{ projectId, name: 'Stock tracker', repositoryUrl: 'https://github.com/example/stock-tracker' }], nextCursor: null }
        : { projects: [], nextCursor: null };
    });
    const scope = f.service.scope(f.viewer, projectId);
    await f.service.request(scope, { ...f.message(), projectId }, f.mcp);
    const { userContent } = f.complete.mock.calls[0]![0];
    expect(userContent).toContain('Stock tracker');
    expect(userContent).toContain('https://github.com/example/stock-tracker');
    for (const foreign of [otherId, 'Minesweeper', 'page-2']) expect(userContent).not.toContain(foreign);
    expect(f.store.read(scope).conversation.proposal?.projectName).toBe('Stock tracker');
  });

  it('invalidates old proposals after a new message and refuses caller-authored action arguments', async () => {
    const f = fixture();
    await f.service.request(f.scope, f.message(), f.mcp);
    const old = f.confirm();
    await f.service.request(f.scope, f.message('Change the requirements'), f.mcp);
    await expect(f.service.request(f.scope, old, f.mcp)).rejects.toThrow('no longer pending');
    expect(assistantRequestSchema.safeParse({ ...f.confirm(), action: { kind: 'start_run' } }).success).toBe(false);
    expect(f.call.mock.calls.some(([name]) => name === 'atoma_project_create')).toBe(false);
  });

  it('isolates conversations by both principal and organisation, including platform admins', async () => {
    const f = fixture();
    await f.service.request(f.scope, f.message(), f.mcp);
    for (const changed of [{ principalId: randomUUID() }, { orgId: randomUUID() }]) {
      expect(f.store.read({ ...f.scope, ...changed }).conversation.messages).toEqual([]);
    }
    expect(() => f.service.scope({ ...f.viewer, role: 'org:viewer', platformAdmin: true }, null)).toThrow('member');
  });

  it('deduplicates inference and refuses stale versions from another browser tab', async () => {
    const f = fixture();
    const first = f.message();
    await f.service.request(f.scope, first, f.mcp);
    await f.service.request(f.scope, first, f.mcp);
    await expect(f.service.request(f.scope, { ...first, requestId: randomUUID() }, f.mcp)).rejects.toThrow('changed');
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it('serialises calls across project conversations and persists locks across instances', () => {
    const f = fixture();
    f.store.claim(f.scope, 0, randomUUID(), true);
    const reopened = new AssistantStore(f.db);
    expect(() => reopened.claim(f.scope, 1, randomUUID(), true)).toThrow('busy');
    expect(() => reopened.claim({ ...f.scope, projectId }, 0, randomUUID(), true)).toThrow('Another conversation');
  });

  it('does not let recycled request IDs bypass accounting across turns or projects', async () => {
    const f = fixture();
    const first = f.message();
    await f.service.request(f.scope, first, f.mcp);
    await f.service.request(f.scope, f.message('Another turn'), f.mcp);
    await expect(f.service.request(f.scope, { ...f.message(), requestId: first.requestId }, f.mcp)).rejects.toThrow('already processed');
    const selected = f.service.scope(f.viewer, projectId);
    await expect(f.service.request(selected, { ...first, projectId }, f.mcp)).rejects.toThrow('already processed');
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM assistant_calls').get()).toEqual({ count: 2 });
  });

  it('records spend when MCP context gathering crosses UTC midnight', () => {
    const f = fixture();
    const store = new AssistantStore(f.db, () => Date.parse('2026-10-08T23:59:59Z'));
    const requestId = randomUUID();
    store.claim(f.scope, 0, requestId, true);
    const receipt = { requestId, at: '2026-10-09T00:00:01Z', cost: 0.01, model: 'test', servedModel: 'test', usage: {}, failed: false };
    store.recordCost(f.scope, receipt);
    store.recordCost(f.scope, receipt);
    expect(f.db.prepare('SELECT day, calls, cost_usd FROM assistant_daily_usage ORDER BY day').all()).toEqual([
      { day: '2026-10-08', calls: 1, cost_usd: 0 }, { day: '2026-10-09', calls: 0, cost_usd: 0.01 },
    ]);
  });

  it('never repeats a project creation with an uncertain transport outcome', async () => {
    const f = fixture();
    await f.service.request(f.scope, f.message(), f.mcp);
    f.execute.mockRejectedValue(new Error('connection lost after commit'));
    const request = f.confirm();
    await expect(f.service.request(f.scope, request, f.mcp)).rejects.toThrow('could not be confirmed');
    expect(f.store.read(f.scope).conversation.proposal?.state).toBe('uncertain');
    await expect(f.service.request(f.scope, request, f.mcp)).rejects.toThrow('no longer pending');
    await expect(f.service.request(f.scope, f.confirm(), f.mcp)).rejects.toThrow('no longer pending');
    expect(f.call.mock.calls.filter(([name]) => name === 'atoma_project_create')).toHaveLength(1);
  });

  it('refuses model proposals targeting an unrelated installation or selected project', async () => {
    const f = fixture({ kind: 'create_project', project: { ...project, repositoryTarget: { ...project.repositoryTarget, owner: 'intruder' } } });
    await expect(f.service.request(f.scope, f.message(), f.mcp)).rejects.toThrow('destination');
    expect(f.store.read(f.scope).conversation.proposal).toBeNull();
    const g = fixture({ ...start, projectId: randomUUID() });
    const scope = g.service.scope(g.viewer, projectId);
    await expect(g.service.request(scope, { ...g.message(), projectId }, g.mcp)).rejects.toThrow('selected project');
  });

  it('records failed partial usage and never exposes provider error text', async () => {
    const f = fixture();
    f.complete.mockRejectedValue(withPartialUsage(new Error('secret provider credential'), { inputTokens: 200, outputTokens: 20 }));
    await expect(f.service.request(f.scope, f.message(), f.mcp)).rejects.toThrow('could not answer');
    const saved = f.store.read(f.scope);
    expect(saved.busy).toBe(false);
    expect(saved.conversation.costUsd).toBeGreaterThan(0);
    expect(saved.conversation.inputTokens).toBe(200);
    expect(JSON.stringify(saved)).not.toContain('secret');
    expect(f.db.prepare('SELECT failed, model FROM assistant_calls').get()).toMatchObject({ failed: 1 });
  });

  it('records served-model accounting even when model output is invalid', async () => {
    const f = fixture();
    f.complete.mockResolvedValue({ text: '{not json', stopReason: 'max_tokens', usage: { inputTokens: 1000, outputTokens: 100 },
      servedModel: 'claude-haiku-4-5-20251001' });
    await expect(f.service.request(f.scope, f.message(), f.mcp)).rejects.toThrow('invalid proposal');
    expect(f.db.prepare('SELECT served_model, cost_usd FROM assistant_calls').get()).toMatchObject({ served_model: 'claude-haiku-4-5-20251001', cost_usd: expect.any(Number) });
    expect(f.store.read(f.scope).conversation.proposal).toBeNull();
  });

  it('bounds inference with a deadline and daily limits without starting work', async () => {
    const f = fixture();
    await f.service.request(f.scope, f.message(), f.mcp);
    expect(f.complete.mock.calls[0]![0].executor).toBeUndefined();
    expect(f.complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    f.db.prepare('UPDATE assistant_daily_usage SET calls=100').run();
    await expect(f.service.request(f.scope, f.message('another'), f.mcp)).rejects.toThrow('Daily');
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it('migrates historical platform costs without charging them to a customer payer', () => {
    const db = new Database(':memory:'); databases.push(db);
    const at = new Date().toISOString();
    db.exec(`CREATE TABLE assistant_daily_usage (principal_id TEXT, org_id TEXT, day TEXT, calls INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
      PRIMARY KEY(principal_id, org_id, day));
      CREATE TABLE assistant_calls (principal_id TEXT, org_id TEXT, request_id TEXT, created_at TEXT, model TEXT, served_model TEXT,
      usage_json TEXT, cost_usd REAL, failed INTEGER, PRIMARY KEY(principal_id, org_id, request_id));`);
    db.prepare('INSERT INTO assistant_daily_usage VALUES (?, ?, ?, 1, 3)').run('alice', 'org', at.slice(0, 10));
    db.prepare("INSERT INTO assistant_calls VALUES ('alice', 'org', 'old', ?, 'old-model', 'old-model', '{}', 3, 0)").run(at);
    const store = new AssistantStore(db);
    const scope = { principalId: 'alice', orgId: 'org', projectId: null };
    expect(db.prepare('SELECT payer FROM assistant_calls').get()).toEqual({ payer: 'host-key' });
    expect(() => store.claim(scope, 0, randomUUID(), 'host-key')).toThrow('Daily');
    const claimed = store.claim(scope, 0, randomUUID(), 'principal-subscription')!;
    store.save(scope, claimed);
    new AssistantStore(db);
    expect(db.prepare('SELECT cost_usd, platform_cost_usd FROM assistant_daily_usage').get()).toEqual({ cost_usd: 3, platform_cost_usd: 3 });
  });

  it('records customer payers and keeps their API-equivalent usage outside the platform dollar cap', () => {
    const f = fixture();
    const today = new Date().toISOString();
    for (const payer of ['org-key', 'principal-subscription'] as const) {
      const requestId = randomUUID();
      const current = f.store.read(f.scope).conversation;
      const claimed = f.store.claim(f.scope, current.version, requestId, payer)!;
      expect(f.store.hasActiveRequestForPrincipal(f.scope.principalId)).toBe(true);
      f.store.recordCost(f.scope, { requestId, at: today, cost: 3, model: 'selected', servedModel: 'served', usage: {}, failed: false, payer });
      f.store.save(f.scope, claimed);
    }
    expect(f.db.prepare('SELECT cost_usd, platform_cost_usd FROM assistant_daily_usage').get()).toEqual({ cost_usd: 6, platform_cost_usd: 0 });
    expect(f.db.prepare('SELECT payer FROM assistant_calls ORDER BY rowid').all()).toEqual([{ payer: 'org-key' }, { payer: 'principal-subscription' }]);
    const claimed = f.store.claim(f.scope, 2, randomUUID(), 'host-key')!;
    f.store.save(f.scope, claimed);
    f.db.prepare('UPDATE assistant_daily_usage SET platform_cost_usd=2').run();
    expect(() => f.store.claim(f.scope, 3, randomUUID(), 'host-key')).toThrow('Daily');
    expect(f.store.claim(f.scope, 3, randomUUID(), 'org-key')).not.toBeNull();
  });

  it('keeps completed conversation state after reopening the store', async () => {
    const f = fixture();
    await f.service.request(f.scope, f.message(), f.mcp);
    expect(new AssistantStore(f.db).read(f.scope)).toEqual(f.store.read(f.scope));
  });


});

describe('server-only assistant MCP grants', () => {
  it('attenuates administrators and rechecks session, organisation, membership, expiry and release', () => {
    let now = 100;
    let viewer: Viewer | null = { ...member(), platformAdmin: true, role: 'org:owner' };
    const original = viewer;
    const grants = new AssistantGrants(() => now);
    const grant = grants.issue(() => viewer);
    expect(grants.resolve(grant.token)?.viewer).toMatchObject({ role: 'org:member', platformAdmin: false });
    viewer = { ...original, orgId: randomUUID() }; expect(grants.resolve(grant.token)).toBeNull();
    viewer = { ...original, role: 'org:viewer' }; expect(grants.resolve(grant.token)).toBeNull();
    viewer = null; expect(grants.resolve(grant.token)).toBeNull();
    viewer = original; expect(grants.resolve(grant.token)).not.toBeNull();
    now += 90_000; expect(grants.resolve(grant.token)).toBeNull();
    const next = grants.issue(() => viewer); next.release(); expect(grants.resolve(next.token)).toBeNull();
  });
});
