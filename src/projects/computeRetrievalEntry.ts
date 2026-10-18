import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { z } from 'zod';
import { computeRetrievalService } from './computeRetrievalService.js';
import { computeRetrievalCommandSchema, computeRetrievalResponseSchema } from '../contracts/computeRetrieval.js';
import { COMPUTE_FRAME_BYTES } from '../contracts/computeProtocol.js';

/** Standalone private image entrypoint; stdin belongs only to the launcher. */
export async function serveComputeRetrieval() {
  const root = process.env['ATOMA_RETRIEVAL_ROOT'];
  if (!root) throw new Error('Retrieval root required');
  const service = computeRetrievalService({ root, python: '/opt/haystack/bin/python',
    cachePath: '/cache/embeddings.db', embeddingPath: '/models/embedding', rerankerPath: '/models/reranker' });
  const request = z.object({ id: z.number().int().positive(), command: computeRetrievalCommandSchema }).strict();
  let buffer = Buffer.alloc(0), lastId = 0;
  try {
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
      if (buffer.length + chunk.length > COMPUTE_FRAME_BYTES) throw new Error('Retrieval frame too large');
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const call = request.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        buffer = buffer.subarray(newline + 1);
        if (call.id <= lastId) throw new Error('Retrieval request replay');
        lastId = call.id;
        let response;
        try { response = { id: call.id, ok: true as const, reply: await service.execute(call.command) }; }
        catch { response = { id: call.id, ok: false as const, error: 'retrieval-unavailable' as const }; }
        const text = JSON.stringify(computeRetrievalResponseSchema.parse(response)) + '\n';
        if (Buffer.byteLength(text) > COMPUTE_FRAME_BYTES) throw new Error('Retrieval response too large');
        if (!process.stdout.write(text)) await once(process.stdout, 'drain');
      }
    }
    if (buffer.length) throw new Error('Retrieval transfer interrupted');
  } finally { await service.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveComputeRetrieval().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
}
