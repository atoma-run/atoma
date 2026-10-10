import type { VizProjectRun } from '../client/types.js';
import type {
  CostSlice, CostSliceKey, CostSliceModel, CostSliceRole,
} from '../../contracts/runCostBreakdown.js';

/**
 * A project's general view, aggregated from the run list the Projects screen
 * already holds — no second request, no second definition of a run's cost.
 * Pixi-free on purpose, so the numbers are tested without a renderer.
 *
 * Two cost figures exist and they are not the same quantity. `llmCostUsd`
 * sums each run's recorded LLM total (its epilogue, else its trace), as every
 * run row shows it. The pie sums the per-call breakdown of the traces that are
 * still readable, AND Jev, which a run's total never included. The overview
 * says which runs the pie covers rather than pretending the two agree.
 */

export const OVERVIEW_SLICE_ORDER = ['l1', 'l2', 'l3', 'jev', 'other'] as const satisfies readonly CostSliceKey[];
const TIER_SLICES = ['l1', 'l2', 'l3'] as const;

/** One model's share of a tier, with when it first worked there. */
export interface OverviewSliceModel extends CostSliceModel {
  /** Runs in which this model served this tier. */
  readonly runs: number;
  readonly firstRunAt: string;
}

export interface OverviewSlice extends Omit<CostSlice, 'models'> {
  /** Most expensive first, for reading. */
  readonly models: readonly OverviewSliceModel[];
  /**
   * The same models in the order they FIRST served this tier: the order the
   * donut shades them in, so a model keeps its shade as spend accrues — colour
   * follows the entity, never its rank.
   */
  readonly modelsByFirstUse: readonly OverviewSliceModel[];
  readonly key: CostSliceKey;
  /** Share of the breakdown total, 0..1. */
  readonly share: number;
  /** Runs that spent anything on this slice. */
  readonly runs: number;
  /** The selectors this tier was pinned to, with the number of runs on each. */
  readonly pins: ReadonlyArray<{ readonly selection: string; readonly runs: number }>;
  /** Who paid for this tier, with the number of runs each. */
  readonly payers: ReadonlyArray<{ readonly payer: string; readonly runs: number }>;
}

export interface OverviewRequester {
  readonly principalId: string;
  readonly name: string;
  readonly runs: number;
  readonly costUsd: number;
  readonly lastRunAt: string;
}

