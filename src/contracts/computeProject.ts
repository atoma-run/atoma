import { z } from 'zod';
import { executionTargetSchema } from './executionTarget.js';
import { computeAdmissionSchema } from './computeDevice.js';

export const COMPUTE_RUN_RESOURCES = { cpus: 5, memoryBytes: 6 * 1024 ** 3, diskBytes: 4 * 1024 ** 3 } as const;
export const computeAvailabilitySchema = z.union([z.literal('ready'), computeAdmissionSchema.options[1].shape.reason]);
export const computeProjectViewSchema = z.object({
  projectId: z.string().uuid(), target: executionTargetSchema, canEdit: z.boolean(), hostedAllowed: z.boolean().default(false),
  pendingRuns: z.array(z.object({ runId: z.string().uuid() }).strict()).max(100).optional(),
  devices: z.array(z.object({ deviceId: z.string().uuid(), name: z.string().max(120), allowed: z.boolean(),
    revoked: z.boolean(), availability: computeAvailabilitySchema }).strict()).max(100),
}).strict();
export type ComputeProjectView = z.infer<typeof computeProjectViewSchema>;

export const computeOnboardingSchema = z.object({
  hostedAllowed: z.boolean(),
  devices: z.array(z.object({ deviceId: z.string().uuid(), name: z.string().max(120), connected: z.boolean() }).strict()).max(100),
}).strict();
