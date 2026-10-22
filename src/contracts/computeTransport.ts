import { z } from 'zod';
import { computeSessionSchema } from './computeDevice.js';
import { COMPUTE_FRAME_BYTES } from './computeProtocol.js';

/** Opt-in only. A plain ready from an older server keeps the legacy channel. */
export const COMPUTE_RESUME_PROTOCOL = 'atoma-compute-resume-v1';
export const COMPUTE_TRANSPORT_BYTES = COMPUTE_FRAME_BYTES + 1024;
// In-memory retransmission only: bounded independently of RPC concurrency.
export const COMPUTE_TRANSPORT_QUEUE_BYTES = 8 * COMPUTE_FRAME_BYTES;
export const COMPUTE_TRANSPORT_QUEUE_FRAMES = 128;
export const COMPUTE_STALE_HEARTBEAT_MS = 10_000;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const envelope = { seq: counter.positive(), ack: counter, body: z.record(z.string(), z.unknown()) };
export const computeTransportFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel-open'), token, ...envelope }).strict(),
  z.object({ kind: z.literal('channel-data'), ...envelope }).strict(),
  z.object({ kind: z.literal('channel-ack'), ack: counter }).strict(),
  z.object({ kind: z.literal('channel-close') }).strict(),
  z.object({ kind: z.literal('channel-resumed'), token, epoch: counter.positive(), received: counter }).strict(),
]);
export const computeResumeSchema = z.object({ kind: z.literal('channel-resume'), token,
  epoch: counter.positive(), received: counter, credential: token, machineId: z.string().uuid(), session: computeSessionSchema }).strict();
export type ComputeResume = z.infer<typeof computeResumeSchema>;
