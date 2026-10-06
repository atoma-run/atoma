// Evaluates the pre-registered rules (PREREGISTRATION.md) on recorded answers.
import fs from 'node:fs';

const dir = new URL('.', import.meta.url).pathname;
const rows = ['A', 'B1', 'B2', 'C'].flatMap((g) => JSON.parse(fs.readFileSync(`${dir}prefilter-${g}.json`, 'utf8')));
const credited = rows.filter((r) => r.path !== 'no-match');
const count = (xs, f) => xs.filter(f).length;

console.log('rows', rows.length, 'credited matches', credited.length);
for (const path of ['jev-picked', 'model', 'no-jev', 'not-found']) {
  const xs = credited.filter((r) => r.path === path);
  console.log(`  ${path}: ${xs.length} (SAME ${count(xs, (r) => r.label === 'SAME')}, OTHER ${count(xs, (r) => r.label === 'OTHER')})`);
}

// Rules apply to decisions with a recorded Jev answer that the model took
// (a Jev pick already passes fit >= 0.7 and would not change under R1/R2).
const withJev = credited.filter((r) => (r.path === 'model' || r.path === 'jev-picked') && typeof r.fitTarget === 'number');
const rules = [
  ...[0.3, 0.4, 0.5, 0.6].map((t) => ({ name: `R1(${t})`, blocks: (r) => r.path === 'model' && r.fitTarget < t })),
  ...[0.3, 0.4, 0.5].map((t) => ({ name: `R2(${t})`, blocks: (r) => r.path === 'model' && typeof r.bestFit === 'number' && r.bestFit < t })),
  { name: 'R3', blocks: (r) => r.path === 'model' && r.choice === 'none_of_these' },
];
const otherTotal = count(withJev, (r) => r.label === 'OTHER');
console.log(`\nwith a recorded Jev answer: ${withJev.length} (OTHER ${otherTotal}, SAME ${withJev.length - otherTotal})`);
const results = rules.map((rule) => {
  const blocked = withJev.filter(rule.blocks);
  const other = count(blocked, (r) => r.label === 'OTHER');
  const same = blocked.length - other;
  const acceptable = otherTotal > 0 && other >= otherTotal / 2 && blocked.length > 0 && other / blocked.length >= 0.75;
  return { rule: rule.name, blockedOther: other, blockedSame: same, otherShareBlocked: otherTotal ? +(other / otherTotal).toFixed(2) : null, precision: blocked.length ? +(other / blocked.length).toFixed(2) : null, acceptable };
});
console.table(results);
const best = results.filter((r) => r.acceptable).sort((a, b) => b.blockedOther - a.blockedOther || a.blockedSame - b.blockedSame)[0];
console.log('proposed:', best ? best.rule : 'none acceptable — no threshold changes');

const fitsOf = (label) => withJev.filter((r) => r.path === 'model' && r.label === label).map((r) => r.fitTarget).sort((a, b) => a - b);
console.log('\nmodel-decided fitTarget, OTHER:', fitsOf('OTHER').map((x) => x.toFixed(2)).join(' '));
console.log('model-decided fitTarget, SAME: ', fitsOf('SAME').map((x) => x.toFixed(2)).join(' '));
fs.writeFileSync(`${dir}results.json`, JSON.stringify({ rows: credited.length, withJev: withJev.length, otherTotal, results, proposed: best?.rule ?? null }, null, 2));