export interface ProjectOverview {
  readonly runCount: number;
  readonly statusCounts: Readonly<Record<VizProjectRun['status'], number>>;
  readonly reruns: number;
  readonly published: number;
  readonly firstRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly totalDurationS: number;
  readonly medianDurationS: number | null;
  /** Sum of the runs' recorded LLM totals; null when no run recorded one. */
  readonly llmCostUsd: number | null;
  readonly tokens: number;
  readonly llmCalls: number;
  readonly jevCalls: number;
  readonly jevCallsLowerBound: boolean;
  readonly requesters: readonly OverviewRequester[];
  /** Slices with spend, in `OVERVIEW_SLICE_ORDER`. */
  readonly slices: readonly OverviewSlice[];
  readonly breakdownTotalUsd: number;
  /** Runs whose trace gave a breakdown, of `runCount`. */
  readonly breakdownRuns: number;
  /** Some tier ran on a subscription: its cost is a list-price equivalent, not a charge. */
  readonly subscriptionPriced: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function mergeNamed<T extends CostSliceRole>(target: Map<string, Mutable<T>>, values: readonly T[],
  name: (value: T) => string): void {
  for (const value of values) {
    const key = name(value);
    const existing = target.get(key);
    if (existing) {
      existing.calls += value.calls;
      existing.costUsd += value.costUsd;
    } else {
      target.set(key, { ...value });
    }
  }
}

function count<K extends string>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts<K extends string>(map: Map<K, number>): Array<[K, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const SUBSCRIPTION_PAYERS = new Set(['host-subscription', 'principal-subscription']);

export function projectOverview(runs: readonly VizProjectRun[], unknownName: string): ProjectOverview {
  const statusCounts: Mutable<ProjectOverview['statusCounts']> = {
    queued: 0, running: 0, delivered: 0, partial: 0, failed: 0, cancelled: 0,
  };
  let reruns = 0;
  let published = 0;
  let firstRunAt: string | null = null;
  let lastRunAt: string | null = null;
  let totalDurationS = 0;
  const durations: number[] = [];
  let llmCostUsd: number | null = null;
  let tokens = 0;
  let llmCalls = 0;
  let jevCalls = 0;
  let jevCallsLowerBound = false;
  let breakdownRuns = 0;
  let subscriptionPriced = false;
  const requesters = new Map<string, Mutable<OverviewRequester>>();
  const slices = new Map<CostSliceKey, {
    totals: Mutable<Omit<CostSlice, 'models' | 'roles'>>;
    models: Map<string, Mutable<OverviewSliceModel>>;
    roles: Map<string, Mutable<CostSliceRole>>;
    runs: number;
    pins: Map<string, number>;
    payers: Map<string, number>;
  }>();
  const slice = (key: CostSliceKey) => {
    let entry = slices.get(key);
    if (!entry) {
      entry = {
        totals: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        models: new Map(), roles: new Map(), runs: 0, pins: new Map(), payers: new Map(),
      };
      slices.set(key, entry);
    }
    return entry;
  };

  for (const run of runs) {
    statusCounts[run.status] += 1;
    if (run.rerunOf) reruns += 1;
    if (run.publication?.status === 'published') published += 1;
    if (firstRunAt === null || run.createdAt < firstRunAt) firstRunAt = run.createdAt;
    if (lastRunAt === null || run.createdAt > lastRunAt) lastRunAt = run.createdAt;
    if (run.durationS != null && Number.isFinite(run.durationS)) {
      totalDurationS += run.durationS;
      durations.push(run.durationS);
    }
    if (run.costUsd != null) llmCostUsd = (llmCostUsd ?? 0) + run.costUsd;
    tokens += run.tokens ?? 0;
    llmCalls += run.llmCalls ?? 0;
    jevCalls += run.jevCalls ?? 0;
    if (run.jevCallsLowerBound) jevCallsLowerBound = true;

    const principalId = run.requestedByPrincipalId ?? '';
    const requester = requesters.get(principalId) ?? {
      principalId, name: run.requestedByName || unknownName, runs: 0, costUsd: 0, lastRunAt: run.createdAt,
    };
    requester.runs += 1;
    requester.costUsd += run.costUsd ?? 0;
    if (run.createdAt > requester.lastRunAt) requester.lastRunAt = run.createdAt;
    requesters.set(principalId, requester);

    for (const key of TIER_SLICES) {
      const row = run.models?.[key];
      if (!row) continue;
      count(slice(key).pins, row.selection);
      count(slice(key).payers, row.payer);
    }
    const breakdown = run.costBreakdown;
    if (!breakdown) continue;
    breakdownRuns += 1;
    for (const key of OVERVIEW_SLICE_ORDER) {
      const part = breakdown[key];
      if (!part || (part.calls === 0 && part.costUsd === 0)) continue;
      const entry = slice(key);
      entry.runs += 1;
      entry.totals.calls += part.calls;
      entry.totals.costUsd += part.costUsd;
      entry.totals.inputTokens += part.inputTokens;
      entry.totals.outputTokens += part.outputTokens;
      entry.totals.cacheReadInputTokens += part.cacheReadInputTokens;
      entry.totals.cacheCreationInputTokens += part.cacheCreationInputTokens;
      if (part.requests !== undefined) entry.totals.requests = (entry.totals.requests ?? 0) + part.requests;
      for (const model of part.models) {
        const existing = entry.models.get(model.model);
        if (existing) {
          existing.calls += model.calls;
          existing.costUsd += model.costUsd;
          existing.runs += 1;
          if (run.createdAt < existing.firstRunAt) existing.firstRunAt = run.createdAt;
        } else {
          entry.models.set(model.model, { ...model, runs: 1, firstRunAt: run.createdAt });
        }
      }
      mergeNamed(entry.roles, part.roles, value => value.role);
      if (key !== 'jev' && key !== 'other' && SUBSCRIPTION_PAYERS.has(run.models?.[key]?.payer ?? '')) subscriptionPriced = true;
    }
  }

  const spent = OVERVIEW_SLICE_ORDER.flatMap(key => {
    const entry = slices.get(key);
    return entry && (entry.totals.costUsd > 0 || entry.totals.calls > 0) ? [{ key, entry }] : [];
  });
  const breakdownTotalUsd = spent.reduce((sum, { entry }) => sum + entry.totals.costUsd, 0);
  const byCost = <T extends { costUsd: number; calls: number }>(values: Iterable<T>) =>
    [...values].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  return {
    runCount: runs.length,
    statusCounts,
    reruns,
    published,
    firstRunAt,
    lastRunAt,
    totalDurationS,
    medianDurationS: median(durations),
    llmCostUsd,
    tokens,
    llmCalls,
    jevCalls,
    jevCallsLowerBound,
    requesters: [...requesters.values()].sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd || a.name.localeCompare(b.name)),
    slices: spent.map(({ key, entry }) => ({
      key,
      ...entry.totals,
      share: breakdownTotalUsd > 0 ? entry.totals.costUsd / breakdownTotalUsd : 0,
      runs: entry.runs,
      models: byCost(entry.models.values()),
      modelsByFirstUse: [...entry.models.values()]
        .sort((a, b) => a.firstRunAt.localeCompare(b.firstRunAt) || b.costUsd - a.costUsd || a.model.localeCompare(b.model)),
      roles: byCost(entry.roles.values()),
      pins: sortedCounts(entry.pins).map(([selection, count]) => ({ selection, runs: count })),
      payers: sortedCounts(entry.payers).map(([payer, count]) => ({ payer, runs: count })),
    })),
    breakdownTotalUsd,
    breakdownRuns,
    subscriptionPriced,
  };
}
