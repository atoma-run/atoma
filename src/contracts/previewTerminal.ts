import { z } from 'zod';

/** Browser/isolate protocol only. It carries no launcher or host capability. */
export const TERMINAL_INPUT_BYTES = 16 * 1024;
export const TERMINAL_UPLOAD_BYTES = 1024 * 1024;
export const TERMINAL_HISTORY_BYTES = 1024 * 1024;
/**
 * The terminal's writable `/data` tmpfs, and the share of it the copied
 * workspace may take. The terminal server copies the read-only source into
 * this tmpfs before it answers, so a copy cap EQUAL to the tmpfs let an
 * admitted workspace fail with ENOSPC inside the container, reported as
 * `readiness-timeout` instead of the `copy-limit` a member can act on. The
 * headroom is for the member's edits and build output, and the copy is
 * charged in whole tmpfs pages so that many small files cannot spend it.
 */
export const TERMINAL_DATA_BYTES = 512 * 1024 * 1024;
export const TERMINAL_COPY_HEADROOM_BYTES = 128 * 1024 * 1024;
export const TERMINAL_COPY_MAX_BYTES = TERMINAL_DATA_BYTES - TERMINAL_COPY_HEADROOM_BYTES;
export const TERMINAL_COPY_PAGE_BYTES = 4096;
export const terminalResizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
}).strict();
export const terminalOutputSchema = z.object({
  data: z.string().max(90_000),
  cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
  exitCode: z.number().int().nullable(),
}).strict();
export type TerminalOutputPage = z.infer<typeof terminalOutputSchema>;
export type TerminalSize = z.infer<typeof terminalResizeSchema>;
export const EXAMPLE_TERMINAL_OUTPUT = terminalOutputSchema.parse({ data: '', cursor: 0, truncated: false, exitCode: null });
