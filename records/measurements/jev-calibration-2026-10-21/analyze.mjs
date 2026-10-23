import fs from 'node:fs';

const root = new URL('.', import.meta.url);
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'));
const pages = read('calibration-pages.json');
const audits = read('audits.json');
const rows = read('effort-primary-rows.json');
const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
let next = 0;
for (const page of pages) {
  if (page.window.offset !== next || page.window.decisions !== 1562) throw new Error('Inconsistent pagination');
  if (page.details.length !== page.report.totals.records) throw new Error('Incomplete detail page');
  next = page.window.nextOffset;
}
if (next !== null) throw new Error('Pagination did not finish');
const detailIds = pages.flatMap((page) => page.details.map((row) => row.id));
if (new Set(detailIds).size !== detailIds.length) throw new Error('Duplicate calibration record');
const outcomes = audits.days.flatMap((day) => {
  if (day.outcomeRuns !== day.outcomes.length) throw new Error('Truncated outcome window');
  return day.outcomes;
});
if (new Set(outcomes.map((row) => row.runId)).size !== 104) throw new Error('Incomplete live corpus');
const live = Object.values(audits.byRole);
const arms = {};
for (const arm of ['applied', 'held-out']) {
  const sample = rows.filter((row) => row.arm === arm);
  const approved = sample.filter((row) => row.result === 'approved').length;
  const refused = sample.filter((row) => row.result === 'refused').length;
  arms[arm] = {
    rows: sample.length,
    approved,
    refused,
    unknown: sample.length - approved - refused,
    refusalRate: refused / (approved + refused),
    medianDurationMs: median(sample.map((row) => row.executeDurationMs)),
    medianOutputTokens: median(sample.map((row) => row.executeOutputTokens)),
    requestedMismatch: sample.filter((row) => (arm === 'applied') !== (row.given === 'high')).length,
  };
}
const applied = arms.applied;
const held = arms['held-out'];
const gap = applied.refusalRate - held.refusalRate;
const durationRatio = applied.medianDurationMs / held.medianDurationMs;
let highVerdict = 'inconclusive';
if (applied.approved + applied.refused < 20 || held.approved + held.refused < 20) {
  highVerdict = 'inconclusive: fewer than 20 known results in an arm';
} else if (-gap >= 0.2 && held.refused >= applied.refused + 2) {
  highVerdict = 'keep high';
} else if (Math.abs(gap) < 0.2 && durationRatio >= 1.5) {
  highVerdict = 'withdraw high';
}
const result = {
  calibration: {
    enumeratedDecisions: pages.reduce((sum, page) => sum + page.window.asked, 0),
    records: detailIds.length,
    answered: pages.reduce((sum, page) => sum + page.report.totals.answered, 0),
    failedClosed: pages.reduce((sum, page) => sum + page.report.totals.failed, 0),
    unparsed: pages.reduce((sum, page) => sum + page.unparsed, 0),
    ineligibleResults: pages.reduce((sum, page) => sum + page.ineligible.RESULT, 0),
    excludedDelegationReviews: pages.reduce((sum, page) => sum + page.excluded['delegation-review'], 0),
    excludedParentSuites: pages.reduce((sum, page) => sum + page.excluded['parent-suite'], 0),
    costUsd: pages.reduce((sum, page) => sum + page.report.totals.costUsd, 0),
  },
  live: {
    runs: outcomes.length,
    jevCostUsd: live.reduce((sum, role) => sum + role.jevCostUsd, 0),
    auditCostUsd: live.reduce((sum, role) => sum + role.auditCostUsd, 0),
    modelFallbackCostUsd: live.reduce((sum, role) => sum + role.modelFallbackCostUsd, 0),
    knownBaselineEstimatedNetSavingUsd: live.reduce((sum, role) => sum + role.estimatedNetSavingUsd, 0),
    roles: audits.byRole,
  },
  effort: {
    totalReadings: outcomes.reduce((sum, row) => sum + row.effort.length, 0),
    highPrimaryRows: rows.length,
    primaryRunCount: new Set(rows.map((row) => row.runId)).size,
    arms,
    gap,
    durationRatio,
    highVerdict,
    lowVerdict: 'inconclusive: no decisive low readings',
    revisionCheck: 'All 22 recorded revisions descend from 5bf1f231; only intervening changes to effort paths are documentation links in 624ebec9.',
  },
};
fs.writeFileSync(new URL('analysis.json', root), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
