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
 * A root phase's ladder is SPENT when a supervise loop under its cell actually
 * returned the cell's last-resort fallback — for the phase itself, for any of
 * its subtasks, or under a peer the cell mutualized the phase to. The fact is
 * typed (`Result.spentLadder`), written where a ladder ends (`superviseLoop`'s
 * fallback return), carried onto an aggregate (`withSpentLadder`) and through
 * a mutualization (`relayPeerLadder`). When the tissue refuses such a phase
 * AND root acceptance will judge the run (`RunContext.rootAcceptance`), it
 * does not re-run it: the whole phase goes up marked, and root acceptance
 * judges what exists (`phase-budget-spent` forces its review). Without a root
 * judge the tissue retries, as before: a hand-up would be delivered unread.
 *
 * Not the counter refused in review (aa6b2956): one budget per phase stopped
 * work before any rung was spent, starved healthy multi-subtask phases and
 * handed up a fragment. This rule counts nothing — every subtask keeps its
 * whole ladder — fires only after a fallback rung ran, hands up the whole
 * aggregate, and is read once the dispatch has settled. Until group G3
 * (review 2026-10-16) it read `producedBy` and a landing-only field, so a plan
 * `[A, C]` without dependencies whose A fell back re-ran the whole ladder, and
 * so did a phase whose cell mutualized to a peer that fell back.
 */
export const PHASE_BUDGET_SPENT_PREFIX = '[PHASE LADDER SPENT';

type SpentLadder = NonNullable<Result['spentLadder']>;

/**
 * Provenance only: the WHOLE result is this atom's own fallback, returned
 * unvalidated by the supervise loop it ran under. Every reader that asks
 * "is this the dispatcher's own, unjudged fallback" uses this one predicate;
 * a plain `viaFallback` is not enough, because an approved N=1 pass-through of
 * a cell's fallback carries it too. It does NOT prove a ladder ended — that is
 * `spentLadder`.
 */
export function isOwnFallback(result: Result, atomName: string): boolean {
  return result.producedBy.viaFallback && result.producedBy.name === atomName;
}

/**
 * An aggregate rebuilt from sub-results loses their fields: put back the one
 * stamp that names the aggregating atom, as the union of the tasks whose
 * ladder ended in its fallback. A stamp naming anyone else is not this atom's
 * ladder and stays below. The N=1 pass-through keeps the stamp by itself.
 */
export function withSpentLadder(aggregate: Result, subResults: readonly Result[], atomName: string): Result {
  const own = subResults.map((result) => result.spentLadder).filter((stamp): stamp is SpentLadder => stamp?.by === atomName);
  if (own.length === 0) return aggregate;
  const on = [...new Set([...(aggregate.spentLadder?.by === atomName ? aggregate.spentLadder.on : []), ...own.flatMap((stamp) => stamp.on)])];
  const via = own.find((stamp) => stamp.via !== undefined)?.via;
  return { ...aggregate, spentLadder: { by: atomName, on, ...(via !== undefined ? { via } : {}) } };
}

/**
 * A cell that mutualized a task to a peer returns the peer's result as it is,
 * and the peer's ladder is what ran. Re-address the peer's stamp to the cell,
 * naming the peer, so the cell's supervisor reads one fact; anything else
 * passes through unchanged. Chains compose: the first peer stays named.
 */
export function relayPeerLadder(result: Result, peerName: string, relayName: string): Result {
  const stamp = result.spentLadder;
  if (stamp?.by !== peerName) return result;
  return { ...result, spentLadder: { ...stamp, by: relayName, via: stamp.via ?? peerName } };
}

/** True when the cell answering this root phase spent its ladder on it (see the header). */
export function ladderSpent(result: Result, cellName: string): boolean {
  return result.spentLadder?.by === cellName;
}

const SPENT_ON_ITEM_MAX = 120;
const SPENT_ON_ITEMS_SHOWN = 3;

/** The tasks a stamp names, bounded for a prompt: three at most, each cut at 120 characters. */
export function spentOn(on: readonly string[]): string {
  const shown = on.slice(0, SPENT_ON_ITEMS_SHOWN)
    .map((description) => JSON.stringify(description.length > SPENT_ON_ITEM_MAX ? `${description.slice(0, SPENT_ON_ITEM_MAX - 1)}…` : description));
  const more = on.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * The refused phase result, unjudged, for root acceptance to judge. The clause
 * is rendered from the typed stamp only, so it is true in every shape: whose
 * ladder ended, on which tasks, and through which peer.
 */
export function spentPhaseResult(result: Result, refusal: string): Result {
  const stamp = result.spentLadder;
  const where = stamp
    ? `${stamp.by}'s ladder ended in its last-resort fallback on ${spentOn(stamp.on)}` +
      (stamp.via !== undefined ? ` (in ${stamp.via}, to which ${stamp.by} delegated this phase)` : '')
    : "the cell's ladder ended in its last-resort fallback";
  return {
    ...result,
    summary: `${PHASE_BUDGET_SPENT_PREFIX}: ${where}, and the tissue still refused this result ` +
      `(${refusal.slice(0, 300)}); it is handed up unjudged]\n${result.summary}`,
    phaseBudgetSpent: true,
  };
}
