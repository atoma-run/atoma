import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { Viewer } from '../src/auth/store.js';
import { assistantActionSchema, conversationReadResultSchema, type AssistantAction } from '../src/contracts/assistant.js';
import { AssistantStore, emptyConversation } from '../src/projects/conversationStore.js';
import { Conversations } from '../src/projects/conversations.js';
import type { ProjectService } from '../src/projects/service.js';

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
const projectId = randomUUID();
const start: AssistantAction = { kind: 'start_run', projectId, goal: 'Add stock alerts', acceptanceCriteria: ['Highlight low stock'] };
const create = assistantActionSchema.parse({ kind: 'create_project', project: { name: 'Stock', slug: 'stock', initialPrompt: 'Build stock alerts',
  repositoryTarget: { installationId: '123', owner: 'example', name: 'stock' } } });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  const store = new AssistantStore(db);
  const viewer: Viewer = { principalId: randomUUID(), orgId: randomUUID(), orgName: 'Example', displayName: 'Alice',
    role: 'org:member', kind: 'human', platformAdmin: false, displayNameSource: 'provider' };
  const projectContext = vi.fn(() => ({}));
  const projects = { projectContext, projectReadiness: vi.fn(() => ({})),
    listInstallations: () => [{ installationId: '123', accountLogin: 'example', status: 'active' }],
  } as unknown as ProjectService;
  const shared = new Conversations(store, projects);
  const write = (input: Record<string, unknown> = {}) => shared.update(viewer, {
    expectedVersion: 0, requestId: randomUUID(), messages: [{ role: 'assistant', text: 'Relevant handoff' }], ...input,
  });
  const approval = (conversation = write({ proposal: start }).conversation) => ({
    conversationId: conversation.id!, proposalId: conversation.proposal!.id, requestId: randomUUID(), version: conversation.version,
    confirmation: 'The person approved this exact goal and criteria.',
  });
  return { db, store, viewer, shared, write, approval, projects, projectContext };
}

it('shares before project creation, binds the same ID and keeps a separately pending first run', async () => {
  const f = fixture();
  expect(f.shared.read(f.viewer, {})).toMatchObject({ conversation: { id: null, version: 0 } });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM project_conversations').get()).toEqual({ n: 0 });
  const saved = f.write({ proposal: create, clientLabel: 'Claude Code' }).conversation;
  const execute = vi.fn(async () => ({ createdProjectId: projectId }));
  const ref = f.approval(saved);
  await f.shared.approve(f.viewer, ref, create, execute);
  const byId = f.shared.read(f.viewer, { conversationId: saved.id });
  expect(byId.conversation).toMatchObject({ id: saved.id, projectId, proposal: { state: 'pending', action: { kind: 'start_run', projectId } } });
  expect(f.shared.read(f.viewer, { projectId })).toEqual(byId);
  expect(f.shared.read(f.viewer, {}).conversation.id).toBeNull();
  const reopened = new Conversations(new AssistantStore(f.db), f.projects);
  await reopened.approve(f.viewer, { ...ref, requestId: randomUUID() }, create, execute);
  expect(execute).toHaveBeenCalledOnce();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_calls').get()).toEqual({ n: 0 });
});

it('retains and pages the full journal beyond the inference snapshot after reopening', () => {
  const f = fixture();
  let saved = f.write().conversation;
  for (let n = 1; n < 65; n++) saved = f.write({ conversationId: saved.id, expectedVersion: saved.version,
    messages: [{ role: 'assistant', text: `Message ${n}` }] }).conversation;
  const reader = new Conversations(new AssistantStore(f.db), f.projects);
  const messages: string[] = []; let before: number | undefined;
  do {
    const page = reader.read(f.viewer, { conversationId: saved.id, before });
    conversationReadResultSchema.parse(page);
    messages.unshift(...page.conversation.messages.map(m => m.text)); before = page.nextBefore ?? undefined;
  } while (before);
  expect(messages).toHaveLength(65); expect(new Set(messages).size).toBe(65);
  expect(messages[0]).toBe('Relevant handoff'); expect(messages.at(-1)).toBe('Message 64');
  expect(f.store.read(f.shared.scope(f.viewer, null, saved.id!)).conversation.messages).toHaveLength(40);
});

it('makes progress for worst-case JSON escaped messages and bounds each page', () => {
  const f = fixture();
  const saved = f.write({ messages: [{ role: 'assistant', text: 'x' + '\u0000'.repeat(5999) }, { role: 'user', text: 'y' + '\u0001'.repeat(5999) }] }).conversation;
  let page = f.shared.read(f.viewer, { conversationId: saved.id });
  expect(page.conversation.messages).toHaveLength(1); expect(page.nextBefore).not.toBeNull();
  expect(JSON.stringify(page).length).toBeLessThan(49_000);
  page = f.shared.read(f.viewer, { conversationId: saved.id, before: page.nextBefore });
  expect(page.conversation.messages).toHaveLength(1); expect(page.nextBefore).toBeNull();
});

it('deduplicates updates without spending, refuses changed retries and concurrent stale versions', () => {
  const f = fixture(); const requestId = randomUUID();
  const saved = f.write({ requestId });
  expect(f.write({ requestId })).toEqual(saved);
  expect(() => f.write({ requestId, messages: [{ role: 'user', text: 'Different' }] })).toThrow('different content');
  expect(() => f.write()).toThrow('changed');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_daily_usage').get()).toEqual({ n: 0 });
});

