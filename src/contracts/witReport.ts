import { z } from 'zod';

export const witReceiptSchema = z.object({
  runId: z.string(), projectId: z.string().nullable(), runLabel: z.string(),
  eventId: z.string(), at: z.number(), actor: z.string().nullable(),
  mode: z.enum(['check', 'generate']), command: z.string(),
  status: z.enum(['passed', 'generated', 'failed', 'error', 'unknown']),
  exitCode: z.number().int().nullable(), durationMs: z.number(),
  output: z.string(), outputTruncated: z.boolean(),
});
export type WitReceipt = z.infer<typeof witReceiptSchema>;
export const witReportSchema = z.object({
  generatedAt: z.string(), runsScanned: z.number().int(), totalRuns: z.number().int(),
  unreadableRuns: z.number().int(), omittedEvents: z.number().int(),
  receipts: z.array(witReceiptSchema), nextBefore: z.string().nullable(),
});
export type WitReport = z.infer<typeof witReportSchema>;
