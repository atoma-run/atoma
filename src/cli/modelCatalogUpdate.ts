import {
  catalogDay,
  modelCatalogSchema,
  modelIsOffered,
  pricePointAt,
  type CatalogModel,
  type ModelCatalog,
  type ModelPricePoint,
} from '../contracts/modelCatalog.js';
import { MODEL_SELECTOR_VENDORS, type ModelSelectorVendor } from '../contracts/modelSelector.js';
import type { LlmProviderEntry } from '../core/providerCatalog.js';

/**
 * HOW THE CATALOGUE LEARNS WHAT CHANGED — the pure half of `npm run models`.
 *
 * Two outside facts drift on the vendors' calendar: which models they serve
 * and what those cost. Neither has a standard API. Model lists do (each
 * vendor's `GET …/models`, keyed, free), prices do not: no vendor publishes a
 * machine-readable price list except xAI. So the price REFERENCE is LiteLLM's
 * community-maintained `model_prices_and_context_window.json`, which keys
 * every entry by the vendor's own model id and cites the vendor page it was
 * read from — and the reference only ever PROPOSES. A refresh prints a diff; a
 * person applies it (`--apply`), the change is reviewed as a commit like any
 * other, and every applied price names its source URL so the reviewer can
 * check the vendor's page rather than trust the aggregator.
 *
 * Nothing here is automatic on purpose. A new model the source learns about is
 * reported, never added: which models an organisation may pick is a product
 * decision, and the source lists image, audio and preview models beside the
 * chat ones. A model the vendor stopped listing is reported, never retired:
 * a listing can be incomplete for one key's entitlements.
 */

export const LITELLM_PRICE_SOURCE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** LiteLLM's provider tag → atoma's vendor. Only these rows are read. */
const LITELLM_PROVIDERS: Readonly<Record<string, ModelSelectorVendor>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  xai: 'xai',
  meta: 'meta',
  mistral: 'mistral',
  dashscope: 'qwen',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  zai: 'zai',
};

export interface SourcePrice {
  readonly input: number;
  readonly output: number;
  /**
   * Absent when the source states no cache price. That is UNKNOWN, not "no
   * discount": it is never compared, and a point built from it keeps the
   * catalogue's cached rate (or, for a new model, the full input price).
   */
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  /** The vendor page the aggregator cites, when it cites one. */
  readonly source?: string;
  /** False when the source says the model has no function calling. */
  readonly toolCalling: boolean | null;
}

export type SourceCatalog = ReadonlyMap<ModelSelectorVendor, ReadonlyMap<string, SourcePrice>>;

/** USD per token → USD per million, rounded so 4e-6 reads 4 and not 4.000000000000001. */
function perMillion(perToken: number): number {
  return Math.round(perToken * 1e12) / 1e6;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Read LiteLLM's price file into per-vendor maps keyed by the vendor's own id.
 * Rows that are not chat models, carry no input/output price, or belong to a
 * provider atoma does not route to are skipped; the first row for an id wins.
 */
export function parseLiteLlmPrices(raw: unknown): SourceCatalog {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('price source is not a JSON object');
  }
  const out = new Map<ModelSelectorVendor, Map<string, SourcePrice>>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const vendor = typeof row['litellm_provider'] === 'string' ? LITELLM_PROVIDERS[row['litellm_provider']] : undefined;
    if (!vendor) continue;
    if (row['mode'] !== 'chat' && row['mode'] !== 'responses') continue;
    const input = finiteNumber(row['input_cost_per_token']);
    const output = finiteNumber(row['output_cost_per_token']);
    if (input === null || output === null) continue;
    const provider = row['litellm_provider'] as string;
    const id = key.startsWith(`${provider}/`) ? key.slice(provider.length + 1) : key;
    if (id.includes('/') || id.startsWith('ft:')) continue;
    const perVendor = out.get(vendor) ?? new Map<string, SourcePrice>();
    if (perVendor.has(id)) continue;
    const cacheRead = finiteNumber(row['cache_read_input_token_cost']);
    const cacheWrite = finiteNumber(row['cache_creation_input_token_cost']);
    const price: SourcePrice = {
      input: perMillion(input),
      output: perMillion(output),
      ...(cacheRead !== null ? { cachedInput: perMillion(cacheRead) } : {}),
      ...(cacheWrite !== null ? { cacheWrite: perMillion(cacheWrite) } : {}),
      ...(typeof row['source'] === 'string' && /^https?:\/\//.test(row['source'])
        ? { source: row['source'] }
        : {}),
      toolCalling: typeof row['supports_function_calling'] === 'boolean' ? row['supports_function_calling'] : null,
    };
    perVendor.set(id, price);
    out.set(vendor, perVendor);
  }
  return out;
}

