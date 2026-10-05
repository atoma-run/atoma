import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { CodexCliLlmClient } from '../../src/core/llmCodexCli.ts';
import { parseVerdict } from '../../src/atoms/json.ts';

const root = new URL('.', import.meta.url);
const measured = JSON.parse(gunzipSync(readFileSync(new URL('ablation-requests.json.gz', root))));
const jobs = measured.filter(j => j.arm === 'combined').map(j => ({ ...j, arm: 'terra', systemPrompt: j.request.systemPrompt, userContent: j.request.userContent }));
for (const job of jobs) {
  job.request = { model: 'gpt-5.6-terra', systemPrompt: job.systemPrompt, userContent: job.userContent, role: 'validate-result', params: { temperature: 0, maxTokens: 2048 } };
  job.sha256 = createHash('sha256').update(JSON.stringify(job.request)).digest('hex');
  delete job.systemPrompt; delete job.userContent;
}
const output = new URL('terra-responses.jsonl', root);
const previous = existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
for (const row of previous) if (jobs.find(j => `${j.id}:${j.arm}:${j.repeat}` === row.key)?.sha256 !== row.sha256) throw Error('Preserve measured inputs');
writeFileSync(new URL('terra-requests.json.gz', root), gzipSync(JSON.stringify(jobs)));
if (!process.argv.includes('--live')) { console.log('Prepared 9 tool-free calls; --live spends quota.'); process.exit(0); }
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
