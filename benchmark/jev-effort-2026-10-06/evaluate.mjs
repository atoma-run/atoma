// Evaluates the pre-registered rules (PREREGISTRATION.md) on rows.json:
// [{ runId, revision, l1, ...one `outcomes[].effort[]` row of atoma_jev_calibrate }].
import fs from 'node:fs';

const dir = new URL('.', import.meta.url).pathname;
const rows = JSON.parse(fs.readFileSync(`${dir}rows.json`, 'utf8'));
const L1 = 'sub:openai:gpt-5.6-luna';
const MIN_ROWS = 8;
const count = (xs, f) => xs.filter(f).length;
const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const onL1 = rows.filter((row) => row.l1 === L1);
const primary = onL1.filter((row) => row.firstAttempt && (row.arm === 'applied' || row.arm === 'held-out') && (row.read === 'low' || row.read === 'high'));
console.log(`rows ${rows.length}, on ${L1} ${onL1.length}, primary ${primary.length}`);
console.log('apart:', Object.fromEntries(['retry', 'undecided', 'failed'].map((arm) => [arm, count(onL1, (row) => row.arm === arm)])),
  'later attempts:', count(onL1, (row) => !row.firstAttempt), 'other L1:', rows.length - onL1.length);

const arms = {};
for (const read of ['low', 'high']) {
  for (const arm of ['applied', 'held-out']) {
    const xs = primary.filter((row) => row.read === read && row.arm === arm);
    const approved = count(xs, (row) => row.result === 'approved');
    const refused = count(xs, (row) => row.result === 'refused');
    arms[`${read}/${arm}`] = {
      rows: xs.length, approved, refused, unknown: xs.length - approved - refused,
      refusalRate: approved + refused > 0 ? +(refused / (approved + refused)).toFixed(2) : null,
      medianDurationMs: median(xs.map((row) => row.executeDurationMs)),
      medianOutputTokens: median(xs.map((row) => row.executeOutputTokens)),
      // Applied rows must have requested the level; held-out rows must not.
      requestedMismatch: count(xs, (row) => (arm === 'applied') !== (row.given === read)),
    };
  }
}
console.table(arms);

function verdict(read) {
  const applied = arms[`${read}/applied`];
  const held = arms[`${read}/held-out`];
  const known = (arm) => arm.approved + arm.refused;
  if (known(applied) < MIN_ROWS || known(held) < MIN_ROWS) return `inconclusive (fewer than ${MIN_ROWS} known-result rows in an arm)`;
  const gap = applied.refusalRate - held.refusalRate;
  const durationRatio = applied.medianDurationMs / held.medianDurationMs;
  if (read === 'low') {
    if (gap >= 0.2 && applied.refused >= held.refused + 2) return 'withdraw low';
    if (gap <= 0.2 && durationRatio <= 0.85) return 'keep low';
    return 'inconclusive';
  }
  if (-gap >= 0.2 && held.refused >= applied.refused + 2) return 'keep high';
  if (Math.abs(gap) < 0.2 && durationRatio >= 1.5) return 'withdraw high';
  return 'inconclusive';
}
const verdicts = { low: verdict('low'), high: verdict('high') };
console.log(verdicts);
fs.writeFileSync(`${dir}results.json`, `${JSON.stringify({ rows: rows.length, primary: primary.length, arms, verdicts }, null, 2)}\n`);