export interface PriceChange {
  readonly vendor: ModelSelectorVendor;
  readonly id: string;
  /** The source row that answered, which may be an alias of `id`. */
  readonly sourceId: string;
  readonly current: ModelPricePoint | null;
  readonly proposed: SourcePrice;
}

export interface CatalogDrift {
  readonly priceChanges: readonly PriceChange[];
  /** Manually priced models whose source value differs: shown, never proposed. */
  readonly manualDisagreements: readonly PriceChange[];
  /** Offered catalogue models the source does not know: their price cannot be checked here. */
  readonly unknownToSource: ReadonlyArray<{ readonly vendor: ModelSelectorVendor; readonly id: string }>;
  /** Tool-capable chat models the source knows and the catalogue does not: candidates for `models add`. */
  readonly newAtSource: ReadonlyArray<{
    readonly vendor: ModelSelectorVendor;
    readonly id: string;
    readonly price: SourcePrice;
  }>;
}

/** Same money to the micro-dollar per million tokens. */
function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Ids that are not a chat model an organisation would pin a tier to, or are
 * a dated snapshot of an id already known. Only filters the CANDIDATE report;
 * nothing is added from it without `models add`.
 */
const NOT_A_TIER_CANDIDATE =
  /(?:tts|audio|realtime|image|embed|transcribe|search|moderation|dall-e|whisper|computer-use|robotics|lyria|veo|imagen|deep-research|vision|omni|ocr|guard|-exp-?\d*$|preview-\d{2}-\d{2})/i;
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;

function knownIds(models: readonly CatalogModel[]): Set<string> {
  const ids = new Set<string>();
  for (const model of models) {
    for (const id of [model.id, ...(model.aliases ?? [])]) ids.add(id.toLowerCase());
  }
  return ids;
}

function sourceRowFor(
  model: CatalogModel,
  rows: ReadonlyMap<string, SourcePrice> | undefined
): { id: string; price: SourcePrice } | null {
  if (!rows) return null;
  for (const id of [model.id, ...(model.aliases ?? [])]) {
    const price = rows.get(id);
    if (price) return { id, price };
  }
  return null;
}

/** Compare every offered, billed catalogue model with the price source. */
export function diffCatalog(
  catalog: ModelCatalog,
  source: SourceCatalog,
  opts: { readonly at?: Date; readonly vendors?: readonly ModelSelectorVendor[] } = {}
): CatalogDrift {
  const at = opts.at ?? new Date();
  const vendors = opts.vendors ?? MODEL_SELECTOR_VENDORS.filter((vendor) => vendor !== 'ollama');
  const priceChanges: PriceChange[] = [];
  const manualDisagreements: PriceChange[] = [];
  const unknownToSource: Array<{ vendor: ModelSelectorVendor; id: string }> = [];
  const newAtSource: Array<{ vendor: ModelSelectorVendor; id: string; price: SourcePrice }> = [];
  for (const vendor of vendors) {
    const models = catalog.vendors[vendor].models;
    const rows = source.get(vendor);
    for (const model of models) {
      if (!modelIsOffered(model, at)) continue;
      const found = sourceRowFor(model, rows);
      if (!found) {
        unknownToSource.push({ vendor, id: model.id });
        continue;
      }
      const current = pricePointAt(model, at);
      const proposed = found.price;
      const moved =
        !current ||
        !samePrice(current.input, proposed.input) ||
        !samePrice(current.output, proposed.output) ||
        (proposed.cachedInput !== undefined && !samePrice(current.cachedInput, proposed.cachedInput)) ||
        (current.cacheWrite !== undefined &&
          proposed.cacheWrite !== undefined &&
          !samePrice(current.cacheWrite, proposed.cacheWrite));
      if (!moved) continue;
      const change = { vendor, id: model.id, sourceId: found.id, current, proposed };
      (model.manualPrice ? manualDisagreements : priceChanges).push(change);
    }
    const known = knownIds(models);
    const sourceIds = new Set([...(rows?.keys() ?? [])].map((id) => id.toLowerCase()));
    for (const [id, price] of rows ?? []) {
      const lower = id.toLowerCase();
      const undated = lower.replace(DATED, '');
      if (known.has(lower) || known.has(undated)) continue;
      // A dated snapshot is reported through its undated id when that exists.
      if (undated !== lower && sourceIds.has(undated)) continue;
      if (price.toolCalling === false || NOT_A_TIER_CANDIDATE.test(id)) continue;
      newAtSource.push({ vendor, id, price });
    }
  }
  return { priceChanges, manualDisagreements, unknownToSource, newAtSource };
}

