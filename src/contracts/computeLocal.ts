import { checkpointConfirmationSchema } from './checkpointTransfer.js';
import { COMPUTE_RUN_RESOURCES } from './computeProject.js';
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
/** Total container envelope, including workspace, both proxies and one preview. */
export const computeResourceBudgetSchema = z.object({
  cpus: z.number().int().min(COMPUTE_RUN_RESOURCES.cpus).max(1024),
  memoryGiB: z.number().int().min(COMPUTE_RUN_RESOURCES.memoryBytes / 1024 ** 3).max(65536),
}).strict();
export type ComputeResourceBudget = z.infer<typeof computeResourceBudgetSchema>;
export function recommendedComputeBudget(capacity: { cpus: number; memoryBytes: number }): ComputeResourceBudget {
  const maxMemory = Math.floor(capacity.memoryBytes / 1024 ** 3);
  return computeResourceBudgetSchema.parse({
    cpus: Math.min(capacity.cpus, Math.max(5, Math.min(capacity.cpus - 2, Math.floor(capacity.cpus * 0.7)))),
    memoryGiB: Math.min(maxMemory, Math.max(6, Math.min(maxMemory - 2, Math.floor(maxMemory * 0.6)))),
  });
}
export function resolveComputeBudget(capacity: { cpus: number; memoryBytes: number }, requested?: ComputeResourceBudget): ComputeResourceBudget {
  const budget = requested ? computeResourceBudgetSchema.parse(requested) : recommendedComputeBudget(capacity);
  if (budget.cpus > capacity.cpus || budget.memoryGiB * 1024 ** 3 > capacity.memoryBytes) throw new Error('Compute CPU or RAM budget exceeds Docker capacity');
  return budget;
}
export function computeWorkloadBudget(input?: ComputeResourceBudget) {
  const budget = computeResourceBudgetSchema.parse(input ?? { cpus: 5, memoryGiB: 6 });
  // Fixed services: control .5 CPU/.5 GiB, two proxies .5 CPU/.25 GiB each,
  // and preview .5 CPU/1 GiB. Copy runs before the preview app starts.
  const searchCpus = Math.max(1, Math.floor((budget.cpus - 2) * 0.4));
  const searchMemory = Math.max(2, Math.floor((budget.memoryGiB - 2) * 0.4));
  return { tools: { cpus: budget.cpus - 2 - searchCpus, memoryGiB: budget.memoryGiB - 2 - searchMemory },
    search: { cpus: searchCpus, memoryGiB: searchMemory } };
}

export const computeClientSettingsSchema = z.object({
  resourceBudget: computeResourceBudgetSchema.optional(),
  version: z.literal(1), origin: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }), deviceId: z.string().uuid(), orgId: z.string().uuid(),
  workspaceImage: computeImageSchema, workerImage: computeImageSchema, retrievalImage: computeImageSchema.optional(), previewImage: computeImageSchema.optional(), egress: z.boolean().default(true),
}).strict();
export type ComputeClientSettings = z.infer<typeof computeClientSettingsSchema>;
