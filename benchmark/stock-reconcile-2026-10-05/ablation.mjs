import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { CodexCliLlmClient } from '../../src/core/llmCodexCli.ts';
import { parseVerdict } from '../../src/atoms/json.ts';
import { VALIDATION_SYSTEM_PROMPT } from '../../src/atoms/verdict.ts';
import { CRITERIA_JUDGEMENT_REQUEST } from '../../src/atoms/rootAcceptance.ts';

const root = new URL('.', import.meta.url);
const archive = JSON.parse(gunzipSync(readFileSync(new URL('live-evidence.json.gz', root))));
const original = archive.events.find(e => e.id === '2d7558f1-de0e-4310-a82b-bd2bab8fed2a');
const tests = readFileSync(new URL('published/stock-reconcile.test.js.txt', root), 'utf8');
const oldRequest = 'ALSO emit "criteria" in your verdict JSON: one entry per item above, [{"id": "c1", "met": true|false, "reason": "<at most 15 words>"}], judged on the evidence.';
const marker = '- test/stock-reconcile.test.js (4644 chars):';
const start = original.userContent.lastIndexOf(marker);
if (start < 0 || !original.userContent.includes(oldRequest)) throw Error('Archived boundary changed');
// This is the final block in the archived request. The production reader now
// keeps this 4644-character file complete; other evidence is held constant.
const controls = [
  {
    "id": "audit-stock-only",
    "expected": false,
    "evidence": "Observed test body runs the same valid reconciliation twice. It saves stock.csv after the first run and asserts stock.csv is byte-identical after the second. It reads audit.json only after the first run and asserts applied=6 and duplicates=1. Both CLI exits are 0, test exit 0. Test title: deterministic stock and audit. No second audit read or comparison occurred."
  },
  {
    "id": "audit-both-compared",
    "expected": true,
    "evidence": "Observed test body runs identical valid inputs twice with successful exits. Before the second run, saves both stock.csv and audit.json as byte buffers. After the second run, reads both fresh files and asserts byte equality against each saved buffer. Both equality assertions pass. Test process exit 0."
  },
  {
    "id": "audit-volatile-field",
    "expected": false,
    "evidence": "Two successful executions with identical inputs. stock.csv bytes are equal. audit.json differs: first generatedAt=1000, second generatedAt=1001. Test removes generatedAt before comparing parsed JSON and passes. The task requires identical output bytes; no volatile-field exception was specified."
  },
  {
    "id": "audit-tautology",
    "expected": false,
    "evidence": "Two successful CLI executions with identical inputs. Test reads stockBefore and auditBefore, invokes the second run, then asserts stockBefore equals stockBefore and auditBefore equals auditBefore. It never reads outputs after the second run. Suite exit 0, title: both files deterministic."
  },
  {
    "id": "audit-direct-comparison",
    "expected": true,
    "evidence": "Observed shell script invokes CLI on identical valid inputs, saves both outputs, invokes CLI again, verifies both exit codes 0, then cmp stock.csv saved-stock and cmp audit.json saved-audit both exit 0. No test framework or test names. No mutations between reads."
  },
  {
    "id": "audit-single-run",
    "expected": false,
    "evidence": "One successful CLI execution; stock.csv and audit.json look deterministic and contain no timestamps. No source read-back and no second invocation. Child states both files were compared across executions."
  }
];
const jobs = [];
for (let repeat = 0; repeat < 3; repeat++) {
  const arms = ['baseline', 'readback-only', 'guidance-only', 'combined'];
  // Rotate order to avoid giving one arm the same position in every block.
  for (const arm of [...arms.slice(repeat), ...arms.slice(0, repeat)]) {
    const guidance = arm === 'guidance-only' || arm === 'combined';
    const full = arm === 'readback-only' || arm === 'combined';
    let userContent = full ? original.userContent.slice(0, start) + marker + ' ' + JSON.stringify(tests) : original.userContent;
    if (guidance) userContent = userContent.replace(oldRequest, CRITERIA_JUDGEMENT_REQUEST);
    jobs.push({ id: 'production', repeat, arm, expected: false, systemPrompt: guidance ? VALIDATION_SYSTEM_PROMPT : original.systemPrompt, userContent });
  }
}
for (const c of controls) jobs.push({ ...c, repeat: 0, arm: 'combined', systemPrompt: VALIDATION_SYSTEM_PROMPT,
  userContent: 'Subject kind: RESULT\nTask: Verify by executing the CLI twice on identical valid inputs that BOTH stock.csv and audit.json are byte-for-byte identical between executions.\nChild report: both outputs verified deterministic.\nTransport-observed evidence (synthetic control):\n' + c.evidence });
for (const job of jobs) {
  job.request = { model: 'gpt-5.6-luna', systemPrompt: job.systemPrompt, userContent: job.userContent, role: 'validate-result', params: { temperature: 0, maxTokens: 2048 } };
  job.sha256 = createHash('sha256').update(JSON.stringify(job.request)).digest('hex');
  delete job.systemPrompt; delete job.userContent;
}
const output = new URL('ablation-responses.jsonl', root);
const previous = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
for (const row of previous) if (jobs.find(j => `${j.id}:${j.arm}:${j.repeat}` === row.key)?.sha256 !== row.sha256) throw Error('Preserve measured inputs');
writeFileSync(new URL('ablation-requests.json.gz', root), gzipSync(JSON.stringify(jobs)));
if (!process.argv.includes('--live')) { console.log('Prepared 18 tool-free calls; --live spends quota.'); process.exit(0); }
const env = { ...process.env }; delete env.ATOMA_CODEX_MODEL;
const binary = realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY);
const client = new CodexCliLlmClient({ env, callTimeoutMs: 60000, spawnFn: (args, stdin, childEnv, cwd) => {
  const adjusted = args.map(a => a.startsWith('permissions.atoma-text-only.filesystem=') ? a.slice(0, -1) + ',' + JSON.stringify(binary) + '="read"}' : a);
  const child = spawn(binary, adjusted, { env: childEnv, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(stdin); return child;
} });
for (const job of jobs) {
  const key = `${job.id}:${job.arm}:${job.repeat}`;
  if (previous.some(r => r.key === key && !r.error)) continue;
  const row = { key, expected: job.expected, sha256: job.sha256, startedAt: new Date().toISOString() };
  try { row.response = await client.complete({ ...job.request, signal: AbortSignal.timeout(65000) }); row.verdict = parseVerdict(row.response.text); }
  catch (error) { row.error = String(error); }
  appendFileSync(output, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ key, verdict: row.verdict, error: row.error }));
  if (row.error) process.exit(1);
}
