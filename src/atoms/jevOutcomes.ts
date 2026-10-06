import { RUN_ACTORS } from '../contracts/runActors.js';

/** Read-only outcome correlations. Later run failures are signals, never proof Jev caused them. */
export function jevOutcomeReport(trace: unknown, runId: string) {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const run = object(trace);
  const events = Array.isArray(run['events']) ? run['events'].map(object) : [];
  const amount = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const median = (values: number[]): number | null => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length ? (values[middle]! + values[Math.floor((values.length - 1) / 2)]!) / 2 : null;
  };
  const jev = events.filter((event) => event['kind'] === 'jev');
  const roles = [...new Set(jev.map((event) => String(event['role'])))];
  const isExecute = (event: Record<string, unknown>): boolean =>
    event['kind'] === 'llm' && (event['role'] === 'execute' || event['role'] === 'fallback-execute');
  // One row per execution-effort decision (benchmark/jev-effort-2026-10-06/):
  // what Jev read, whether it was applied, held out or withheld, the effort
  // the execute call was actually given, and what became of that execution —
  // the next credit or blame of the molecule, or another execution in its lane.
  const effort = events.flatMap((event, index) => {
    if (event['kind'] !== 'jev' || event['role'] !== 'execute-effort') return [];
    const atom = object(event['actor'])['name'];
    const branchId = event['branchId'];
    const outcome = String(event['outcome']);
    const read = object(event['answer'])['choice'];
    const arm = outcome.startsWith('effort ') ? 'applied'
      : outcome.startsWith('default effort (held out') ? 'held-out'
        : outcome.startsWith('default effort (retry') ? 'retry'
          : event['failure'] != null ? 'failed' : 'undecided';
    const at = events.findIndex((candidate, position) => position > index && candidate['kind'] === 'llm' &&
      candidate['role'] === 'execute' && object(candidate['actor'])['name'] === atom && candidate['branchId'] === branchId);
    const execute = at >= 0 ? events[at]! : undefined;
    let result: 'approved' | 'refused' | 'unknown' = 'unknown';
    for (const later of execute ? events.slice(at + 1) : []) {
      if (later['kind'] === 'registry' && later['name'] === atom && (later['op'] === 'recordSuccess' || later['op'] === 'recordFailure')) {
        result = later['op'] === 'recordSuccess' ? 'approved' : 'refused';
        break;
      }
      if (isExecute(later) && later['branchId'] === branchId) {
        result = 'refused';
        break;
      }
    }
    const given = execute?.['effort'];
    // A later attempt depends on the one before it: the measurement compares first attempts.
    const firstAttempt = !events.slice(0, index).some((earlier) => isExecute(earlier) && earlier['branchId'] === branchId &&
      object(earlier['actor'])['name'] === atom);
    return [{
      eventId: event['id'], branchId: branchId ?? null, atom: typeof atom === 'string' ? atom : null,
      read: typeof read === 'string' ? read : null, arm, firstAttempt,
      given: typeof given === 'string' ? given : null,
      executeEventId: execute?.['id'] ?? null,
      executeDurationMs: execute ? amount(execute['durationMs']) : null,
      executeOutputTokens: execute ? amount(object(execute['usage'])['outputTokens']) : null,
      result,
    }];
  });
  return {
    runId,
    startedAt: typeof run['startedAt'] === 'string' ? run['startedAt'] : null,
    roles: roles.map((role) => {
      const rows = jev.filter((event) => event['role'] === role);
      const model = events.filter((event) => event['kind'] === 'llm' && event['role'] === role && object(event['actor'])['name'] !== RUN_ACTORS.root.name);
      const audits = events.filter((event) => event['kind'] === 'llm' && event['role'] === 'jev-audit' &&
        event['subject'] === (role === 'validate-plan' ? 'PLAN' : role === 'validate-result' ? 'RESULT' : undefined));
      const avoided = rows.filter((event) => event['outcome'] === 'approved' ||
        (role === 'prefilter' && object(event['actor'])['tier'] !== 3 &&
          /^(picked |escalate)/.test(String(event['outcome'])))).length;
      const baselineCosts = model.filter((event) => typeof event['costUsd'] === 'number').map((event) => amount(event['costUsd']));
      const baseline = median(baselineCosts);
      const jevCostUsd = rows.reduce((sum, event) => sum + amount(event['costUsd']), 0);
      const auditCostUsd = audits.reduce((sum, event) => sum + amount(event['costUsd']), 0);
      const modelFallbackCostUsd = model.reduce((sum, event) => sum + amount(event['costUsd']), 0);
      return { role, calls: rows.length, avoidedModelCalls: avoided,
        failures: rows.filter((event) => event['failure'] != null).length,
        medianDurationMs: median(rows.map((event) => amount(event['durationMs']))),
        jevCostUsd, auditCostUsd, modelFallbackCostUsd,
        measuredTotalCostUsd: jevCostUsd + auditCostUsd + modelFallbackCostUsd,
        baselineSamples: baselineCosts.length, baselineMedianCostUsd: baseline,
        estimatedNetSavingUsd: baseline === null ? null : avoided * baseline - jevCostUsd - auditCostUsd };
    }),
    effortCount: effort.length,
    effort: effort.slice(-100),
    approvalCount: jev.filter((event) => event['outcome'] === 'approved').length,
    approvals: events.map((event, index) => ({ event, index }))
      .filter(({ event }) => event['kind'] === 'jev' && event['outcome'] === 'approved').slice(-100).map(({ event, index }) => {
      const later = events.slice(index + 1);
      const related = later.filter((candidate) => candidate['branchId'] === event['branchId']);
      return { eventId: event['id'], branchId: event['branchId'] ?? null,
        laterRootRefusals: later.filter((candidate) => candidate['kind'] === 'acceptance' && candidate['approved'] === false).slice(0, 25).map((candidate) => candidate['id']),
        laterToolFailures: related.filter((candidate) => candidate['kind'] === 'tool' && candidate['error'] != null).slice(0, 25).map((candidate) => candidate['id']),
        laterRemediations: related.filter((candidate) => candidate['kind'] === 'llm' &&
          (candidate['role'] === 'fallback-plan' || candidate['role'] === 'fallback-execute')).slice(0, 25).map((candidate) => candidate['id']),
      };
    }),
    note: 'Later events are correlations within a run, not causal labels. Savings use same-run model medians, not a controlled counterfactual; unknown baselines remain null.',
  };
}
