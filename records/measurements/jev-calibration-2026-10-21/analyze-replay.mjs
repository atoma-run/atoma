import fs from 'node:fs';
const root = new URL('.', import.meta.url);
const all = fs.readFileSync(new URL('replay-readings.ndjson', root), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
const manifest = all.find((row) => row.type === 'manifest');
const completion = all.find((row) => row.type === 'complete');
if (!manifest || !completion) throw new Error('Replay is not complete');
const readings = all.filter((row) => row.type === 'reading');
const failures = all.filter((row) => row.type === 'failure');
if (new Set([...readings, ...failures].map((row) => row.jobId)).size !== completion.completed) {
  throw new Error('Missing or duplicated output rows');
}
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (fraction === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const primary = readings.filter((row) => !row.reversedOptions);
const arms = {};
for (const arm of ['original', 'questions', 'state', 'both']) {
  const sample = primary.filter((row) => row.arm === arm);
  const controls = sample.filter((row) => row.modelReference);
  const disputed = sample.filter((row) => !row.modelReference);
  const allArm = readings.filter((row) => row.arm === arm);
  arms[arm] = {
    primaryReadings: sample.length,
    approvalsAgainstRefusal: disputed.filter((row) => row.approved).length,
    refusalReferenceReadings: disputed.length,
    approvalsOnPositiveControls: controls.filter((row) => row.approved).length,
    positiveControlReadings: controls.length,
    byGroup: Object.fromEntries(['disagreement', 'previous-agreement', 'model-approved-deferred'].map((group) => {
      const groupRows = sample.filter((row) => row.group === group);
      return [group, { readings: groupRows.length, approvals: groupRows.filter((row) => row.approved).length }];
    })),
    costUsdIncludingOrderDiagnostic: allArm.reduce((sum, row) => sum + row.costUsd, 0),
    latencyMs: {
      median: quantile(sample.map((row) => row.durationMs), 0.5),
      p95: quantile(sample.map((row) => row.durationMs), 0.95),
    },
    inputTokens: {
      median: quantile(sample.map((row) => row.inputTokens), 0.5),
      max: sample.length ? Math.max(...sample.map((row) => row.inputTokens)) : null,
    },
  };
}
const cases = manifest.states.map((item) => {
  const perArm = {};
  for (const arm of Object.keys(arms)) {
    const sample = primary.filter((row) => row.caseId === item.caseId && row.arm === arm);
    const reordered = readings.find((row) => row.caseId === item.caseId && row.arm === arm && row.reversedOptions);
    const acceptable = sample.map((row) => row.acceptable);
    perArm[arm] = {
      answered: sample.length,
      approved: sample.filter((row) => row.approved).length,
      acceptable,
      majorityApproved: sample.length === 3 ? sample.filter((row) => row.approved).length >= 2 : null,
      reversedOrderApproved: reordered?.approved ?? null,
      reversedOrderAcceptable: reordered?.acceptable ?? null,
      orderDisagreesWithPrimaryMajority: reordered && sample.length === 3
        ? reordered.approved !== (sample.filter((row) => row.approved).length >= 2) : null,
    };
  }
  return { ...item, arms: perArm };
});
const summary = {
  experimentId: manifest.experimentId, release: manifest.release,
  model: manifest.model, thresholds: manifest.thresholds, proposalHash: manifest.proposalHash,
  completion, failures, arms, cases,
  repeatInstability: cases.flatMap((item) => Object.entries(item.arms)
    .filter(([, arm]) => arm.answered === 3 && arm.approved > 0 && arm.approved < 3)
    .map(([arm, value]) => ({ caseId: item.caseId, arm, approved: value.approved }))),
  orderDisagreements: cases.flatMap((item) => Object.entries(item.arms)
    .filter(([, arm]) => arm.orderDisagreesWithPrimaryMajority)
    .map(([arm]) => ({ caseId: item.caseId, arm }))),
  interpretation: 'Model refusals and approvals are references, not independent correctness labels. Primary results use three identical-order repetitions; reordered options are a separate diagnostic. State packets and approval requests are reconstructed. No production change follows automatically.',
};
fs.writeFileSync(new URL('replay-analysis.json', root), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ completion, failures: failures.length, arms, disagreements: cases.filter((row) => row.group === 'disagreement') }, null, 2));
