import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
} from './types.js';
import {
  pricePointAt,
  type CatalogModel,
  type ModelCatalog,
} from '../contracts/modelCatalog.js';
import { MODEL_SELECTOR_VENDORS, tryParseModelSelector } from '../contracts/modelSelector.js';
import { MODEL_CATALOG } from './modelCatalog.js';

export interface LlmCallMetrics {
  readonly model: string;
  /**
   * The model as the CALLER asked for it, prefix intact — `req.model`, before
   * a transport collapsed it onto what it actually served. `model` above is
   * priced and must stay the served id; this one is what says WHO PAID, and it
   * is the only place the distinction survives. Optional so every existing
   * recorder and fixture keeps compiling; absent means "same as `model`".
   *
   * Added 2026-08-28 with the per-tier host subscription: a mixed run bills an
   * organisation's key for some calls and spends the operator's own login for
   * others, and a single `costUsd` that blends real spend with the notional
   * API-price equivalent of subscription tokens is a figure that contradicts
   * the journal row beside it.
   */
  readonly requestedModel?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly durationMs: number;
  readonly stopReason: string | null;
}

export interface MetricsRecorder {
  record(m: LlmCallMetrics): void;
}

/**
 * USD per million tokens, from the checked-in model catalogue
 * (`core/modelCatalog.json`, schema `contracts/modelCatalog.ts`). Unknown
 * models fall back to zero so the summary still runs. Override with a custom
 * PriceTable in the InMemoryMetrics constructor.
 */
export interface ModelPrices {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
  /** Cache-write input where a vendor bills it apart; absent means 1.25 × input. */
  readonly cacheWrite?: number;
}

/**
 * First matching row wins. `match` is anything with `test(model)` — a RegExp
 * for a hand-written table, a catalogue matcher for the default one.
 */
export type PriceTable = ReadonlyArray<{
  readonly match: { test(model: string): boolean };
  readonly prices: ModelPrices;
}>;

/**
 * The priced identity of a model string, which arrives in three spellings: a
 * full selector (`api:zai:glm-4.5-air`), the served bare id a transport
 * reported (`glm-4.5-air`, `models/gemini-3.8-flash`), or a legacy
 * `vendor:model` pair. A self-hosted Ollama selector names no API vendor: its
 * tag prices through the family fallbacks, as what those tokens WOULD cost at
 * the vendor whose weights it runs, like every subscription transport here.
 */
function pricedIdentity(model: string): { vendor: string | null; id: string } {
  const selector = tryParseModelSelector(model);
  if (selector) {
    return {
      vendor: selector.vendor === 'ollama' ? null : selector.vendor,
      id: selector.model.toLowerCase(),
    };
  }
  const bare = model.trim().replace(/^models\//i, '').toLowerCase();
  const colon = bare.indexOf(':');
  if (colon > 0 && (MODEL_SELECTOR_VENDORS as readonly string[]).includes(bare.slice(0, colon))) {
    const vendor = bare.slice(0, colon);
    return { vendor: vendor === 'ollama' ? null : vendor, id: bare.slice(colon + 1) };
  }
  return { vendor: null, id: bare };
}

/** Dated snapshots (`-20251001`, `-2026-03-05`, `-0309`) price like their family id. */
const DATED_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;

/**
 * The default table, derived from the catalogue for the prices in force on
 * `at`: every model's exact ids (retired ones too — their past calls still
 * need pricing), then each vendor's family fallbacks. Exact rows are
 * vendor-scoped when the priced string names its vendor, so one vendor's id
 * can never borrow another's price.
 */
export function catalogPriceTable(
  catalog: ModelCatalog = MODEL_CATALOG,
  at: Date = new Date()
): PriceTable {
  const exact: Array<PriceTable[number]> = [];
  const fallbacks: Array<PriceTable[number]> = [];
  for (const vendor of MODEL_SELECTOR_VENDORS) {
    const entry = catalog.vendors[vendor];
    const priceOf = (model: CatalogModel): ModelPrices | null => {
      const point = pricePointAt(model, at);
      if (!point) return null;
      return {
        input: point.input,
        output: point.output,
        cachedInput: point.cachedInput,
        ...(point.cacheWrite !== undefined ? { cacheWrite: point.cacheWrite } : {}),
      };
    };
    for (const model of entry.models) {
      const prices = priceOf(model);
      if (!prices) continue;
      const ids = new Set([model.id, ...(model.aliases ?? [])].map((id) => id.toLowerCase()));
      exact.push({
        match: {
          test: (value) => {
            const priced = pricedIdentity(value);
            if (priced.vendor !== null && priced.vendor !== vendor) return false;
            return ids.has(priced.id) || ids.has(priced.id.replace(DATED_SUFFIX, ''));
          },
        },
        prices,
      });
    }
    for (const fallback of entry.fallbacks ?? []) {
      const target = entry.models.find((model) => model.id === fallback.priceOf);
      const prices = target ? priceOf(target) : null;
      if (!prices) continue;
      const pattern = new RegExp(fallback.pattern, 'i');
      fallbacks.push({
        match: {
          test: (value) => {
            const priced = pricedIdentity(value);
            if (priced.vendor !== null && priced.vendor !== vendor) return false;
            return pattern.test(priced.id);
          },
        },
        prices,
      });
    }
  }
  return [...exact, ...fallbacks];
}

/**
 * Current prices, fixed when the process loads. A price change reaches a
 * running server at its next deploy, like every other catalogue change.
 */
export const DEFAULT_PRICES: PriceTable = catalogPriceTable();

export function pricesFor(model: string, table: PriceTable = DEFAULT_PRICES): ModelPrices {
  for (const entry of table) if (entry.match.test(model)) return entry.prices;
  return { input: 0, output: 0, cachedInput: 0 };
}

/**
 * What `model` cost on `at`, from the catalogue's price HISTORY — for anything
 * that re-prices old usage. Live recording keeps using `DEFAULT_PRICES`.
 */
export function pricesAt(model: string, at: Date, catalog: ModelCatalog = MODEL_CATALOG): ModelPrices {
  return pricesFor(model, catalogPriceTable(catalog, at));
}

/**
 * USD cost for a single LLM call given Anthropic's disjoint token
 * counters. Per docs:
 *   "total_input_tokens = cache_read_input_tokens +
 *    cache_creation_input_tokens + input_tokens"
 * where `input_tokens` is ONLY the content after the last cache
 * breakpoint — NOT a grand total. 5-minute cache writes are billed at
 * 1.25× the base input price, unless the catalogue names the vendor's own
 * cache-write price (Z.ai and DeepSeek bill none).
 *
 * Exported so both `InMemoryMetrics.summary` and `RecordingLlmClient`
 * (viz) use the same formula — previously they had two copies that
 * drifted; the viz copy still had the old subtractive bug and produced
 * negative costs on runs with heavy cache reads.
 */
export const CACHE_CREATE_MULTIPLIER_5M = 1.25;

export function estimateCostUsd(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  },
  prices: ModelPrices
): number {
  return (
    (usage.inputTokens * prices.input +
      usage.cacheReadInputTokens * prices.cachedInput +
      usage.cacheCreationInputTokens *
        (prices.cacheWrite ?? prices.input * CACHE_CREATE_MULTIPLIER_5M) +
      usage.outputTokens * prices.output) /
    1_000_000
  );
}

