import { z } from 'zod';
import { COMPUTE_PROTOCOL_VERSION, computeCapabilitiesSchema, computeSessionSchema } from './computeDevice.js';
import { workspaceCommandSchema, workspaceResponseSchema } from './workspaceProtocol.js';

export const COMPUTE_FRAME_BYTES = 1024 * 1024;
const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const computeExecutionSchema = z.object({ runId: z.string().uuid(), generation: requestId }).strict();
export type ComputeExecution = z.infer<typeof computeExecutionSchema>;
export const computeHelloSchema = z.object({
  kind: z.literal('hello'), version: z.literal(COMPUTE_PROTOCOL_VERSION),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/), capabilities: computeCapabilitiesSchema,
}).strict();
export const computeClientFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heartbeat'), id: requestId }).strict(),
  z.object({ kind: z.literal('workspace-result'), execution: computeExecutionSchema, response: workspaceResponseSchema }).strict(),
]);
export const computeServerFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), version: z.literal(COMPUTE_PROTOCOL_VERSION), session: computeSessionSchema }).strict(),
  z.object({ kind: z.literal('heartbeat'), id: requestId }).strict(),
  z.object({ kind: z.literal('workspace-command'), id: requestId, execution: computeExecutionSchema, command: workspaceCommandSchema }).strict(),
]);
export type ComputeServerFrame = z.infer<typeof computeServerFrameSchema>;
