import { renderObservations, type AttestationRecord } from '../contracts/attestation.js';
import { witnessesFromPayload, type TransportWitness, type Witness } from '../contracts/witness.js';
import type { RunContext } from '../core/types.js';

type BranchView = Pick<RunContext, 'attestations' | 'currentBranchId' | 'attempt'>;

/** How many records this context's branch holds now: where an executor's own calls begin. */
export function branchRecordCount(ctx: BranchView): number {
  return ctx.attestations?.forBranch(ctx.currentBranchId).length ?? 0;
}

/**
 * The evidence an EXECUTOR's result carries, a molecule's or a supervisor's
 * fallback: the probes its output declares, then one witness per call the
 * transport attested in its branch during its attempt, from record `since`
 * on, rendered together so a repeated smoke is written out once.
 *
 * A fallback passes `since`: it runs in the branch of the molecules it
 * replaces, and what they observed is not its work. Its result carried no
 * evidence at all until run ff102525 (2026-10-01), whose tissue validator saw
 * none of a cell fallback's five browser checks and refused a correct result
 * as narration.
 */
export function executorEvidence(
  output: unknown,
  ctx: BranchView,
  since = 0,
  /** Narrows the branch's records to one execution's, when the branch is shared. */
  keep: (record: AttestationRecord) => boolean = () => true
): Witness[] {
  const records = (ctx.attestations?.forBranch(ctx.currentBranchId) ?? [])
    .slice(since)
    .filter((record) => (record.attempt ?? 1) === (ctx.attempt ?? 1) && keep(record));
  const lines = renderObservations(records);
  return [
    ...witnessesFromPayload({ output }),
    ...records.map((record, index): Witness => ({
      source: 'transport-observed',
      eventId: record.eventId,
      tool: record.tool,
      observed: lines[index]!,
      ...(record.observation.kind === 'browser' ? { browser: browserFacts(record.observation) } : {}),
    })),
  ];
}

/** What evidence selection reads of a browser observation (`renderTransportEvidence`). */
function browserFacts(observation: Extract<AttestationRecord['observation'], { kind: 'browser' }>): NonNullable<TransportWitness['browser']> {
  return {
    ok: observation.ok,
    // The runtime's executed log, never the request: two calls are one check
    // when the page received the same actions under the same smoke and size.
    check: JSON.stringify([observation.executedInteractions, observation.smoke ?? null, observation.viewport ?? null]),
    ...(observation.document ? { document: { path: observation.document.path, sha256: observation.document.sha256 } } : {}),
  };
}
