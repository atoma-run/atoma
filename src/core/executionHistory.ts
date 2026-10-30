import { transportWitnesses } from '../contracts/witness.js';
import type { AttestationRecord } from '../contracts/attestation.js';
import type { Result, RunContext } from './types.js';

/** Diagnostic context from earlier executions, never current proof or credit. */
export function historicalExecutionRecords(ctx: RunContext, ids: readonly string[] = []): AttestationRecord[] {
  return [...new Set(ids)].flatMap(id => {
    const record = ctx.attestations?.get(id);
    return record && !record.historical && (record.attempt ?? 1) === (ctx.attempt ?? 1) &&
      record.observation.kind === 'execution' && !['read_file', 'host_read_file'].includes(record.tool)
      ? [record] : [];
  });
}

/** Only references actually carried by this execution; never scan other branches. */
export function executionHistoryIds(ctx: RunContext, result: Result): string[] {
  return historicalExecutionRecords(ctx, [...(result.historicalEvidenceIds ?? []),
    ...transportWitnesses(result.evidence).map(witness => witness.eventId)]).map(record => record.eventId);
}
