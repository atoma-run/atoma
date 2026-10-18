import { z } from 'zod';
import { toolCallRequestSchema } from './workerProtocol.js';

/** Private tool channel: workspace lifecycle operations are never element names. */
export const computeToolCommandSchema = z.discriminatedUnion('method', [
  toolCallRequestSchema.omit({ id: true }).extend({ method: z.literal('invoke') }),
  z.object({ method: z.literal('drain') }).strict(),
]);
export type ComputeToolCommand = z.infer<typeof computeToolCommandSchema>;
export const computeToolResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.string().max(8192) }).strict(),
]);
