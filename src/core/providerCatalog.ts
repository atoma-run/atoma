import {
  formatModelSelector,
  tryParseModelSelector,
  type ModelSelector,
  type ModelSelectorVendor,
  type TierNumber,
} from '../contracts/modelSelector.js';
import {
  CHATGPT_SUBSCRIPTION_MODELS,
  RETIRED_CHATGPT_SUBSCRIPTION_MODELS,
  HOST_SUBSCRIPTION_ALIASES,
} from '../contracts/runPayers.js';
import { ZAI_DEFAULT_BASE_URL } from '../contracts/modelSelector.js';
import { offeredCatalogModels } from './modelCatalog.js';

/** Gemini API's OpenAI-compatible endpoint (an AI Studio key, not Vertex AI). */
export const GOOGLE_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * THE VENDOR/MODEL CATALOGUE FOR TENANT SELECTION.
 * =================================================
 *
 * One static description of every vendor a deployment may route a run to by
 * API, and the models each offers, read by three consumers that must not
 * drift: the settings-write validators (`contracts/tierModels.ts`), the run
 * environment builder (`projects/coordinator.ts`), and the GL client's
 * Settings selectors.
 *
 * Every offered choice is a full selector (`contracts/modelSelector.ts`):
 * a catalogue entry offers `api:<vendor>:<model>`, and the subscription
 * FAMILIES below offer `sub:` and `own:` spellings of the two vendors whose
 * CLI atoma can drive. The picker renders `${selectorPrefix}:${model.id}` and
 * nothing else builds a selector by hand.
 *
 * The lists are EXTENDED BY DESIGN (owner decision 2026-08-27): every
 * generation a vendor still serves, so an organisation can standardise on an
 * older cheaper model if it wants. They are DATA since 2026-09-27: the model
 * lists and their prices live in `core/modelCatalog.json` and change through
 * `npm run models`; what stays here is what a vendor IS — its credential,
 * endpoint, wire protocol and listing URL. There is no second copy of either.
 *
 * The Ollama entries are SUGGESTIONS, not an inventory: that vendor is
 * self-hosted, so what actually resolves depends on the deployment pulling
 * the tags. The listed tags keep it selectable without free text, and stay
 * honest about their role through `suggestive: true`.
 *
 * THE SUBSCRIPTIONS ARE NEIGHBOURS, NOT MEMBERS (design 2026-08-28, D4).
 * `HOST_SUBSCRIPTION_FAMILIES` are offered by the account picker beside this
 * catalogue and are deliberately not entries, because three mechanisms read
 * `LLM_PROVIDER_CATALOG` as "things that may hold a key": `orgProviderIsReady`
 * returns TRUE for any entry whose `credentialEnvVar` is null, so a
 * subscription row would read as always-ready to every viewer — the exact
 * inverse of a per-requester offer; `resolveOrgProviderKeys` passes
 * `provider.id` into a `ProviderKeyProvider` parameter, mirrored by the
 * `CHECK (provider IN (…))` constraint on `auth_org_provider_keys`; and
 * `injectOrgProviderKeys` iterates the same array.
 */

export interface ProviderModelEntry {
  /** The vendor's model id — the third selector segment. */
  readonly id: string;
  /** Human label rendered by the Settings pickers. */
  readonly label: string;
  /** Tiers this model may serve; absent means every tier. */
  readonly tiers?: readonly TierNumber[];
}

/** The wire protocol a vendor's `api:` transport speaks. */
export type ProviderWire = 'anthropic-messages' | 'openai-responses' | 'chat-completions' | 'ollama';

export interface LlmProviderEntry {
  readonly id: ModelSelectorVendor;
  readonly label: string;
  /** What the picker prepends to a model id to form the stored selector. */
  readonly selectorPrefix: `api:${ModelSelectorVendor}`;
  /**
   * The credential the run child needs, when one exists. `null` means the
   * vendor needs no secret (self-hosted Ollama); such a vendor is always
   * considered configured for an organisation.
   */
  readonly credentialEnvVar: string | null;
  /** Additional tuning variables a deployment may set alongside the key. */
  readonly configurableEnvVars: readonly string[];
  /** True when the model list reflects a live remote inventory we cannot enumerate statically. */
  readonly suggestive: boolean;
  readonly wire: ProviderWire;
  /** The variable that overrides the endpoint, and the endpoint when it is unset. */
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
  /**
   * Where the vendor lists the models it serves today, read by
   * `npm run models -- check --live`. Null when there is no listing atoma can
   * read with the credential it holds.
   */
  readonly modelListing: {
    readonly url: string;
    readonly auth: 'bearer' | 'anthropic';
  } | null;
  readonly models: readonly ProviderModelEntry[];
}

