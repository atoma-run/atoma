import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rawCatalog from '../src/core/modelCatalog.json' with { type: 'json' };
import { modelCatalogSchema, pricePointAt, type ModelCatalog } from '../src/contracts/modelCatalog.js';
import {
  addModel,
  applyPriceChanges,
  diffCatalog,
  diffLiveListing,
  fetchLiveListing,
  parseLiteLlmPrices,
  pricePointFromSource,
  retireModel,
  setModelPrice,
  type FetchJson,
} from '../src/cli/modelCatalogUpdate.js';
import { findProvider } from '../src/core/providerCatalog.js';

const catalog = (): ModelCatalog => modelCatalogSchema.parse(structuredClone(rawCatalog));

/** A LiteLLM-shaped price file: per-token USD, provider-tagged, prefixed keys. */
const SOURCE = {
  sample_spec: { litellm_provider: 'openai', mode: 'chat' },
  'claude-sonnet-5': {
    litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7, source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    supports_function_calling: true,
  },
  'gemini/gemini-3.5-flash': {
    litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 1.5e-6, output_cost_per_token: 9e-6,
    cache_read_input_token_cost: 1.5e-7,
  },
  // No cache price stated: unknown, never compared.
  'zai/glm-4.5-air': { litellm_provider: 'zai', mode: 'chat', input_cost_per_token: 2e-7, output_cost_per_token: 1.1e-6 },
  // The reference disagrees with a manually priced model.
  'dashscope/qwen3.8-max': {
    litellm_provider: 'dashscope', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 6e-6,
    cache_read_input_token_cost: 2.5e-7,
  },
  'xai/grok-9': { litellm_provider: 'xai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, supports_function_calling: true },
  'xai/grok-9-0101': { litellm_provider: 'xai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  'xai/grok-imagine-image': { litellm_provider: 'xai', mode: 'image_generation', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  'mistral/no-tools': { litellm_provider: 'mistral', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6, supports_function_calling: false },
  'cohere/command': { litellm_provider: 'cohere', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
};

describe('the price reference', () => {
  it('reads per-token USD into per-million prices keyed by the vendor’s own id', () => {
    const source = parseLiteLlmPrices(SOURCE);
    expect(source.get('anthropic')?.get('claude-sonnet-5')).toMatchObject({ input: 3, output: 15, cachedInput: 0.3 });
    expect(source.get('google')?.get('gemini-3.5-flash')).toMatchObject({ input: 1.5, output: 9 });
    expect(source.get('zai')?.get('glm-4.5-air')?.cachedInput).toBeUndefined();
    expect(source.get('xai')?.has('grok-imagine-image')).toBe(false);
    expect([...source.keys()]).not.toContain('cohere');
  });

  it('proposes moved prices, shows manual disagreements, and reports candidates without adding them', () => {
    const drift = diffCatalog(catalog(), parseLiteLlmPrices(SOURCE), { at: new Date('2026-10-01T00:00:00Z') });
    expect(drift.priceChanges.map((change) => `${change.vendor}:${change.id}`)).toEqual(['anthropic:claude-sonnet-5']);
    expect(drift.manualDisagreements.map((change) => change.id)).toEqual(['qwen3.8-max']);
    // grok-9's dated snapshot folds into grok-9; no-tools and image rows are not candidates.
    expect(drift.newAtSource.map((entry) => `${entry.vendor}:${entry.id}`)).toEqual(['xai:grok-9']);
    expect(drift.unknownToSource.some((entry) => entry.id === 'kimi-k3')).toBe(true);
  });

  it('appends a changed price as a new point and keeps the history, including a scheduled one', () => {
    const before = catalog();
    const drift = diffCatalog(before, parseLiteLlmPrices(SOURCE), { at: new Date('2026-10-01T00:00:00Z') });
    const after = applyPriceChanges(before, drift.priceChanges, '2026-10-01');
    const sonnet = after.vendors.anthropic.models.find((model) => model.id === 'claude-sonnet-5')!;
    expect(sonnet.prices.map((point) => point.since)).toEqual(['2026-09-27', '2026-10-01']);
    expect(pricePointAt(sonnet, new Date('2026-09-30T00:00:00Z'))?.input).toBe(2);
    expect(pricePointAt(sonnet, new Date('2026-10-02T00:00:00Z'))).toMatchObject({ input: 3, source: expect.stringMatching(/claude/) });
    expect(after.reviewedAt).toBe('2026-10-01');
    // A second refresh the same day corrects its point rather than stacking one.
    const again = applyPriceChanges(after, drift.priceChanges, '2026-10-01');
    expect(again.vendors.anthropic.models.find((model) => model.id === 'claude-sonnet-5')!.prices).toHaveLength(2);
  });

  it('adds, prices by hand and retires, refusing duplicates', () => {
    const base = catalog();
    const added = addModel(base, 'xai', {
      id: 'grok-9', label: 'Grok 9', prices: [{ since: '2026-10-01', input: 1, output: 2, cachedInput: 0.2 }],
    });
    expect(() => addModel(added, 'xai', { id: 'GROK-9', label: 'x', prices: added.vendors.xai.models.at(-1)!.prices })).toThrow(/already/);
    const priced = setModelPrice(added, 'xai', 'grok-9', { since: '2026-10-05', input: 0.5, output: 1, cachedInput: 0.1 });
    expect(priced.vendors.xai.models.at(-1)).toMatchObject({ manualPrice: true });
    const retired = retireModel(priced, 'xai', 'grok-9', '2026-11-01');
    expect(retired.vendors.xai.models.at(-1)?.retired).toBe('2026-11-01');
    expect(() => retireModel(retired, 'xai', 'grok-9')).toThrow(/already retired/);
  });
});

describe('live listings', () => {
  it('asks with the vendor’s own auth header, and skips a vendor without a key', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchJson: FetchJson = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'models/gemini-3.8-flash' }, { id: 'gemini-9-pro' }] }) };
    };
    const google = await fetchLiveListing(findProvider('google')!, { GEMINI_API_KEY: 'k-google' }, fetchJson);
    expect(google).toEqual({ kind: 'listed', ids: ['gemini-3.8-flash', 'gemini-9-pro'] });
    await fetchLiveListing(findProvider('anthropic')!, { ANTHROPIC_API_KEY: 'k-ant' }, fetchJson);
    expect(seen[0]).toEqual({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
      headers: { authorization: 'Bearer k-google' },
    });
    expect(seen[1]!.headers).toEqual({ 'x-api-key': 'k-ant', 'anthropic-version': '2023-06-01' });
    expect(await fetchLiveListing(findProvider('xai')!, {}, fetchJson)).toEqual({ kind: 'skipped', reason: 'XAI_API_KEY not set' });
    expect(await fetchLiveListing(findProvider('ollama')!, {}, fetchJson)).toMatchObject({ kind: 'skipped' });
  });

  it('never repeats the key in a failure', async () => {
    const failing: FetchJson = async () => {
      throw new Error('socket hang up');
    };
    const result = await fetchLiveListing(findProvider('mistral')!, { MISTRAL_API_KEY: 'secret-123' }, failing);
    expect(result).toEqual({ kind: 'failed', reason: 'socket hang up' });
    expect(JSON.stringify(result)).not.toContain('secret-123');
  });

  it('separates models no longer listed from models the catalogue does not know', () => {
    const live = diffLiveListing(catalog(), 'moonshot', ['kimi-k3', 'kimi-k2.6', 'kimi-k4', 'moonshot-v1-8k-vision-preview']);
    expect(live.notListed).toEqual(['kimi-k2.7-code']);
    expect(live.unknownToCatalogue).toEqual(['kimi-k4']);
  });
});

