// Paired same-model replay. Default is offline; --live explicitly spends quota.
import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CodexCliLlmClient } from '../../src/core/llmCodexCli.ts';
import { llmVerdict, VALIDATION_SYSTEM_PROMPT } from '../../src/atoms/verdict.ts';
import { DELEGATED_SCOPE_GUIDANCE, delegatedTaskContext } from '../../src/atoms/taskContext.ts';

const root = new URL('.', import.meta.url);
const file = name => new URL(`scope-v2-${name}`, root);
const baselineSystem = JSON.parse(readFileSync(new URL('scope-baseline-system.json', root)));
const archive = JSON.parse(gunzipSync(readFileSync(new URL('fourth-attempt.json.gz', root))));
const cases = ['f8b8b52d-1714-479b-9e2a-cf6ae3f9d316', 'f844795a-efd2-48f3-9674-3ac7e7f1710c'].map(id => ({
  id, event: archive.events.find(e => e.id === id), expected: null,
  rationale: 'Manual review: reject genuine implementation defects, but do not demand full executed tests assigned to the forthcoming phase.',
}));
const original = { description: 'Deliver price.mjs and README. price(n) applies a 10% discount BEFORE adding a fee of 5. Execute a test asserting price(100)===95, which distinguishes fee-before-discount (94.5). README documents the function.' };
const phase = { description: 'Write price.mjs implementing the specified price(n), and inspect its complete source. Executed tests and README belong to a later phase.' };
const source = 'export function price(n) { return n * 0.9 + 5; }';
const observed = `== GROUND-TRUTH ==\nHost read of current, unchanged price.mjs, entire file: ${source}\nNo test has run; no README exists.`;
const fixture = (id, task, evidence, expected, summary = 'Wrote price.mjs and inspected its source.') => ({ id, task, evidence, expected, summary });
cases.push(
  fixture('delegated-source-only', { ...phase, ...delegatedTaskContext(original, phase) }, observed, true),
  fixture('delegated-current-test-missing', { ...phase, ...delegatedTaskContext(original, phase), description: 'Write price.mjs and execute a test asserting price(100)===95. README belongs to a later phase.' }, observed, false),
  fixture('delegated-wrong-behavior', { ...phase, ...delegatedTaskContext(original, phase) }, observed.replace(source, 'export function price(n) { return (n + 5) * 0.9; }'), false),
  fixture('root-missing-proof', original, observed, false),
  fixture('child-cannot-defer', { ...original, ...delegatedTaskContext(original, original) }, observed, false, 'Implementation complete; I defer tests and README to a later phase.'),
  fixture('root-complete', original, `== GROUND-TRUTH ==\nComplete current price.mjs: ${source}\nComplete README: price(n) discounts n by 10%, then adds 5.\nComplete price.test.mjs: import assert from 'node:assert/strict'; import {price} from './price.mjs'; assert.equal(price(100),95);\nHost ran node price.test.mjs against those unchanged files, exit 0.`, true),
);
const live = process.argv.includes('--live');
const rows = existsSync(file('responses.jsonl')) ? readFileSync(file('responses.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const binary = live ? realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY) : undefined;
const env = { ...process.env }; delete env.ATOMA_CODEX_MODEL;
const client = live ? new CodexCliLlmClient({ env, callTimeoutMs: 120000, spawnFn: (args, input, childEnv, cwd) => {
  const adjusted = args.map(a => a.startsWith('permissions.atoma-text-only.filesystem=') ? a.slice(0, -1) + ',' + JSON.stringify(binary) + '="read"}' : a);
  const child = spawn(binary, adjusted, { env: childEnv, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end(input); return child;
} }) : undefined;
const requests = [], results = [];
for (const [index, fixture] of cases.entries()) {
  for (const arm of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const complete = async rendered => {
      const request = fixture.event ? { model: 'gpt-5.6-luna', systemPrompt: fixture.event.systemPrompt, userContent: fixture.event.userContent, params: rendered.params }
        : { ...rendered, model: 'gpt-5.6-luna' };
      delete request.signal;
      request.systemPrompt = arm === 'baseline' ? baselineSystem : VALIDATION_SYSTEM_PROMPT;
      if (fixture.event && arm === 'candidate') request.userContent = request.userContent.replace('\nInputs (originalTask ', '\n' + DELEGATED_SCOPE_GUIDANCE + '\nInputs (originalTask ');
      if (arm === 'baseline') request.userContent = request.userContent.replace(DELEGATED_SCOPE_GUIDANCE + '\n', '');
      const key = `${fixture.id}:${arm}`, sha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      requests.push({ key, sha256, request });
      const saved = rows.find(r => r.key === key && r.response);
      if (saved && saved.sha256 !== sha256) throw Error(`Input drift: ${key}`);
      if (saved) return saved.response;
      if (!live) throw Error(`Missing response ${key}; --live spends quota`);
      const row = { key, sha256, startedAt: new Date().toISOString() };
      try { row.response = await client.complete({ ...request, signal: AbortSignal.timeout(125000) }); }
      catch (error) { row.error = String(error); }
      appendFileSync(file('responses.jsonl'), JSON.stringify(row) + '\n');
      writeFileSync(file('requests.json.gz'), gzipSync(JSON.stringify(requests), { mtime: 0 }));
      if (row.error) throw Error(row.error);
      return row.response;
    };
    const ctx = { signal: new AbortController().signal, llm: { complete } };
    const verdict = await llmVerdict({ ctx, model: 'gpt-5.6-luna', supervisorName: 'Cell', supervisorTier: 2, subject: 'RESULT',
      child: { name: 'Molecule', tier: 1, toolNames: () => ['read_file', 'write_file', 'run_shell'], isFallbackMode: () => false },
      task: fixture.task ?? { description: 'Archived exact task supplied by recorded request' },
      payload: { output: { files: ['price.mjs'] }, summary: fixture.summary ?? '' }, groundTruthBlock: fixture.evidence ?? 'Archived exact evidence supplied by recorded request' });
    const row = { id: fixture.id, arm, expected: fixture.expected, matchesExpected: fixture.expected === null ? null : verdict.approved === fixture.expected, verdict };
    results.push(row); console.log(JSON.stringify(row));
    writeFileSync(file('results.json'), JSON.stringify(results, null, 2) + '\n');
  }
}
writeFileSync(file('requests.json.gz'), gzipSync(JSON.stringify(requests), { mtime: 0 }));
