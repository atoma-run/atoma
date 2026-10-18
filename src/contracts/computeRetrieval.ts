import { z } from 'zod';
import { projectRetrievalScopeSchema, projectRetrievalQuerySchema, projectRetrievalResponseSchema } from './projectRetrieval.js';
import { projectRetrievalManifestSchema } from './projectRetrievalCorpus.js';
import { checkpointTransferHeaderSchema, checkpointWireFrameSchema } from './checkpointTransfer.js';

/** Runtime and model identities cross the wire; host executable paths never do. */
export const computeRetrievalModelsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bm25'), runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ mode: z.literal('hybrid-rerank'), runtimeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    embeddingRevision: z.string().regex(/^[a-f0-9]{64}$/), rerankerRevision: z.string().regex(/^[a-f0-9]{64}$/),
    documentPrefix: z.string().max(1000).optional(), queryPrefix: z.string().max(1000) }).strict(),
]);
export const computeRetrievalCommandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('open'), scope: projectRetrievalScopeSchema,
    manifest: projectRetrievalManifestSchema, models: computeRetrievalModelsSchema,
    header: checkpointTransferHeaderSchema }).strict(),
  z.object({ method: z.literal('upload'), frame: checkpointWireFrameSchema }).strict(),
  z.object({ method: z.literal('prepare') }).strict(),
  z.object({ method: z.literal('search'), query: projectRetrievalQuerySchema }).strict(),
  z.object({ method: z.literal('close') }).strict(),
]);
export type ComputeRetrievalCommand = z.infer<typeof computeRetrievalCommandSchema>;
export const computeRetrievalReplySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('open'), value: z.null() }).strict(),
  z.object({ method: z.literal('upload'), value: z.null() }).strict(),
  z.object({ method: z.literal('prepare'), value: z.null() }).strict(),
  z.object({ method: z.literal('search'), value: projectRetrievalResponseSchema }).strict(),
  z.object({ method: z.literal('close'), value: z.null() }).strict(),
]);
export type ComputeRetrievalReply = z.infer<typeof computeRetrievalReplySchema>;
export const computeRetrievalResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), reply: computeRetrievalReplySchema }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.literal('retrieval-unavailable') }).strict(),
]);
