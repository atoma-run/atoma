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
 * retry. `waiting`: nothing moved the files; try again later.
 */
export function computeResultsAttempt(error: unknown): 'working' | 'waiting' {
  // Duck-typed `ApiHttpError` (status, reason): this module is drawn by the
  // renderer, which stays clear of the data client.
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
  if (status === null) return 'working';
  if (status === 409) return 'reason' in (error as object) && (error as { reason?: unknown }).reason === 'active' ? 'working' : 'waiting';
  return status === 502 || status === 503 || status === 504 ? 'working' : 'waiting';
}
