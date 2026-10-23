import { z } from 'zod';
import { commitShaSchema } from './projects.js';
import { WORKSPACE_LIMITS } from './workspaceLimits.js';

export const repositoryFileStateSchema = z.object({
  mode: z.enum(['100644', '100755']), sha: commitShaSchema,
}).strict();
export type RepositoryFileState = z.infer<typeof repositoryFileStateSchema>;
export const repositoryInventorySchema = z.record(z.string().max(512), repositoryFileStateSchema)
  // BASE may retain tombstones from a previous workspace as well as new paths.
  .refine(value => Object.keys(value).length <= WORKSPACE_LIMITS.maxFiles * 2, 'Repository base exceeds its bound');
export type RepositoryInventory = z.infer<typeof repositoryInventorySchema>;
export const repositorySyncSchema = z.object({
  status: z.enum(['synced', 'unchanged', 'unavailable', 'no_anchor']),
  head: commitShaSchema.nullable(),
  base: repositoryInventorySchema,
  materialised: z.boolean(),
  debtResolved: z.boolean().default(true),
  seedPath: z.string().max(4096).nullable(),
  taken: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  paths: z.array(z.string().max(512)).max(20),
}).strict();
export type RepositorySync = z.infer<typeof repositorySyncSchema>;

/** Bounded host receipt, without inventory, host paths or publication authority. */
export const REPOSITORY_PREPARATION_ENV = 'ATOMA_REPOSITORY_PREPARATION';
export const repositoryPreparationSchema = repositorySyncSchema.pick({
  status: true, head: true, taken: true, conflicts: true, paths: true,
}).extend({
  status: z.enum(['synced', 'unchanged', 'unavailable', 'no_anchor', 'snapshot']),
  taken: z.number().int().nonnegative().nullable(),
  conflicts: z.number().int().nonnegative().nullable(),
  mode: z.enum(['synchronize', 'selected-version', 'resume', 'comparison']),
  baseSha: commitShaSchema.nullable(),
}).strict();
export type RepositoryPreparation = z.infer<typeof repositoryPreparationSchema>;

export function decodeRepositoryPreparation(raw: string | undefined): RepositoryPreparation | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > 16_384) throw new Error('Repository preparation receipt exceeds its bound');
  return repositoryPreparationSchema.parse(JSON.parse(raw));
}

/** Raw git entries include unsupported types so a remote link cannot be overwritten. */
export const repositoryTreeEntrySchema = z.object({
  path: z.string().max(4096), mode: z.string(), sha: commitShaSchema,
  type: z.enum(['blob', 'tree', 'commit']), size: z.number().int().nonnegative().optional(),
}).strict();
export type RepositoryTreeEntry = z.infer<typeof repositoryTreeEntrySchema>;

export const repositoryPushSchema = z.object({
  repositoryId: z.string().regex(/^[1-9][0-9]*$/), installationId: z.string().regex(/^[1-9][0-9]*$/),
  ref: z.string().max(1024), before: commitShaSchema, after: commitShaSchema,
  created: z.boolean(), deleted: z.boolean(), forced: z.boolean(),
  senderLogin: z.string().min(1).max(100), senderType: z.string().min(1).max(100),
}).strict();
export type RepositoryPush = z.infer<typeof repositoryPushSchema>;
