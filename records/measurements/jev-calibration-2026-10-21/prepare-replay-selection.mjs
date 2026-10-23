import fs from 'node:fs';
const root = new URL('.', import.meta.url);
const pages = JSON.parse(fs.readFileSync(new URL('calibration-pages.json', root), 'utf8'));
const rows = pages.flatMap((page) => page.details)
  .filter((row) => row.kind === 'approval' && row.model === 'approved' && !row.failure);
const selected = [];
// The initial preflight found this archived run absent on the host. Exclude
// it before any model answers are observed and take the next run in order.
const unavailableRuns = new Set(['cafd0d69-267e-4caf-a94c-60a6e2f1ec25']);
for (const [subject, fast, limit] of [['PLAN', true, 6], ['RESULT', true, 2], ['PLAN', false, 6], ['RESULT', false, 6]]) {
  const runs = new Set();
  for (const row of rows) {
    if (row.subject !== subject || (row.documented === 'approved') !== fast || runs.has(row.runId) || unavailableRuns.has(row.runId)) continue;
    runs.add(row.runId);
    selected.push({ runId: row.runId, eventId: row.id, subject, group: fast ? 'previous-agreement' : 'model-approved-deferred' });
    if (runs.size === limit) break;
  }
  if (runs.size !== limit) throw new Error('Not enough controls');
}
fs.writeFileSync(new URL('replay-control-selection.json', root), JSON.stringify(selected, null, 2) + '\n');
console.log(JSON.stringify({ controls: selected.length, rule: 'first distinct run in each stratum, in archived page order; no new scores used' }));
