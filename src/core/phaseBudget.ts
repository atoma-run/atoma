import type { Result } from './types.js';

/**
 * ONE LADDER PER ROOT PHASE (owner decision 2026-10-10: judge what exists).
 *
 * The supervise ladders nest: a cell retries its molecule, branches it, falls
 * back to itself, and the tissue above may reject the phase and run that whole
 * ladder again. Run bad74240 spent ~1,100 s on its first phase (six molecule
 * executions and the cell's fallback), then the tissue refused it and ran the
 * ladder again: 27 executions, 404 browser checks, 4,222 s for the run.
 *
 * When a ROOT phase's result is the cell's own fallback — its ladder is spent
 * — and the tissue refuses it, the tissue no longer re-runs the phase: that
 * result, the whole phase's, goes up marked, and root acceptance judges what
 * exists (`phase-budget-spent` forces its review). A counter was built first
 * and refused in review: one budget per phase starved healthy multi-subtask
 * phases and handed up a fragment instead of the phase.
 */
export const PHASE_BUDGET_SPENT_PREFIX = '[PHASE LADDER SPENT';

/** True when the cell answering this root phase already used its own fallback. */
export function ladderSpent(result: Result, cellName: string): boolean {
  return result.producedBy.viaFallback && result.producedBy.tier === 2 && result.producedBy.name === cellName;
}

/** The refused phase result, unjudged, for root acceptance to judge. */
export function spentPhaseResult(result: Result, refusal: string): Result {
  return {
    ...result,
    summary: `${PHASE_BUDGET_SPENT_PREFIX}: the cell's retries, branch and fallback ran, and the tissue still refused this result ` +
      `(${refusal.slice(0, 300)}); it is handed up unjudged]\n${result.summary}`,
    phaseBudgetSpent: true,
  };
}
