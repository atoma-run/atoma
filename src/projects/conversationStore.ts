import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { assistantActionSchema, assistantConversationSchema, assistantMessageSchema, conversationReceiptSchema, type AssistantPayer, type AssistantConversation, type AssistantAction, type ConversationReceipt } from '../contracts/assistant.js';
import { openStoreHandle } from '../core/stores.js';

const DDL = `CREATE TABLE IF NOT EXISTS project_conversations (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT,
  body TEXT NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS project_conversation_scope ON project_conversations(principal_id, org_id, IFNULL(project_id, 'new'));
CREATE TABLE IF NOT EXISTS conversation_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_message_page ON conversation_messages(conversation_id, sequence);
CREATE TABLE IF NOT EXISTS conversation_requests (
  principal_id TEXT NOT NULL, org_id TEXT NOT NULL, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, PRIMARY KEY(principal_id, org_id, request_id)
);
CREATE TABLE IF NOT EXISTS conversation_approvals (
  conversation_id TEXT NOT NULL, proposal_id TEXT NOT NULL, action TEXT NOT NULL, receipt TEXT NOT NULL,
  PRIMARY KEY(conversation_id, proposal_id)
);
CREATE TABLE IF NOT EXISTS assistant_daily_usage (
  principal_id TEXT NOT NULL, org_id TEXT NOT NULL, day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_id, org_id, day)
);
CREATE TABLE IF NOT EXISTS assistant_calls (
  principal_id TEXT NOT NULL, org_id TEXT NOT NULL, request_id TEXT NOT NULL,
  created_at TEXT NOT NULL, model TEXT NOT NULL, served_model TEXT NOT NULL,
  usage_json TEXT NOT NULL, cost_usd REAL NOT NULL, failed INTEGER NOT NULL,
  PRIMARY KEY (principal_id, org_id, request_id)
);`;
export interface AssistantScope { principalId: string; orgId: string; projectId: string | null; conversationId?: string }
export const emptyConversation = (projectId: string | null = null): AssistantConversation => ({ id: null, projectId, version: 0, messages: [], proposal: null,
  lastRun: null, costUsd: 0, inputTokens: 0, outputTokens: 0, lastRequestId: null });

export class AssistantConflict extends Error {}