function cloneCatalog(catalog: ModelCatalog): ModelCatalog {
  return structuredClone(catalog);
}

function findModel(catalog: ModelCatalog, vendor: ModelSelectorVendor, id: string): CatalogModel {
  const model = catalog.vendors[vendor].models.find((entry) => entry.id === id);
  if (!model) throw new Error(`${vendor}:${id} is not in the catalogue`);
  return model;
}

/**
 * Put one price point into a model's history. A point already dated that day
 * is REPLACED (a second refresh the same day corrects, it does not stack);
 * any other point stays, including a scheduled future one.
 */
function placePricePoint(model: CatalogModel, point: ModelPricePoint): void {
  const kept = model.prices.filter((existing) => existing.since !== point.since);
  kept.push(point);
  kept.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  model.prices = kept;
}

/**
 * `SourcePrice` → a price point dated `since`. An unstated cache price keeps
 * `current`'s, else bills cached tokens as input: over-stating a cost is the
 * error this repository prefers to under-stating one.
 */
export function pricePointFromSource(
  price: SourcePrice,
  since: string,
  current: ModelPricePoint | null = null
): ModelPricePoint {
  return {
    since,
    input: price.input,
    output: price.output,
    cachedInput: price.cachedInput ?? current?.cachedInput ?? price.input,
    ...(price.cacheWrite !== undefined && !samePrice(price.cacheWrite, price.input * 1.25)
      ? { cacheWrite: price.cacheWrite }
      : {}),
    ...(price.source ? { source: price.source } : {}),
  };
}

/** Append each change as a new point dated `day`, and stamp the review. */
export function applyPriceChanges(
  catalog: ModelCatalog,
  changes: readonly PriceChange[],
  day: string = catalogDay(new Date())
): ModelCatalog {
  const next = cloneCatalog(catalog);
  for (const change of changes) {
    placePricePoint(
      findModel(next, change.vendor, change.id),
      pricePointFromSource(change.proposed, day, change.current)
    );
  }
  next.reviewedAt = day;
  return modelCatalogSchema.parse(next);
}

/** Record that the catalogue was compared on `day`, whether or not anything moved. */
export function markReviewed(catalog: ModelCatalog, day: string = catalogDay(new Date())): ModelCatalog {
  return modelCatalogSchema.parse({ ...cloneCatalog(catalog), reviewedAt: day });
}

export function addModel(
  catalog: ModelCatalog,
  vendor: ModelSelectorVendor,
  model: CatalogModel
): ModelCatalog {
  const next = cloneCatalog(catalog);
  const known = knownIds(next.vendors[vendor].models);
  for (const id of [model.id, ...(model.aliases ?? [])]) {
    if (known.has(id.toLowerCase())) throw new Error(`${vendor}:${id} is already in the catalogue`);
  }
  next.vendors[vendor].models.push(model);
  return modelCatalogSchema.parse(next);
}

/**
 * A price read by a person from the vendor's page. It marks the model
 * `manualPrice`, so the next refresh shows the source's number beside it
 * instead of proposing it; `manual: false` hands the model back to the source.
 */
export function setModelPrice(
  catalog: ModelCatalog,
  vendor: ModelSelectorVendor,
  id: string,
  point: ModelPricePoint,
  opts: { readonly manual?: boolean } = {}
): ModelCatalog {
  const next = cloneCatalog(catalog);
  const model = findModel(next, vendor, id);
  placePricePoint(model, point);
  if (opts.manual === false) delete model.manualPrice;
  else model.manualPrice = true;
  return modelCatalogSchema.parse(next);
}

