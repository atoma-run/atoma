import { readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { CodexCliLlmClient } from '../../src/core/llmCodexCli.ts';
import { reviewAcceptanceCriteria } from '../../src/atoms/criteriaReview.ts';

const root = new URL('.', import.meta.url);
const old = new URL('../stock-reconcile-2026-10-05/', root);
const archive = JSON.parse(gunzipSync(readFileSync(new URL('live-evidence.json.gz', old))));
const original = archive.events.find(e => e.id === '2d7558f1-de0e-4310-a82b-bd2bab8fed2a');
const protocol = JSON.parse(readFileSync(new URL('protocol.json', old)));
const source = readFileSync(new URL('published/stock-reconcile.test.js.txt', old), 'utf8');
const text = original.userContent;
const probeStart = text.indexOf('== GROUND-TRUTH EVIDENCE');
const rootStart = text.indexOf('ROOT DELIVERY PROOF');
const filesStart = text.indexOf('FILES THE CRITERIA NAME');
const fileStart = text.lastIndexOf('- test/stock-reconcile.test.js (4644 chars):');
if ([probeStart, rootStart, filesStart, fileStart].some(i => i < 0)) throw Error('Archive boundary changed');
const evidence = text.slice(probeStart, rootStart) + text.slice(filesStart, fileStart)
  + '- test/stock-reconcile.test.js (4644 chars): ' + JSON.stringify(source);
const items = list => list.map((behaviour, i) => ({ id: `c${i + 1}`, behaviour, check: { kind: 'review' } }));
const cases = Array.from({ length: 3 }, (_, repeat) => ({ id: `warehouse-${repeat}`, task: { description: protocol.request.goal },
  checklist: items(protocol.request.acceptanceCriteria), evidence, expectedUnmet: ['c4', 'c6'] }));
cases.push(
  { id: 'valid-cli', task: { description: 'Verify conflicting duplicate IDs preserve input/output bytes and verify both output files are deterministic across two executions.' },
    checklist: items(['Conflicting duplicate IDs fail and preserve both input and existing output files.', 'Both stock.csv and audit.json are byte-identical across repeated valid executions.']),
    evidence: 'Synthetic host records e1: valid opening A=1; events x,A,RECEIVE,1 and x,A,RECEIVE,2. CLI exit=1, stderr conflicting duplicate x at row 3. sha256 before and after match for opening.csv, events.csv, existing stock.csv and audit.json. e2: on identical valid inputs, first and second CLI exits=0. The script captures buffers of both outputs after EACH execution and assert.deepEqual(firstStock,secondStock), assert.deepEqual(firstAudit,secondAudit) pass. Script exit=0. No intervening edits.', expectedUnmet: [] },
  { id: 'misleading-cli', task: { description: 'Verify conflicting duplicate IDs preserve output bytes and verify both output files are deterministic across two executions.' },
    checklist: items(['Conflicting duplicate IDs fail and preserve existing outputs.', 'Both stock.csv and audit.json are byte-identical across repeated valid executions.']),
    evidence: 'Synthetic host record e1: passing test named conflicts uses two IDENTICAL rows x,A,RECEIVE,1 and asserts exit 0, duplicates=1. No conflicting row executed. e2: two valid CLI runs exit 0; test compares stock.csv buffers from each run, but reads audit.json ONLY after the first. Suite title: all requirements verified; exit 0.', expectedUnmet: ['c1', 'c2'] },
  { id: 'valid-api', task: { description: 'Verify idempotent creation and conflicting requests to a record API. No UI or file artifacts are requested.' },
    checklist: items(['Repeating the same key and payload creates only one record.', 'Reusing a key with a changed payload is refused without changing the stored record.']),
    evidence: 'Synthetic transport records: GET /records -> 200 [] before setup. POST /records key=k body={value:7} -> 201 {id:1,value:7}; repeat identical POST -> 200 {id:1,value:7}; GET -> 200 [{id:1,value:7}]. POST key=k body={value:8} -> 409 conflict; GET -> 200 [{id:1,value:7}]. Assertion script checks every status, ID, returned value and final one-record array and exits 0.', expectedUnmet: [] },
  { id: 'valid-document', task: { description: 'Document the CLI invocation and opening CSV header sku,onHand, including that onHand is a nonnegative integer. Only documentation is requested.' },
    checklist: items(['README documents the CLI command.', 'README documents the opening CSV header and nonnegative integer stock.']),
    evidence: 'Host read_file README.md, complete: # Usage\nRun node reconcile.js --opening opening.csv --events events.csv --out output\nOpening CSV header: sku,onHand. onHand is a nonnegative integer.\nNo code execution was requested or performed.', expectedUnmet: [] },
  { id: 'truncated-document', task: { description: 'Document the CLI invocation and opening CSV header sku,onHand, including nonnegative integer stock.' },
    checklist: items(['README documents the CLI command.', 'README documents the opening CSV header and nonnegative integer stock.']),
    evidence: 'Host read_file README.md excerpt: # Usage\nRun node reconcile.js --opening opening.csv --events events.csv --out output\n[excerpt truncated; remaining contents unavailable]. A report claims formats appear later. No complete read available.', expectedUnmet: ['c2'] },
  { id: 'wrong-refusal-cause', task: { description: 'Verify conflicting duplicate IDs are refused and inputs are preserved.' },
    checklist: items(['Conflicting duplicate IDs are refused.', 'Existing inputs remain byte-identical on failure.']),
    evidence: 'Synthetic record: the events contain duplicate ID x with different quantities. Opening file does NOT exist. CLI exit=1, stderr cannot read opening.csv. Script compares the existing events.csv before/after bytes and passes. No valid-opening duplicate execution occurred.', expectedUnmet: ['c1'] },
);
const live = process.argv.includes('--live');
const previous = existsSync(new URL('responses.jsonl', root)) ? readFileSync(new URL('responses.jsonl', root), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const env = { ...process.env }; delete env.ATOMA_CODEX_MODEL;
process.env.ATOMA_MODEL_L1 = 'sub:openai:gpt-5.6-luna';
const binary = live ? realpathSync(process.env.ATOMA_REPLAY_CODEX_BINARY) : undefined;
const client = live ? new CodexCliLlmClient({ env, callTimeoutMs: 60000, spawnFn: (args, stdin, childEnv, cwd) => {
  const adjusted = args.map(a => a.startsWith('permissions.atoma-text-only.filesystem=') ? a.slice(0, -1) + ',' + JSON.stringify(binary) + '="read"}' : a);
  const child = spawn(binary, adjusted, { env: childEnv, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); child.stdin.end(stdin); return child;
} }) : undefined;
const requests = [];
for (const fixture of cases) {
  let batch = 0;
  const ctx = { signal: new AbortController().signal, llm: { complete: async req => {
    const request = { ...req, model: 'gpt-5.6-luna' }; delete request.signal;
    const key = `${fixture.id}:${batch++}`;
    const sha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    requests.push({ key, sha256, request });
    const recorded = previous.find(r => r.key === key);
    if (recorded && recorded.sha256 !== sha256) throw Error('Measured inputs changed; preserve this series');
    if (recorded?.response) return recorded.response;
    if (!live) {
      const group = fixture.checklist.slice((batch - 1) * 2, batch * 2);
      return { text: JSON.stringify({ approved: true, reasoning: 'Dry-run capture only', criteria: group.map(i => ({ id: i.id, met: true, reason: 'Dry-run fixture, not a judgment' })) }), stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    }
    const row = { key, sha256, startedAt: new Date().toISOString() };
    try { row.response = await client.complete({ ...request, signal: AbortSignal.timeout(65000) }); }
    catch (error) { row.error = String(error); }
    appendFileSync(new URL('responses.jsonl', root), JSON.stringify(row) + '\n');
    if (row.error) throw Error(row.error);
    return row.response;
  } } };
  const review = await reviewAcceptanceCriteria({ ctx, ...fixture });
  if (live) { const row = { id: fixture.id, expectedUnmet: fixture.expectedUnmet, review }; appendFileSync(new URL('reviews.jsonl', root), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); }
}
writeFileSync(new URL('requests.json.gz', root), gzipSync(JSON.stringify(requests)));
console.log(live ? 'Completed production review helper replay.' : `Prepared ${requests.length} calls through the production helper; --live spends quota.`);
