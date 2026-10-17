import { projectWorkspaceIdentitySchema } from './launcherVolumes.js';
import { z } from 'zod';
import { launcherOwnerIdSchema } from './launcher.js';

/** Workspace keys are operator-configured capabilities, never caller paths. */
export const workerWorkspaceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const launcherWorkerSpecSchema = z.object({
  ownerId: launcherOwnerIdSchema,
  workspaceId: workerWorkspaceIdSchema.optional(),
  project: projectWorkspaceIdentitySchema.optional(),
  egress: z.boolean(),
  /**
   * Mount the workspace's `.atoma-runs` read-only (read runs). Strict on both
   * sides: a launcher that predates it refuses the request, and the handle
   * echoes it only when asked, so an older client never meets it.
   */
  readOnlyRunCopies: z.literal(true).optional(),
}).strict();
export type LauncherWorkerSpec = z.infer<typeof launcherWorkerSpecSchema>;
export const launcherWorkerHandleSchema = z.object({
  id: z.string().uuid(), ownerId: launcherOwnerIdSchema,
  socketPath: z.string().min(1), workspaceHostPath: z.string().min(1), volume: z.string().optional(),
  readOnlyRunCopies: z.literal(true).optional(),
}).strict();
export type LauncherWorkerHandle = z.infer<typeof launcherWorkerHandleSchema>;
export interface WorkerLauncher {
  startWorker(spec: LauncherWorkerSpec): Promise<LauncherWorkerHandle>;
  stopWorker(id: string): Promise<void>;
  checkpointWorkerAbsent?(id: string): Promise<boolean>;
}