/** Bounded conversation snapshots, in the primary product DB, never in a second store. */
export class AssistantStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(DDL);
    db.transaction(() => {
      const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
      if (!columns('assistant_calls').includes('payer')) db.exec("ALTER TABLE assistant_calls ADD COLUMN payer TEXT NOT NULL DEFAULT 'host-key'");
      if (!columns('assistant_daily_usage').includes('platform_cost_usd')) {
        db.exec('ALTER TABLE assistant_daily_usage ADD COLUMN platform_cost_usd REAL NOT NULL DEFAULT 0');
        db.exec('UPDATE assistant_daily_usage SET platform_cost_usd=cost_usd');
      }
    }).immediate();
    // Preserve the first assistant's snapshots. A read never migrates or merges histories.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_conversations'").get()) {
      db.transaction(() => {
        const rows = db.prepare('SELECT * FROM assistant_conversations').all() as Array<{ principal_id: string; org_id: string; context: string; body: string; locked_until: number }>;
        for (const row of rows) {
          const conversation = assistantConversationSchema.parse(JSON.parse(row.body));
          conversation.id = randomUUID(); conversation.projectId = row.context === 'new' ? null : row.context;
          this.persistMessages(conversation);
          db.prepare('INSERT INTO project_conversations VALUES (?, ?, ?, ?, ?, ?)').run(conversation.id, row.principal_id, row.org_id,
            conversation.projectId, JSON.stringify(conversation), row.locked_until);
        }
        db.exec('DROP TABLE assistant_conversations');
      }).immediate();
    }
  }
  static open(path: string): AssistantStore { return new AssistantStore(openStoreHandle(path, DDL)); }

  read(scope: AssistantScope): { conversation: AssistantConversation; busy: boolean } {
    const row = (scope.conversationId
      ? this.db.prepare('SELECT body, locked_until FROM project_conversations WHERE principal_id=? AND org_id=? AND id=?')
        .get(scope.principalId, scope.orgId, scope.conversationId)
      : this.db.prepare('SELECT body, locked_until FROM project_conversations WHERE principal_id=? AND org_id=? AND project_id IS ?')
        .get(scope.principalId, scope.orgId, scope.projectId)) as { body: string; locked_until: number } | undefined;
    if (scope.conversationId && !row) throw new AssistantConflict('Conversation not found.');
    const conversation = row ? assistantConversationSchema.parse(JSON.parse(row.body)) : emptyConversation(scope.projectId);
    if (scope.projectId && conversation.projectId !== scope.projectId) throw new AssistantConflict('Conversation not found.');
    return { conversation,
      busy: (row?.locked_until ?? 0) > this.now() };
  }

  claim(scope: AssistantScope, version: number, requestId: string, spend: boolean | AssistantPayer, fingerprint = ''): AssistantConversation | null {
    return this.db.transaction(() => {
      const current = this.read(scope);
      if (current.busy) throw new AssistantConflict('The conversation is busy. Wait for the current request.');
      const prior = this.db.prepare('SELECT conversation_id, fingerprint FROM conversation_requests WHERE principal_id=? AND org_id=? AND request_id=?')
        .get(scope.principalId, scope.orgId, requestId) as { conversation_id: string; fingerprint: string } | undefined;
      if (prior) {
        if (prior.conversation_id !== current.conversation.id || prior.fingerprint !== fingerprint) throw new AssistantConflict('This request was already processed with different content.');
        return null;
      }
      if (current.conversation.lastRequestId === requestId) return null;
      if (current.conversation.version !== version) throw new AssistantConflict('The conversation changed. Refresh before continuing.');
      if (this.db.prepare('SELECT 1 FROM assistant_calls WHERE principal_id=? AND org_id=? AND request_id=?')
        .get(scope.principalId, scope.orgId, requestId)) {
        throw new AssistantConflict('This request was already processed. Refresh before continuing.');
      }
      const active = this.db.prepare('SELECT principal_id, org_id FROM project_conversations WHERE locked_until > ?')
        .all(this.now()) as Array<{ principal_id: string; org_id: string }>;
      if (active.some(row => row.principal_id === scope.principalId && row.org_id === scope.orgId)) {
        throw new AssistantConflict('Another conversation is busy. Wait for it to finish.');
      }
      if (active.length >= 8) throw new AssistantConflict('The assistant is busy. Please try again shortly.');
      if (spend) {
        const day = new Date(this.now()).toISOString().slice(0, 10);
        this.db.prepare('INSERT OR IGNORE INTO assistant_daily_usage (principal_id, org_id, day) VALUES (?, ?, ?)')
          .run(scope.principalId, scope.orgId, day);
        const usage = this.db.prepare('SELECT calls, platform_cost_usd FROM assistant_daily_usage WHERE principal_id=? AND org_id=? AND day=?')
          .get(scope.principalId, scope.orgId, day) as { calls: number; platform_cost_usd: number };
        if (usage.calls >= 100 || ((spend === true || spend === 'host-key') && usage.platform_cost_usd >= 2)) throw new AssistantConflict('Daily conversation limit reached. Your runs are unaffected.');
        this.db.prepare('UPDATE assistant_daily_usage SET calls=calls+1 WHERE principal_id=? AND org_id=? AND day=?')
          .run(scope.principalId, scope.orgId, day);
      }
      // The version advances BEFORE remote work; a crashed request cannot be replayed as a fresh turn.
      const next = { ...current.conversation, id: current.conversation.id ?? randomUUID(), version: version + 1, lastRequestId: requestId };
      this.db.prepare(`INSERT INTO project_conversations VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET body=excluded.body, locked_until=excluded.locked_until`)
        .run(next.id, scope.principalId, scope.orgId, next.projectId, JSON.stringify(next), this.now() + 90_000);
      this.db.prepare('INSERT INTO conversation_requests VALUES (?, ?, ?, ?, ?)')
        .run(scope.principalId, scope.orgId, requestId, next.id, fingerprint);
      return next;
    }).immediate();
  }

  save(scope: AssistantScope, conversation: AssistantConversation, release = true): void {
    this.db.transaction(() => {
      this.persistMessages(conversation);
      conversation.messages = conversation.messages.slice(-40);
      const body = JSON.stringify(assistantConversationSchema.parse(conversation));
      const updated = this.db.prepare(`UPDATE project_conversations SET body=?, project_id=?, locked_until=CASE WHEN ? THEN 0 ELSE locked_until END
        WHERE principal_id=? AND org_id=? AND id=? AND json_extract(body, '$.version')=?`)
        .run(body, conversation.projectId, release ? 1 : 0, scope.principalId, scope.orgId, conversation.id, conversation.version);
      if (!updated.changes) throw new AssistantConflict('The conversation changed. Refresh before continuing.');
    }).immediate();
  }

  keepAlive(scope: AssistantScope, conversation: AssistantConversation): void {
    this.db.prepare(`UPDATE project_conversations SET locked_until=?
      WHERE principal_id=? AND org_id=? AND id=? AND json_extract(body, '$.version')=? AND locked_until>0`)
      .run(this.now() + 90_000, scope.principalId, scope.orgId, conversation.id, conversation.version);
  }

  private persistMessages(conversation: AssistantConversation): void {
    for (const message of conversation.messages) {
      message.id ??= randomUUID(); message.origin ??= 'legacy';
      this.db.prepare('INSERT OR IGNORE INTO conversation_messages (conversation_id, message_id, body) VALUES (?, ?, ?)')
        .run(conversation.id, message.id, JSON.stringify(assistantMessageSchema.parse(message)));
    }
  }

  page(scope: AssistantScope, before?: number, limit = 10) {
    const { conversation, busy } = this.read(scope);
    const rows = conversation.id ? this.db.prepare(`SELECT sequence, body FROM conversation_messages
      WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?`).all(conversation.id, before ?? Number.MAX_SAFE_INTEGER, Math.min(20, limit) + 1) as Array<{ sequence: number; body: string }> : [];
    let chars = 0;
    const page: typeof rows = [];
    for (const row of rows) {
      if (page.length === limit || chars + row.body.length > 48_000) break;
      page.push(row); chars += row.body.length;
    }
    const nextBefore = rows.length > page.length ? page.at(-1)!.sequence : null;
    return { conversation: { ...conversation, messages: page.reverse().map(row => assistantMessageSchema.parse(JSON.parse(row.body))) }, busy, nextBefore, untrusted: true as const };
  }

  approval(scope: AssistantScope, proposalId: string): { action: AssistantAction; receipt: ConversationReceipt } | null {
    const id = this.read(scope).conversation.id;
    const row = this.db.prepare('SELECT action, receipt FROM conversation_approvals WHERE conversation_id=? AND proposal_id=?')
      .get(id, proposalId) as { action: string; receipt: string } | undefined;
    return row ? { action: assistantActionSchema.parse(JSON.parse(row.action)), receipt: conversationReceiptSchema.parse(JSON.parse(row.receipt)) } : null;
  }

  finishApproval(scope: AssistantScope, conversation: AssistantConversation, proposalId: string, action: AssistantAction, receipt: ConversationReceipt): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO conversation_approvals VALUES (?, ?, ?, ?)')
        .run(conversation.id, proposalId, JSON.stringify(action), JSON.stringify(conversationReceiptSchema.parse(receipt)));
      this.save(scope, conversation);
    }).immediate();
  }

  hasActiveRequestForPrincipal(principalId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM project_conversations WHERE principal_id=? AND locked_until>? LIMIT 1').get(principalId, this.now()));
  }

  recordCost(scope: AssistantScope, input: { cost: number; at: string; requestId: string; model: string;
    servedModel: string; usage: object; failed: boolean; payer?: AssistantPayer }): void {
    this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO assistant_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(scope.principalId, scope.orgId, input.requestId, input.at, input.model, input.servedModel,
          JSON.stringify(input.usage), input.cost, input.failed ? 1 : 0, input.payer ?? 'host-key');
      if (inserted.changes) this.db.prepare(`INSERT INTO assistant_daily_usage (principal_id, org_id, day, cost_usd, platform_cost_usd) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (principal_id, org_id, day) DO UPDATE SET cost_usd=assistant_daily_usage.cost_usd+excluded.cost_usd,
          platform_cost_usd=assistant_daily_usage.platform_cost_usd+excluded.platform_cost_usd`)
        .run(scope.principalId, scope.orgId, input.at.slice(0, 10), input.cost, !input.payer || input.payer === 'host-key' ? input.cost : 0);
    }).immediate();
  }
}