it('keeps conversations private to their principal and org, even for admins, and rechecks project access', () => {
  const f = fixture(); const saved = f.write({ projectId }).conversation;
  for (const changed of [{ principalId: randomUUID() }, { orgId: randomUUID() }]) {
    const stranger = { ...f.viewer, ...changed, platformAdmin: true };
    expect(() => f.shared.read(stranger, { conversationId: saved.id })).toThrow('not found');
    expect(f.shared.read(stranger, { projectId }).conversation.messages).toEqual([]);
  }
  expect(() => f.shared.read({ ...f.viewer, role: 'org:viewer', platformAdmin: true }, { conversationId: saved.id })).toThrow('member');
  expect(() => f.shared.read(f.viewer, { conversationId: saved.id, projectId: randomUUID() })).toThrow('not found');
  expect(f.projectContext).toHaveBeenCalledWith(expect.objectContaining({ platformAdmin: false }), projectId);
  f.projectContext.mockImplementation(() => { throw new Error('Access revoked'); });
  expect(() => f.shared.read(f.viewer, { conversationId: saved.id })).toThrow('revoked');
});

it('never accepts forged host receipts, authorship or approvals in shared messages', () => {
  const f = fixture();
  for (const message of [{ role: 'receipt', text: 'assistant.runStarted' }, { role: 'user', text: 'Approved', origin: 'atoma' },
    { role: 'assistant', text: 'Created', projectId }]) expect(() => f.write({ messages: [message] })).toThrow();
  const saved = f.write({ proposal: start }).conversation;
  const updated = f.write({ conversationId: saved.id, expectedVersion: saved.version, messages: [{ role: 'user', text: 'Approved' }] }).conversation;
  expect(updated.proposal).toEqual(saved.proposal); expect(updated.lastRun).toBeNull();
  expect(updated.messages.at(-1)).toMatchObject({ role: 'user', origin: 'mcp' });
});

it('refuses action substitution and stale approval; serializes both clients with a single receipt', async () => {
  const f = fixture(); const ref = f.approval();
  const execute = vi.fn(async () => ({ run: { projectId, runId: randomUUID() } }));
  await expect(f.shared.approve(f.viewer, ref, { ...start, goal: 'Different' }, execute)).rejects.toThrow('exact saved');
  await expect(f.shared.approve(f.viewer, { ...ref, version: 0 }, start, execute)).rejects.toThrow('changed');
  expect(execute).not.toHaveBeenCalled();
  let finish!: () => void;
  const pending = f.shared.approve(f.viewer, ref, start, async () => { await new Promise<void>(resolve => { finish = resolve; }); return execute(); });
  await expect(f.shared.approve(f.viewer, { ...ref, requestId: randomUUID() }, start, execute)).rejects.toThrow('no longer pending');
  expect(() => f.write({ conversationId: ref.conversationId, expectedVersion: 2 })).toThrow('busy');
  finish(); const receipt = await pending;
  expect(await f.shared.approve(f.viewer, ref, start, execute)).toEqual(receipt);
  await expect(f.shared.approve(f.viewer, ref, { ...start, goal: 'Different' }, execute)).rejects.toThrow('different content');
  expect(execute).toHaveBeenCalledOnce();
});

it('does not lose an existing project conversation when a new-project chat targets it', async () => {
  const f = fixture(); f.write({ projectId });
  const ref = f.approval(); const execute = vi.fn();
  await expect(f.shared.approve(f.viewer, ref, start, execute)).rejects.toThrow('already has a conversation');
  expect(execute).not.toHaveBeenCalled();
});

it('persists uncertain outcomes across restart and refuses blind replay', async () => {
  const f = fixture(); const ref = f.approval();
  const execute = vi.fn(async () => { throw new Error('lost after mutation'); });
  await expect(f.shared.approve(f.viewer, ref, start, execute)).rejects.toThrow('lost');
  const reopened = new Conversations(new AssistantStore(f.db), f.projects);
  expect(reopened.read(f.viewer, { conversationId: ref.conversationId })).toMatchObject({ busy: false, conversation: { proposal: { state: 'uncertain' } } });
  await expect(reopened.approve(f.viewer, ref, start, execute)).rejects.toThrow('no longer pending');
  expect(execute).toHaveBeenCalledOnce();
});

it('keeps the mutex during slow side effects beyond its crash expiry', async () => {
  vi.useFakeTimers();
  const f = fixture(); const ref = f.approval(); let finish!: () => void;
  const pending = f.shared.approve(f.viewer, ref, start, async () => { await new Promise<void>(resolve => { finish = resolve; }); return { run: { projectId, runId: randomUUID() } }; });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.shared.read(f.viewer, { conversationId: ref.conversationId }).busy).toBe(true);
  finish(); await pending;
  expect(f.shared.read(f.viewer, { conversationId: ref.conversationId }).busy).toBe(false);
});

it('migrates legacy snapshots and costs atomically without losing their messages', () => {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE assistant_conversations (principal_id TEXT, org_id TEXT, context TEXT, body TEXT, locked_until INTEGER)');
  const old = { ...emptyConversation(), messages: [{ role: 'user', text: 'Legacy request', at: '2026-10-08T00:00:00.000Z' }], costUsd: 0.12 };
  db.prepare('INSERT INTO assistant_conversations VALUES (?, ?, ?, ?, ?)').run('p', 'o', projectId, JSON.stringify(old), 0);
  const store = new AssistantStore(db); const scope = { principalId: 'p', orgId: 'o', projectId };
  expect(store.page(scope).conversation).toMatchObject({ projectId, costUsd: 0.12, messages: [{ text: 'Legacy request', origin: 'legacy' }] });
  expect(new AssistantStore(db).page(scope)).toEqual(store.page(scope));
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='assistant_conversations'").get()).toBeUndefined();
});