/**
 * The catalogue's offered models of one vendor, as picker entries. Evaluated
 * when the process loads, like the prices: a model retired on a later day
 * leaves the pickers at the first deploy after that day.
 */
function offeredModels(vendor: ModelSelectorVendor): readonly ProviderModelEntry[] {
  return offeredCatalogModels(vendor).map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.tiers ? { tiers: model.tiers } : {}),
  }));
}

/**
 * One OpenAI-compatible Chat Completions vendor: its key, its endpoint and
 * its listing, all under one base URL. `wire` is what `run/providers.ts`
 * switches on; the per-vendor protocol differences live beside the client
 * (`core/llmChatCompletions.ts`).
 */
function chatCompletionsVendor(input: {
  readonly id: ModelSelectorVendor;
  readonly label: string;
  readonly credentialEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
}): LlmProviderEntry {
  return {
    id: input.id,
    label: input.label,
    selectorPrefix: `api:${input.id}`,
    credentialEnvVar: input.credentialEnvVar,
    configurableEnvVars: [input.baseUrlEnvVar],
    suggestive: false,
    wire: 'chat-completions',
    baseUrlEnvVar: input.baseUrlEnvVar,
    defaultBaseUrl: input.defaultBaseUrl,
    modelListing: { url: `${input.defaultBaseUrl.replace(/\/+$/, '')}/models`, auth: 'bearer' },
    models: offeredModels(input.id),
  };
}

export const LLM_PROVIDER_CATALOG: readonly LlmProviderEntry[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    selectorPrefix: 'api:anthropic',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    // ANTHROPIC_AUTH_TOKEN is deliberately absent: the bearer slot has no
    // place to be supplied from in this product, and project runs refuse it
    // (see src/projects/AGENTS.md). Local operator runs still honour it
    // through the SDK's own chain in src/run/auth.ts.
    configurableEnvVars: ['ANTHROPIC_BASE_URL'],
    suggestive: false,
    wire: 'anthropic-messages',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelListing: { url: 'https://api.anthropic.com/v1/models?limit=1000', auth: 'anthropic' },
    models: offeredModels('anthropic'),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    selectorPrefix: 'api:openai',
    credentialEnvVar: 'OPENAI_API_KEY',
    configurableEnvVars: ['OPENAI_BASE_URL'],
    suggestive: false,
    wire: 'openai-responses',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    modelListing: { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
    models: offeredModels('openai'),
  },
  chatCompletionsVendor({
    id: 'google',
    label: 'Google DeepMind',
    credentialEnvVar: 'GEMINI_API_KEY',
    baseUrlEnvVar: 'GEMINI_BASE_URL',
    defaultBaseUrl: GOOGLE_DEFAULT_BASE_URL,
  }),
  chatCompletionsVendor({
    id: 'xai',
    label: 'xAI',
    credentialEnvVar: 'XAI_API_KEY',
    baseUrlEnvVar: 'XAI_BASE_URL',
    defaultBaseUrl: 'https://api.x.ai/v1',
  }),
  // Meta's Model API. Its docs name the key MODEL_API_KEY; a name that generic
  // collides with everything, so atoma reads it under the vendor's name.
  chatCompletionsVendor({
    id: 'meta',
    label: 'Meta',
    credentialEnvVar: 'META_API_KEY',
    baseUrlEnvVar: 'META_BASE_URL',
    defaultBaseUrl: 'https://api.meta.ai/v1',
  }),
  chatCompletionsVendor({
    id: 'mistral',
    label: 'Mistral AI',
    credentialEnvVar: 'MISTRAL_API_KEY',
    baseUrlEnvVar: 'MISTRAL_BASE_URL',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
  }),
  // Model Studio, International (Singapore). Alibaba now issues per-workspace
  // hosts (`https://<workspace>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`)
  // and asks new integrations to use them; the shared host below still
  // answers, and DASHSCOPE_BASE_URL selects a workspace host.
  chatCompletionsVendor({
    id: 'qwen',
    label: 'Alibaba Qwen',
    credentialEnvVar: 'DASHSCOPE_API_KEY',
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  }),
  chatCompletionsVendor({
    id: 'deepseek',
    label: 'DeepSeek',
    credentialEnvVar: 'DEEPSEEK_API_KEY',
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
  }),
  chatCompletionsVendor({
    id: 'moonshot',
    label: 'Moonshot AI (Kimi)',
    credentialEnvVar: 'MOONSHOT_API_KEY',
    baseUrlEnvVar: 'MOONSHOT_BASE_URL',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
  }),
  {
    id: 'zai',
    label: 'Z.ai',
    selectorPrefix: 'api:zai',
    credentialEnvVar: 'ZAI_API_KEY',
    configurableEnvVars: ['ZAI_BASE_URL'],
    suggestive: false,
    wire: 'anthropic-messages',
    baseUrlEnvVar: 'ZAI_BASE_URL',
    defaultBaseUrl: ZAI_DEFAULT_BASE_URL,
    // The Anthropic-compatible endpoint lists nothing; the platform's own
    // OpenAI-compatible API does, under the same key.
    modelListing: { url: 'https://api.z.ai/api/paas/v4/models', auth: 'bearer' },
    models: offeredModels('zai'),
  },
  {
    id: 'ollama',
    label: 'Ollama',
    selectorPrefix: 'api:ollama',
    credentialEnvVar: null,
    configurableEnvVars: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'],
    suggestive: true,
    wire: 'ollama',
    baseUrlEnvVar: 'OLLAMA_BASE_URL',
    defaultBaseUrl: 'http://localhost:11434',
    // Self-hosted: what resolves is whatever the deployment pulled.
    modelListing: null,
    models: offeredModels('ollama'),
  },
] as const;

