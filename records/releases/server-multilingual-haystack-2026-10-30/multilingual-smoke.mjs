// Production-path smoke: release dist + host Python + configured models, 13 locales x {same, en}.
// Usage: node multilingual-smoke.mjs <release dir> <languages.json> <config.json>
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const [release, languagesPath, configPath] = process.argv.slice(2);
const { prepareProjectRetrievalCorpus, projectRetrievalHash } = await import(join(release, 'dist/projects/retrievalCorpus.js'));
const { createHaystackRetrievalBinding } = await import(join(release, 'dist/projects/retrievalHaystack.js'));
const { createProjectRetrievalTool } = await import(join(release, 'dist/tools/projectRetrieval.js'));
const { haystackLaunchSchema } = await import(join(release, 'dist/contracts/retrievalHaystack.js'));

const languages = JSON.parse(readFileSync(languagesPath, 'utf8'));
const launch = haystackLaunchSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
const ctx = (ms = 600_000) => ({ signal: new AbortController().signal, deadlineAt: Date.now() + ms });
const root = mkdtempSync(join(tmpdir(), 'atoma-multilingual-smoke-'));
try {
  const files = Object.fromEntries(Object.entries(languages).flatMap(([locale, entries]) =>
    entries.slice(1).map((text, i) => [`languages/${locale}/${i}.txt`, text])));
  const documents = Object.entries(files).map(([path, content]) => {
    const bytes = Buffer.from(content);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: projectRetrievalHash(bytes), bytes: bytes.length };
  });
  const manifest = { version: 1, corpusId: 'docs', snapshotId: 'smoke', snapshotSha256: projectRetrievalHash(JSON.stringify(documents)), documents };
  const corpus = await prepareProjectRetrievalCorpus(root, manifest, ctx());
  const scope = { kind: 'tenant', runId: 'smoke-run', orgId: 'smoke-org', projectId: 'smoke-project', principalId: 'smoke',
    corpusId: 'docs', snapshotId: 'smoke', snapshotSha256: manifest.snapshotSha256, generation: corpus.generation };
  const authority = { scope, service: { authorize: async () => true, search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {} } };
  const started = Date.now();
  let stats;
  const binding = await createHaystackRetrievalBinding({ authority, corpus, python: launch.python, settings: launch.settings,
    runtimeSha256: launch.runtimeSha256, context: ctx(), cacheDbPath: join(root, 'cache.db'), onPreparationStats: s => { stats = s; } });
  console.log(JSON.stringify({ ready: true, ms: Date.now() - started, passages: corpus.passages.length, stats }));
  const tool = createProjectRetrievalTool(binding, ctx());
  let failed = 0, passed = 0;
  try {
    for (const [locale, [query]] of Object.entries(languages)) {
      for (const directory of [locale, 'en']) {
        const result = await tool.execute({ query, filters: { directories: [`languages/${directory}`] }, limit: 1 });
        const top = result.ok ? result.passages[0]?.path : `error:${result.status}`;
        const ok = top === `languages/${directory}/0.txt`;
        ok ? passed++ : failed++;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${locale} -> ${directory}: ${top}`);
      }
    }
  } finally { await tool.close(); await binding.service.dispose(); }
  console.log(JSON.stringify({ passed, failed }));
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(root, { recursive: true, force: true }); }
