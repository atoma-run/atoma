import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/projects/service.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyseProjectCode } from '../src/projects/retrievalCode.js';
import { prepareTestCorpus, corpusScope, retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { createHaystackRetrievalBinding } from '../src/projects/retrievalHaystack.js';
import { createProjectRetrievalTool } from '../src/tools/projectRetrieval.js';
import { haystackTestRuntime } from './helpers/haystack.js';
import { selectRetrievalDocuments } from '../src/projects/retrievalSelection.js';
import { projectRetrievalFixture } from './helpers/projectRetrievalLaunch.js';
import { ProjectRetrievalLaunchStore } from '../src/projects/retrievalLaunch.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { searchSavedProjectCode } from '../src/projects/retrievalRead.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-code-')); });
afterEach(() => { closeStoreHandles(); rmSync(root, { recursive: true, force: true }); });
const files = {
  'refund.ts': 'export function refundAmount(hours: number) {\r\n  // remboursement café\r\n  return hours >= 24 ? 100 : 0;\r\n}\r\nexport const unrelated = 1;\r\n',
  'refund.test.ts': "import { refundAmount } from './refund.js';\nexport const cases = [refundAmount(24), refundAmount(23)];\n",
  'notes.txt': 'Never part of the code filters.\n',
};

it('preserves UTF-8/CRLF citations, separates symbols and resolves test imports from admitted paths only', async () => {
  const corpus = await prepareTestCorpus(root, files);
  expect(corpus.config.chunkerVersion).toBe('typescript-symbols-v1');
  const first = corpus.passages.find(p => p.code?.symbol === 'refundAmount')!;
  expect(first.excerpt).toContain('café\r\n');
  expect(first.excerpt).not.toContain('unrelated');
  expect(first.code).toMatchObject({ startLine: 1, endLine: 4, relations: [{ path: 'refund.test.ts', kind: 'imported-by' }] });
  for (const p of corpus.passages) expect(Buffer.from(files[p.path as keyof typeof files]).subarray(p.startByte, p.endByte).toString()).toBe(p.excerpt);
  const analysed = analyseProjectCode('x.ts', "import '../outside'; import 'node:fs'; import './missing';", ['x.ts']);
  expect(analysed.imports).toEqual([]);
  expect(analyseProjectCode('x.ts', 'export function broken( {', ['x.ts']).parseStatus).toBe('syntax-errors');
});

it('expands resolved neighbours through the real Haystack subprocess boundary and keeps filters and revocation', async () => {
  const corpus = await prepareTestCorpus(root, files);
  const authorize = vi.fn(async () => true);
  // Protocol fixture chooses a symbol as its first result; ranking quality is measured separately with real Haystack.
  const launch = haystackTestRuntime(root);
  const script = readFileSync(launch.python, 'utf8').replace('documents.slice(0,r.limit)', "documents.filter(d => !r.filters || r.filters.value.includes(d.meta.path)).sort((a,b) => Number(b.meta.symbol === 'refundAmount') - Number(a.meta.symbol === 'refundAmount')).slice(0,r.limit)");
  writeFileSync(launch.python, script);
  const binding = await createHaystackRetrievalBinding({ corpus, ...launch, context: retrievalContext(), authority: {
    scope: corpusScope(corpus), service: { authorize, search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {} },
  } });
  const tool = createProjectRetrievalTool(binding, retrievalContext());
  try {
    const result = await tool.execute({ query: 'refund amount', includeRelated: true, limit: 2 });
    expect(result.ok && result.passages.map(p => p.path)).toEqual(['refund.ts', 'refund.test.ts']);
    const narrowed = await tool.execute({ query: 'refund', includeRelated: true, filters: { paths: ['refund.ts'] } });
    expect(narrowed.ok && narrowed.passages.every(p => p.path === 'refund.ts')).toBe(true);
    authorize.mockResolvedValue(false);
    expect(await tool.execute({ query: 'refund' })).toEqual({ ok: false, status: 'denied' });
  } finally { await tool.close(); }
});

it('reports bounded coverage rather than failing a run on a large code inventory', () => {
  const selected = selectRetrievalDocuments(Array.from({ length: 205 }, (_, i) => ({ path: `src/f${i}.ts`, size: 100, sha256: 'a'.repeat(64), mode: '100644' })));
  expect(selected.coverage).toEqual({ eligible: 205, indexed: 200, omitted: 5 });
});

it('captures the actual imported seed and reuses the frozen corpus on continuation', async () => {
  const f = projectRetrievalFixture(root);
  const source = f.makeRun(files);
  const current = f.makeRun();
  const store = ProjectRetrievalLaunchStore.open(f.dbPath);
  const receipt = await store.prepare(current.run.projectRunId, null, retrievalContext(), source.layout.workspacePath);
  expect(receipt.manifest.documents.map(d => d.path)).toContain('refund.ts');
  writeFileSync(join(source.layout.workspacePath, 'refund.ts'), 'changed');
  const next = f.makeRun();
  const resumed = await store.prepare(next.run.projectRunId, null, retrievalContext(), undefined, current.run.projectRunId);
  expect(readFileSync(join(resumed.sourceRoot, 'refund.ts'), 'utf8')).toBe(files['refund.ts']);
});

it('uses the same reader for saved artifacts, refuses revoked access and altered bytes', async () => {
  const f = projectRetrievalFixture(root);
  const saved = f.makeRun(files);
  const launch = haystackTestRuntime(root);
  const input = { run: saved.run, principalId: f.viewer.principalId, launch, query: { query: 'refund' },
    read: (path: string) => readFileSync(join(saved.layout.workspacePath, path)), authorize: () => true };
  expect(await searchSavedProjectCode(input)).toMatchObject({ ok: true, coverage: { indexed: 3 } });
  expect(await searchSavedProjectCode({ ...input, authorize: () => false })).toEqual({ ok: false, status: 'denied' });
  writeFileSync(join(saved.layout.workspacePath, 'refund.ts'), 'tampered');
  expect(await searchSavedProjectCode(input)).toEqual({ ok: false, status: 'unavailable' });
});

it('serves a saved run whose unextractable PDF is counted as omitted, not a failed search (ea294153)', async () => {
  const f = projectRetrievalFixture(root);
  const broken = readFileSync(new URL('./fixtures/retrieval-documents/malformed-page-tree.pdf', import.meta.url));
  const saved = f.makeRun({ ...files, 'reading-edition.pdf': broken });
  const result = await searchSavedProjectCode({ run: saved.run, principalId: f.viewer.principalId,
    launch: haystackTestRuntime(root), query: { query: 'refund' },
    read: (path: string) => readFileSync(join(saved.layout.workspacePath, path)), authorize: () => true });
  expect(result).toMatchObject({ ok: true, coverage: { eligible: 4, indexed: 3, omitted: 1 } });
}, 60_000);

it('extracts class members and refuses ambiguous local module edges', () => {
  const analysis = analyseProjectCode('a.ts', 'export class Refund {\n  calculate(hours: number) { return hours; }\n}\n', ['a.ts']);
  expect(analysis.symbols.map(s => s.symbol)).toEqual(['Refund', 'Refund.calculate']);
  expect(analyseProjectCode('a.ts', "import './dep';", ['a.ts', 'dep.ts', 'dep.js']).imports).toEqual([]);
  expect(analyseProjectCode('a.ts', "import './dep';", ['a.ts', 'dep.ts']).imports).toEqual(['dep.ts']);
});

it('the shared service refuses cross-organisation and live-workspace reads before Haystack starts', async () => {
  const f = projectRetrievalFixture(root);
  const saved = f.makeRun(files);
  const service = new ProjectService({ store: f.projects, github: null, coordinator: {} as never });
  await expect(service.searchCode({ ...f.viewer, orgId: randomUUID(), platformAdmin: false }, f.project.projectId,
    saved.run.projectRunId, { query: 'refund' })).rejects.toMatchObject({ status: 404 });
  const current = f.makeRun();
  await expect(service.searchCode(f.viewer, f.project.projectId, current.run.projectRunId, { query: 'refund' }))
    .rejects.toMatchObject({ status: 409 });
  expect(f.projects.canReadProjectNow(f.viewer.principalId, f.viewer.orgId, f.project.projectId)).toBe(true);
  expect(f.projects.canReadProjectNow(f.viewer.principalId, f.viewer.orgId, f.project.projectId, 'foreign-active-org')).toBe(false);
  expect(f.projects.canReadProjectNow('foreign-principal', f.viewer.orgId, f.project.projectId)).toBe(false);
});
