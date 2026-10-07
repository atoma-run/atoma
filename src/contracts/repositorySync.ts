import { z } from 'zod';
import { commitShaSchema } from './projects.js';

export const repositoryFileStateSchema = z.object({
  mode: z.enum(['100644', '100755']), sha: commitShaSchema,
}).strict();
export type RepositoryFileState = z.infer<typeof repositoryFileStateSchema>;
export const repositoryInventorySchema = z.record(z.string().max(512), repositoryFileStateSchema)
  .refine(value => Object.keys(value).length <= 1024, 'Repository base exceeds its bound');
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
