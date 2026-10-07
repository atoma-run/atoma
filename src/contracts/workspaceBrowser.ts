import { z } from 'zod';
import { WORKSPACE_LIMITS } from './workspaceLimits.js';

export const workspaceIndexSchema = z.object({
  runId: z.string(), createdAt: z.string(), status: z.enum(['delivered', 'partial']),
  files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
});
export type WorkspaceIndex = z.infer<typeof workspaceIndexSchema>;
export const workspaceFileSchema = z.object({
  path: z.string(), size: z.number().int().nonnegative(),
  kind: z.enum(['text', 'binary', 'too_large']), text: z.string().nullable(),
});
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export const MAX_WORKSPACE_PREVIEW_BYTES = 256 * 1024;

/** Bound binary previews before reading or decoding a saved artifact. */
export const MAX_WORKSPACE_FILE_BYTES = WORKSPACE_LIMITS.maxFileBytes;
