import { DEFAULT_MAX_TOOL_ITERATIONS } from './llm.js';
import {
  DEFAULT_PRICES,
  estimateCostUsd,
  pricesFor,
  type LlmCallMetrics,
  type MetricsRecorder,
  type PriceTable,
} from './metrics.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from './types.js';

/**
 * WHAT ONE RUN MAY SPEND ON THE LLM, ENFORCED WHILE IT SPENDS IT.
 * ===============================================================
 *
 * The wall-clock budget has always been enforceable because a deadline is a
 * timer: `AbortSignal.timeout` fires whether or not anything is looking. A
 * TOKEN or a SPEND ceiling has no timer — it is only knowable after a call
 * comes back — so until this module the only thing the platform could do
 * about a run consuming 40M tokens was notice afterwards, or notice from the
 * sentinel and journal an anomaly nothing acted on.
 *
 * TWO PIECES, AND THEY ENFORCE AT THE TWO PLACES THE NUMBERS ARE KNOWN.
 *
 *   - `RunBudgetMeter` is a `MetricsRecorder` DECORATOR, not a client. Every
 *     LLM call in a run already flows through `MetricsLlmClient`, which
 *     records the successful call AND the partial usage of a failed one, so
 *     wrapping the recorder is how the meter sees everything the run paid for
 *     without a second accounting path. It reuses `estimateCostUsd` and
 *     `pricesFor` — the ONE cost formula, per the root contract — so a run
 *     cancelled for spending $5 and the summary printed beside it can never
 *     disagree about what $5 meant.
 *   - `ToolIterationCeilingLlmClient` is a client decorator, because a
 *     tool-loop budget is a REQUEST field and the only moment to bound it is
 *     before the transport reads it.
 *
 * ABORT, DON'T THROW. A recorder that threw would surface a budget decision
 * as a transport error from whichever call happened to cross the line, and
 * `MetricsLlmClient` would have already recorded it. Instead the meter calls
 * `onExceeded` ONCE and the runner aborts the run's own controller: the
 * in-flight calls stop on the signal they already listen to, the trace closes
 * through the path that closes it for a timeout, and the reason is a typed
 * error the failure path can name instead of "This operation was aborted".
 *
 * WHAT THE COST CEILING MEANS ON A SUBSCRIPTION. The same thing every other
 * cost figure in this repository means there: what the tokens WOULD cost at
 * API list prices. Nothing is charged per token on a subscription, so a
 * ceiling denominated in dollars is a proxy for consumption — which is what
 * an operator asking "cap a runaway run" wants, and it is the same number the
 * sentinel's cost alert and the run summary already show.
 */

export type RunBudgetKind = 'tokens' | 'cost';

export class RunBudgetExceededError extends Error {
  readonly kind: RunBudgetKind;
  readonly observed: number;
  readonly ceiling: number;

  constructor(kind: RunBudgetKind, observed: number, ceiling: number) {
    super(
      kind === 'tokens'
        ? `run token ceiling exceeded: ${observed} tokens consumed, limit ${ceiling}`
        : `run cost ceiling exceeded: $${observed.toFixed(4)} estimated, limit $${ceiling.toFixed(2)}`
    );
    this.name = 'RunBudgetExceededError';
    this.kind = kind;
    this.observed = observed;
    this.ceiling = ceiling;
  }
}

export interface RunBudgetCeilings {
  /** Billable tokens across the run, or null for no ceiling. */
  readonly tokens: number | null;
  /** Estimated USD across the run, or null for no ceiling. */
  readonly costUsd: number | null;
}

/**
 * BILLABLE TOKENS OF ONE CALL — all four counters.
 *
 * Anthropic's counters are DISJOINT (`input_tokens` is only the content after
 * the last cache breakpoint), so summing them is the total the call moved, and
 * summing only input+output would undercount a cache-heavy run by most of its
 * volume. A cached read is cheaper, not free; the cost ceiling is where price
 * differences belong.
 */
export function billableTokensOf(call: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}): number {
  return (
    call.inputTokens +
    call.outputTokens +
    call.cacheCreationInputTokens +
    call.cacheReadInputTokens
  );
}

export class RunBudgetMeter implements MetricsRecorder {
  private readonly inner: MetricsRecorder;
  private readonly ceilings: RunBudgetCeilings;
  private readonly prices: PriceTable;
  private readonly onExceeded: (error: RunBudgetExceededError) => void;
  private tokens = 0;
  private costUsd = 0;
  private fired = false;

  constructor(
    inner: MetricsRecorder,
    ceilings: RunBudgetCeilings,
    onExceeded: (error: RunBudgetExceededError) => void,
    prices: PriceTable = DEFAULT_PRICES
  ) {
    this.inner = inner;
    this.ceilings = ceilings;
    this.onExceeded = onExceeded;
    this.prices = prices;
  }

  /** Consumption so far, for a caller that wants to report it. */
  consumed(): { tokens: number; costUsd: number } {
    return { tokens: this.tokens, costUsd: this.costUsd };
  }

  record(call: LlmCallMetrics): void {
    // The inner recorder FIRST and unconditionally: the run summary, the CSV
    // and the trace must carry the call that crossed the line, not stop one
    // call short of the evidence for the cancellation.
    this.inner.record(call);
    this.tokens += billableTokensOf(call);
    this.costUsd += estimateCostUsd(call, pricesFor(call.model, this.prices));
    if (this.fired) return;
    // ONCE. A run keeps calling for as long as it takes the abort to land,
    // and an operator does not need four rows saying the same thing.
    const { tokens, costUsd } = this.ceilings;
    if (tokens !== null && this.tokens > tokens) {
      this.fired = true;
      this.onExceeded(new RunBudgetExceededError('tokens', this.tokens, tokens));
      return;
    }
    if (costUsd !== null && this.costUsd > costUsd) {
      this.fired = true;
      this.onExceeded(new RunBudgetExceededError('cost', this.costUsd, costUsd));
    }
  }
}

/**
 * Lower a request's tool-loop budget to the platform ceiling. NEVER raises
 * one: a request that named no budget is bounded by
 * `min(ceiling, DEFAULT_MAX_TOOL_ITERATIONS)`, because setting it to the
 * ceiling outright would hand a 24-iteration transport default a 50-iteration
 * loop the moment an admin stated a ceiling of 50 — a limit that increased
 * spend is not a limit.
 */
export function capRequestedToolIterations(
  requested: number | undefined,
  ceiling: number | null
): number | undefined {
  if (ceiling === null) return requested;
  const bound = Math.max(1, Math.floor(ceiling));
  if (requested === undefined) return Math.min(bound, DEFAULT_MAX_TOOL_ITERATIONS);
  return Math.min(requested, bound);
}

export class ToolIterationCeilingLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly ceiling: number | null
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const capped = capRequestedToolIterations(req.maxToolIterations, this.ceiling);
    if (capped === req.maxToolIterations) return this.inner.complete(req);
    return this.inner.complete(
      capped === undefined ? req : { ...req, maxToolIterations: capped }
    );
  }
}
