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
