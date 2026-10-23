import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { renderer, sources } from '../renderers.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const protocol = JSON.parse(readFileSync(root + 'protocol.json', 'utf8'));
const sourceRoot = process.env.ATOMA_EVAL_SOURCE_ROOT;
if (!sourceRoot || !sourceRoot.startsWith('/')) throw Error('ATOMA_EVAL_SOURCE_ROOT must name the verified isolated checkout');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== protocol.selectors.candidate) throw Error('Source revision changed');
const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
const { parseVerdict } = await load('src/atoms/json.ts');
const { estimateCostUsd, pricesFor, partialUsageOf } = await load('src/core/metrics.ts');
const requestFile = root + 'requests.json.gz';
const output = root + 'responses.jsonl';
const digest = value => createHash('sha256').update(value).digest('hex');
let requests;
if (!process.argv.includes('--live')) {
  const { L1Atom } = await load('src/atoms/L1Atom.ts');
  const { llmVerdict } = await load('src/atoms/verdict.ts');
  const { parseExecutionObservation, renderObservations } = await load('src/contracts/attestation.ts');
  const { makeCtx } = await load('tests/helpers.ts');
  const cases = JSON.parse(readFileSync(resolve(root, '../../proof-replay-2026-10-04/cases.json'), 'utf8'));
  requests = [];
  for (const c of cases) {
    const records = [];
    const add = (tool, args, raw) => records.push({ eventId: 'e' + records.length, tool, attempt: 1, branchId: 'verification',
      observation: parseExecutionObservation(tool, args, raw) });
    const fixtures = JSON.parse(readFileSync(resolve(root, '../../proof-replay-2026-10-04/fixtures.json'), 'utf8'));
    const serverSource = c.mutation ? fixtures['server.cjs'].replace(...c.mutation) : fixtures['server.cjs'];
    if (digest(serverSource) !== c.serverSha256) throw Error('Actual implementation identity mismatch');
    for (let offset = 0; offset < serverSource.length; offset += 1000) {
      const end = Math.min(offset + 1000, serverSource.length);
      const page = { path: 'server.js', offset, totalChars: serverSource.length, nextOffset: end < serverSource.length ? end : null, content: serverSource.slice(offset, end) };
      if (JSON.stringify(page).length > 1600) throw Error('Source page would be truncated by the canonical observer');
      add('read_file', { path: 'server.js', offset, limit: 1000 }, page);
    }
    for (const file of c.files) add('read_file', { path: file.path }, { path: file.path, content: file.content });
    if (c.id !== 'original') add('read_file', { path: 'helper.cjs' }, { path: 'helper.cjs', content: c.helper });
    add('run_shell', { cmd: 'node --test ' + c.files.map(f => f.path).join(' ') }, { exitCode: c.exitCode, stdout: c.stdout, stderr: c.stderr });
    // Controlled evidence-eviction stress, identical across every arm of a case.
    for (let i = 0; i < 64; i++) add('run_shell', { cmd: `inspect-unrelated-metadata-${i}` },
      { exitCode: 0, stdout: 'Unrelated historical inventory. '.repeat(100) });
    const observations = renderObservations(records);
    const evidence = records.map((r, i) => ({ source: 'transport-observed', eventId: r.eventId, tool: r.tool, observed: observations[i] }));
    const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'Capture only; no model call.' }));
    const child = new L1Atom({ name: 'CarbonDioxide', ordinal: 1, model: protocol.phaseB.model, systemPrompt: 'Verify', params: {},
      tools: ['read_file', 'run_shell'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) });
    await llmVerdict({ ctx, model: protocol.phaseB.model, supervisorName: 'Cell', supervisorTier: 2, subject: 'RESULT', child,
      task: { description: 'Verification only, with no implementation or migration: verify the existing library and its regression tests for exactly three requirements. Premium members may hold at most five active loans; a sixth otherwise available copy is refused. Renewal advances the existing due date exactly fourteen days. Exactly 500 cents of fines permits borrowing; only greater amounts block it. Regression tests must distinguish violations of every named rule and all tests must pass. Other UI, deployment and project-wide requirements are outside this phase. Evidence below is a controlled reconstruction using actual isolated Node test outcomes; unrelated inventory records are stress padding and prove none of these requirements.' },
      payload: { output: 'Verification complete', summary: 'All three scoped rules and regression tests are verified.' }, evidence, groundTruthBlock: '' });
    const captured = ctx.llm.calls.at(-1);
    const marker = '== TRANSPORT-OBSERVED TOOL EVIDENCE ==';
    const begin = captured.userContent.indexOf(marker);
    const end = captured.userContent.indexOf('\n== ', begin + marker.length);
    if (begin < 0) throw Error('Evidence boundary missing');
    const originalBlock = captured.userContent.slice(begin, end < 0 ? undefined : end);
    const header = originalBlock.split('\n').slice(0, 2).join('\n');
    for (const arm of Object.keys(sources)) for (const budget of protocol.budgetsChars) {
      const selected = renderer(arm, budget)(evidence);
      const block = header + '\n' + (selected.omitted ? `${selected.omitted} earlier observations omitted; absence here does not prove they did not run.\n` : '') + selected.lines.join('\n');
      const request = { ...captured, signal: undefined,
        userContent: captured.userContent.slice(0, begin) + block + (end < 0 ? '' : captured.userContent.slice(end)) };
      if (request.tools?.length || request.executor) throw Error('A validation replay must not have tools');
      requests.push({ id: c.id, expected: c.expected, arm, budget, evidenceChars: selected.lines.join('\n').length,
        request, sha256: digest(JSON.stringify(request)) });
    }
  }
  const plan = { registeredAt: new Date().toISOString(), cases: requests.length / 8, requests: requests.length,
    plannedCalls: requests.length * protocol.phaseB.repeats, followup: protocol.followupReason, observationFormat: 'Candidate canonical observations held identical across selector/budget arms; this isolates selection and budget, not the exit-status schema change.',
    padding: '64 synthetic unrelated successful shell inventories, each parsed by the canonical bounded observer, after the actual independently executed Node test receipt.',
    requestSetSha256: digest(JSON.stringify(requests.map(r => [r.id, r.arm, r.budget, r.sha256]))),
    sources: Object.fromEntries(Object.entries(sources).map(([arm, s]) => [arm, { revision: s.revision, sourceSha256: s.sourceSha256, projectionSha256: s.projectionSha256 }])),
    selectionWarning: 'Archive cases and development incident were previously known. This is an exploratory mechanism test, not an unseen cross-product benchmark.' };
  if (existsSync(output)) {
    const prior = JSON.parse(readFileSync(root + 'execution-plan.json', 'utf8'));
    if (prior.requestSetSha256 !== plan.requestSetSha256) throw Error('Preserve measured requests');
  }
  writeFileSync(requestFile, gzipSync(JSON.stringify(requests) + '\n'));
  writeFileSync(root + 'execution-plan.json', JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify(plan));
  process.exit(0);
}
requests = JSON.parse(gunzipSync(readFileSync(requestFile)));
const terminal = JSON.parse(readFileSync(new URL('../active-run-terminal.json', import.meta.url), 'utf8'));
if (terminal.runId !== 'b920faf6-7bd7-4e89-87f8-7176c1c97f92' || !['delivered', 'partial', 'failed', 'cancelled'].includes(terminal.status)) throw Error('Do not compete with the active Attica run');
if (Date.now() - Date.parse(terminal.observedAt) > 300000) throw Error('Refresh terminal receipt before replay');
const { CodexCliLlmClient } = await load('src/core/llmCodexCli.ts');
const binary = realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY || '/Users/mgtf/.local/bin/codex');
const env = { ...process.env };
delete env.ATOMA_CODEX_MODEL;
const client = new CodexCliLlmClient({ env, callTimeoutMs: 60000, spawnFn: (args, stdin, childEnv, cwd) => {
  const adjusted = args.map(a => a.startsWith('permissions.atoma-text-only.filesystem=') ? a.slice(0, -1) + ',' + JSON.stringify(binary) + '="read"}' : a);
  const child = spawn(binary, adjusted, { env: childEnv, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(stdin);
  return child;
} });
const previous = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
for (const row of previous) if (requests.find(r => r.id === row.id && r.arm === row.arm && r.budget === row.budget)?.sha256 !== row.requestSha256) throw Error('Measured input changed');
const ids = [...new Set(requests.map(r => r.id))];
const arms = Object.keys(sources).flatMap(arm => protocol.budgetsChars.map(budget => ({ arm, budget })));
for (let repeat = 0; repeat < protocol.phaseB.repeats; repeat++) for (let ci = 0; ci < ids.length; ci++) for (let ai = 0; ai < arms.length; ai++) {
  if (Date.now() >= Date.parse('2026-10-22T06:55:00Z')) { console.log('Stopped at preregistered time; incomplete measurements retained.'); process.exit(0); }
  const choice = arms[(ai + ci + repeat) % arms.length];
  const job = requests.find(r => r.id === ids[ci] && r.arm === choice.arm && r.budget === choice.budget);
  const key = [repeat, job.id, job.arm, job.budget].join(':');
  if (previous.some(r => r.key === key && !r.error)) continue;
  const row = { key, repeat, id: job.id, arm: job.arm, budget: job.budget, expected: job.expected,
    requestSha256: job.sha256, startedAt: new Date().toISOString() };
  const begin = Date.now();
  try {
    row.response = await client.complete({ ...job.request, signal: AbortSignal.timeout(65000) });
    if (row.response.servedModel && row.response.servedModel !== protocol.phaseB.model) throw Error('Served model changed');
    try { row.verdict = parseVerdict(row.response.text); } catch (error) { row.parseError = String(error); }
    const usage = row.response.usage;
    row.subscriptionEquivalentUsd = estimateCostUsd({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0, cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0 }, pricesFor(row.response.servedModel ?? protocol.phaseB.model));
  } catch (error) {
    row.error = String(error);
    row.partialUsage = partialUsageOf(error);
  }
  row.durationMs = Date.now() - begin;
  appendFileSync(output, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ key, approved: row.verdict?.approved, expected: row.expected, durationMs: row.durationMs,
    subscriptionEquivalentUsd: row.subscriptionEquivalentUsd, error: row.error, parseError: row.parseError }));
  if (row.error) process.exit(1);
}
