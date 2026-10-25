import { computeResultsWaitingSchema, type ComputeResultsWaiting } from '../../contracts/computeDevice.js';
import type { VizProjectRun } from '../client/types.js';
import type { AuthUiSnapshot } from './session-controller.js';

/**
 * A Compute run whose work ended while its files wait on the requester's
 * computer, as the server stated it (`resultsWaiting`, host facts). Never
 * inferred here from a status or an error: a running run without the field
 * is simply running.
 */
export function computeResultsWaiting(run: VizProjectRun): ComputeResultsWaiting | null {
  if (run.status !== 'running') return null;
  const parsed = computeResultsWaitingSchema.safeParse(run.resultsWaiting);
  return parsed.success ? parsed.data : null;
}

/** The run picker's mark for finished work waiting for its results: waiting, not an alarm. */
export const COMPUTE_RESULTS_WAITING_GLYPH = '◷';

/** The activation id prefix of "Get the results" on a run card, GPU and DOM alike. */
export const COMPUTE_RESULTS_ACTION = 'project.computeResults.';

/** Only the person who started the run may ask for its results: the server's own rule. */
export function canGetComputeResults(run: VizProjectRun, auth: AuthUiSnapshot | null): boolean {
  const viewer = auth?.viewer;
  return computeResultsWaiting(run) !== null && !!viewer?.activeOrganisation &&
    (!run.orgId || run.orgId === viewer.activeOrganisation.id) &&
    viewer.principalId === run.requestedByPrincipalId &&
    ['org:member', 'org:admin', 'org:owner'].includes(viewer.activeOrganisation.role);
}

/**
 * The plain sentence a run card or the run's own page shows: for the person
 * who may press "Get the results" or for another member, and, when the
 * computer is connected and accepting work yet the files did not arrive,
 * the neutral variant: "open Atoma Compute" would be the wrong advice.
 */
export function computeResultsMessageKey(run: VizProjectRun, auth: AuthUiSnapshot | null): string {
  const stalled = computeResultsWaiting(run)?.computerReady === true;
  return canGetComputeResults(run, auth)
    ? stalled ? 'projects.resultsWaiting.stalled' : 'projects.resultsWaiting.message'
    : stalled ? 'projects.resultsWaiting.stalledOther' : 'projects.resultsWaiting.messageOther';
}

/**
 * What a failed "Get the results" request means for the person who pressed
 * it. `working`: a transfer is running (the server's typed 409 `active`, often
 * the automatic one), or the request timed out or lost its connection, whose
 * transfer may still be running; the page refetches instead of asking for a
 * retry. `waiting`: the transfer was tried and nothing moved the files (409
 * `pending`): open Atoma Compute and try again. `cancelling`: the run's
 * cancellation was requested (409 `cancelling`), so its files are never
 * fetched and it closes by itself. `unavailable`: a refusal no
 * computer can change (the requester's access, an archived project, an
 * unavailable server): neutral words, never "open Atoma Compute".
 */
export function computeResultsAttempt(error: unknown): 'working' | 'waiting' | 'cancelling' | 'unavailable' {
  // Duck-typed `ApiHttpError` (status, reason): this module is drawn by the
  // renderer, which stays clear of the data client.
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
  if (status === null) return 'working';
  const reason = 'reason' in (error as object) ? (error as { reason?: unknown }).reason : undefined;
  if (status === 409 && reason === 'active') return 'working';
  if (status === 409 && reason === 'pending') return 'waiting';
  if (status === 409 && reason === 'cancelling') return 'cancelling';
  return status === 502 || status === 504 ? 'working' : 'unavailable';
}

/** The catalog key for a failed "Get the results", by `computeResultsAttempt`. */
export const COMPUTE_RESULTS_ATTEMPT_KEYS = {
  working: 'projects.resultsWaiting.working',
  waiting: 'projects.resultsWaiting.stillWaiting',
  cancelling: 'projects.resultsWaiting.cancelling',
  unavailable: 'projects.resultsWaiting.unavailable',
} as const;

/** How long a "Get the results" outcome stays on a run still waiting, so it can be read. */
export const COMPUTE_RESULTS_NOTICE_HOLD_MS = 10_000;

/**
 * Whether a "Get the results" outcome shown on a run card is out of date,
 * judged only on run data fetched after it was shown (`at`): the run stopped
 * waiting (a transfer took it, or it ended), it started waiting anew (`since`
 * moved), or a poll at least `COMPUTE_RESULTS_NOTICE_HOLD_MS` later still shows
 * it waiting with no transfer running. The card then shows the run's own state.
 */
export function computeResultsNoticeStale(notice: { readonly at: number; readonly waitingSince: string | null },
  run: VizProjectRun | undefined, dataUpdatedAt: number): boolean {
  if (dataUpdatedAt <= notice.at) return false;
  const waiting = run ? computeResultsWaiting(run) : null;
  if (!waiting || waiting.since !== notice.waitingSince) return true;
  return dataUpdatedAt >= notice.at + COMPUTE_RESULTS_NOTICE_HOLD_MS;
}
