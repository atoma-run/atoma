import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretKey } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthStore, PROVIDER_KEY_PROVIDERS } from '../src/auth/store.js';
import { MODEL_SELECTOR_VENDORS } from '../src/contracts/modelSelector.js';
import { ChatCompletionsLlmClient } from '../src/core/llmChatCompletions.js';
import { RoutingLlmClient } from '../src/core/llmRouting.js';
import { buildTierClients, makeTransportClient } from '../src/run/providers.js';
import { analystProvider } from '../src/supervisor/session.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
afterAll(() => {
  for (const db of databases) db.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const encryption = { key: createSecretKey(Buffer.alloc(32, 7)), keyId: 'test-key' };

describe('organisation keys for every vendor', () => {
  it('holds a key for every selector vendor', () => {
    expect([...PROVIDER_KEY_PROVIDERS]).toEqual([...MODEL_SELECTOR_VENDORS]);
  });

  it('widens a store created under the four-vendor CHECK, keeping every stored envelope', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-provider-keys-'));
    roots.push(root);
    const path = join(root, 'store.db');

    // A store as the previous release left it: the old constraint, one zai key.
    const first = new Database(path);
    const store = new AuthStore(first);
    const orgId = store.completeLogin(
      { provider: 'github', subject: 'owner', displayName: 'Owner', email: null, emailVerified: false },
      null
    )!.viewer.orgId;
    store.setOrgProviderKey({ orgId, provider: 'zai', plaintext: 'sk-zai-key', encryption });
    first.exec(`
      CREATE TABLE legacy AS SELECT * FROM auth_org_provider_keys;
      DROP TABLE auth_org_provider_keys;
      CREATE TABLE auth_org_provider_keys (
        org_id       TEXT NOT NULL REFERENCES auth_organisations(org_id),
        provider     TEXT NOT NULL CHECK (provider IN ('anthropic','openai','zai','ollama')),
        envelope     TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (org_id, provider)
      );
      INSERT INTO auth_org_provider_keys SELECT * FROM legacy;
      DROP TABLE legacy;
    `);
    expect(() =>
      first.prepare("INSERT INTO auth_org_provider_keys VALUES (?, 'deepseek', 'x', 'y')").run(orgId)
    ).toThrow(/CHECK/);
    first.close();

    const reopened = new Database(path);
    databases.push(reopened);
    const upgraded = new AuthStore(reopened);
    expect(upgraded.decryptOrgProviderKey(orgId, 'zai', encryption)).toBe('sk-zai-key');
    upgraded.setOrgProviderKey({ orgId, provider: 'deepseek', plaintext: 'sk-deepseek-key', encryption });
    expect(upgraded.decryptOrgProviderKey(orgId, 'deepseek', encryption)).toBe('sk-deepseek-key');
    expect(upgraded.listOrgProviderKeys(orgId).map((row) => row.provider).sort()).toEqual(['deepseek', 'zai']);
    // Converged: a second open does not rebuild again.
    const sql = (reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'auth_org_provider_keys'").get() as { sql: string }).sql;
    new AuthStore(reopened);
    expect((reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'auth_org_provider_keys'").get() as { sql: string }).sql).toBe(sql);
  });
});

describe('the seven Chat Completions transports', () => {
  const env = {
    GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', META_API_KEY: 'm', MISTRAL_API_KEY: 'mi',
    DASHSCOPE_API_KEY: 'q', DEEPSEEK_API_KEY: 'd', MOONSHOT_API_KEY: 'k',
  };

  it('builds one client per vendor from that vendor’s key', () => {
    for (const transport of ['google-api', 'xai-api', 'meta-api', 'mistral-api', 'qwen-api', 'deepseek-api', 'moonshot-api'] as const) {
      expect(makeTransportClient(transport, { env }), transport).toBeInstanceOf(ChatCompletionsLlmClient);
    }
    expect(() => makeTransportClient('moonshot-api', { env: {} })).toThrow(/api:moonshot requires MOONSHOT_API_KEY/);
  });

  it('routes a mixed three-vendor run to three distinct transports', async () => {
    const clients = buildTierClients({
      ...env,
      ATOMA_MODEL_L1: 'api:deepseek:deepseek-flash',
      ATOMA_MODEL_L2: 'api:mistral:mistral-medium-latest',
      ATOMA_MODEL_L3: 'api:google:gemini-3.1-pro-preview',
    });
    expect(Object.keys(clients).sort()).toEqual(['deepseek-api', 'google-api', 'mistral-api']);
    const router = new RoutingLlmClient(clients);
    await expect(
      router.complete({ model: 'api:xai:grok-4.7', systemPrompt: '', userContent: '' })
    ).rejects.toThrow(/no client for transport "xai-api"/);
  });
});

describe('supervisor sessions', () => {
  it('refuses a Chat Completions vendor, which neither Claude Code nor Codex can drive', () => {
    expect(() => analystProvider({ ATOMA_ANALYST_MODEL: 'api:deepseek:deepseek-v4-pro' })).toThrow(
      /neither can be pointed at deepseek/
    );
  });
});
