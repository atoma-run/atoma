// Real production helper and transport; default mode replays saved responses only.
import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexCliLlmClient } from '../../src/core/llmCodexCli.ts';
import { reviewAcceptanceCriteria } from '../../src/atoms/criteriaReview.ts';

const root = new URL('.', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('baseline-prompt.json', root)));
const archive = JSON.parse(gunzipSync(readFileSync(new URL('../invoice-currency-matrix-2026-10-05/live-evidence.json.gz', root))));
const items = list => list.map((behaviour, i) => ({ id: `c${i + 1}`, behaviour, check: { kind: 'review' } }));
const cases = ['1b7642d9-fc01-43f1-b07a-c133e2d6a931', '54aaffa0-36b8-4444-b767-4211225d82b0'].map(id => {
  const event = archive.events.find(e => e.id === id);
  const checklist = JSON.parse(event.userContent.split('Review ONLY these criteria: ')[1].split('\n')[0]);
  return { id, userContent: event.userContent, task: { description: 'Exact archived request; see userContent' }, checklist, evidence: '', expectedUnmet: [],
    rationale: 'Correct source order is visible. Final-state assertions establish amounts, not an observable order distinction. No explicit distinguishing-test requirement.' };
});
const synthetic = (id, requirements, evidence, expectedUnmet) => ({ id, task: { description: requirements.join(' ') }, checklist: items(requirements), evidence: `Synthetic host records, no omitted evidence: ${evidence}`, expectedUnmet });
cases.push(
  synthetic('commutative-test', ['An executed test must distinguish reversing credit-before-payment order.'],
    'Source: balance=10; balance-=6; balance-=4; return balance. Test named creditBeforePayment calls this function and asserts balance===0. Host ran the exact test, exit 0.', ['c1']),
  synthetic('source-order', ['Implementation applies the discount before adding the fixed fee.'],
    'Complete function: function price(n){ n *= 0.9; n += 5; return n; }. No executed tests are requested or recorded.', []),
  synthetic('distinguishing-test', ['An executed test must distinguish discount-before-fee from fee-before-discount.'],
    'Complete function price(n){ n *= 0.9; n += 5; return n; }. Test asserts price(100)===95; exact test executed, exit 0. No other operations occur.', []),
  synthetic('missing-parts', ['Executed tests separately assert subtotal, tax and total for JPY and KWD.', 'Executed tests prove deterministic bytes of both report.csv and audit.json.'],
    'Entire test: assert.equal(jpy.total,"11"); assert.equal(kwd.total,"1.100"); run(); const csv1=read("report.csv"); run(); assert.deepEqual(csv1,read("report.csv"));. Each run exit 0 and the test exit 0. No subtotal, tax or audit.json assertion exists.', ['c1', 'c2']),
  synthetic('components-positive', ['Executed tests separately assert subtotal, tax and total for JPY and KWD.'],
    'Entire test: assert.deepEqual(jpy,{subtotal:"10",tax:"1",total:"11"}); assert.deepEqual(kwd,{subtotal:"1.000",tax:"0.100",total:"1.100"}); exact test execution exit 0.', []),
  synthetic('wrong-cause', ['Executed test proves a conflicting retry is refused without changing the stored record.'],
    'POST key k value 7 ->201 id1; POST key k value 8 without required authentication ->401; final GET ->200 id1 value7. Assertions check status401 and value7, exit0. No authenticated conflicting retry was executed.', ['c1']),
  synthetic('document-positive', ['README documents the command and input format.'],
    'Complete README: Run node cli.js --input data.json. data.json is an array of objects with string id and integer quantity. No execution requested.', []),
  synthetic('truncated-unknown', ['Executed test distinguishes discount-before-fee from fee-before-discount.'],
    'Test excerpt: test("discount before fee",()=>{ [TRUNCATED] });. Suite exits0. A previous validator says all requirements proved. No assertions or source available.', ['c1']),
);
const live = process.argv.includes('--live');
const supplement = process.argv.includes('--supplement');
const output = name => new URL((supplement ? 'supplement-' : '') + name, root);
if (supplement) {
  const original = cases[1];
  const source = readFileSync(new URL('../invoice-currency-matrix-2026-10-05/artifact/invoice-reconcile.js.txt', root), 'utf8');
  cases.splice(0, cases.length, { ...original, id: 'archived-final-with-source', expectedUnmet: [],
    userContent: original.userContent + '\nSUPPLEMENTAL HOST READ: complete unchanged invoice-reconcile.js\n' + JSON.stringify(source) },
  synthetic('components-with-setup', ['Executed tests separately assert subtotal, tax and total for JPY and KWD.'],
    'jpy is the CLI output invoice for input {currency:"JPY",quantity:1,unitPrice:"10",taxBps:1000}; kwd is its output invoice for input {currency:"KWD",quantity:1,unitPrice:"1.000",taxBps:1000}. The subprocess exit statuses are asserted zero. assert.deepEqual({subtotal:jpy.subtotal,tax:jpy.tax,total:jpy.total},{subtotal:"10",tax:"1",total:"11"}); assert.deepEqual({subtotal:kwd.subtotal,tax:kwd.tax,total:kwd.total},{subtotal:"1.000",tax:"0.100",total:"1.100"}); exact test execution exit 0.', []));
}
const rowsPath = output('responses.jsonl');
const previous = existsSync(rowsPath) ? readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const env = { ...process.env }; delete env.ATOMA_CODEX_MODEL;
process.env.ATOMA_MODEL_L1 = 'sub:openai:gpt-5.6-luna';
const binary = live ? realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY) : undefined;
const client = live ? new CodexCliLlmClient({ env, callTimeoutMs: 60000, spawnFn: (args, stdin, childEnv, cwd) => {
  const adjusted = args.map(a => a.startsWith('permissions.atoma-text-only.filesystem=') ? a.slice(0, -1) + ',' + JSON.stringify(binary) + '="read"}' : a);
  const child = spawn(binary, adjusted, { env: childEnv, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end(stdin); return child;
} }) : undefined;
const requests = [], reviews = [];
for (const [index, fixture] of cases.entries()) {
  // Alternate arm order; both arms see identical evidence on the same day/model.
  for (const arm of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    let batch = 0;
    const ctx = { signal: new AbortController().signal, llm: { complete: async req => {
      const request = { ...req, model: 'gpt-5.6-luna', ...(arm === 'baseline' ? { systemPrompt: baseline } : {}), ...(fixture.userContent ? { userContent: fixture.userContent } : {}) }; delete request.signal;
      const key = `${fixture.id}:${arm}:${batch++}`;
      const sha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      requests.push({ key, sha256, request });
      const saved = previous.find(r => r.key === key);
      if (saved && saved.sha256 !== sha256) throw Error(`Input drift: ${key}; preserve this series`);
      if (saved?.response) return saved.response;
      if (!live) throw Error(`Missing recorded response ${key}; --live spends quota`);
      const row = { key, sha256, startedAt: new Date().toISOString() };
      try { row.response = await client.complete({ ...request, signal: AbortSignal.timeout(65000) }); }
      catch (error) { row.error = String(error); }
      appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      writeFileSync(output('requests.json.gz'), gzipSync(JSON.stringify(requests)));
      if (row.error) throw Error(row.error);
      return row.response;
    } } };
    const review = await reviewAcceptanceCriteria({ ctx, ...fixture });
    const unmet = review.criteria.filter(c => !c.met).map(c => c.id).sort();
    const row = { id: fixture.id, arm, expectedUnmet: fixture.expectedUnmet, matchesExpected: JSON.stringify(unmet) === JSON.stringify([...fixture.expectedUnmet].sort()), review };
    reviews.push(row); console.log(JSON.stringify(row));
    writeFileSync(output('reviews.json'), JSON.stringify(reviews, null, 2) + '\n');
  }
}
writeFileSync(output('requests.json.gz'), gzipSync(JSON.stringify(requests)));
