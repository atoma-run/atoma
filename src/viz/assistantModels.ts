import type { AuthStore } from '../auth/store.js';
import type { AccountSubscriptionService } from '../auth/subscriptionProfiles.js';
import type { AssistantModelChoice } from '../contracts/assistant.js';
import type { AccountSubscriptionStatus } from '../contracts/accountSubscriptions.js';
import { assertPersonalCodexModels, CODEX_MODEL_CAPABILITIES_ENV } from '../contracts/codexModels.js';
import { transportOf, tryParseModelSelector, type ModelSelectorVendor } from '../contracts/modelSelector.js';
import { PERSONAL_CODEX_PROFILE_ROOT_ENV } from '../core/codexHomeLease.js';
import { RoutingLlmClient } from '../core/llmRouting.js';
import { LLM_PROVIDER_CATALOG, PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY, findProvider } from '../core/providerCatalog.js';
import type { LlmClient } from '../core/types.js';
import { hostRunTitleConfig } from '../projects/runTitle.js';
import { makeTransportClient } from '../run/providers.js';
import { AssistantConflict, type AssistantScope } from './assistantStore.js';

export interface AssistantModel { choice: AssistantModelChoice; llm: LlmClient }
export interface AssistantModels {
  choices(scope: AssistantScope): Promise<AssistantModelChoice[]>;
  subscriptions(scope: AssistantScope): Promise<AccountSubscriptionStatus[]>;
  resolve(scope: AssistantScope, id: string): Promise<AssistantModel>;
}
interface Options {
  host: NodeJS.ProcessEnv;
  auth: Pick<AuthStore, 'listOrgProviderKeys'>;
  subscriptions: Pick<AccountSubscriptionService, 'codexProfileForRun' | 'claudeProfileForRun' | 'codexModels' | 'status'> | null;
  orgKey(orgId: string, vendor: ModelSelectorVendor): string | null;
  active(principalId: string): boolean;
  transport?: typeof makeTransportClient;
}
const unavailable = () => new AssistantConflict('The selected assistant connection or model is unavailable. Check Settings or choose another connection. No other account was charged.');
const operatingKeys = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'CI',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'] as const;

/** Selection fixes BOTH model and payer. Credentials are re-resolved on every message. */
export class ConnectedAssistantModels implements AssistantModels {
  constructor(private readonly options: Options) {}

  async subscriptions(scope: AssistantScope): Promise<AccountSubscriptionStatus[]> {
    if (!this.options.subscriptions) return [];
    const { claude, codex } = await this.options.subscriptions.status(scope.principalId, { verify: false });
    return [claude, codex];
  }

  private platform() {
    return hostRunTitleConfig({ ...this.options.host,
      ATOMA_MODEL_L1: this.options.host['ATOMA_ASSISTANT_MODEL'] ?? this.options.host['ATOMA_MODEL_L1'] });
  }

  async choices(scope: AssistantScope): Promise<AssistantModelChoice[]> {
    const choices: AssistantModelChoice[] = [];
    const subscriptions = this.options.subscriptions;
    if (subscriptions?.codexProfileForRun(scope.principalId)) {
      const inventory = await subscriptions.codexModels(scope.principalId, false, this.options.active(scope.principalId));
      if (inventory.state === 'ready') for (const entry of inventory.models) {
        const model = `own:openai:${entry.id}`;
        choices.push({ id: model, model, label: `ChatGPT · ${entry.label}`, payer: 'principal-subscription' });
      }
    }
    if (subscriptions?.claudeProfileForRun(scope.principalId)) {
      for (const entry of PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY.models) {
        const model = `own:anthropic:${entry.id}`;
        choices.push({ id: model, model, label: `Claude · ${entry.label} (beta)`, payer: 'principal-subscription' });
      }
    }
    const vendors = new Set(this.options.auth.listOrgProviderKeys(scope.orgId).map(key => key.provider));
    for (const provider of LLM_PROVIDER_CATALOG) {
      if (!provider.credentialEnvVar || !vendors.has(provider.id)) continue;
      for (const entry of provider.models) {
        const model = `${provider.selectorPrefix}:${entry.id}`;
        choices.push({ id: model, model, label: `${provider.label} · ${entry.label}`, payer: 'org-key' });
      }
    }
    const platform = this.platform();
    if (!('unavailable' in platform)) choices.push({ id: `platform:${platform.model}`, model: platform.model, label: platform.model, payer: 'host-key' });
    return choices;
  }

  async resolve(scope: AssistantScope, id: string): Promise<AssistantModel> {
    let choice: AssistantModelChoice;
    let env: NodeJS.ProcessEnv = {};
    if (id === 'platform' || id.startsWith('platform:')) {
      const platform = this.platform();
      if ('unavailable' in platform || (id !== 'platform' && id !== `platform:${platform.model}`)) throw unavailable();
      choice = { id: `platform:${platform.model}`, model: platform.model, label: platform.model, payer: 'host-key' };
      env = platform.env;
    } else {
      const selector = tryParseModelSelector(id);
      if (!selector || selector.mode === 'sub') throw unavailable();
      const provider = findProvider(selector.vendor)!;
      if (selector.mode === 'api') {
        if (!provider.credentialEnvVar || !provider.models.some(entry => entry.id === selector.model)) throw unavailable();
        const key = this.options.orgKey(scope.orgId, selector.vendor);
        if (!key?.trim()) throw unavailable();
        // A customer's key goes only to its issuer, never the host's gateway.
        env[provider.credentialEnvVar] = key;
        env[provider.baseUrlEnvVar] = provider.defaultBaseUrl;
        choice = { id, model: id, label: `${provider.label} · ${selector.model}`, payer: 'org-key' };
      } else {
        for (const key of operatingKeys) if (this.options.host[key]) env[key] = this.options.host[key];
        const subscriptions = this.options.subscriptions;
        if (selector.vendor === 'openai') {
          const profile = subscriptions?.codexProfileForRun(scope.principalId);
          if (!profile) throw unavailable();
          const inventory = await subscriptions!.codexModels(scope.principalId, true);
          // Discovery may await a provider process: a concurrent logout/re-login invalidates its result.
          if (subscriptions!.codexProfileForRun(scope.principalId)?.profileId !== profile.profileId) throw unavailable();
          try { assertPersonalCodexModels([id], inventory); } catch { throw unavailable(); }
          env['CODEX_HOME'] = profile.homePath;
          env['CODEX_SQLITE_HOME'] = profile.homePath;
          env[PERSONAL_CODEX_PROFILE_ROOT_ENV] = profile.profilesRoot;
          env[CODEX_MODEL_CAPABILITIES_ENV] = JSON.stringify(inventory.models);
        } else if (selector.vendor === 'anthropic') {
          const profile = subscriptions?.claudeProfileForRun(scope.principalId);
          if (!profile || !PRINCIPAL_CLAUDE_SUBSCRIPTION_FAMILY.models.some(entry => entry.id === selector.model)) throw unavailable();
          env['CLAUDE_CODE_OAUTH_TOKEN'] = profile.oauthToken;
          env['CLAUDE_CONFIG_DIR'] = profile.homePath;
        } else throw unavailable();
        choice = { id, model: id, label: id, payer: 'principal-subscription' };
      }
    }
    const transport = transportOf(tryParseModelSelector(choice.model)!);
    return { choice, llm: new RoutingLlmClient({ [transport]: (this.options.transport ?? makeTransportClient)(transport, { env }) }) };
  }
}
