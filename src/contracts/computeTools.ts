import { z } from 'zod';
import { toolCallRequestSchema, WORKER_FRAME_BYTES } from './workerProtocol.js';
import { archivedToolEvidenceSchema } from './evidenceReading.js';

/** Private tool channel: workspace lifecycle operations are never element names. */
export const computeToolCommandSchema = z.discriminatedUnion('method', [
  toolCallRequestSchema.omit({ id: true }).extend({ method: z.literal('invoke') }),
  z.object({ method: z.literal('drain') }).strict(),
]);
export type ComputeToolCommand = z.infer<typeof computeToolCommandSchema>;
/** Large results reuse the lossless evidence envelope, bounded by the worker's
 * existing response budget. The outer application frame remains at 1 MiB. */
export const computeToolResultArchiveSchema = archivedToolEvidenceSchema.extend({
  bytes: z.number().int().nonnegative().max(WORKER_FRAME_BYTES),
});
export const computeToolResponseSchema = z.union([
  z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(true), resultArchive: computeToolResultArchiveSchema }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.string().max(8192) }).strict(),
]);
export type ComputeToolResponse = z.infer<typeof computeToolResponseSchema>;
