import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = new URL('.', import.meta.url);
const read = (root, name) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const projection = read(base, 'projection-audit.json');
assert.equal(hash(readFileSync(new URL('protocol.json', base))), projection.protocolSha256);
assert.equal(projection.cases.length, 67);
assert.equal(projection.rows.length, projection.cases.length * 8);
for (const row of projection.rows) {
  assert(row.keptLatestCommands <= row.latestCommands);
  assert(row.keptKnownSuccesses <= row.knownSuccesses);
  assert(row.keptKnownFailures <= row.knownFailures);
  if (row.arm === 'candidate') assert(row.actualChars <= row.budget);
}
const sourceRoot = process.env.ATOMA_EVAL_SOURCE_ROOT;
assert(sourceRoot);
const { estimateCostUsd, pricesFor } = await import(pathToFileURL(join(sourceRoot, 'src/core/metrics.ts')).href);
const results = [];
for (const name of ['', 'followup-source-complete/']) {
  const root = new URL(name, base);
  const protocol = read(root, 'protocol.json');
  const plan = read(root, 'execution-plan.json');
  const requests = JSON.parse(gunzipSync(readFileSync(new URL('requests.json.gz', root))));
  assert.equal(hash(JSON.stringify(requests.map(r => [r.id, r.arm, r.budget, r.sha256]))), plan.requestSetSha256);
  for (const r of requests) {
    assert.equal(hash(JSON.stringify(r.request)), r.sha256);
    assert.equal(r.request.model, protocol.phaseB.model);
    assert(!r.request.tools?.length && !r.request.executor);
  }
  if (name) for (const id of new Set(requests.map(r => r.id))) {
    assert.equal(new Set(requests.filter(r => r.id === id).map(r => r.sha256)).size, 8, 'Follow-up must actually vary every arm');
  }
  const file = new URL('responses.jsonl', root);
  const responses = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  assert.equal(new Set(responses.map(r => r.key)).size, responses.length, 'No duplicate paid replay');
  for (const r of responses) {
    const input = requests.find(x => x.id === r.id && x.arm === r.arm && x.budget === r.budget);
    assert(input);
    assert.equal(input.sha256, r.requestSha256);
    assert.equal(input.expected, r.expected);
    assert(Date.parse(r.startedAt) > Date.parse(protocol.amendedBeforeCallsAt ?? protocol.registeredAt));
    if (r.response) {
      assert(!r.response.servedModel || r.response.servedModel === protocol.phaseB.model);
      const u = r.response.usage;
      const cost = estimateCostUsd({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadInputTokens: u.cacheReadInputTokens ?? 0, cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0 }, pricesFor(protocol.phaseB.model));
      assert(Math.abs(cost - r.subscriptionEquivalentUsd) < 1e-12);
    }
  }
  assert(responses.length <= protocol.phaseB.maxCalls);
  if (!process.argv.includes('--partial')) {
    assert.equal(responses.length, protocol.phaseB.maxCalls, 'Keep incomplete measurements explicit');
    assert(responses.every(r => !r.error && !r.parseError && typeof r.verdict?.approved === 'boolean'));
  }
  results.push({ series: name || 'initial', planned: protocol.phaseB.maxCalls, measured: responses.length, errors: responses.filter(r => r.error || r.parseError).length,
    requestsSha256: plan.requestSetSha256, protocolSha256: hash(readFileSync(new URL('protocol.json', root))) });
}
const result = { verifiedAt: new Date().toISOString(), complete: !process.argv.includes('--partial'), projectionContexts: 67, series: results };
writeFileSync(new URL('verification.json', base), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
