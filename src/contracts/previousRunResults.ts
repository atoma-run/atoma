import { z } from 'zod';

export const PREVIOUS_RESULTS_ENV = 'ATOMA_PREVIOUS_RUN_RESULTS';
export const PREVIOUS_RESULTS_MAX_CHARS = 24_000;
export const previousRunResultsSchema = z.object({
  historyTruncated: z.boolean(),
  runs: z.array(z.object({
    runId: z.string().uuid(),
    status: z.enum(['delivered', 'partial']),
    goal: z.string().max(4_000),
    output: z.string().max(8_000),
    truncated: z.boolean(),
    unavailable: z.boolean(),
  }).strict()).max(3),
}).strict();
export type PreviousRunResults = z.infer<typeof previousRunResultsSchema>;

/** Oldest to newest. Omitted context is explicit; an excerpt is never a full answer. */
export function encodePreviousResults(value: PreviousRunResults): string {
  const bounded = previousRunResultsSchema.parse(value);
  while (JSON.stringify(bounded).length > PREVIOUS_RESULTS_MAX_CHARS) {
    if (bounded.runs.length > 1) {
      bounded.runs.shift();
      bounded.historyTruncated = true;
    } else {
      const run = bounded.runs[0]!;
      run.truncated = true;
      if (run.output.length > 0) run.output = run.output.slice(0, Math.floor(run.output.length / 2));
      else run.goal = run.goal.slice(0, Math.floor(run.goal.length / 2));
    }
  }
  return JSON.stringify(bounded);
}

export function decodePreviousResults(value: string | undefined): PreviousRunResults | undefined {
  if (value === undefined) return undefined;
  if (value.length > PREVIOUS_RESULTS_MAX_CHARS) throw new Error('previous run context exceeds its bound');
  return previousRunResultsSchema.parse(JSON.parse(value));
}
