import { EXAMPLE_ACCOUNT_SUBSCRIPTIONS } from '../src/contracts/accountSubscriptions.js';
import { describe, expect, it, vi } from 'vitest';
import type { CodexModelInventory } from '../src/contracts/codexModels.js';
import { LLM_PROVIDER_CATALOG } from '../src/core/providerCatalog.js';
import type { LlmCompletionResponse } from '../src/core/types.js';
import type { makeTransportClient } from '../src/run/providers.js';
import { ConnectedAssistantModels } from '../src/viz/assistantModels.js';

const scope = { principalId: 'alice', orgId: 'organisation-a', projectId: null };
function fixture() {
  const host = { PATH: '/bin', HOME: '/host', ATOMA_ASSISTANT_MODEL: 'api:openai:gpt-5.6-luna',
    OPENAI_API_KEY: 'host-api', OPENAI_BASE_URL: 'https://host-gateway.invalid', ANTHROPIC_API_KEY: 'host-anthropic',
    CLAUDE_CODE_OAUTH_TOKEN: 'host-claude', ATOMA_CLAUDE_MODEL: 'opus', CLAUDE_CONFIG_DIR: '/host/claude', CODEX_HOME: '/host/codex' };
  const codex = { profileId: 'generation-a', homePath: '/private/alice/codex/generation-a', profilesRoot: '/private' };
  const claude = { profileId: 'generation-c', homePath: '/private/alice/claude/generation-c', profilesRoot: '/private', oauthToken: 'alice-claude' };
  const inventory: CodexModelInventory = { state: 'ready', checkedAt: new Date().toISOString(), models: [{ id: 'future-model', label: 'Future model',
    isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium'] }] };
  const subscriptions = {
    status: vi.fn(async () => EXAMPLE_ACCOUNT_SUBSCRIPTIONS),
    codexProfileForRun: vi.fn((principal: string) => principal === 'alice' ? codex : null),
    claudeProfileForRun: vi.fn((principal: string) => principal === 'alice' ? claude : null),
    codexModels: vi.fn(async (_principal: string, _refresh?: boolean, _cached?: boolean) => inventory),
  };
  const orgKey = vi.fn((org: string) => org === scope.orgId ? 'organisation-api' : null);
  const complete = vi.fn(async (): Promise<LlmCompletionResponse> => ({ text: '{}', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' }));
  const transport = vi.fn<typeof makeTransportClient>(() => ({ complete }));
  const active = vi.fn(() => false);
  const auth = { listOrgProviderKeys: vi.fn(() => [{ provider: 'openai' as const, configuredAt: new Date().toISOString() }]) };
  const models = new ConnectedAssistantModels({ host, auth, subscriptions, orgKey, transport, active });
  return { host, codex, claude, inventory, subscriptions, orgKey, transport, complete, active, models };
}

describe('assistant customer connections', () => {
  it('reports local connection states without verifying accounts or exposing device codes', async () => {
    const f = fixture();
    const states = await f.models.subscriptions(scope);
    expect(states).toEqual([EXAMPLE_ACCOUNT_SUBSCRIPTIONS.claude, EXAMPLE_ACCOUNT_SUBSCRIPTIONS.codex]);
    expect(f.subscriptions.status).toHaveBeenCalledWith(scope.principalId, { verify: false });
    expect(f.subscriptions.codexModels).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('offers public models and payer attribution without exposing any credential or profile', async () => {
    const f = fixture();
    const choices = await f.models.choices(scope);
    expect(choices).toContainEqual(expect.objectContaining({ id: 'own:openai:future-model', payer: 'principal-subscription' }));
    expect(choices).toContainEqual(expect.objectContaining({ id: 'own:anthropic:haiku', payer: 'principal-subscription' }));
    expect(choices).toContainEqual(expect.objectContaining({ payer: 'org-key' }));
    expect(choices).toContainEqual(expect.objectContaining({ payer: 'host-key' }));
    for (const secret of ['host-api', 'organisation-api', 'alice-claude', '/private', 'host-gateway']) expect(JSON.stringify(choices)).not.toContain(secret);
    expect(f.transport).not.toHaveBeenCalled();
    f.active.mockReturnValue(true);
    await f.models.choices(scope);
    expect(f.subscriptions.codexModels).toHaveBeenLastCalledWith('alice', false, true);
  });

  it('works without a host API and routes the selected customer API only to its issuer', async () => {
    const f = fixture();
    f.host.OPENAI_API_KEY = '';
    const selected = (await f.models.choices(scope)).find(choice => choice.payer === 'org-key')!;
    const model = await f.models.resolve(scope, selected.id);
    expect(model.choice.payer).toBe('org-key');
    expect(f.orgKey).toHaveBeenCalledWith(scope.orgId, 'openai');
    expect(f.transport).toHaveBeenCalledWith('openai-api', { env: { OPENAI_API_KEY: 'organisation-api', OPENAI_BASE_URL: 'https://api.openai.com/v1' } });
    await model.llm.complete({ model: model.choice.model, systemPrompt: 'system', userContent: 'message', params: { maxTokens: 20 } });
    expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ model: selected.model.split(':').slice(2).join(':') }));
  });

  it('never falls back to host credentials after revocation, wrong organisation or an unknown model', async () => {
    const f = fixture();
    const selected = (await f.models.choices(scope)).find(choice => choice.payer === 'org-key')!;
    await expect(f.models.resolve({ ...scope, orgId: 'organisation-b' }, selected.id)).rejects.toThrow('unavailable');
    f.orgKey.mockReturnValue(null);
    await expect(f.models.resolve(scope, selected.id)).rejects.toThrow('unavailable');
    await expect(f.models.resolve(scope, 'api:openai:invented-model')).rejects.toThrow('unavailable');
    await expect(f.models.resolve(scope, 'sub:anthropic:haiku')).rejects.toThrow('unavailable');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('uses the principal’s exact Codex generation and fresh discovered model capabilities', async () => {
    const f = fixture();
    const result = await f.models.resolve(scope, 'own:openai:future-model');
    expect(result.choice.payer).toBe('principal-subscription');
    expect(f.subscriptions.codexModels).toHaveBeenCalledWith('alice', true);
    expect(f.transport).toHaveBeenCalledWith('codex-cli', { env: {
      PATH: '/bin', HOME: '/host', CODEX_HOME: f.codex.homePath, CODEX_SQLITE_HOME: f.codex.homePath,
      ATOMA_PERSONAL_CODEX_PROFILE_ROOT: '/private', ATOMA_CODEX_MODEL_CAPABILITIES: JSON.stringify(f.inventory.models),
    } });
    await expect(f.models.resolve({ ...scope, principalId: 'bob' }, 'own:openai:future-model')).rejects.toThrow('unavailable');
    await expect(f.models.resolve(scope, 'own:openai:retired-model')).rejects.toThrow('unavailable');
    f.inventory.state = 'stale';
    await expect(f.models.resolve(scope, 'own:openai:future-model')).rejects.toThrow('unavailable');
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('refuses a Codex profile replaced while discovery was in progress', async () => {
    const f = fixture();
    f.subscriptions.codexModels.mockImplementation(async () => {
      f.subscriptions.codexProfileForRun.mockReturnValue({ ...f.codex, profileId: 'new-generation' });
      return f.inventory;
    });
    await expect(f.models.resolve(scope, 'own:openai:future-model')).rejects.toThrow('unavailable');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('uses the personal Claude token and config directory without host overrides or keys', async () => {
    const f = fixture();
    await f.models.resolve(scope, 'own:anthropic:haiku');
    expect(f.transport).toHaveBeenCalledWith('claude-cli', { env: { PATH: '/bin', HOME: '/host',
      CLAUDE_CODE_OAUTH_TOKEN: 'alice-claude', CLAUDE_CONFIG_DIR: f.claude.homePath } });
    f.subscriptions.claudeProfileForRun.mockReturnValue(null);
    await expect(f.models.resolve(scope, 'own:anthropic:haiku')).rejects.toThrow('unavailable');
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicitly selected platform API separate from the same vendor’s organisation key', async () => {
    const f = fixture();
    const choice = (await f.models.choices(scope)).find(entry => entry.payer === 'host-key')!;
    await f.models.resolve(scope, choice.id);
    expect(f.transport).toHaveBeenCalledWith('openai-api', { env: { OPENAI_API_KEY: 'host-api', OPENAI_BASE_URL: 'https://host-gateway.invalid' } });
    expect(f.orgKey).not.toHaveBeenCalled();
    f.host.ATOMA_ASSISTANT_MODEL = 'sub:openai:future-model';
    await expect(f.models.resolve(scope, choice.id)).rejects.toThrow('unavailable');
  });

  it('forwards each configured organisation credential under the catalogue’s variable only', async () => {
    for (const provider of LLM_PROVIDER_CATALOG) {
      if (!provider.credentialEnvVar || !provider.models.length) continue;
      const f = fixture();
      await f.models.resolve(scope, `${provider.selectorPrefix}:${provider.models[0]!.id}`);
      expect(f.transport.mock.calls[0]![1]?.env).toEqual({ [provider.credentialEnvVar]: 'organisation-api', [provider.baseUrlEnvVar]: provider.defaultBaseUrl });
    }
  });
});
