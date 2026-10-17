import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Viewer } from '../src/auth/store.js';
import { assistantActionSchema, assistantReplySchema, assistantRequestSchema, canonicalAction, conversationReadResultSchema,
  conversationWriteSchema, type AssistantAction } from '../src/contracts/assistant.js';
import { ProjectHttpError } from '../src/projects/service.js';
import { AssistantStore, emptyConversation, SHARED_WRITES_PER_DAY } from '../src/projects/conversationStore.js';
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
  const checkReadRuns = vi.fn((_viewer: Viewer, _projectId: string, _runIds: readonly string[]) => {});
  const projects = { projectContext, projectReadiness: vi.fn(() => ({})), checkReadRuns,
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
  return { db, store, viewer, shared, write, approval, projects, projectContext, checkReadRuns };
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

it('admits a bounded number of shared writes per principal, organisation and UTC day', () => {
  const f = fixture();
  let clock = Date.parse('2026-10-09T08:00:00.000Z');
  const shared = new Conversations(new AssistantStore(f.db, () => clock), f.projects);
  const journal = () => (f.db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get() as { n: number }).n;
  let saved = shared.update(f.viewer, { expectedVersion: 0, requestId: randomUUID(), messages: [{ role: 'user', text: 'x' }] }).conversation;
  const next = (viewer = f.viewer, requestId: string = randomUUID()) => shared.update(viewer, {
    conversationId: viewer === f.viewer ? saved.id : undefined, expectedVersion: viewer === f.viewer ? saved.version : 0,
    requestId, messages: [{ role: 'user', text: 'x' }],
  });
  let last: string = randomUUID();
  for (let n = 1; n < SHARED_WRITES_PER_DAY; n++) { last = randomUUID(); saved = next(f.viewer, last).conversation; }
  expect(journal()).toBe(SHARED_WRITES_PER_DAY);
  // A retry of an admitted write is not a new write.
  expect(shared.update(f.viewer, { conversationId: saved.id, expectedVersion: saved.version - 1, requestId: last,
    messages: [{ role: 'user', text: 'x' }] }).conversation.version).toBe(saved.version);
  expect(() => next()).toThrow('Daily shared-message limit reached');
  expect(journal()).toBe(SHARED_WRITES_PER_DAY);
  expect(shared.read(f.viewer, { conversationId: saved.id }).conversation.version).toBe(saved.version);
  // Another principal keeps its own allowance.
  next({ ...f.viewer, principalId: randomUUID() });
  clock += 24 * 3600_000;
  saved = next().conversation;
  expect(journal()).toBe(SHARED_WRITES_PER_DAY + 2);
  // Model attempts are a separate counter: shared writes never spend them.
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

it('reads back a saved start\'s read runs, and its receipt, by spelling: a later cap never makes them unreadable', async () => {
  const f = fixture();
  const ids = Array.from({ length: 4 }, () => randomUUID()).sort();
  const saved = f.write({ proposal: start }).conversation;
  // Four ids, one more than a writer may propose today: what a saved row holds if the cap is ever lowered.
  const body = JSON.parse((f.db.prepare('SELECT body FROM project_conversations WHERE id=?').get(saved.id) as { body: string }).body);
  body.proposal.action.readRunIds = ids;
  f.db.prepare('UPDATE project_conversations SET body=? WHERE id=?').run(JSON.stringify(body), saved.id);
  const page = f.shared.read(f.viewer, { conversationId: saved.id });
  expect(conversationReadResultSchema.parse(page).conversation.proposal?.action).toEqual({ ...start, readRunIds: ids });
  const scope = f.shared.scope(f.viewer, null, saved.id!);
  const receiptId = randomUUID();
  f.db.prepare('INSERT INTO conversation_approvals VALUES (?, ?, ?, ?)').run(saved.id, receiptId, JSON.stringify({ ...start, readRunIds: ids }), '{}');
  expect(f.store.approval(scope, receiptId)?.action).toEqual({ ...start, readRunIds: ids });
  // Restated without them, the start is refused before anything is claimed, and stays pending.
  const execute = vi.fn(async () => ({ run: { projectId, runId: randomUUID() } }));
  await expect(f.shared.approve(f.viewer, f.approval(saved), start, execute)).rejects.toThrow('restate its readRunIds unchanged');
  expect(execute).not.toHaveBeenCalled();
  expect(f.shared.read(f.viewer, { conversationId: saved.id }).conversation).toMatchObject({ version: saved.version, proposal: { state: 'pending' } });
});

it('saves a shared proposal\'s read runs sorted once the project accepts them, and checks them again before the claim', async () => {
  const f = fixture();
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort() as [string, string, string];
  // One to three distinct runs, as atoma_run_start takes them.
  for (const readRunIds of [[], [a, a], [a, b, c, randomUUID()], ['not-a-run']]) {
    expect(() => f.write({ proposal: { ...start, readRunIds } })).toThrow();
  }
  // The project refuses a run it could not give the run: nothing is saved.
  f.checkReadRuns.mockImplementationOnce(() => { throw new ProjectHttpError(409, 'A read run must be a retained delivered or partial run of this project'); });
  expect(() => f.write({ proposal: { ...start, readRunIds: [c] } })).toThrow('retained delivered or partial run');
  expect(f.shared.read(f.viewer, {}).conversation).toMatchObject({ id: null, version: 0, proposal: null });
  const saved = f.write({ proposal: { ...start, readRunIds: [b, a] } }).conversation;
  expect(saved.proposal?.action).toEqual({ ...start, readRunIds: [a, b] });
  expect(f.checkReadRuns).toHaveBeenLastCalledWith(expect.objectContaining({ platformAdmin: false }), projectId, [a, b]);
  const execute = vi.fn(async () => ({ run: { projectId, runId: randomUUID() } }));
  const ref = f.approval(saved);
  // An omitted, added or different list is refused before the claim; the proposal stays pending.
  for (const readRunIds of [undefined, [a, b, c], [a, c]]) {
    await expect(f.shared.approve(f.viewer, { ...ref, requestId: randomUUID() }, { ...start, readRunIds }, execute))
      .rejects.toThrow('Confirm the exact saved proposal: restate its readRunIds unchanged.');
  }
  // A cap exceeded, or a run expired, since the proposal was saved: refused before the claim too.
  f.checkReadRuns.mockImplementationOnce(() => { throw new ProjectHttpError(409, 'The read runs hold 70000000 saved bytes together'); });
  await expect(f.shared.approve(f.viewer, ref, { ...start, readRunIds: [b, a] }, execute)).rejects.toThrow('saved bytes together');
  expect(execute).not.toHaveBeenCalled();
  expect(f.shared.read(f.viewer, { conversationId: saved.id }).conversation).toMatchObject({ version: saved.version, proposal: { state: 'pending' } });
  // In another order it is the same list.
  const receipt = await f.shared.approve(f.viewer, { ...ref, requestId: randomUUID() }, { ...start, readRunIds: [b, a] }, execute);
  expect(execute).toHaveBeenCalledOnce();
  expect(f.checkReadRuns).toHaveBeenLastCalledWith(expect.objectContaining({ platformAdmin: false }), projectId, [a, b]);
  expect(f.db.prepare('SELECT action FROM conversation_approvals').get()).toEqual({ action: JSON.stringify({ ...start, readRunIds: [a, b] }) });
  expect(await f.shared.approve(f.viewer, ref, { ...start, readRunIds: [a, b] }, execute)).toEqual(receipt);
  await expect(f.shared.approve(f.viewer, ref, start, execute)).rejects.toThrow('different content');
});

it('approves a start without read runs restated with an explicit undefined, and replays its receipt', async () => {
  const f = fixture(); const ref = f.approval();
  const restated = { ...start, readRunIds: undefined };
  // Zod keeps the explicit key, and isDeepStrictEqual tells it from an absent one: the canonical form drops it.
  expect(Object.hasOwn(assistantActionSchema.parse(restated), 'readRunIds')).toBe(true);
  const execute = vi.fn(async () => ({ run: { projectId, runId: randomUUID() } }));
  const receipt = await f.shared.approve(f.viewer, ref, restated, execute);
  expect(execute).toHaveBeenCalledOnce();
  expect(await f.shared.approve(f.viewer, ref, start, execute)).toEqual(receipt);
  expect(await f.shared.approve(f.viewer, ref, restated, execute)).toEqual(receipt);
  expect(execute).toHaveBeenCalledOnce();
});

it('gives read runs one canonical form, outside the schemas that render as JSON Schema', () => {
  const [a, b] = [randomUUID(), randomUUID()].sort() as [string, string];
  expect(canonicalAction({ ...start, readRunIds: [b, a] })).toEqual({ ...start, readRunIds: [a, b] });
  for (const none of [[], undefined]) expect(Object.hasOwn(canonicalAction({ ...start, readRunIds: none as string[] }), 'readRunIds')).toBe(false);
  expect(canonicalAction(create)).toBe(create);
  // The SDK renders an outputSchema in output mode, where a transform throws; the model reads the input mode.
  for (const io of ['input', 'output'] as const) {
    for (const schema of [z.looseObject(conversationReadResultSchema.shape), conversationWriteSchema, assistantReplySchema]) {
      expect(JSON.stringify(z.toJSONSchema(schema, { io }))).toContain('"readRunIds"');
    }
  }
  expect(assistantReplySchema.safeParse({ message: 'Proposal', proposal: { ...start, readRunIds: [b, a] } }).success).toBe(true);
  // The confirmation may echo the read runs its card displayed: one to three distinct run ids.
  const confirm = { kind: 'confirm', requestId: randomUUID(), version: 1, projectId, proposalId: randomUUID() };
  expect(assistantRequestSchema.safeParse(confirm).success).toBe(true);
  expect(assistantRequestSchema.safeParse({ ...confirm, readRunIds: [b, a] }).success).toBe(true);
  for (const echo of [[], [a, a], ['not-a-run'], [a, b, randomUUID(), randomUUID()]]) {
    expect(assistantRequestSchema.safeParse({ ...confirm, readRunIds: echo }).success).toBe(false);
  }
});
