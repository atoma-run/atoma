import { z } from 'zod';
import { WORKSPACE_LIMITS } from './workspaceLimits.js';

export const CHECKPOINT_CHUNK_BYTES = 256 * 1024;
/** POSIX paths only; every directory is declared before its children. */
export const checkpointEntryPathSchema = z.string().min(1).max(WORKSPACE_LIMITS.maxPathChars)
  .refine(path => !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Invalid checkpoint path');
export const checkpointTransferHeaderSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  rootMode: z.number().int().min(0).max(0o777),
}).strict();
export type CheckpointTransferHeader = z.infer<typeof checkpointTransferHeaderSchema>;
export const checkpointTransferEntrySchema = z.object({
  path: checkpointEntryPathSchema,
  kind: z.enum(['directory', 'file', 'symlink']),
  mode: z.number().int().min(0).max(0o177777),
  size: z.number().int().min(0).max(WORKSPACE_LIMITS.maxFileBytes),
}).strict();
export type CheckpointTransferEntry = z.infer<typeof checkpointTransferEntrySchema>;

export type CheckpointExportFrame = { kind: 'entry'; entry: CheckpointTransferEntry }
  | { kind: 'chunk'; offset: number; bytes: Uint8Array };
export interface CheckpointExport {
  readonly header: CheckpointTransferHeader;
  frames(): AsyncGenerator<CheckpointExportFrame>;
  close(): void | Promise<void>;
}
export const checkpointWireFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entry'), entry: checkpointTransferEntrySchema }).strict(),
  z.object({ kind: z.literal('chunk'), offset: z.number().int().nonnegative(),
    data: z.string().min(4).max(4 * Math.ceil(CHECKPOINT_CHUNK_BYTES / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ kind: z.literal('end') }).strict(),
]);
