// Paired, quota-free retrieval evaluation. Run after build: node benchmark/code-retrieval/evaluate.mjs /absolute/python
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareProjectRetrievalCorpus, projectRetrievalHash, chunkDocument, retrievalIndexConfig, retrievalGeneration } from '../../dist/projects/retrievalCorpus.js';
import { createHaystackRetrievalBinding } from '../../dist/projects/retrievalHaystack.js';
import { inspectHaystackRuntime } from '../../dist/projects/retrievalRuntime.js';
import { createProjectRetrievalTool } from '../../dist/tools/projectRetrieval.js';
const launch = process.argv.includes('--configured') ? JSON.parse(process.env.ATOMA_HAYSTACK_CONFIG)
  : { python: process.argv[2], settings: { mode: 'bm25' } };
const root = mkdtempSync(join(tmpdir(), 'atoma-code-eval-'));
// Frozen synthetic tasks and independent expected file sets, shared by both arms.
const cases = [
  { symbol: 'refundAmount', request: 'refund amount hours boundary', body: 'hours >= 24 ? 100 : 0', expected: ['src/refundAmount.ts', 'tests/refundAmount.test.ts'] },
  { symbol: 'taxTotal', request: 'tax total rounding cents', body: 'Math.round(hours * 1.2)', expected: ['src/taxTotal.ts', 'tests/taxTotal.test.ts'] },
  { symbol: 'sessionExpiry', request: 'session expiry hours timeout', body: 'hours > 48', expected: ['src/sessionExpiry.ts', 'tests/sessionExpiry.test.ts'] },
];
const files = Object.fromEntries(cases.flatMap(c => [
  [c.expected[0], `export const unrelated = ${JSON.stringify('noise '.repeat(110))};\nexport function ${c.symbol}(hours: number) {\n  return ${c.body};\n}\n`],
  [c.expected[1], `import { ${c.symbol} } from '../src/${c.symbol}.js';\nexport const boundaries = [${c.symbol}(24), ${c.symbol}(23)];\n`],
]));
const context = () => ({ signal: AbortSignal.timeout(120_000), deadlineAt: Date.now() + 120_000 });
try {
  const runtimeSha256 = await inspectHaystackRuntime(launch.python, launch.settings.mode === 'hybrid-rerank');
  const implementationSha256 = projectRetrievalHash(['retrievalCorpus', 'retrievalCode', 'retrievalHaystack'].map(name => readFileSync(new URL(`../../dist/projects/${name}.js`, import.meta.url), 'utf8')).join('\n'));
  const documents = Object.entries(files).map(([path, text]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
    return { path, sha256: projectRetrievalHash(text), bytes: Buffer.byteLength(text) };
  });
  const structured = await prepareProjectRetrievalCorpus(root, { version: 1, corpusId: 'evaluation', snapshotId: 'fixture-v1',
    snapshotSha256: projectRetrievalHash(JSON.stringify(files)), documents }, context());
  const config = retrievalIndexConfig();
  const baseline = { ...structured, config, generation: retrievalGeneration(structured.manifest, config),
    passages: documents.flatMap(d => chunkDocument(d, Buffer.from(files[d.path]), config.chunks)) };
  const rows = [];
  for (const [arm, corpus] of [['line-chunks', baseline], ['symbols-and-relations', structured]]) {
    const scope = { kind: 'operator', runId: 'evaluation', corpusId: corpus.manifest.corpusId,
      snapshotId: corpus.manifest.snapshotId, snapshotSha256: corpus.manifest.snapshotSha256, generation: corpus.generation };
    const start = performance.now();
    const binding = await createHaystackRetrievalBinding({ corpus, ...launch, context: context(),
      authority: { scope, service: { authorize: async () => true, search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {} } } });
    const preparationMs = performance.now() - start;
    const tool = createProjectRetrievalTool(binding, context());
    try {
      for (const c of cases) {
        const started = performance.now();
        const result = await tool.execute({ query: c.request, includeRelated: arm === 'symbols-and-relations', limit: 2 });
        if (!result.ok) throw new Error(JSON.stringify(result));
        const paths = [...new Set(result.passages.map(p => p.path))];
        rows.push({ arm, task: c.symbol, expected: c.expected, paths,
          recall: c.expected.filter(p => paths.includes(p)).length / c.expected.length,
          excerptBytes: result.passages.reduce((n, p) => n + Buffer.byteLength(p.excerpt), 0),
          responseBytes: Buffer.byteLength(JSON.stringify(result)), queryMs: performance.now() - started, preparationMs });
      }
    } finally { await tool.close(); }
  }
  process.stdout.write(JSON.stringify({ fixture: 'code-retrieval-v1', measuredAt: new Date().toISOString(), node: process.version, runtimeSha256, implementationSha256, backend: `real Haystack ${launch.settings.mode}`,
    modelPins: launch.settings.mode === 'hybrid-rerank' ? { embedding: launch.settings.embeddingRevision, reranker: launch.settings.rerankerRevision, queryPrefix: launch.settings.queryPrefix } : null, tasks: cases.length,
    paidCalls: 0, scope: 'Synthetic retrieval only; no end-to-end agent quality or cost claim.', rows }, null, 2) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
