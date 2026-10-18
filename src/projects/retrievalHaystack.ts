import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { HAYSTACK_FRAME_BYTES, HAYSTACK_REPLY_BYTES, haystackReplySchema, haystackSettingsSchema,
  type HaystackReply, type HaystackSettings } from '../contracts/retrievalHaystack.js';
import { matchesProjectRetrievalFilters, projectDocumentFormat, projectRetrievalPassageSchema, type ProjectRetrievalPassage } from '../contracts/projectRetrieval.js';
import { PROJECT_RETRIEVAL_CORPUS_LIMITS } from '../contracts/projectRetrievalCorpus.js';
import { haystackModelRevision } from './retrievalModelFiles.js';
import { validateProjectRetrievalBinding, type ProjectRetrievalBinding,
  type ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';
import { assertRetrievalTime, canonicalRetrievalManifest, projectRetrievalHash,
  retrievalDocumentId, retrievalEmbeddingText, retrievalGeneration, retrievalPassageContext, type PreparedProjectRetrievalCorpus } from './retrievalCorpus.js';
import { ProjectEmbeddingCache, retrievalEncoderKey } from './retrievalEmbeddingCache.js';

/** Run-owned Python backend. Only admitted text enters; only IDs and scores return. */
class HaystackProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: HaystackReply) => void; reject: () => void }>();
  private readonly exited: Promise<unknown>;
  private buffer = '';
  private stopped = false;
  private ordinal = 0;
  constructor(python: string) {
    if (!isAbsolute(python)) throw new Error('Haystack requires an absolute host Python executable');
    this.child = spawn(python, ['-I', '-u', fileURLToPath(new URL('../../scripts/retrieval-haystack.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      // No HOME, provider credentials, tracing destination, Python injection, or product paths.
      env: { PATH: process.env['PATH'], LANG: 'C.UTF-8', HAYSTACK_TELEMETRY_ENABLED: 'False',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
    });
    this.exited = once(this.child, 'close').catch(() => {});
    this.child.on('error', () => this.stop());
    this.child.on('close', () => this.stop());
    this.child.stdin.on('error', () => this.stop());
    // Drain diagnostics without retaining potential document bodies or host paths.
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          if (Buffer.byteLength(line) > HAYSTACK_REPLY_BYTES) throw new Error('oversized response');
          const message = haystackReplySchema.parse(JSON.parse(line));
          const pending = this.pending.get(message.id);
          if (!pending) throw new Error('unexpected response');
          this.pending.delete(message.id);
          if (message.kind === 'error') { pending.reject(); this.stop(); return; }
          pending.resolve(message);
        } catch { this.stop(); return; }
      }
      if (Buffer.byteLength(this.buffer) > HAYSTACK_REPLY_BYTES) this.stop();
    });
  }
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const pid = this.child.pid;
    if (pid && Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    for (const pending of this.pending.values()) pending.reject();
    this.pending.clear(); this.buffer = '';
  }
  async send(payload: Record<string, unknown>, context: ProjectRetrievalCallContext, initial = false): Promise<HaystackReply> {
    assertRetrievalTime(context);
    if (this.stopped || this.pending.size >= 8) throw new Error('Haystack unavailable');
    const id = initial ? 0 : ++this.ordinal;
    const bytes = JSON.stringify({ ...payload, id }) + '\n';
    if (Buffer.byteLength(bytes) > HAYSTACK_FRAME_BYTES) throw new Error('Haystack input too large');
    const stop = () => this.stop();
    const timer = setTimeout(stop, Math.max(1, context.deadlineAt - Date.now()));
    context.signal.addEventListener('abort', stop, { once: true });
    try {
      const result = await new Promise<HaystackReply>((resolve, reject) => {
        this.pending.set(id, { resolve, reject: () => reject(new Error('Haystack unavailable')) });
        this.child.stdin.write(bytes);
        if (context.signal.aborted) this.stop();
      });
      assertRetrievalTime(context);
      return result;
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', stop); }
  }
  async close(): Promise<void> { this.stop(); await this.exited; }
}

