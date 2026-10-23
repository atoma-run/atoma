import { z } from 'zod';

export const COMPUTE_PROTOCOL_VERSION = 1;
/** How long a device keeps its session and workloads without a heartbeat
 * acknowledgement, on both ends: the client stops its workloads when it
 * expires, the server invalidates the session. 30 s until 2026-10-23; a
 * reverse-proxy restart (5 s) plus a Wi-Fi migration (20-30 s) sat at its
 * edge, and the transport resumes the same session within it, so the cost of
 * a longer lease is only how long a vanished device delays a run's failure. */
export const COMPUTE_LEASE_MS = 120_000;
export const COMPUTE_PAIRING_MS = 10 * 60_000;
export const computeActorSchema = z.object({ orgId: z.string().uuid(), principalId: z.string().uuid() }).strict();
export type ComputeActor = z.infer<typeof computeActorSchema>;
export const computeResourcesSchema = z.object({
  cpus: z.number().finite().positive().max(1024),
  memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  diskBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ComputeResources = z.infer<typeof computeResourcesSchema>;
export const computeCapabilitiesSchema = computeResourcesSchema.extend({
  protocol: z.literal(COMPUTE_PROTOCOL_VERSION),
  appVersion: z.string().min(1).max(80),
  platform: z.enum(['darwin', 'win32']), architecture: z.enum(['arm64', 'x64']),
  services: z.array(z.enum(['workspace', 'tools', 'retrieval', 'preview'])).max(4).optional(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type ComputeCapabilities = z.infer<typeof computeCapabilitiesSchema>;
export const computeSessionSchema = z.object({
  deviceId: z.string().uuid(), sessionId: z.string().uuid(), generation: z.number().int().positive(),
}).strict();
export type ComputeSession = z.infer<typeof computeSessionSchema>;
export const computeAssignmentSchema = z.object({
  runId: z.string().uuid(), projectId: z.string().uuid(), generation: z.number().int().positive(),
  state: z.enum(['active', 'indeterminate']),
}).strict();
export type ComputeAssignment = z.infer<typeof computeAssignmentSchema>;

export const computeAdmissionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), session: computeSessionSchema }).strict(),
  z.object({ status: z.literal('waiting'), reason: z.enum([
    'disconnected', 'busy', 'resources-insufficient', 'version-incompatible', 'not-accepting', 'access-unavailable',
  ]) }).strict(),
]);
export type ComputeAdmission = z.infer<typeof computeAdmissionSchema>;
