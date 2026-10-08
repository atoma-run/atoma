import { z } from 'zod';

/** Browser/isolate protocol only. It carries no launcher or host capability. */
export const TERMINAL_INPUT_BYTES = 16 * 1024;
export const TERMINAL_UPLOAD_BYTES = 1024 * 1024;
export const TERMINAL_HISTORY_BYTES = 1024 * 1024;
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