/**
 * WHAT THE SUBSCRIPTION SPENT, separated from what a key spent.
 *
 * The number is what those tokens WOULD have cost at API list prices — the
 * convention this file already states for the codex rows — not a bill: on a
 * subscription nothing is charged per token. It exists so a mixed run's single
 * `costUsd` stops silently blending an organisation's real spend with the
 * operator's notional one, which is the contradiction the journal row would
 * otherwise carry from its first day (design 2026-08-28, Q3).
 *
 * Reads `requestedModel`, because that is the only field where the payer
 * survives: `model` is what the transport served, and `claude-cli` maps every
 * pin onto a bare alias, so by the time pricing sees it the prefix is gone.
 */
export function subscriptionCostUsd(
  events: readonly LlmCallMetrics[],
  isSubscriptionModel: (requestedModel: string) => boolean,
  table: PriceTable = DEFAULT_PRICES
): number {
  let total = 0;
  for (const event of events) {
    const requested = event.requestedModel ?? event.model;
    if (!isSubscriptionModel(requested)) continue;
    total += estimateCostUsd(event, pricesFor(event.model, table));
  }
  return total;
}

/**
 * Usage a transport aggregated BEFORE its error, attached to the thrown
 * error as `partialUsage` (the mechanism AnthropicLlmClient.raise
 * established in e15d810; Ollama and claude-cli mirror it — review
 * 2026-08-14 §1.13). ONE reader for both observability layers:
 * MetricsLlmClient and RecordingLlmClient used to disagree about the same
 * failed call — the CSV carried the partial tokens while the trace wrote
 * $0 — so trace and cost curve contradicted each other about one event.
 */
export interface PartialUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export function partialUsageOf(err: unknown): PartialUsage | undefined {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return undefined;
  const p = (err as { partialUsage?: unknown }).partialUsage;
  if (p === null || typeof p !== 'object') return undefined;
  const u = p as Partial<PartialUsage>;
  // Missing counters default to 0 rather than rejecting the whole object:
  // a transport that only tracks input/output (Ollama has no cache) still
  // gets its paid tokens counted.
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
  };
}

export interface ModelAggregate {
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly durationMs: number;
  readonly costUsd: number;
}

export interface MetricsSummary {
  readonly perModel: ModelAggregate[];
  readonly totals: Omit<ModelAggregate, 'model'> & { model: 'TOTAL' };
}

/**
 * Simple in-memory aggregator. Keeps raw events for debugging and produces a
 * per-model summary with estimated USD cost using the configured PriceTable.
 * Thread-unsafe (single-process, single-event-loop assumption).
 */
