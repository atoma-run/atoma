import type { VizProjectRun } from '../client/types.js';

/** The complete project history is newest first; its oldest run is #1.
 * Activity and trace feeds are paged, so they must never define this number.
 * Older traces may name only their trace ID. Unknown runs have no guessed number.
 */
export function projectRunNumber(runs: readonly Pick<VizProjectRun, 'projectRunId' | 'traceId'>[], id: string): number | null {
  const index = runs.findIndex(run => run.projectRunId === id || run.traceId === id);
  return index < 0 ? null : runs.length - index;
}
