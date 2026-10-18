import { z } from 'zod';

export const COMPUTE_PROTOCOL_VERSION = 1;
export const COMPUTE_LEASE_MS = 30_000;
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
