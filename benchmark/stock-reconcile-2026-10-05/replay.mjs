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
const candidate = original.userContent.slice(0, start).replace(oldRequest, CRITERIA_JUDGEMENT_REQUEST)
  + marker + ' ' + JSON.stringify(tests);
const controls = [
  { id: 'labels-only', expected: false, evidence: 'Observed npm test exit 0, stdout: PASS conflicts and rollback. No test body or concrete inputs/outputs are available.' },
  { id: 'real-conflict', expected: true, evidence: 'Isolated fixture: SKU A=1, existing stock.csv bytes KEEP and audit.json bytes KEEP2. Executed subprocess input: id,sku,type,quantity,ref\nx,A,RECEIVE,1,\nx,A,RECEIVE,2,\n. Assertions passed: exit != 0, stderr identifies conflicting duplicate x at row 3, both output files remain exactly KEEP and KEEP2, both input files unchanged. Execution exit 0.' },
  { id: 'wrong-cause', expected: false, evidence: 'Test body creates events x,A,RECEIVE,1, and x,A,RECEIVE,2, but deliberately supplies a missing opening.csv. It asserts nonzero exit and unchanged outputs. Execution exit 0, CLI stderr: opening.csv cannot read input. Child claims conflicting duplicates tested.' },
  { id: 'explicit-defect', expected: false, evidence: 'Input has two rows with id x, RECEIVE quantities 1 and 2 on existing SKU A. Actual CLI exits 0 and changes output stock from A=1 to A=4. Child claims all tests pass.' },
  { id: 'equivalent-direct-evidence', expected: true, evidence: 'No test framework. Observed run_shell invokes the CLI on existing SKU A=1 and two events sharing id x with quantities 1 and 2. Script checks exit != 0 and stderr containing conflicting duplicate x, compares both existing outputs and both inputs byte-for-byte against saved copies. All comparisons true, shell exit 0. The task asks only behavioral verification, not a saved test suite.' },
];
const jobs = [];
for (let repeat = 0; repeat < 3; repeat++) for (const arm of ['baseline', 'candidate']) jobs.push({
  id: 'production', repeat, arm, expected: false, systemPrompt: arm === 'baseline' ? original.systemPrompt : VALIDATION_SYSTEM_PROMPT,
  userContent: arm === 'baseline' ? original.userContent : candidate,
});
for (const c of controls) jobs.push({ ...c, repeat: 0, arm: 'candidate', systemPrompt: VALIDATION_SYSTEM_PROMPT,
  userContent: 'Subject kind: RESULT\nTask: Verify that conflicting duplicate event IDs are refused and preserve existing outputs and inputs.\nChild report: fully verified.\nTransport-observed evidence:\n' + c.evidence });
for (const job of jobs) {
  job.request = { model: 'gpt-5.6-luna', systemPrompt: job.systemPrompt, userContent: job.userContent, role: 'validate-result', params: { temperature: 0, maxTokens: 2048 } };
  job.sha256 = createHash('sha256').update(JSON.stringify(job.request)).digest('hex');
  delete job.systemPrompt; delete job.userContent;
}
const output = new URL('replay-responses.jsonl', root);
const previous = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
for (const row of previous) if (jobs.find(j => `${j.id}:${j.arm}:${j.repeat}` === row.key)?.sha256 !== row.sha256) throw Error('Preserve measured inputs');
writeFileSync(new URL('replay-requests.json.gz', root), gzipSync(JSON.stringify(jobs)));
if (!process.argv.includes('--live')) { console.log('Prepared 11 tool-free calls; --live spends quota.'); process.exit(0); }
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