export interface SubscriptionFamily {
  /** The selector prefix the picker prepends: `sub:<vendor>` or `own:<vendor>`. */
  readonly id: `sub:${ModelSelectorVendor}` | `own:${ModelSelectorVendor}`;
  readonly selectorPrefix: `sub:${ModelSelectorVendor}` | `own:${ModelSelectorVendor}`;
  readonly label: string;
  readonly credentialEnvVar: null;
  readonly suggestive: false;
  readonly models: readonly ProviderModelEntry[];
}

/**
 * The host's own Claude Code login, offered per tier to a platform admin on a
 * deployment that declares it. Shaped like a catalogue entry so one picker can
 * render both, and typed separately so nothing that iterates the catalogue can
 * reach it. Its "models" are the ALIASES the transport serves — a subscription
 * resolves whatever generation Claude Code gives it that day, so a dated id
 * here would be a promise the transport cannot keep (design 2026-08-28, Q2).
 */
export const HOST_SUBSCRIPTION_FAMILY: SubscriptionFamily = {
  id: 'sub:anthropic',
  selectorPrefix: 'sub:anthropic',
  label: 'Claude (host subscription)',
  credentialEnvVar: null,
  suggestive: false,
  models: HOST_SUBSCRIPTION_ALIASES.map((alias) => ({ id: alias, label: aliasLabel(alias) })),
};

/** The operator's ChatGPT subscription, routed through the local Codex CLI. */
export const CHATGPT_SUBSCRIPTION_FAMILY: SubscriptionFamily = {
  id: 'sub:openai',
  selectorPrefix: 'sub:openai',
  label: 'ChatGPT (host subscription)',
  credentialEnvVar: null,
  suggestive: false,
  models: CHATGPT_SUBSCRIPTION_MODELS.map((model) => ({
    id: model,
    label: modelLabel(model),
    tiers: [1, 2, 3],
  })),
};

/** The signed-in requester's own ChatGPT subscription. Account-only. */
export const PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY: SubscriptionFamily = {
  id: 'own:openai',
  selectorPrefix: 'own:openai',
  label: 'ChatGPT (your subscription)',
  credentialEnvVar: null,
  suggestive: false,
  models: [],
};

/** Every machine-bound family offered beside (never inside) the key catalogue. */
export const HOST_SUBSCRIPTION_FAMILIES: readonly SubscriptionFamily[] = [
  HOST_SUBSCRIPTION_FAMILY,
  CHATGPT_SUBSCRIPTION_FAMILY,
];

function aliasLabel(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1);
}