export class InMemoryMetrics implements MetricsRecorder {
  public readonly events: LlmCallMetrics[] = [];
  private readonly prices: PriceTable;

  constructor(prices: PriceTable = DEFAULT_PRICES) {
    this.prices = prices;
  }

  record(m: LlmCallMetrics): void {
    this.events.push(m);
  }

  clear(): void {
    this.events.length = 0;
  }

  summary(): MetricsSummary {
    const buckets = new Map<string, ModelAggregate>();
    for (const e of this.events) {
      const p = pricesFor(e.model, this.prices);
      const cost = estimateCostUsd(e, p);
      const prev = buckets.get(e.model) ?? {
        model: e.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 0,
        costUsd: 0,
      };
      buckets.set(e.model, {
        model: e.model,
        calls: prev.calls + 1,
        inputTokens: prev.inputTokens + e.inputTokens,
        outputTokens: prev.outputTokens + e.outputTokens,
        cacheReadInputTokens: prev.cacheReadInputTokens + e.cacheReadInputTokens,
        cacheCreationInputTokens: prev.cacheCreationInputTokens + e.cacheCreationInputTokens,
        durationMs: prev.durationMs + e.durationMs,
        costUsd: prev.costUsd + cost,
      });
    }
    const perModel = [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd);
    type Totals = Omit<ModelAggregate, 'model'> & { model: 'TOTAL' };
    const totals: Totals = perModel.reduce<Totals>(
      (acc, m) => ({
        model: 'TOTAL',
        calls: acc.calls + m.calls,
        inputTokens: acc.inputTokens + m.inputTokens,
        outputTokens: acc.outputTokens + m.outputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + m.cacheReadInputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + m.cacheCreationInputTokens,
        durationMs: acc.durationMs + m.durationMs,
        costUsd: acc.costUsd + m.costUsd,
      }),
      {
        model: 'TOTAL',
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 0,
        costUsd: 0,
      }
    );
    return { perModel, totals };
  }

  /** Human-readable one-page report. */
  formatSummary(): string {
    const s = this.summary();
    const rows = [
      ['model', 'calls', 'in', 'out', 'cache_read', 'cost_usd'],
      ...s.perModel.map((m) => [
        m.model,
        String(m.calls),
        String(m.inputTokens),
        String(m.outputTokens),
        String(m.cacheReadInputTokens),
        m.costUsd.toFixed(4),
      ]),
      [
        'TOTAL',
        String(s.totals.calls),
        String(s.totals.inputTokens),
        String(s.totals.outputTokens),
        String(s.totals.cacheReadInputTokens),
        s.totals.costUsd.toFixed(4),
      ],
    ];
    const widths = rows[0]!.map((_, col) =>
      Math.max(...rows.map((r) => r[col]!.length))
    );
    const fmt = (r: string[]): string =>
      r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
    const divider = widths.map((w) => '-'.repeat(w)).join('  ');
    return [fmt(rows[0]!), divider, ...rows.slice(1, -1).map(fmt), divider, fmt(rows[rows.length - 1]!)].join('\n');
  }
}

/**
 * Decorator LlmClient that forwards every request to an inner client and
 * records timing + usage to a MetricsRecorder. Compose around AnthropicLlmClient
 * when you want observability; leave it off in tests that don't need metrics.
 */
export class MetricsLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly recorder: MetricsRecorder
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const started = Date.now();
    let resp: LlmCompletionResponse;
    try {
      resp = await this.inner.complete(req);
    } catch (err) {
      // Record the failed call WITH whatever usage the loop aggregated
      // before dying (attached by each transport's raise path). Zeros meant
      // a run killed on round 7 of a tool loop reported none of the six
      // rounds it PAID for — burn-in rows showed llm=? / cost=null and
      // the curve understated exactly the runs that hurt most.
      const partial = partialUsageOf(err);
      this.recorder.record({
        model: req.model,
        requestedModel: req.model,
        inputTokens: partial?.inputTokens ?? 0,
        outputTokens: partial?.outputTokens ?? 0,
        cacheCreationInputTokens: partial?.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: partial?.cacheReadInputTokens ?? 0,
        durationMs: Date.now() - started,
        stopReason: 'error',
      });
      throw err;
    }
    this.recorder.record({
      // Price on the model the transport ACTUALLY invoked, not the tier
      // pin: `codex:claude-opus-5` served gpt-5.6-sol tokens but hit the
      // /opus/i price row, Ollama collapses every pin onto its configured
      // defaultModel, claude-cli maps pins onto aliases (review 2026-08-14
      // §1.13). Transports that serve req.model verbatim omit servedModel.
      model: resp.servedModel ?? req.model,
      // A failed call keeps its partial tokens AND its payer; so does this one.
      requestedModel: req.model,
      inputTokens: resp.usage.inputTokens,
      outputTokens: resp.usage.outputTokens,
      cacheCreationInputTokens: resp.usage.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: resp.usage.cacheReadInputTokens ?? 0,
      durationMs: Date.now() - started,
      stopReason: resp.stopReason,
    });
    return resp;
  }
}