describe('npm run models', () => {
  it('stays a dry run until --apply, then writes a catalogue the product loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-models-'));
    const catalogPath = join(dir, 'catalog.json');
    const sourcePath = join(dir, 'source.json');
    const original = `${JSON.stringify(rawCatalog, null, 2)}\n`;
    writeFileSync(catalogPath, original);
    writeFileSync(sourcePath, JSON.stringify(SOURCE));
    const run = (...args: string[]) =>
      spawnSync('npx', ['tsx', 'src/cli/models.ts', ...args, '--catalog', catalogPath, '--source', sourcePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });

    const dry = run('refresh');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/anthropic:claude-sonnet-5 +2\/10\/0\.2 \(cache write 2\.5\) → 3\/15\/0\.3 \(cache write 3\.75\)/);
    expect(dry.stdout).toMatch(/dry run/);
    expect(readFileSync(catalogPath, 'utf8')).toBe(original);

    const applied = run('refresh', '--apply');
    expect(applied.status, applied.stderr).toBe(0);
    const written = modelCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8')));
    // Dated today: on the seed's own day it replaces that point, later it appends.
    const sonnet = written.vendors.anthropic.models.find((model) => model.id === 'claude-sonnet-5')!;
    expect(sonnet.prices.at(-1)).toMatchObject({ input: 3, output: 15, cachedInput: 0.3 });

    const refused = run('retire', 'nosuch:model');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/expected <vendor>:<model-id>/);
  }, 60_000);
});

it('preserves every known free cache-write price when the reference omits it', () => {
  const points = Object.values(catalog().vendors).flatMap((vendor) => vendor.models.flatMap((model) => model.prices)).filter((point) => point.cacheWrite === 0);
  expect(points.length).toBeGreaterThan(0);
  for (const current of points) {
    const next = pricePointFromSource({ input: current.input + 0.1, output: current.output, toolCalling: true }, '2026-10-02', current);
    expect(next.cacheWrite).toBe(0);
  }
});
