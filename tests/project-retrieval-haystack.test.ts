import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHaystackRetrievalBinding } from '../src/projects/retrievalHaystack.js';
import { haystackModelRevision } from '../src/projects/retrievalModelFiles.js';
import { createProjectRetrievalTool, type ProjectRetrievalBinding } from '../src/tools/projectRetrieval.js';
import { corpusScope, prepareTestCorpus, retrievalContext } from './helpers/projectRetrievalCorpus.js';
import { prepareProjectRetrievalCorpus, projectRetrievalHash, retrievalEmbeddingText } from '../src/projects/retrievalCorpus.js';
import { ProjectEmbeddingCache, retrievalEncoderKey } from '../src/projects/retrievalEmbeddingCache.js';
import { matchesProjectRetrievalFilters } from '../src/contracts/projectRetrieval.js';
import type { HaystackSettings } from '../src/contracts/retrievalHaystack.js';

let root: string;
const owned: ProjectRetrievalBinding[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atoma-haystack-test-')); });
afterEach(async () => { await Promise.allSettled(owned.splice(0).map(b => b.service.dispose())); rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const corpus = await prepareTestCorpus(root, { 'price.md': '# Price\nAnnual price is 190 euros.\n', 'support.md': '# Support\nContact the desk.\n' });
  const scope = corpusScope(corpus);
  const authority = { scope, service: { authorize: vi.fn(async () => true),
    search: vi.fn(async () => ({ ok: false as const, status: 'unavailable' as const })), dispose: vi.fn(async () => {}) } };
  return { corpus, authority, context: retrievalContext(), settings: { mode: 'bm25' as const } };
}
/** A real child executable exercises the host protocol without Python/model dependencies in CI. */
function executable(behavior = 'valid') {
  const path = join(root, 'protocol');
  writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(process.pid));
const mode = ${JSON.stringify(behavior)};
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
let documents;
const computed = new Map();
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.op === 'search') fs.writeFileSync(${JSON.stringify(join(root, 'query.json'))}, JSON.stringify(request));
 if(request.op === 'init') {
   documents = request.documents;
   if(mode === 'cache' || mode === 'cache-reject') {
     if(mode === 'cache-reject' && documents.some(d => !!d.cachedEmbedding)) {
       fs.appendFileSync(${JSON.stringify(join(root, 'cache-rejections'))}, 'rejected\\n');
       reply({kind:'cache-rejected',id:0});
       return;
     }
     for(const doc of documents) if(!doc.cachedEmbedding) {
       const value = Buffer.alloc(8);
       value.writeFloatLE(doc.embeddingText.length, 0);
       value.writeFloatLE(doc.embeddingText.charCodeAt(0), 4);
       computed.set(doc.id, value.toString('base64'));
     }
     fs.appendFileSync(${JSON.stringify(join(root, 'cache-calls.jsonl'))}, JSON.stringify({
       computed:computed.size, cached:documents.filter(d => !!d.cachedEmbedding).length,
       inputs:documents.map(d => d.embeddingText)}) + '\\n');
   }
   if(mode === 'threads' && (process.env.OMP_NUM_THREADS !== '3' || process.env.MKL_NUM_THREADS !== '3')) process.exit(2);
   if(mode === 'env' && (process.env.OPENAI_API_KEY || process.env.HOME || process.env.PYTHONPATH || process.env.HF_HUB_OFFLINE !== '1' || process.env.OMP_NUM_THREADS !== '1' || process.env.MKL_NUM_THREADS !== '1')) process.exit(2);
   reply({kind:'ready',id:0,version:mode === 'version' ? '0.0.0' : '3.1.1',documents:documents.length,
     ...(mode === 'cache' || mode === 'cache-reject' ? {runtimeSha256:'f'.repeat(64),dimension:2,computed:computed.size} : {})});
 } else if(mode === 'hang') { /* keep stdin open until cancellation */ }
 else if((mode === 'cache' || mode === 'cache-reject') && request.op === 'embedding') {
   const vector = computed.get(request.documentId);
   if(!vector) process.exit(2);
   reply({kind:'embedding',id:request.id,documentId:request.documentId,dimension:2,vector});
 }
 else if(mode === 'malformed') process.stdout.write('not json\\n');
 else if(mode === 'oversized') process.stdout.write('x'.repeat(33 * 1024 * 1024));
 else if(mode === 'unknown') reply({kind:'result',id:request.id,hits:[{id:'f'.repeat(64),score:1}]});
 else if(mode === 'duplicate') reply({kind:'result',id:request.id,hits:[{id:documents[0].id,score:1},{id:documents[0].id,score:1}]});
 else reply({kind:'result',id:request.id,hits:documents.map(d => ({id:d.id,score:1}))});
});
`, { mode: 0o700 });
  return path;
}
async function bind(behavior = 'valid') {
  const input = await fixture();
  const binding = await createHaystackRetrievalBinding({ ...input, python: executable(behavior) });
  owned.push(binding);
  return { ...input, binding, tool: createProjectRetrievalTool(binding, retrievalContext()) };
}

describe('experimental Haystack host boundary', () => {
  it('reuses unchanged fragments across fresh processes and keeps projects separate', async () => {
    const embeddingPath = join(root, 'embedding');
    const rerankerPath = join(root, 'reranker');
    mkdirSync(embeddingPath); mkdirSync(rerankerPath);
    writeFileSync(join(embeddingPath, 'weights'), 'embedding-v1');
    writeFileSync(join(rerankerPath, 'weights'), 'reranker-v1');
    const settings: HaystackSettings = { mode: 'hybrid-rerank', embeddingPath, rerankerPath, queryPrefix: '',
      embeddingRevision: await haystackModelRevision(embeddingPath, retrievalContext()),
      rerankerRevision: await haystackModelRevision(rerankerPath, retrievalContext()) };
    const dbPath = join(root, 'product.db');
    const python = executable('cache');
    const bindCorpus = async (files: Record<string, string>, snapshotId: string, projectId = 'project-a',
      child = python, documentPrefix?: string) => {
      const first = await prepareTestCorpus(root, files);
      const corpus = await prepareProjectRetrievalCorpus(root, { ...first.manifest, snapshotId }, retrievalContext());
      const scope = corpusScope(corpus, { runId: snapshotId, projectId, snapshotId, generation: corpus.generation });
      const authority: ProjectRetrievalBinding = { scope, service: {
        authorize: async () => true, search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {},
      } };
      const binding = await createHaystackRetrievalBinding({ authority, corpus, python: child, settings: { ...settings, ...(documentPrefix === undefined ? {} : { documentPrefix }) },
        runtimeSha256: 'f'.repeat(64), cacheDbPath: dbPath, context: retrievalContext() });
      owned.push(binding);
      return { corpus, binding };
    };
    const first = await bindCorpus({ 'price.md': 'Annual price is 190 euros.\n', 'support.md': 'Contact the desk.\n' }, 'snapshot-a');
    await first.binding.service.dispose();
    const second = await bindCorpus({ 'price.md': 'Annual price is 190 euros.\n', 'support.md': 'Contact the desk.\n' }, 'snapshot-b');
    expect(await createProjectRetrievalTool(second.binding, retrievalContext()).execute({ query: 'price' })).toMatchObject({ ok: true });
    await second.binding.service.dispose();
    const third = await bindCorpus({ 'price.md': 'Annual price is 191 euros.\n', 'support.md': 'Contact the desk.\n' }, 'snapshot-c');
    await third.binding.service.dispose();
    const otherProject = await bindCorpus({ 'price.md': 'Annual price is 190 euros.\n', 'support.md': 'Contact the desk.\n' }, 'snapshot-d', 'project-b');
    await otherProject.binding.service.dispose();
    const originalGet = ProjectEmbeddingCache.prototype.get;
    let reads = 0;
    const fault = vi.spyOn(ProjectEmbeddingCache.prototype, 'get').mockImplementation(function (this: ProjectEmbeddingCache, hash) {
      if (++reads === 2) throw new Error('cache read failed');
      return originalGet.call(this, hash);
    });
    try {
      const recovered = await bindCorpus({ 'price.md': 'Annual price is 190 euros.\n', 'support.md': 'Contact the desk.\n' }, 'snapshot-f');
      await recovered.binding.service.dispose();
    } finally { fault.mockRestore(); }
    const rejected = await bindCorpus({ 'price.md': 'Annual price is 190 euros.\n', 'support.md': 'Contact the desk.\n' },
      'snapshot-e', 'project-a', executable('cache-reject'));
    await rejected.binding.service.dispose();
    const prefixed = await bindCorpus({ 'price.md': 'Annual price is 190 euros.\n', 'support.md': 'Contact the desk.\n' },
      'snapshot-prefix', 'project-a', python, 'passage: ');
    await prefixed.binding.service.dispose();
    const calls = readFileSync(join(root, 'cache-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => [call.computed, call.cached])).toEqual([[2, 0], [0, 2], [1, 1], [2, 0], [2, 0], [2, 0], [2, 0]]);
    expect(readFileSync(join(root, 'cache-rejections'), 'utf8')).toBe('rejected\n');
    expect(calls[0].inputs).toEqual(calls[1].inputs);
    expect(calls[1].inputs).toContain(retrievalEmbeddingText(second.corpus.passages[0]!));
    const cache = new ProjectEmbeddingCache(dbPath, 'org-a', 'project-a',
      retrievalEncoderKey(settings.embeddingRevision, 'f'.repeat(64)));
    try { expect(cache.get(projectRetrievalHash(calls[0].inputs[0]))?.dimension).toBe(2); }
    finally { cache.close(); }
  });
  it('discards damaged vectors and repairs the same content key', () => {
    const dbPath = join(root, 'product.db');
    const cache = new ProjectEmbeddingCache(dbPath, 'org-a', 'project-a', 'encoder-a');
    const vector = Buffer.alloc(8);
    vector.writeFloatLE(1.5, 0); vector.writeFloatLE(2.5, 4);
    cache.putMany([{ inputHash: 'input-a', dimension: 2, vector }]);
    expect(cache.get('input-a')?.vector).toEqual(vector);
    const db = new Database(dbPath);
    try { db.prepare('UPDATE project_embedding_cache SET vector_sha256 = ? WHERE input_hash = ?').run('invalid', 'input-a'); }
    finally { db.close(); }
    expect(cache.get('input-a')).toBeNull();
    cache.putMany([{ inputHash: 'input-a', dimension: 2, vector }]);
    expect(cache.get('input-a')?.vector).toEqual(vector);
    cache.close();
  });
  it('combines filter fields and respects directory boundaries', () => {
    const filters = { directories: ['docs'], paths: ['docs/nested/a.md', 'docs/a.txt'] };
    expect(matchesProjectRetrievalFilters('docs/nested/a.md', filters)).toBe(true);
    expect(matchesProjectRetrievalFilters('docs-other/a.md', filters)).toBe(false);
    expect(matchesProjectRetrievalFilters('docs/b.md', filters)).toBe(false);
    expect(matchesProjectRetrievalFilters('docs/a.txt', { ...filters, formats: ['md'] })).toBe(false);
  });
  it('forwards bounded filters and refuses an excluded backend hit', async () => {
    const { tool } = await bind();
    expect(await tool.execute({ query: 'price', filters: { paths: ['price.md'] } }))
      .toEqual({ ok: false, status: 'unavailable' });
    expect(JSON.parse(readFileSync(join(root, 'query.json'), 'utf8'))).toMatchObject({
      filters: { field: 'meta.path', operator: 'in', value: ['price.md'] },
    });
    for (const filters of [{ orgId: 'other' }, { snapshotId: 'other' }, { paths: ['../secret.md'] },
      { directories: ['docs/'] }, { formats: ['exe'] }, { paths: [] }]) {
      expect(await tool.execute({ query: 'price', filters })).toEqual({ ok: false, status: 'invalid_request' });
    }
  });
  it('preserves NFC text for semantic search across the child boundary', async () => {
    const { tool } = await bind();
    expect(await tool.execute({ query: 'Cafe\u0301 : pourquoi NON, non ?' })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(root, 'query.json'), 'utf8'))).toMatchObject({
      query: 'Café : pourquoi NON, non ?', lexicalQuery: 'café pourquoi non',
    });
  });
  it('returns exact admitted passages through the existing L1 element and honors live revocation', async () => {
    const { tool, binding, authority, corpus } = await bind();
    const result = await tool.execute({ query: 'price', limit: 1 });
    expect(result).toMatchObject({ ok: true, passages: [{ ...corpus.passages[0], score: 1 }], truncated: true });
    expect(authority.service.search).not.toHaveBeenCalled();
    expect(await binding.service.authorize({ ...binding.scope, runId: 'other' }, retrievalContext())).toBe(false);
    authority.service.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await tool.execute({ query: 'price' })).toEqual({ ok: false, status: 'denied' });
    await tool.close();
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await binding.service.authorize(binding.scope, retrievalContext())).toBe(false);
  });
  it.each(['unknown', 'duplicate', 'malformed', 'oversized'])('hides %s backend output', async behavior => {
    const { tool } = await bind(behavior);
    expect(await tool.execute({ query: 'price' })).toEqual({ ok: false, status: 'unavailable' });
    await tool.close();
  });
  it('kills and reaps a child when a query is cancelled', async () => {
    const { binding } = await bind('hang');
    const controller = new AbortController();
    const tool = createProjectRetrievalTool(binding, retrievalContext(30_000, controller.signal));
    const pending = tool.execute({ query: 'price' });
    setTimeout(() => controller.abort(), 30);
    expect(await pending).toEqual({ ok: false, status: 'cancelled' });
    await tool.close();
    expect(() => process.kill(Number(readFileSync(join(root, 'pid'), 'utf8')), 0)).toThrow();
  });
  it('rejects a missing runtime and mismatched package version with authority teardown', async () => {
    const input = await fixture();
    await expect(createHaystackRetrievalBinding({ ...input, python: join(root, 'missing') })).rejects.toThrow();
    expect(input.authority.service.dispose).toHaveBeenCalledOnce();
    await expect(createHaystackRetrievalBinding({ ...input, python: executable('version') })).rejects.toThrow();
  });
  it('never starts the backend when source authority or generation is wrong', async () => {
    const input = await fixture();
    input.authority.service.authorize.mockResolvedValue(false);
    await expect(createHaystackRetrievalBinding({ ...input, python: executable() })).rejects.toThrow('denied');
    expect(() => readFileSync(join(root, 'pid'))).toThrow();
    input.authority.scope = { ...input.authority.scope, generation: 'f'.repeat(64) };
    await expect(createHaystackRetrievalBinding({ ...input, python: executable() })).rejects.toThrow('mismatch');
  });
  it('requires a literal true admission before sending documents to Python', async () => {
    const input = await fixture();
    input.authority.service.authorize.mockResolvedValue('yes' as never);
    await expect(createHaystackRetrievalBinding({ ...input, python: executable() })).rejects.toThrow('denied');
    expect(() => readFileSync(join(root, 'pid'))).toThrow();
  });
  it('passes the desktop CPU budget through the isolated Python process environment', async () => {
    vi.stubEnv('ATOMA_COMPUTE_RETRIEVAL_CPUS', '3');
    try { const { tool } = await bind('threads'); expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true }); }
    finally { vi.unstubAllEnvs(); }
  });
  it('does not inherit host secrets or enable model downloads', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-key'); vi.stubEnv('PYTHONPATH', root);
    try { const { tool } = await bind('env'); expect(await tool.execute({ query: 'price' })).toMatchObject({ ok: true }); }
    finally { vi.unstubAllEnvs(); }
  });
  it('pins nested model names with portable POSIX separators', async () => {
    const model = join(root, 'portable-model');
    mkdirSync(join(model, 'nested'), { recursive: true });
    writeFileSync(join(model, 'nested', 'weights'), 'v1');
    const content = createHash('sha256').update('v1').digest('hex');
    expect(await haystackModelRevision(model, retrievalContext())).toBe(
      projectRetrievalHash(JSON.stringify([['nested/weights', content]])));
  });
  it('pins model content and refuses changed weights and symlinks', async () => {
    const input = await fixture();
    const model = join(root, 'model'); mkdirSync(model); writeFileSync(join(model, 'weights'), 'v1');
    const revision = await haystackModelRevision(model, retrievalContext());
    mkdirSync(join(model, '.cache')); writeFileSync(join(model, '.cache', 'metadata'), 'ignored');
    expect(await haystackModelRevision(model, retrievalContext())).toBe(revision);
    writeFileSync(join(model, 'weights'), 'v2');
    const settings: HaystackSettings = { mode: 'hybrid-rerank', embeddingPath: model, rerankerPath: model,
      queryPrefix: '', embeddingRevision: revision, rerankerRevision: revision };
    await expect(createHaystackRetrievalBinding({ ...input, settings, python: executable() })).rejects.toThrow('model files changed');
    expect(() => readFileSync(join(root, 'pid'))).toThrow();
    symlinkSync(join(model, 'weights'), join(model, 'alias'));
    await expect(haystackModelRevision(model, retrievalContext())).rejects.toThrow('symlinks');
  });
});

const python = process.env['ATOMA_HAYSTACK_TEST_PYTHON'];
describe.skipIf(!python)('real optional Haystack runtime', () => {
  it('exits when its host input pipe disappears', async () => {
    const child = spawn(python!, ['-I', '-u', fileURLToPath(new URL('../scripts/retrieval-haystack.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { HAYSTACK_TELEMETRY_ENABLED: 'False', HF_HUB_OFFLINE: '1' } });
    child.stderr.resume();
    const closed = once(child, 'close');
    try {
      child.stdin.write(JSON.stringify({ id: 0, op: 'init', settings: { mode: 'bm25' }, documents: [] }) + '\n');
      await once(child.stdout, 'data');
      child.stdin.destroy();
      expect((await closed)[0]).toBe(0);
    } finally { child.kill('SIGKILL'); }
  }, 15_000);

  it('loads the pinned framework and retrieves source bytes across the Python boundary', async () => {
    const input = await fixture();
    const binding = await createHaystackRetrievalBinding({ ...input, python: python!, context: retrievalContext(60_000) });
    owned.push(binding);
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    expect(await tool.execute({ query: 'annual price', limit: 1 })).toMatchObject({ ok: true, passages: [{ path: 'price.md', excerpt: input.corpus.passages[0]!.excerpt }] });
    const filtered = await tool.execute({ query: 'annual price', filters: { paths: ['support.md'] } });
    expect(filtered).toMatchObject({ ok: true });
    if (filtered.ok) expect(filtered.passages.every(p => p.path === 'support.md')).toBe(true);
    expect(await tool.execute({ query: 'price', filters: { formats: ['txt'] } }))
      .toMatchObject({ ok: true, passages: [] });
    await tool.close();
  }, 65_000);
  it.skipIf(!process.env['ATOMA_HAYSTACK_TEST_MODELS'])('runs local embeddings, fusion and cross-encoder reranking', async () => {
    const input = await fixture();
    const models = process.env['ATOMA_HAYSTACK_TEST_MODELS']!;
    const context = retrievalContext(120_000);
    const embeddingPath = join(models, 'embedding'), rerankerPath = join(models, 'reranker');
    const settings: HaystackSettings = { mode: 'hybrid-rerank', embeddingPath, rerankerPath,
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      embeddingRevision: await haystackModelRevision(embeddingPath, context),
      rerankerRevision: await haystackModelRevision(rerankerPath, context) };
    const binding = await createHaystackRetrievalBinding({ ...input, python: python!, settings, context });
    owned.push(binding);
    const tool = createProjectRetrievalTool(binding, retrievalContext());
    expect(await tool.execute({ query: 'annual price', limit: 1 })).toMatchObject({ ok: true, passages: [{ path: 'price.md' }] });
    const filtered = await tool.execute({ query: 'annual price', filters: { paths: ['support.md'] } });
    expect(filtered).toMatchObject({ ok: true });
    if (filtered.ok) expect(filtered.passages.every(p => p.path === 'support.md')).toBe(true);
    expect(await tool.execute({ query: 'price', filters: { formats: ['txt'] } }))
      .toMatchObject({ ok: true, passages: [] });
    await tool.close();
  }, 125_000);
});
