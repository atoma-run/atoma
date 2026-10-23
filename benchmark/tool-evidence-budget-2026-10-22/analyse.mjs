import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
const base = new URL('.', import.meta.url);
const root = process.argv.includes('--followup') ? new URL('followup-source-complete/', base) : base;
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const projection = JSON.parse(readFileSync(new URL('projection-audit.json', base), 'utf8'));
const protocol = read('protocol.json');
const requests = JSON.parse(gunzipSync(readFileSync(new URL('requests.json.gz', root))));
const receipts = requests.map(r => {
  const cmd = r.id === 'original' ? 'node --test original.cjs' : 'node --test premium.cjs renewal.cjs threshold.cjs';
  const block = r.request.userContent.split('== TRANSPORT-OBSERVED TOOL EVIDENCE ==')[1]?.split('\n== ')[0] ?? '';
  const line = block.split('\n').find(line => /^e\d+: /.test(line) && line.includes('run_shell') && line.includes('request=' + JSON.stringify({ cmd })));
  const sourceLines = block.split('\n').filter(line => /^e\d+: read_file /.test(line) && line.includes('request={"path":"server.js","offset":'));
  return { id: r.id, arm: r.arm, budget: r.budget, targetCommandReceiptVisible: Boolean(line), partial: line?.includes('PARTIAL SHELL OBSERVATION') ?? false,
    sourcePagesVisible: sourceLines.length, sourceSeedPageVisible: sourceLines.some(line => line.includes('"offset":0,')) };
});
const sourceRoot = process.env.ATOMA_EVAL_SOURCE_ROOT;
if (!sourceRoot || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== protocol.selectors.candidate) throw Error('Use the pinned isolated source checkout for canonical cost accounting');
const { estimateCostUsd, pricesFor } = await import(pathToFileURL(join(sourceRoot, 'src/core/metrics.ts')).href);
const prices = pricesFor(protocol.phaseB.model);
const responsePath = new URL('responses.jsonl', root);
const responses = existsSync(responsePath) ? readFileSync(responsePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sum = (rows, field) => rows.reduce((n, r) => n + (r[field] ?? 0), 0);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const median = xs => { const a = xs.toSorted((a, b) => a - b); return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : null; };
const withoutCache = r => {
  const u = r.response?.usage;
  return u ? estimateCostUsd({ inputTokens: u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), outputTokens: u.outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, prices) : null;
};
const arms = [];
for (const arm of Object.keys(protocol.selectors)) for (const budget of protocol.budgetsChars) {
  const a = projection.rows.filter(r => r.arm === arm && r.budget === budget);
  const b = responses.filter(r => r.arm === arm && r.budget === budget);
  const inputs = requests.filter(r => r.arm === arm && r.budget === budget);
  const judged = b.filter(r => typeof r.verdict?.approved === 'boolean' && !r.error);
  const valid = judged.filter(r => r.expected);
  const invalid = judged.filter(r => !r.expected);
  arms.push({ arm, budget, contexts: a.length,
    commands: sum(a, 'latestCommands'), retained: sum(a, 'keptLatestCommands'),
    successes: sum(a, 'knownSuccesses'), successesRetained: sum(a, 'keptKnownSuccesses'),
    failures: sum(a, 'knownFailures'), failuresRetained: sum(a, 'keptKnownFailures'),
    partialReceipts: sum(a, 'partialShells'), meanChars: mean(a.map(r => r.actualChars)), maxChars: Math.max(...a.map(r => r.actualChars)),
    replayCalls: b.length, judged: judged.length, validCases: valid.length, invalidCases: invalid.length,
    meanPreparedEvidenceChars: mean(inputs.map(r => r.evidenceChars)),
    maxPreparedEvidenceChars: Math.max(...inputs.map(r => r.evidenceChars)),
    falseRefusals: valid.filter(r => !r.verdict.approved).length,
    falseApprovals: invalid.filter(r => r.verdict.approved).length,
    errors: b.filter(r => r.error || r.parseError).length,
    totalSubscriptionEquivalentUsd: sum(b, 'subscriptionEquivalentUsd'),
    meanSubscriptionEquivalentUsd: mean(b.filter(r => Number.isFinite(r.subscriptionEquivalentUsd)).map(r => r.subscriptionEquivalentUsd)),
    meanWithoutCacheEquivalentUsd: mean(b.filter(r => r.response?.usage).map(withoutCache)),
    uncachedInputTokens: b.reduce((n, r) => n + (r.response?.usage.inputTokens ?? 0), 0),
    cachedInputTokens: b.reduce((n, r) => n + (r.response?.usage.cacheReadInputTokens ?? 0), 0),
    cacheCreationInputTokens: b.reduce((n, r) => n + (r.response?.usage.cacheCreationInputTokens ?? 0), 0),
    totalInputTokens: b.reduce((n, r) => n + (r.response?.usage.inputTokens ?? 0) + (r.response?.usage.cacheReadInputTokens ?? 0) + (r.response?.usage.cacheCreationInputTokens ?? 0), 0),
    outputTokens: b.reduce((n, r) => n + (r.response?.usage.outputTokens ?? 0), 0),
    meanDurationMs: mean(b.map(r => r.durationMs)),
    medianDurationMs: median(b.map(r => r.durationMs)),
    byCase: [...new Set(b.map(r => r.id))].map(id => ({ id, outcomes: b.filter(r => r.id === id).map(r => ({ repeat: r.repeat, expected: r.expected, approved: r.verdict?.approved, error: r.error ?? r.parseError ?? null })) }))
  });
}
const windows = projection.cases.map(c => c.followingWindow.subscriptionEquivalentUsd);
const findings = {
  generatedAt: new Date().toISOString(), protocolSha256: projection.protocolSha256,
  cohortSha256: projection.cohortSha256, contexts: projection.includedCases,
  plannedReplayCalls: protocol.phaseB.maxCalls, completedReplayCalls: responses.length,
  replayTotalSubscriptionEquivalentUsd: sum(responses, 'subscriptionEquivalentUsd'),
  replayStatus: responses.some(r => r.error) ? 'stopped-on-transport-error' : responses.length === protocol.phaseB.maxCalls ? 'complete' : 'incomplete',
  followupReason: protocol.followupReason ?? null,
  targetReceiptVisibility: receipts,
  oracleCorrectCaseDecisions: responses.filter(r => r.expected).map(r => ({ key: r.key, arm: r.arm, budget: r.budget, repeat: r.repeat, approved: r.verdict?.approved, reasoning: r.verdict?.reasoning, error: r.error ?? r.parseError ?? null })),
  observedDevelopmentRework: existsSync(new URL('development-rework-window.json', base)) ? JSON.parse(readFileSync(new URL('development-rework-window.json', base), 'utf8')) : null,
  identicalPreparedRequestGroups: [...new Set(requests.map(r => r.id))].map(id => {
    const matching = requests.filter(r => r.id === id);
    return { id, distinctInputs: new Set(matching.map(r => r.sha256)).size,
      groups: [...new Set(matching.map(r => r.sha256))].map(sha256 => ({ sha256, arms: matching.filter(r => r.sha256 === sha256).map(r => [r.arm, r.budget]) })) };
  }),
  oracleDisagreementDefinition: 'False-refusal field counts refusal of an oracle-correct case. In the initial series, absent seed/precondition evidence can make that refusal reasonable; it is not automatically an evidence-budget error.',
  canonicalModelPricesPerMillionTokens: prices,
  arms,
  historicalReworkWindows: { count: windows.length, medianSubscriptionEquivalentUsd: median(windows), maximumSubscriptionEquivalentUsd: Math.max(...windows),
    attribution: 'Overlapping run-wide windows may include parallel and unrelated work. Do not sum them or attribute them causally to omissions.' },
  developmentIncident: projection.cases.find(c => c.runId.startsWith('b920') && c.eventIndex === 874),
  limitations: [
    'Retained receipts, especially partial receipts, do not establish assertion coverage or freshness.',
    '67 retrospective contexts from three related Attica runs; observations recur across contexts.',
    'Five previously known library fixtures with synthetic unrelated evidence pressure, two repetitions; exploratory, not independent end-to-end runs.',
    'Initial prompts omit implementation seed evidence requested by several reviewers. Refusals of the oracle-correct case are disagreements with that oracle label, not proved truncation-caused mistakes. The separately preregistered follow-up supplies actual source identically in every arm without changing the tests.',
    'Tool-free model judgments measure direct verification cost and errors, not actual remediation cost or eventual delivery.',
    'USD values are canonical model-price equivalents for the existing subscription, not an additional API invoice.',
    'Cache state and call order affect observed cost. Rotating arm order does not eliminate this effect; the no-cache normalisation is a model-price sensitivity calculation, not observed billing.',
    'A global optimal budget or causal total-run savings cannot be established by this pilot.'
  ]
};
writeFileSync(new URL('analysis.json', root), JSON.stringify(findings, null, 2) + '\n');
console.log(JSON.stringify({ contexts: findings.contexts, replayStatus: findings.replayStatus, completedReplayCalls: responses.length,
  totalSubscriptionEquivalentUsd: findings.replayTotalSubscriptionEquivalentUsd,
  arms: arms.map(({ arm, budget, retained, commands, replayCalls, falseRefusals, falseApprovals, errors, meanSubscriptionEquivalentUsd }) => ({ arm, budget, retained, commands, replayCalls, falseRefusals, falseApprovals, errors, meanSubscriptionEquivalentUsd })) }));
