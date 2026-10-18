import { z } from 'zod';
import { previewEgressHostsSchema, previewEntrySchema } from './preview.js';
import { deliveryKindSchema } from './taskExecution.js';

export const COMPUTE_PREVIEW_CHUNK_BYTES = 64 * 1024;
export const computePreviewIdentitySchema = z.object({ runId: z.string().uuid(), generation: z.number().int().positive(), instanceId: z.string().uuid() }).strict();
export type ComputePreviewIdentity = z.infer<typeof computePreviewIdentitySchema>;
const stream = z.string().uuid();
const data = z.string().min(4).max(4 * Math.ceil(COMPUTE_PREVIEW_CHUNK_BYTES / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** No URL, port, host path, engine option or shell text is a wire capability. */
export const computePreviewCommandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('start'), source: z.enum(['delivered', 'in-flight']), mode: z.enum(['app', 'terminal']),
    copyMaxBytes: z.number().int().positive().max(512 * 1024 ** 2), allowedHosts: previewEgressHostsSchema,
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), delivery: deliveryKindSchema.optional(),
    attribution: z.boolean(), hardMs: z.number().int().positive().max(2 * 60 * 60_000) }).strict(),
  z.object({ method: z.literal('stop') }).strict(),
  z.object({ method: z.literal('connect') }).strict(),
  z.object({ method: z.literal('read'), stream }).strict(),
  z.object({ method: z.literal('write'), stream, data }).strict(),
  z.object({ method: z.literal('end'), stream }).strict(),
  z.object({ method: z.literal('disconnect'), stream }).strict(),
]);
export type ComputePreviewCommand = z.infer<typeof computePreviewCommandSchema>;
export const computePreviewReplySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('start'), value: z.object({ kind: z.enum(['static', 'node']), entry: previewEntrySchema,
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict() }).strict(),
  z.object({ method: z.literal('stop'), value: z.null() }).strict(),
  z.object({ method: z.literal('connect'), value: stream }).strict(),
  z.object({ method: z.literal('read'), value: data.nullable() }).strict(),
  z.object({ method: z.literal('write'), value: z.null() }).strict(),
  z.object({ method: z.literal('end'), value: z.null() }).strict(),
  z.object({ method: z.literal('disconnect'), value: z.null() }).strict(),
]);
export type ComputePreviewReply = z.infer<typeof computePreviewReplySchema>;
export const computePreviewResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), reply: computePreviewReplySchema }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.literal('preview-unavailable') }).strict(),
]);
