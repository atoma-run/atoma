import { checkpointConfirmationSchema } from './checkpointTransfer.js';
import { z } from 'zod';
import { computeExecutionSchema } from './computeProtocol.js';

export const computeLocalAllocationSchema = z.object({
  execution: computeExecutionSchema,
  allocationId: z.string().uuid(),
  state: z.enum(['allocating', 'active', 'stopped', 'unconfirmed']),
  checkpoint: checkpointConfirmationSchema.optional(),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type ComputeLocalAllocation = z.infer<typeof computeLocalAllocationSchema>;
export const computeLocalJournalSchema = z.object({
  version: z.literal(1), machineId: z.string().uuid(),
  allocations: z.array(computeLocalAllocationSchema).max(1000),
}).strict().superRefine((journal, ctx) => {
  const owners = new Map<string, string>();
  for (const row of journal.allocations) {
    const owner = owners.get(row.allocationId);
    if (owner && owner !== row.execution.runId) ctx.addIssue({ code: 'custom', message: 'Allocation shared across runs' });
    owners.set(row.allocationId, row.execution.runId);
  }
  const runs = journal.allocations.map(row => `${row.execution.runId}:${row.execution.generation}`);
  if (new Set(runs).size !== runs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate allocation identity' });
});

export const computeImageSchema = z.string().regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._/:-]*@)?sha256:[a-f0-9]{64}$/);
export const computeClientSettingsSchema = z.object({
  version: z.literal(1), origin: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }), deviceId: z.string().uuid(), orgId: z.string().uuid(),
  workspaceImage: computeImageSchema, workerImage: computeImageSchema, retrievalImage: computeImageSchema.optional(), previewImage: computeImageSchema.optional(), egress: z.boolean().default(true),
}).strict();
export type ComputeClientSettings = z.infer<typeof computeClientSettingsSchema>;
