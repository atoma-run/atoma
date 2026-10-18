import { z } from 'zod';
import { computeExecutionSchema } from './computeProtocol.js';

export const computeLocalAllocationSchema = z.object({
  execution: computeExecutionSchema,
  allocationId: z.string().uuid(),
  state: z.enum(['allocating', 'active', 'stopped', 'unconfirmed']),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type ComputeLocalAllocation = z.infer<typeof computeLocalAllocationSchema>;
export const computeLocalJournalSchema = z.object({
  version: z.literal(1), machineId: z.string().uuid(),
  allocations: z.array(computeLocalAllocationSchema).max(1000),
}).strict().superRefine((journal, ctx) => {
  const ids = journal.allocations.map(row => row.allocationId);
  const runs = journal.allocations.map(row => `${row.execution.runId}:${row.execution.generation}`);
  if (new Set(ids).size !== ids.length || new Set(runs).size !== runs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate allocation identity' });
});
