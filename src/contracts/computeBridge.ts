import { computeRetrievalCommandSchema } from './computeRetrieval.js';
import { z } from 'zod';
import { workspaceCommandSchema } from './workspaceProtocol.js';
import { computeToolCommandSchema } from './computeTools.js';

/** Private host process boundary. Never mounted into a customer workload. */
export const COMPUTE_BRIDGE_ENV = 'ATOMA_COMPUTE_BRIDGE';
export const computeBridgeAddressSchema = z.object({ socket: z.string().min(1).max(100), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const computeBridgeRequestSchema = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  call: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('workspace'), command: workspaceCommandSchema }).strict(),
    z.object({ channel: z.literal('retrieval'), command: computeRetrievalCommandSchema }).strict(),
    z.object({ channel: z.literal('tools'), command: computeToolCommandSchema }).strict(),
  ]) }).strict();
export type ComputeBridgeCall = z.infer<typeof computeBridgeRequestSchema>['call'];
export const computeBridgeResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), error: z.string().max(8192) }).strict(),
]);
