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
  return {
    runId,
    startedAt: typeof run['startedAt'] === 'string' ? run['startedAt'] : null,
    roles: roles.map((role) => {
      const rows = jev.filter((event) => event['role'] === role);
      const model = events.filter((event) => event['kind'] === 'llm' && event['role'] === role && object(event['actor'])['name'] !== 'run-root');
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
