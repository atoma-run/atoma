import { z } from 'zod';

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
