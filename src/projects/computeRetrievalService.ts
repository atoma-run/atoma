import { join } from 'node:path';
import { computeRetrievalCommandSchema, type ComputeRetrievalCommand, type ComputeRetrievalReply } from '../contracts/computeRetrieval.js';
import { WorkspaceImport } from '../run/workspaceImport.js';
import { prepareProjectRetrievalCorpus, retrievalConfigForManifest, retrievalGeneration, canonicalRetrievalManifest } from './retrievalCorpus.js';
import { createHaystackRetrievalBinding } from './retrievalHaystack.js';
import type { ProjectRetrievalBinding } from '../tools/projectRetrieval.js';

/** Private launcher service. Its source and cache volumes never enter L1.
 * The host remains the authority; this process cannot read the product store. */
export function computeRetrievalService(options: { root: string; python: string; cachePath: string;
  embeddingPath: string; rerankerPath: string }) {
  let opened: Extract<ComputeRetrievalCommand, { method: 'open' }> | undefined;
  let importing: WorkspaceImport | undefined;
  let sealed = false, closed = false, busy = false;
  let binding: ProjectRetrievalBinding | undefined;
  const abort = new AbortController();
  const source = join(options.root, 'corpus');
  const close = async () => {
    closed = true; abort.abort(); importing?.abort(); importing = undefined;
    await binding?.service.dispose(); binding = undefined;
  };
  return { close, execute: async (input: unknown): Promise<ComputeRetrievalReply> => {
    const command = computeRetrievalCommandSchema.parse(input);
    if (command.method === 'close') { await close(); return { method: command.method, value: null }; }
    if (closed || busy) throw new Error('Compute retrieval unavailable');
    busy = true;
    try {
      switch (command.method) {
        case 'open': {
          if (opened) throw new Error('Compute retrieval already bound');
          const manifest = canonicalRetrievalManifest(command.manifest), scope = command.scope;
          if (scope.kind !== 'tenant' || scope.corpusId !== manifest.corpusId || scope.snapshotId !== manifest.snapshotId ||
            scope.snapshotSha256 !== manifest.snapshotSha256 || scope.generation !== retrievalGeneration(manifest, retrievalConfigForManifest(manifest))) {
            throw new Error('Compute retrieval scope mismatch');
          }
          opened = command; importing = new WorkspaceImport(source, command.header, false);
          return { method: command.method, value: null };
        }
        case 'upload': {
          if (!opened || !importing || sealed) throw new Error('Compute retrieval upload unavailable');
          const frame = command.frame;
          if (frame.kind === 'entry') {
            const entry = frame.entry;
            const document = opened.manifest.documents.find(d => d.path === entry.path);
            if (entry.kind === 'symlink' || (entry.kind === 'file' && (!document || document.bytes !== entry.size)) ||
              (entry.kind === 'directory' && !opened.manifest.documents.some(d => d.path.startsWith(entry.path + '/')))) {
              throw new Error('Unadmitted retrieval source');
            }
            importing.begin(entry);
          } else if (frame.kind === 'chunk') importing.append(frame.offset, Buffer.from(frame.data, 'base64'));
          else { importing.finish(); importing = undefined; sealed = true; }
          return { method: command.method, value: null };
        }
        case 'prepare': {
          if (!opened || !sealed || binding) throw new Error('Compute retrieval preparation unavailable');
          const context = { signal: abort.signal, deadlineAt: Date.now() + 30 * 60_000 };
          const corpus = await prepareProjectRetrievalCorpus(source, opened.manifest, context, {}, { omitUnextractable: true });
          const scope = { ...opened.scope, generation: corpus.generation };
          const authority: ProjectRetrievalBinding = { scope, service: {
            authorize: async candidate => !closed && JSON.stringify(candidate) === JSON.stringify(scope),
            search: async () => ({ ok: false, status: 'unavailable' }), dispose: async () => {},
          } };
          const models = opened.models;
          binding = await createHaystackRetrievalBinding({ authority, corpus, python: options.python,
            runtimeSha256: models.runtimeSha256, settings: models.mode === 'bm25' ? { mode: 'bm25' }
              : { mode: models.mode, queryPrefix: models.queryPrefix, embeddingRevision: models.embeddingRevision,
                rerankerRevision: models.rerankerRevision, embeddingPath: options.embeddingPath, rerankerPath: options.rerankerPath },
            context, cacheDbPath: options.cachePath, cacheMaxDatabaseBytes: 256 * 1024 ** 2 });
          return { method: command.method, value: null };
        }
        case 'search': {
          if (!binding || !opened) throw new Error('Compute retrieval not prepared');
          const result = await binding.service.search(binding.scope, command.query,
            { signal: abort.signal, deadlineAt: Date.now() + 30_000 });
          // The outer generation identifies the host-admitted source corpus.
          // Extraction omissions remain explicit in coverage, as on hosted runs.
          return { method: command.method, value: result.ok ? { ...result, generation: opened.scope.generation } : result };
        }
      }
    } catch (error) { await close(); throw error; }
    finally { busy = false; }
  } };
}