function modelLabel(model: string): string {
  const match = /^gpt-(\d+(?:\.\d+)?)-(.+)$/.exec(model);
  return match ? `GPT-${match[1]} ${aliasLabel(match[2]!)}` : model;
}

/** Every selectable vendor id, e.g. handed to the routing tables. */
export function llmProviderIds(): readonly LlmProviderEntry['id'][] {
  return LLM_PROVIDER_CATALOG.map((provider) => provider.id);
}

export function findProvider(vendor: string): LlmProviderEntry | undefined {
  return LLM_PROVIDER_CATALOG.find((provider) => provider.id === vendor);
}

/**
 * A billed vendor is ready only with a stored org key. Self-hosted vendors
 * (credentialEnvVar null) are always ready.
 */
export function orgProviderIsReady(
  provider: { readonly id: string; readonly credentialEnvVar: string | null },
  configuredProviderIds: ReadonlySet<string>
): boolean {
  if (provider.credentialEnvVar === null) return true;
  return configuredProviderIds.has(provider.id);
}

/** True when the org has stored at least one billed-vendor key. */
export function orgHasBilledProviderKey(configuredProviderIds: ReadonlySet<string>): boolean {
  return LLM_PROVIDER_CATALOG.some(
    (provider) => provider.credentialEnvVar !== null && configuredProviderIds.has(provider.id)
  );
}

/**
 * Is `value` an `api:` selection the catalogue offers? The ORG level's whole
 * value space: an org default is inherited by every member, so it may name a
 * key-billed choice and nothing that spends a login.
 */
export function isValidTierModelSelection(value: string): boolean {
  const selector = tryParseModelSelector(value);
  if (!selector || selector.mode !== 'api') return false;
  const provider = findProvider(selector.vendor);
  return provider !== undefined && provider.models.some((model) => model.id === selector.model);
}

/** The family a `sub:`/`own:` selector belongs to, when it names an offered model on that tier. */
function subscriptionFamilyOf(
  selector: ModelSelector,
  tier?: TierNumber
): SubscriptionFamily | null {
  const family = [
    HOST_SUBSCRIPTION_FAMILY,
    CHATGPT_SUBSCRIPTION_FAMILY,
    PRINCIPAL_CHATGPT_SUBSCRIPTION_FAMILY,
  ].find((candidate) => candidate.selectorPrefix === `${selector.mode}:${selector.vendor}`);
  if (!family) return null;
  if (selector.mode === 'own' && selector.vendor === 'openai') return family;
  const model = family.models.find((entry) => entry.id === selector.model);
  // A retired host slug is still a SPELLING this family owns: a stored pin to
  // it must read back as itself, never as null, which would silently hand the
  // tier to another payer. It is no longer offered, and a launch refuses it
  // (`assertServedHostChatGptModels`).
  if (!model && family === CHATGPT_SUBSCRIPTION_FAMILY &&
    (RETIRED_CHATGPT_SUBSCRIPTION_MODELS as readonly string[]).includes(selector.model)) return family;
  if (!model) return null;
  if (tier !== undefined && model.tiers && !model.tiers.includes(tier)) return null;
  return family;
}

/**
 * The ACCOUNT level's admissible value space: a catalogue selection, or a
 * subscription family's model on a tier it may serve. The single union point —
 * every other reader stays on `isValidTierModelSelection`, so widening the
 * account space cannot widen the org space by accident.
 */
export function isAccountTierSelection(value: string, tier?: TierNumber): boolean {
  if (isValidTierModelSelection(value)) return true;
  const selector = tryParseModelSelector(value);
  // Persistence validates spelling, not a time-varying account entitlement.
  // New choices and launches validate against that principal's discovered inventory.
  return selector !== null && subscriptionFamilyOf(selector, tier) !== null;
}

/** Label for a stored selection, or the raw value when unknown. */
export function tierModelSelectionLabel(value: string): string {
  const selector = tryParseModelSelector(value);
  if (!selector) return value;
  const family = subscriptionFamilyOf(selector);
  if (family) {
    const model = family.models.find((entry) => entry.id === selector.model);
    return `${family.label} — ${model?.label ?? modelLabel(selector.model)}`;
  }
  const provider = findProvider(selector.vendor);
  if (!provider || selector.mode !== 'api') return formatModelSelector(selector);
  return (
    provider.models.find((model) => model.id === selector.model)?.label ??
    `${provider.label} ${selector.model}`
  );
}
