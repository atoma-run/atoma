import { z } from 'zod';

/** Browser-safe persisted replay shapes; replay execution stays in inheritedChecks.ts. */
/** Why a check no longer passes. */
export const REPLAY_CAUSES = ['value-changed', 'element-missing', 'page-gone'] as const;
export type ReplayCause = (typeof REPLAY_CAUSES)[number];

/**
 * Why a replay stopped before its last check. `budget`: its time ran out (at
 * the start, with a tool call of the run waiting); `cap`: the run-start
 * replay ran on while nothing waited, up to its extended cap.
 */
export const REPLAY_STOPS = ['deadline', 'budget', 'cap', 'abandoned', 'server', 'aborted'] as const;
export type ReplayStop = (typeof REPLAY_STOPS)[number];

export const recordedCheckSchema = z.object({ cause: z.enum(REPLAY_CAUSES), steps: z.string(), smoke: z.string(), detail: z.string() });

/** What `AcceptanceInfo` records of one acceptance's replay, the run-start replay included. */
export const inheritedChecksSummarySchema = z.object({
  /** Absent on the records written before it existed (run 41711050). */
  selected: z.number().int().nonnegative().optional(),
  considered: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  baselineCannotRun: z.number().int().nonnegative(),
  markedDead: z.number().int().nonnegative().optional(),
  pruned: z.number().int().nonnegative().optional(),
  revived: z.number().int().nonnegative().optional(),
  baselineStopped: z.enum(REPLAY_STOPS).optional(),
  baselineNote: z.string().optional(),
  replayed: z.number().int().nonnegative(),
  stillPassing: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
  notReplayed: z.number().int().nonnegative(),
  listed: z.number().int().nonnegative(),
  stopped: z.enum(REPLAY_STOPS).optional(),
  /** Why this acceptance compared nothing: no file changed, a gate refused, or the workspace could not be read. */
  notCompared: z.enum(['unchanged', 'refused', 'unreadable']).optional(),
  newPageError: z.string().optional(),
  items: z.array(z.object({
    id: z.string(), file: z.string(), summary: z.string(),
    /** Up to five of the item's checks, so a refusal and its remediation can name what to restore. */
    checks: z.array(recordedCheckSchema),
    asked: z.boolean().optional(), reason: z.string().optional(),
  })),
});
export type InheritedChecksSummary = z.infer<typeof inheritedChecksSummarySchema>;