export function retireModel(
  catalog: ModelCatalog,
  vendor: ModelSelectorVendor,
  id: string,
  day: string = catalogDay(new Date())
): ModelCatalog {
  const next = cloneCatalog(catalog);
  const model = findModel(next, vendor, id);
  if (model.retired !== undefined) throw new Error(`${vendor}:${id} was already retired on ${model.retired}`);
  model.retired = day;
  return modelCatalogSchema.parse(next);
}

/**
 * The family fallbacks that price like `id`. Retiring such a model is allowed
 * — it keeps pricing its own old calls — but a fallback pricing TODAY's
 * aliases at a retired model's rate is stale, so the CLI says so.
 */
export function fallbacksPricingOf(
  catalog: ModelCatalog,
  vendor: ModelSelectorVendor,
  id: string
): readonly string[] {
  return (catalog.vendors[vendor].fallbacks ?? [])
    .filter((fallback) => fallback.priceOf === id)
    .map((fallback) => fallback.pattern);
}

/** The catalogue's file form: validated, two-space JSON, trailing newline. */
export function serializeCatalog(catalog: ModelCatalog): string {
  return `${JSON.stringify(modelCatalogSchema.parse(catalog), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Live listings — which ids a vendor serves to this key today.

export type LiveListing =
  | { readonly kind: 'listed'; readonly ids: readonly string[] }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export type FetchJson = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/**
 * Ask one vendor which models it lists. Keyless vendors are skipped, never
 * guessed at; the key goes in a header only and appears in no message.
 */
export async function fetchLiveListing(
  entry: LlmProviderEntry,
  env: NodeJS.ProcessEnv,
  fetchJson: FetchJson,
  timeoutMs = 10_000
): Promise<LiveListing> {
  if (!entry.modelListing) return { kind: 'skipped', reason: 'no listing endpoint' };
  const key = entry.credentialEnvVar ? env[entry.credentialEnvVar]?.trim() : undefined;
  if (!key) return { kind: 'skipped', reason: `${entry.credentialEnvVar ?? 'credential'} not set` };
  const headers: Record<string, string> =
    entry.modelListing.auth === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${key}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchJson(entry.modelListing.url, { headers, signal: controller.signal });
    if (!response.ok) return { kind: 'failed', reason: `HTTP ${response.status}` };
    const body = (await response.json()) as { data?: unknown; models?: unknown };
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
    if (!rows) return { kind: 'failed', reason: 'listing has no data array' };
    const ids = rows
      .map((row) => (row && typeof row === 'object' ? (row as { id?: unknown; name?: unknown }) : {}))
      .map((row) => (typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : null))
      .filter((id): id is string => id !== null)
      .map((id) => id.replace(/^models\//, ''));
    return { kind: 'listed', ids };
  } catch (error) {
    return {
      kind: 'failed',
      reason: controller.signal.aborted ? `timed out after ${timeoutMs} ms` : (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface LiveDrift {
  /** Offered in the catalogue, absent from the vendor's listing under every alias. */
  readonly notListed: readonly string[];
  /** Listed by the vendor, unknown to the catalogue (dated snapshots of known ids excluded). */
  readonly unknownToCatalogue: readonly string[];
}

export function diffLiveListing(
  catalog: ModelCatalog,
  vendor: ModelSelectorVendor,
  liveIds: readonly string[],
  at: Date = new Date()
): LiveDrift {
  const live = new Set(liveIds.map((id) => id.toLowerCase()));
  const models = catalog.vendors[vendor].models;
  const notListed = models
    .filter((model) => modelIsOffered(model, at))
    .filter((model) => ![model.id, ...(model.aliases ?? [])].some((id) => live.has(id.toLowerCase())))
    .map((model) => model.id);
  const known = knownIds(models);
  const unknownToCatalogue = [...new Set(liveIds)]
    .filter((id) => !known.has(id.toLowerCase()) && !known.has(id.toLowerCase().replace(DATED, '')))
    .filter((id) => !NOT_A_TIER_CANDIDATE.test(id))
    .sort();
  return { notListed, unknownToCatalogue };
}
