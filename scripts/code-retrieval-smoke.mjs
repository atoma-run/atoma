// Compiled ingestion -> real child protocol -> bounded agent reader; no model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareProjectRetrievalCorpus, projectRetrievalHash } from '../dist/projects/retrievalCorpus.js';
import { createHaystackRetrievalBinding } from '../dist/projects/retrievalHaystack.js';
import { createProjectRetrievalTool } from '../dist/tools/projectRetrieval.js';
import { haystackTestRuntime } from './fixtures/haystack-test-runtime.mjs';
const root = mkdtempSync(join(tmpdir(), 'atoma-code-smoke-'));
let tool;
try {
  const text = 'export function refundAmount(hours) { return hours >= 24 ? 100 : 0; }\n';
  writeFileSync(join(root, 'refund.js'), text);
  const context = { signal: AbortSignal.timeout(30_000), deadlineAt: Date.now() + 30_000 };
  const corpus = await prepareProjectRetrievalCorpus(root, { version: 1, corpusId: 'code', snapshotId: 'compiled',
    snapshotSha256: projectRetrievalHash(text), documents: [{ path: 'refund.js', sha256: projectRetrievalHash(text), bytes: Buffer.byteLength(text) }] }, context);
  const scope = { kind: 'operator', runId: 'compiled', corpusId: 'code', snapshotId: 'compiled', snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation };
  const binding = await createHaystackRetrievalBinding({ corpus, context, ...haystackTestRuntime(root), authority: { scope,
    service: { authorize: async () => true, search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {} } } });
  tool = createProjectRetrievalTool(binding, context);
  const result = await tool.execute({ query: 'refund amount' });
  assert.equal(result.ok, true);
  assert.equal(result.passages[0].code.symbol, 'refundAmount');
  assert.equal(result.passages[0].citation.quote, text);
  console.log('Compiled code retrieval: parser, Haystack protocol and exact citation passed');
} finally { await tool?.close(); rmSync(root, { recursive: true, force: true }); }