/** Experimental library binding. Atoma retains admission, scope, citations and L1 execution. */
export async function createHaystackRetrievalBinding(input: {
  authority: ProjectRetrievalBinding; corpus: PreparedProjectRetrievalCorpus;
  python: string; settings: HaystackSettings; runtimeSha256?: string; context: ProjectRetrievalCallContext;
  cacheDbPath?: string; cacheMaxDatabaseBytes?: number;
  onPreparationStats?: (stats: { documents: number; cacheHits: number; computed: number;
    pythonInitMs: number; cacheExportMs: number }) => void;
}): Promise<ProjectRetrievalBinding> {
  const binding = validateProjectRetrievalBinding(input.authority);
  const { scope } = binding;
  const settings = haystackSettingsSchema.parse(input.settings);
  const manifest = canonicalRetrievalManifest(input.corpus.manifest);
  if (scope.corpusId !== manifest.corpusId || scope.snapshotId !== manifest.snapshotId ||
    scope.snapshotSha256 !== manifest.snapshotSha256 || scope.generation !== input.corpus.generation ||
    retrievalGeneration(manifest, input.corpus.config) !== scope.generation ||
    input.corpus.passages.length > PROJECT_RETRIEVAL_CORPUS_LIMITS.passages) throw new Error('Haystack corpus binding mismatch');
  const passages = new Map(input.corpus.passages.map(value => {
    const passage = projectRetrievalPassageSchema.parse(value);
    const document = manifest.documents.find(d => d.path === passage.path && d.sha256 === passage.sha256);
    if (!document || passage.endByte > (passage.extraction?.bytes ?? document.bytes) || passage.documentId !== retrievalDocumentId(document.path, document.sha256)) {
      throw new Error('Haystack passage source mismatch');
    }
    const id = projectRetrievalHash(JSON.stringify([passage.documentId, passage.startByte, passage.endByte]));
    return [id, passage] as const;
  }));
  if (passages.size !== input.corpus.passages.length) throw new Error('Haystack duplicate passage');
  let child: HaystackProcess | undefined;
  let cache: ProjectEmbeddingCache | undefined;
  const closeCache = (): void => { try { cache?.close(); } catch { /* Disposable cache. */ } cache = undefined; };
  try {
    if (await binding.service.authorize(scope, input.context) !== true) throw new Error('Haystack source denied');
    if (settings.mode === 'hybrid-rerank' && (
      await haystackModelRevision(settings.embeddingPath, input.context) !== settings.embeddingRevision ||
      await haystackModelRevision(settings.rerankerPath, input.context) !== settings.rerankerRevision)) {
      throw new Error('Haystack model files changed');
    }
    if (settings.mode === 'hybrid-rerank' && scope.kind === 'tenant' && input.cacheDbPath && input.runtimeSha256) {
      try { cache = new ProjectEmbeddingCache(input.cacheDbPath, scope.orgId, scope.projectId,
        retrievalEncoderKey(settings.embeddingRevision, input.runtimeSha256),
        input.cacheMaxDatabaseBytes ? { maxDatabaseBytes: input.cacheMaxDatabaseBytes } : undefined); }
      catch { /* A cache fault never removes project search. */ }
    }
    const prepared = [...passages].map(([id, p]) => {
      const embeddingText = retrievalEmbeddingText(p);
      return { id, embeddingText, inputHash: projectRetrievalHash(embeddingText),
        content: retrievalPassageContext(manifest, p) + '\n' + p.excerpt,
        meta: { path: p.path, ...(p.code ? { symbol: p.code.symbol, kind: p.code.kind } : {}),
          format: projectDocumentFormat(p.path), snapshotId: manifest.snapshotId, snapshotSha256: manifest.snapshotSha256 } };
    });
    const cachedByInput = new Map<string, Buffer>();
    const cachedById = new Set<string>();
    const documents = prepared.map(({ inputHash, ...document }) => {
      if (!cache || settings.mode !== 'hybrid-rerank') return document;
      try {
        const stored = cache.get(inputHash);
        if (!stored) return document;
        cachedByInput.set(inputHash, stored.vector);
        cachedById.add(document.id);
        return { ...document, cachedEmbedding: stored.vector.toString('base64') };
      } catch { closeCache(); cachedByInput.clear(); cachedById.clear(); return document; }
    });
    if (!cache) for (const document of documents) {
      delete (document as { cachedEmbedding?: string }).cachedEmbedding;
    }
    // Keep the existing 32 MiB protocol bound even for a corpus with many cached vectors.
    let frameBytes = Buffer.byteLength(JSON.stringify({ op: 'init', settings, documents, id: 0 })) + 1;
    for (let i = documents.length - 1; frameBytes > HAYSTACK_FRAME_BYTES && i >= 0; i--) {
      const document = documents[i];
      if (!document || !('cachedEmbedding' in document)) continue;
      frameBytes -= Buffer.byteLength(JSON.stringify({ cachedEmbedding: document.cachedEmbedding })) - 2 + 1;
      cachedById.delete(document.id);
      delete (document as { cachedEmbedding?: string }).cachedEmbedding;
    }
    assertRetrievalTime(input.context);
    child = new HaystackProcess(input.python);
    const pythonStarted = Date.now();
    let ready = await child.send({ op: 'init', settings, documents }, input.context, true);
    if (ready.kind === 'cache-rejected' && cachedById.size) {
      await child.close();
      closeCache(); cachedByInput.clear(); cachedById.clear();
      for (const document of documents) delete (document as { cachedEmbedding?: string }).cachedEmbedding;
      child = new HaystackProcess(input.python);
      ready = await child.send({ op: 'init', settings, documents }, input.context, true);
    }
    const pythonInitMs = Date.now() - pythonStarted;
    if (ready.kind !== 'ready' || (input.runtimeSha256 !== undefined && ready.runtimeSha256 !== input.runtimeSha256) ||
        ready.documents !== passages.size || await binding.service.authorize(scope, input.context) !== true) {
      throw new Error('Haystack initialization refused');
    }
    if (settings.mode === 'hybrid-rerank' && cache) {
      if (!ready.dimension || ready.computed !== documents.length - cachedById.size) {
        throw new Error('Haystack embedding accounting mismatch');
      }
      let learned: { inputHash: string; vector: Buffer; dimension: number }[] = [];
      let exportedBytes = 0;
      for (const document of prepared) {
        if (cachedById.has(document.id) || cachedByInput.has(document.inputHash)) continue;
        if (exportedBytes >= 64 * 1024 * 1024) break;
        const response = await child.send({ op: 'embedding', documentId: document.id }, input.context);
        if (response.kind !== 'embedding' || response.documentId !== document.id || response.dimension !== ready.dimension) {
          throw new Error('Haystack embedding export mismatch');
        }
        const vector = Buffer.from(response.vector, 'base64');
        if (vector.toString('base64') !== response.vector || vector.length !== ready.dimension * 4) {
          throw new Error('Haystack invalid embedding export');
        }
        for (let i = 0; i < vector.length; i += 4) if (!Number.isFinite(vector.readFloatLE(i))) {
          throw new Error('Haystack non-finite embedding export');
        }
        cachedByInput.set(document.inputHash, vector);
        exportedBytes += vector.length;
        learned.push({ inputHash: document.inputHash, vector, dimension: ready.dimension });
        if (learned.length >= 32) {
          try { cache.putMany(learned); } catch { closeCache(); break; }
          learned = [];
        }
      }
      if (cache && learned.length) try { cache.putMany(learned); } catch { /* Safe to recompute. */ }
    }
    const cacheExportMs = Date.now() - pythonStarted - pythonInitMs;
    closeCache();
    assertRetrievalTime(input.context);
    try { input.onPreparationStats?.({ documents: documents.length, cacheHits: cachedById.size,
      computed: ready.kind === 'ready' ? ready.computed ?? 0 : 0, pythonInitMs, cacheExportMs }); }
    catch { /* A reporting failure cannot invalidate a ready backend. */ }
    const process = child;
    let closed = false;
    return { scope, limits: binding.limits, service: {
      authorize: async (candidate, context) => !closed && JSON.stringify(candidate) === JSON.stringify(scope) &&
        await binding.service.authorize(candidate, context) === true,
      search: async (candidate, query, context) => {
        if (closed || JSON.stringify(candidate) !== JSON.stringify(scope)) return { ok: false, status: 'denied' };
        const filters = query.filters ? { field: 'meta.path', operator: 'in',
          value: manifest.documents.filter(d => matchesProjectRetrievalFilters(d.path, query.filters)).map(d => d.path) } : undefined;
        const result = await process.send({ op: 'search', query: query.text, lexicalQuery: query.terms.join(' '),
          limit: query.maxCandidates, ...(filters ? { filters } : {}) }, context);
        if (result.kind !== 'result' || result.hits.length > query.maxCandidates || new Set(result.hits.map(h => h.id)).size !== result.hits.length) {
          throw new Error('Haystack invalid result');
        }
        const ranked = result.hits.map(hit => {
          const passage = passages.get(hit.id);
          if (!passage || !matchesProjectRetrievalFilters(passage.path, query.filters)) throw new Error('Haystack unknown or excluded passage');
          return { ...passage, score: hit.score };
        });
        // Keep the best match first, then one source excerpt per resolved neighbouring file.
        // Expansion never escapes the caller's filters or the same admitted snapshot.
        const expanded: ProjectRetrievalPassage[] = [...ranked];
        if (query.includeRelated && ranked[0]?.code) {
          const seen = new Set([ranked[0].path]);
          const related = ranked[0].code.relations.flatMap(relation => {
            if (seen.has(relation.path)) return [];
            const neighbours = [...passages.values()].filter(p => p.path === relation.path && matchesProjectRetrievalFilters(p.path, query.filters));
            const passage = neighbours.find(p => p.code?.symbol !== '<module>' || p.code?.kind === 'ExpressionStatement') ?? neighbours[0];
            if (!passage) return [];
            seen.add(relation.path); return [passage];
          }).slice(0, Math.max(0, query.limit - 1));
          expanded.splice(1, 0, ...related);
        }
        const unique = expanded.filter((p, i, all) => all.findIndex(q => q.path === p.path && q.startByte === p.startByte) === i);
        return { ok: true, status: 'ok', corpusId: scope.corpusId, snapshotId: scope.snapshotId,
          snapshotSha256: scope.snapshotSha256, generation: scope.generation,
          ...(manifest.coverage ? { coverage: manifest.coverage } : {}),
          passages: unique.slice(0, query.maxCandidates), truncated: result.hits.length >= query.maxCandidates || unique.length > query.maxCandidates };
      },
      dispose: async () => {
        if (closed) return;
        closed = true;
        try { await process.close(); } finally { passages.clear(); await binding.service.dispose(); }
      },
    } };
  } catch (error) {
    closeCache();
    try { await child?.close(); } finally { await binding.service.dispose(); }
    throw error;
  }
}
