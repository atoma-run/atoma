import { realpathSync, lstatSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openProjectRunRetrievalAuthority, ProjectRetrievalLaunchStore } from './retrievalLaunch.js';
import { assertRetrievalTime, retrievalDocumentId } from './retrievalCorpus.js';
import { computeRetrievalReplySchema, type ComputeRetrievalCommand } from '../contracts/computeRetrieval.js';
import { projectRetrievalResponseSchema, matchesProjectRetrievalFilters } from '../contracts/projectRetrieval.js';
import { captureCheckpointExport } from '../run/checkpointExport.js';
import type { HaystackLaunch } from '../contracts/retrievalHaystack.js';
import type { ProjectRetrievalBinding, ProjectRetrievalCallContext } from '../tools/projectRetrieval.js';

/** Host authority wraps remote observations; the device cannot introduce corpus
 * references or turn a revocation into an empty successful search. */
export function openProjectRunComputeRetrieval(input: Parameters<typeof openProjectRunRetrievalAuthority>[0],
  config: HaystackLaunch, send: (command: ComputeRetrievalCommand) => Promise<unknown>) {
  const authority = openProjectRunRetrievalAuthority(input);
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
  let receipt;
  try { receipt = new ProjectRetrievalLaunchStore(db, { initialize: false }).resolve(input.runId); }
  finally { db.close(); }
  if (!receipt) throw new Error('Compute retrieval receipt unavailable');
  const source = receipt;
  let closed = false, preparing: Promise<void> | undefined;
  const cancelled = new AbortController();
  const call = async (command: ComputeRetrievalCommand) => {
    const reply = computeRetrievalReplySchema.parse(await send(command));
    if (reply.method !== command.method) throw new Error('Compute retrieval reply mismatch');
    return reply;
  };
  const binding: ProjectRetrievalBinding = { scope: authority.scope, service: {
    authorize: async (scope, context) => !closed && await authority.service.authorize(scope, context) === true,
    ready: async () => { if (preparing) await preparing; },
    search: async (scope, query, context) => {
      assertRetrievalTime(context);
      if (closed || await authority.service.authorize(scope, context) !== true) return { ok: false, status: 'denied' };
      const reply = await call({ method: 'search', query });
      assertRetrievalTime(context);
      if (closed || await authority.service.authorize(scope, context) !== true) return { ok: false, status: 'denied' };
      if (reply.method !== 'search') throw new Error('Compute retrieval reply mismatch');
      const result = projectRetrievalResponseSchema.parse(reply.value);
      if (!result.ok) return result;
      if (result.corpusId !== scope.corpusId || result.snapshotId !== scope.snapshotId ||
        result.snapshotSha256 !== scope.snapshotSha256 || result.generation !== scope.generation || result.passages.length > query.maxCandidates) {
        throw new Error('Compute retrieval source mismatch');
      }
      for (const passage of result.passages) {
        const document = source.manifest.documents.find(d => d.path === passage.path && d.sha256 === passage.sha256);
        if (!document || passage.documentId !== retrievalDocumentId(document.path, document.sha256) ||
          passage.endByte > (passage.extraction?.bytes ?? document.bytes) || !matchesProjectRetrievalFilters(document.path, query.filters) ||
          passage.code?.relations.some(relation => !source.manifest.documents.some(d => d.path === relation.path))) {
          throw new Error('Compute retrieval returned an unadmitted reference');
        }
      }
      return result;
    },
    dispose: async () => {
      if (closed) return;
      closed = true; cancelled.abort();
      try { await preparing; } catch { /* Keep the original preparation failure. */ }
      try { await call({ method: 'close' }); } finally { await authority.service.dispose(); }
    },
  } };
  return { binding, prepare: (context: ProjectRetrievalCallContext): Promise<void> => {
    context = { signal: AbortSignal.any([context.signal, cancelled.signal]), deadlineAt: context.deadlineAt };
    return preparing ??= (async () => {
      assertRetrievalTime(context);
      if (closed || await authority.service.authorize(authority.scope, context) !== true) throw new Error('Compute retrieval denied');
      if (lstatSync(source.sourceRoot).isSymbolicLink()) throw new Error('Compute corpus archive cannot be a link');
      const snapshot = captureCheckpointExport(realpathSync(source.sourceRoot));
      try {
        const settings = config.settings;
        await call({ method: 'open', scope: source.scope, manifest: source.manifest, header: snapshot.header,
          models: settings.mode === 'bm25' ? { mode: 'bm25', runtimeSha256: config.runtimeSha256 }
            : { mode: settings.mode, runtimeSha256: config.runtimeSha256, queryPrefix: settings.queryPrefix,
              embeddingRevision: settings.embeddingRevision, rerankerRevision: settings.rerankerRevision } });
        for await (const frame of snapshot.frames()) {
          assertRetrievalTime(context);
          await call({ method: 'upload', frame: frame.kind === 'entry' ? frame
            : { kind: 'chunk', offset: frame.offset, data: Buffer.from(frame.bytes).toString('base64') } });
        }
        await call({ method: 'upload', frame: { kind: 'end' } });
      } finally { await snapshot.close(); }
      assertRetrievalTime(context);
      await call({ method: 'prepare' });
      assertRetrievalTime(context);
      if (closed || await authority.service.authorize(authority.scope, context) !== true) throw new Error('Compute retrieval denied');
    })();
  } };
}
