import type { Viewer } from '../auth/store.js';
import type { ProjectService } from '../projects/service.js';
import type { ProjectStore } from '../projects/store.js';
import { SUITE_DISPUTE_REPORT_INPUT, parseSuiteDisputeReportArgs, suiteDisputeReport } from '../projects/suiteDisputes.js';

/**
 * `atoma_suite_disputes` — the platform door onto the suite-dispute report
 * (`src/projects/suiteDisputes.ts`), whose other door is
 * `npm run projects -- disputes`. It reads every organisation's run traces,
 * so each organisation is journaled as a cross-organisation `mcp.trace` read
 * BEFORE anything of any organisation is read, exactly as
 * `atoma_jev_calibrate` does; a refused or unavailable audit refuses the call,
 * and arguments it cannot answer are refused before any receipt is written.
 * It writes nothing else and asks no model.
 */

export const SUITE_DISPUTES_INPUT = SUITE_DISPUTE_REPORT_INPUT;

export async function suiteDisputesCall(
  input: {
    readonly projects: { readonly service: ProjectService; readonly store: ProjectStore };
    readonly viewer: Viewer;
    /** Every organisation on the instance, read at call time: a new one is in. */
    readonly orgIds: () => readonly string[];
    readonly signal?: AbortSignal;
  },
  args: unknown
): Promise<Record<string, unknown>> {
  const parsed = parseSuiteDisputeReportArgs(args);
  const orgIds = input.orgIds();
  for (const orgId of orgIds) input.projects.service.auditRead(input.viewer, orgId, 'mcp.trace');
  return suiteDisputeReport(
    { store: input.projects.store, orgIds, ...(input.signal ? { signal: input.signal } : {}) },
    parsed
  );
}
