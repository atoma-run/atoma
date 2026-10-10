import { tryParseModelSelector } from './modelSelector.js';

/**
 * Where a run's money went, by the MODEL PIN that served each call — L1, L2,
 * L3 — plus Jev, whose decisions are priced on their own and are NOT folded
 * into the run's `totals` (`VizJevEvent`). One definition, written by the
 * project control plane from a trace and read by the Projects overview.
 *
 * A call is attributed to the tier whose pin served it, not to the rank it
 * spoke for: `run-root` judges for L3 on the L1 or L2 pin, and the bill is the
 * pin's. When several tiers share one pin the call's own rank breaks the tie
 * if it is one of them; a model no pin names (a fallback, or a trace recorded
 * before `tierModels`) falls back to that rank. A call with neither lands in
 * `other`, so the slices always sum to what the trace recorded.
 */
export const COST_SLICE_KEYS = ['l1', 'l2', 'l3', 'jev', 'other'] as const;
export type CostSliceKey = (typeof COST_SLICE_KEYS)[number];

export interface CostSliceModel {
  readonly model: string;
  readonly calls: number;
  readonly costUsd: number;
}

export interface CostSliceRole {
  readonly role: string;
  readonly calls: number;
  readonly costUsd: number;
}

export interface CostSlice {
  /** LLM completions, or Jev decisions for the `jev` slice. */
  readonly calls: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** Jev HTTP requests, retries included; absent where none was recorded. */
  readonly requests?: number;
  /** Most expensive first. */
  readonly models: readonly CostSliceModel[];
  /** Most expensive first. */
  readonly roles: readonly CostSliceRole[];
}

export type RunCostBreakdown = Readonly<Record<CostSliceKey, CostSlice>>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface SliceAccumulator {
  slice: Mutable<Omit<CostSlice, 'models' | 'roles'>>;
  models: Map<string, Mutable<CostSliceModel>>;
  roles: Map<string, Mutable<CostSliceRole>>;
}

const TIER_KEYS = ['l1', 'l2', 'l3'] as const;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyAccumulator(): SliceAccumulator {
  return {
    slice: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    models: new Map(),
    roles: new Map(),
  };
}

function add(target: SliceAccumulator, model: string, role: string, costUsd: number, usage: Record<string, unknown>): void {
  target.slice.calls += 1;
  target.slice.costUsd += costUsd;
  target.slice.inputTokens += amount(usage['inputTokens']);
  target.slice.outputTokens += amount(usage['outputTokens']);
  target.slice.cacheReadInputTokens += amount(usage['cacheReadInputTokens']);
  target.slice.cacheCreationInputTokens += amount(usage['cacheCreationInputTokens']);
  const byModel = target.models.get(model) ?? { model, calls: 0, costUsd: 0 };
  byModel.calls += 1;
  byModel.costUsd += costUsd;
  target.models.set(model, byModel);
  const byRole = target.roles.get(role) ?? { role, calls: 0, costUsd: 0 };
  byRole.calls += 1;
  byRole.costUsd += costUsd;
  target.roles.set(role, byRole);
}

function byCost<T extends { costUsd: number; calls: number }>(values: Iterable<T>): T[] {
  return [...values].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

function finish(accumulator: SliceAccumulator): CostSlice {
  return { ...accumulator.slice, models: byCost(accumulator.models.values()), roles: byCost(accumulator.roles.values()) };
}

/** The pin's model, matched both as a full selector and as its bare model id. */
function pinIdentities(selector: unknown): string[] {
  if (typeof selector !== 'string' || selector.length === 0) return [];
  const parsed = tryParseModelSelector(selector);
  return parsed ? [selector, parsed.model] : [selector];
}

function tierOfCall(model: string, rank: unknown, pins: ReadonlyMap<string, ReadonlySet<CostSliceKey>>): CostSliceKey {
  const own = typeof rank === 'number' && rank >= 1 && rank <= 3 ? TIER_KEYS[rank - 1]! : null;
  const matching = pins.get(model) ?? pins.get(tryParseModelSelector(model)?.model ?? '');
  if (matching && matching.size > 0) {
    if (own && matching.has(own)) return own;
    return TIER_KEYS.find(key => matching.has(key)) ?? own ?? 'other';
  }
  return own ?? 'other';
}

/** Attribute every priced call of one parsed trace document. */
export function runCostBreakdown(trace: unknown): RunCostBreakdown {
  const run = object(trace);
  const pins = new Map<string, Set<CostSliceKey>>();
  const tierModels = object(run['tierModels']);
  for (const key of TIER_KEYS) {
    for (const identity of pinIdentities(tierModels[key])) {
      const tiers = pins.get(identity) ?? new Set<CostSliceKey>();
      tiers.add(key);
      pins.set(identity, tiers);
    }
  }
  const slices = Object.fromEntries(COST_SLICE_KEYS.map(key => [key, emptyAccumulator()])) as Record<CostSliceKey, SliceAccumulator>;
  const events = Array.isArray(run['events']) ? run['events'] : [];
  let requests = 0;
  for (const raw of events) {
    const event = object(raw);
    const role = typeof event['role'] === 'string' && event['role'] ? event['role'] : 'unknown';
    if (event['kind'] === 'llm') {
      const model = typeof event['model'] === 'string' && event['model'] ? event['model'] : 'unknown';
      const key = tierOfCall(model, object(event['actor'])['tier'], pins);
      // The served model is what the call was priced on; the pin stays the attribution.
      const served = typeof event['servedModel'] === 'string' && event['servedModel'] ? event['servedModel'] : model;
      add(slices[key], served, role, amount(event['costUsd']), object(event['usage']));
    } else if (event['kind'] === 'jev') {
      const model = typeof event['servedModel'] === 'string' && event['servedModel'] ? event['servedModel']
        : typeof event['evaluator'] === 'string' && event['evaluator'] ? event['evaluator'] : 'jev';
      add(slices.jev, model, role, amount(event['costUsd']), object(event['usage']));
      const count = event['requestCount'];
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) requests += count;
    }
  }
  const result = Object.fromEntries(COST_SLICE_KEYS.map(key => [key, finish(slices[key])])) as Record<CostSliceKey, CostSlice>;
  if (requests > 0) result.jev = { ...result.jev, requests };
  return result;
}
