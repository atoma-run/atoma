import { describe, it, expect } from 'vitest';
import rawCatalog from '../src/core/modelCatalog.json' with { type: 'json' };
import {
  modelCatalogSchema,
  modelIsOffered,
  pricePointAt,
  type ModelCatalog,
} from '../src/contracts/modelCatalog.js';
import { MODEL_SELECTOR_VENDORS, parseModelSelector, transportOf } from '../src/contracts/modelSelector.js';
import { CHATGPT_SUBSCRIPTION_MODELS } from '../src/contracts/runPayers.js';
import { MODEL_CATALOG } from '../src/core/modelCatalog.js';
import {
  CACHE_CREATE_MULTIPLIER_5M,
  catalogPriceTable,
  estimateCostUsd,
  pricesAt,
  pricesFor,
} from '../src/core/metrics.js';
import {
  LLM_PROVIDER_CATALOG,
  isValidTierModelSelection,
  tierModelSelectionLabel,
} from '../src/core/providerCatalog.js';

function catalogWith(mutate: (catalog: ModelCatalog) => void): unknown {
  const copy = structuredClone(rawCatalog) as unknown as ModelCatalog;
  mutate(copy);
  return copy;
}

describe('the checked-in model catalogue', () => {
  it('parses, and offers at least one priced model for every billed vendor', () => {
    expect(() => modelCatalogSchema.parse(rawCatalog)).not.toThrow();
    for (const vendor of MODEL_SELECTOR_VENDORS) {
      const offered = MODEL_CATALOG.vendors[vendor].models.filter((model) => modelIsOffered(model));
      expect(offered.length, vendor).toBeGreaterThan(0);
      if (vendor === 'ollama') continue;
      for (const model of offered) expect(pricePointAt(model), `${vendor}:${model.id}`).not.toBeNull();
    }
  });

  it('prices every model the ChatGPT subscription can serve, so Codex calls never read as free', () => {
    for (const model of CHATGPT_SUBSCRIPTION_MODELS) {
      expect(pricesFor(`sub:openai:${model}`).input, model).toBeGreaterThan(0);
    }
  });

  it('refuses a billed model without a price, out-of-order history, duplicate ids and dangling fallbacks', () => {
    expect(() =>
      modelCatalogSchema.parse(catalogWith((c) => c.vendors.xai.models.push({ id: 'grok-x', label: 'X', prices: [] })))
    ).toThrow(/has no price/);
    expect(() =>
      modelCatalogSchema.parse(
        catalogWith((c) => {
          const model = c.vendors.google.models[0]!;
          model.prices = [...model.prices].reverse();
        })
      )
    ).toThrow(/ascending/);
    expect(() =>
      modelCatalogSchema.parse(
        catalogWith((c) => c.vendors.xai.models[0]!.aliases = [c.vendors.xai.models[1]!.id])
      )
    ).toThrow(/listed twice/);
    expect(() =>
      modelCatalogSchema.parse(
        catalogWith((c) => (c.vendors.zai.fallbacks = [{ pattern: 'glm', priceOf: 'glm-99' }]))
      )
    ).toThrow(/has no price in this vendor/);
  });

  it('keeps a price history: a scheduled change applies from its day, earlier calls keep the old numbers', () => {
    const flash = MODEL_CATALOG.vendors.google.models.find((model) => model.id === 'gemini-3.8-flash')!;
    expect(pricePointAt(flash, new Date('2026-12-31T23:00:00Z'))?.input).toBe(0.75);
    expect(pricePointAt(flash, new Date('2027-01-01T00:00:00Z'))?.input).toBe(1.5);
    // Before the catalogue's memory, the oldest point applies — never zero.
    expect(pricePointAt(flash, new Date('2020-01-01T00:00:00Z'))?.input).toBe(0.75);
    expect(pricesAt('api:google:gemini-3.8-flash', new Date('2027-02-01T00:00:00Z')).output).toBe(7.5);
  });
});

describe('pricing from the catalogue', () => {
  it('prices a selector, a served bare id, a dated snapshot and a Gemini resource name alike', () => {
    expect(pricesFor('api:anthropic:claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(pricesFor('claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(pricesFor('claude-opus-4-7-20260416')).toMatchObject({ input: 5, output: 25 });
    expect(pricesFor('models/gemini-3.5-flash')).toMatchObject({ input: 1.5, output: 9 });
    expect(pricesFor('api:xai:grok-code-fast-1')).toMatchObject({ input: 1, output: 2 });
  });

  it('never lends one vendor’s price to another vendor’s selector', () => {
    expect(pricesFor('api:xai:glm-5.3')).toEqual({ input: 0, output: 0, cachedInput: 0 });
    expect(pricesFor('api:zai:glm-5.3')).toMatchObject({ input: 1.4, output: 4.4 });
  });

  it('prices subscription aliases and self-hosted tags through the family fallbacks', () => {
    expect(pricesFor('sub:anthropic:sonnet')).toMatchObject({ input: 2, output: 10 });
    expect(pricesFor('opus')).toMatchObject({ input: 4, output: 20 });
    expect(pricesFor('glm-5.1:cloud')).toMatchObject({ input: 0.6, output: 2.2 });
    expect(pricesFor('api:ollama:qwen3:8b')).toEqual({ input: 0, output: 0, cachedInput: 0 });
    expect(pricesFor('gpt-foo')).toEqual({ input: 0, output: 0, cachedInput: 0 });
  });

  it('bills cache writes at the vendor’s own rate when the catalogue names one', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000 };
    expect(estimateCostUsd(usage, pricesFor('api:zai:glm-5.3'))).toBe(0);
    expect(estimateCostUsd(usage, pricesFor('claude-sonnet-5'))).toBeCloseTo(2 * CACHE_CREATE_MULTIPLIER_5M, 9);
  });

  it('keeps retired models priced, so their past calls still cost what they cost', () => {
    const table = catalogPriceTable(MODEL_CATALOG, new Date('2026-09-27T00:00:00Z'));
    expect(pricesFor('claude-opus-4-1', table)).toMatchObject({ input: 15, output: 75 });
  });
});

describe('the provider catalogue', () => {
  it('has one entry per vendor, each routed to that vendor’s own transport', () => {
    expect(LLM_PROVIDER_CATALOG.map((entry) => entry.id)).toEqual([...MODEL_SELECTOR_VENDORS]);
    for (const entry of LLM_PROVIDER_CATALOG) {
      expect(entry.selectorPrefix).toBe(`api:${entry.id}`);
      const transport = transportOf(parseModelSelector(`api:${entry.id}:x`));
      expect(transport).toBe(entry.id === 'ollama' ? 'ollama' : `${entry.id}-api`);
      expect(() => new URL(entry.defaultBaseUrl)).not.toThrow();
    }
  });

  it('offers new vendors’ models for selection and refuses retired ones', () => {
    expect(isValidTierModelSelection('api:deepseek:deepseek-v4-pro')).toBe(true);
    expect(isValidTierModelSelection('api:moonshot:kimi-k3')).toBe(true);
    expect(isValidTierModelSelection('api:anthropic:claude-opus-4-1')).toBe(false);
    expect(tierModelSelectionLabel('api:mistral:mistral-large-latest')).toBe('Mistral Large 3');
  });

  it('refuses a subscription on a vendor atoma has no CLI for', () => {
    expect(() => parseModelSelector('sub:google:gemini-3.8-flash')).toThrow(/no subscription/);
  });
});
