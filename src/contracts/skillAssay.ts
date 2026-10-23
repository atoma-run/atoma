import { z } from 'zod';

/**
 * THE SKILL ASSAY (owner decision 2026-10-15, docs/skill-assay-2026-10-15.md):
 * one recipe, a few credited tasks, two ordinary runs per task — one with
 * the recipe in the catalog, one without — and a verdict read from what the
 * runs DELIVERED. The record is the fourth supervisor stage's output, kept
 * under `supervisor/assays/`, and this is its one schema.
 *
 * Nothing model-authored enters it: the case is a task text the host
 * recorded when the recipe was credited, the outcome is the runner's own
 * epilogue, "matched" is a runtime-stamped skill event in the arm's trace.
 */

export const assayArmSchema = z.enum(['with', 'without']);
export type AssayArm = z.infer<typeof assayArmSchema>;

export const assayVerdictSchema = z.enum(['not-reached', 'helpful', 'neutral', 'harmful']);
export type AssayVerdict = z.infer<typeof assayVerdictSchema>;

export const assayDecisionSchema = z.enum(['keep', 'retire']);
export type AssayDecision = z.infer<typeof assayDecisionSchema>;

export const assayRunOutcomeSchema = z.enum(['delivered', 'partial', 'failed', 'error', 'cancelled']);
export type AssayRunOutcome = z.infer<typeof assayRunOutcomeSchema>;

export const assayArmResultSchema = z.object({
  arm: assayArmSchema,
  outcome: assayRunOutcomeSchema,
  costUsd: z.number().finite().nonnegative().nullable(),
  durationS: z.number().finite().nonnegative().nullable(),
  llmCalls: z.number().int().nonnegative().nullable(),
  /** The recipe under assay was matched or dispatched in this run (a runtime skill event). */
  matched: z.boolean(),
  traceId: z.string().nullable(),
  /** Relative to the assay directory. */
  logPath: z.string(),
}).strict();
export type AssayArmResult = z.infer<typeof assayArmResultSchema>;

export const assayCaseResultSchema = z.object({
  task: z.string().min(1),
  /** When the recipe was credited on this task. */
  sampledAt: z.string(),
  with: assayArmResultSchema,
  without: assayArmResultSchema,
}).strict();
export type AssayCaseResult = z.infer<typeof assayCaseResultSchema>;

export const assayJudgementSchema = z.object({
  verdict: assayVerdictSchema,
  decision: assayDecisionSchema,
  /** Cases where the `with` arm matched the recipe: the only ones that say anything about it. */
  matchedCases: z.number().int().nonnegative(),
  deliveries: z.object({ with: z.number().int().nonnegative(), without: z.number().int().nonnegative() }).strict(),
  /** Over matched cases; null when an arm's cost is unknown. */
  costUsd: z.object({ with: z.number().nullable(), without: z.number().nullable() }).strict(),
}).strict();
export type AssayJudgement = z.infer<typeof assayJudgementSchema>;

export const skillAssayRecordSchema = z.object({
  schema: z.literal('atoma.supervisor.assay/v1'),
  namespace: z.string().min(1),
  skillId: z.string().min(1),
  /** sha256 of kind, when_to_use and body: the surface this assay judged. */
  surfaceDigest: z.string().length(64),
  kind: z.enum(['llm', 'script']),
  startedAt: z.string(),
  endedAt: z.string(),
  cases: z.array(assayCaseResultSchema),
  /** Absent on legacy records; invalid legacy arms are projected as failed by readers. */
  status: z.enum(['completed', 'failed', 'preempted']).optional(),
  failure: z.string().max(2000).nullable().optional(),
  judgement: assayJudgementSchema.nullable(),
  /** The decision was applied to the live catalog (false on a dry run). */
  applied: z.boolean(),
  totalCostUsd: z.number().finite().nonnegative().nullable(),
}).strict();
export type SkillAssayRecord = z.infer<typeof skillAssayRecordSchema>;

/** Parsed at load, like every contract example. */
export const EXAMPLE_ASSAY_RECORD: SkillAssayRecord = skillAssayRecordSchema.parse({
  schema: 'atoma.supervisor.assay/v1',
  namespace: 'atom-0000',
  skillId: 'probe-json-api-lifecycle',
  surfaceDigest: 'a'.repeat(64),
  kind: 'llm',
  startedAt: '2026-10-15T10:00:00.000Z',
  endedAt: '2026-10-15T10:20:00.000Z',
  cases: [{
    task: 'Verify the running books API answers its documented routes',
    sampledAt: '2026-10-14T09:00:00.000Z',
    with: { arm: 'with', outcome: 'delivered', costUsd: 0.21, durationS: 240, llmCalls: 12, matched: true, traceId: 'trace-a', logPath: 'runs/0-with.log' },
    without: { arm: 'without', outcome: 'delivered', costUsd: 0.3, durationS: 300, llmCalls: 15, matched: false, traceId: 'trace-b', logPath: 'runs/0-without.log' },
  }],
  judgement: { verdict: 'neutral', decision: 'keep', matchedCases: 1, deliveries: { with: 1, without: 1 }, costUsd: { with: 0.21, without: 0.3 } },
  applied: true,
  totalCostUsd: 0.51,
});

/** Technical failures cannot establish a comparison, even if the other arm delivered. */
export function assayRecordStatus(record: SkillAssayRecord): 'completed' | 'failed' | 'preempted' {
  if (record.status && record.status !== 'completed') return record.status;
  if (!record.judgement || !assayCasesComplete(record.cases)) return 'failed';
  return 'completed';
}

export type AssaySummary = Pick<SkillAssayRecord, 'namespace' | 'skillId' | 'surfaceDigest' | 'startedAt' | 'endedAt' | 'totalCostUsd'> & {
  id: string;
  status: ReturnType<typeof assayRecordStatus>;
  judgement: AssayJudgement | null;
  failure: string | null;
  cases: number;
  arms: Array<Pick<AssayArmResult, 'arm' | 'outcome' | 'matched' | 'llmCalls' | 'durationS' | 'traceId'>>;
};
export interface AssayListing {
  assays: AssaySummary[];
  nextBefore: string | null;
  scanned: number;
  unreadable: number;
  scanTruncated: boolean;
}

/** One validity predicate for judgement, persistence, recovery and every reader. */
export function assayCasesComplete(cases: readonly AssayCaseResult[]): boolean {
  return cases.length > 0 && cases.every(c => [c.with, c.without].every(a =>
    a.outcome !== 'error' && a.outcome !== 'cancelled' && a.traceId !== null));
}
