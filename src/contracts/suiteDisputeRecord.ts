import { z } from 'zod';
import { parentTestCauseSchema, parentTestStatusSchema } from './parentTestRecord.js';
import { parentTestSuiteSchema, type ParentTestSuite } from './parentTests.js';

/**
 * THE RECORD OF A SUITE DISPUTE (2026-10-17), kept in the run trace as the
 * top-level member `VizRun.suiteDisputes`, so a counted dispute can be
 * classified without forensics: before it, one took a run.log grep, digests
 * recomputed over 19 suites parsed out of plan replies in an 18 MB trace, and
 * a read of the saved workspace (run 034d176d).
 *
 * Written by `suiteDisputeWatch` (`src/core/parentTests.ts`) through
 * `RunContext.recordSuiteDispute`; read by the platform report
 * (`src/projects/suiteDisputes.ts`). NO RUN PATH READS IT, so no model in a
 * run sees it: it is not an event (the analyst's digest and events file are
 * model input), never part of `result` (which goes up the tree and into
 * later runs), and no run reads the member. Outside runs it stays where the
 * plan replies and the run log already are: a viewer's `section=metadata`,
 * and the whole trace the post-mortem analyst may open.
 *
 * Two entries:
 *  - `counted`, one per counted dispute, emitted with the `suite-dispute` run
 *    stat, so their numbers are equal: the suite the host holds (its digest
 *    is the unit's key), the failing set that repeated, and every
 *    observation of that suite the loop held;
 *  - `later`, one per later verification of that suite in the same loop (a
 *    branch retry, the parent's fallback), at most
 *    `SUITE_DISPUTE_LATER_PER_COUNT` per count.
 *
 * Strict writer, tolerant reader, as `parentTestRecord.ts`: the builders
 * bound every string before the strict schema checks it, so a real dispute
 * is never refused for its size; the reader keeps what it knows, reads an
 * unknown cause as unrecorded and drops an unreadable observation, never the
 * entry around it. Decision and pre-registration:
 * docs/decisions/parent-owned-tests-2026-10-16.md,
 * benchmark/suite-dispute-2026-10-17/.
 */

export const SUITE_DISPUTE_RECORD_VERSION = 1;
/** Entries the trace member holds; a counted entry displaces a later one, never the reverse. */
export const SUITE_DISPUTE_TRACE_ENTRIES = 64;
export const SUITE_DISPUTE_LATER_PER_COUNT = 8;
/** Observations a counted entry lists, the latest kept. */
export const SUITE_DISPUTE_OBSERVATIONS = 32;
export const SUITE_DISPUTE_TASK_CHARS = 600;
/** Above the repeat key's own bound (`failingExcerpt` writes at most ~1,800 characters). */
export const SUITE_DISPUTE_EXCERPT_CHARS = 2_000;
const NAME_CHARS = 200;
const DIGEST_CHARS = 128;

const count = z.number().int().nonnegative();
const suiteDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** One observation of the disputed suite, without its details or the child's output. */
export const suiteDisputeObservationSchema = z.object({
  observedAt: count.optional(),
  subjectDigest: z.string().max(DIGEST_CHARS).optional(),
  workspaceDigest: z.string().max(DIGEST_CHARS),
  status: parentTestStatusSchema,
  cause: parentTestCauseSchema.optional(),
  passed: count,
  failed: count,
  skipped: count,
  /** It failed with the counted failing set (the repeat key's text). */
  sameSet: z.boolean(),
}).strict();
export type SuiteDisputeObservation = z.infer<typeof suiteDisputeObservationSchema>;

/** The key every entry carries: which suite, in which attempt and lane. */
const keyShape = {
  v: z.literal(SUITE_DISPUTE_RECORD_VERSION),
  id: z.string().uuid(),
  /** Epoch ms when the host wrote the entry. */
  at: count,
  attempt: z.number().int().positive().optional(),
  branchId: z.string().max(NAME_CHARS).optional(),
  suiteDigest: suiteDigestSchema,
};

export const suiteDisputeCountedSchema = z.object({
  ...keyShape,
  type: z.literal('counted'),
  /** The loop's parent: the supervisor that owns the suite's verification. */
  owner: z.object({ name: z.string().max(NAME_CHARS), tier: tierSchema }).strict(),
  failingChild: z.string().max(NAME_CHARS),
  /** The escalation's phase (`EscalationSignal.phase`). */
  phase: z.string().max(64),
  task: z.string().max(SUITE_DISPUTE_TASK_CHARS),
  /** The reviewed copy the host holds; `parentTestSuiteDigest(suite)` is `suiteDigest`. */
  suite: parentTestSuiteSchema,
  /** The failing set every counted observation shares: the repeat key. */
  excerpt: z.string().max(SUITE_DISPUTE_EXCERPT_CHARS),
  /** The dispute's own numbers, the ones the run log line prints. */
  counts: z.object({ observations: count, subjects: count }).strict(),
  observations: z.array(suiteDisputeObservationSchema).max(SUITE_DISPUTE_OBSERVATIONS),
}).strict();
export type SuiteDisputeCounted = z.infer<typeof suiteDisputeCountedSchema>;

export const suiteDisputeLaterSchema = z.object({
  ...keyShape,
  type: z.literal('later'),
  /** The counted entry this verification follows. */
  countId: z.string().uuid(),
  producedBy: z.object({ name: z.string().max(NAME_CHARS), tier: tierSchema, viaFallback: z.boolean() }).strict(),
  observation: suiteDisputeObservationSchema,
}).strict();
export type SuiteDisputeLater = z.infer<typeof suiteDisputeLaterSchema>;

export const suiteDisputeEntrySchema = z.discriminatedUnion('type', [suiteDisputeCountedSchema, suiteDisputeLaterSchema]);
export type SuiteDisputeEntry = z.infer<typeof suiteDisputeEntrySchema>;

/** What the builders take for an observation: the held shape, details included. */
export interface SuiteDisputeObservationInput {
  readonly observedAt?: number | undefined;
  readonly subjectDigest?: string | undefined;
  readonly workspaceDigest: string;
  readonly status: z.infer<typeof parentTestStatusSchema>;
  readonly cause?: z.infer<typeof parentTestCauseSchema> | undefined;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface SuiteDisputeKey {
  readonly id: string;
  readonly at: number;
  readonly attempt?: number | undefined;
  readonly branchId?: string | undefined;
  readonly suiteDigest: string;
}

function keyOf(key: SuiteDisputeKey) {
  return {
    v: SUITE_DISPUTE_RECORD_VERSION,
    id: key.id,
    at: key.at,
    ...(key.attempt !== undefined ? { attempt: key.attempt } : {}),
    ...(key.branchId !== undefined ? { branchId: key.branchId.slice(0, NAME_CHARS) } : {}),
    suiteDigest: key.suiteDigest,
  };
}

function observationOf(observation: SuiteDisputeObservationInput, sameSet: boolean): SuiteDisputeObservation {
  return {
    ...(observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}),
    ...(observation.subjectDigest !== undefined ? { subjectDigest: observation.subjectDigest.slice(0, DIGEST_CHARS) } : {}),
    workspaceDigest: observation.workspaceDigest.slice(0, DIGEST_CHARS),
    status: observation.status,
    ...(observation.cause !== undefined ? { cause: observation.cause } : {}),
    passed: observation.passed,
    failed: observation.failed,
    skipped: observation.skipped,
    sameSet,
  };
}

/** The strict writer of a counted entry; strings are bounded first, so only a malformed key or suite throws. */
export function suiteDisputeCountedEntry(input: {
  readonly key: SuiteDisputeKey;
  readonly owner: { readonly name: string; readonly tier: 1 | 2 | 3 };
  readonly failingChild: string;
  readonly phase: string;
  readonly task: string;
  readonly suite: ParentTestSuite;
  readonly excerpt: string;
  readonly counts: { readonly observations: number; readonly subjects: number };
  /** Every observation of the suite the loop held, in order, each with whether it failed with `excerpt`'s set. */
  readonly observations: readonly { readonly observation: SuiteDisputeObservationInput; readonly sameSet: boolean }[];
}): SuiteDisputeCounted {
  return suiteDisputeCountedSchema.parse({
    ...keyOf(input.key),
    type: 'counted',
    owner: { name: input.owner.name.slice(0, NAME_CHARS), tier: input.owner.tier },
    failingChild: input.failingChild.slice(0, NAME_CHARS),
    phase: input.phase.slice(0, 64),
    task: input.task.slice(0, SUITE_DISPUTE_TASK_CHARS),
    suite: input.suite,
    excerpt: input.excerpt.slice(0, SUITE_DISPUTE_EXCERPT_CHARS),
    counts: { observations: input.counts.observations, subjects: input.counts.subjects },
    observations: input.observations.slice(-SUITE_DISPUTE_OBSERVATIONS).map(({ observation, sameSet }) => observationOf(observation, sameSet)),
  });
}

/** The strict writer of a later entry. */
export function suiteDisputeLaterEntry(input: {
  readonly key: SuiteDisputeKey;
  readonly countId: string;
  readonly producedBy: { readonly name: string; readonly tier: 1 | 2 | 3; readonly viaFallback: boolean };
  readonly observation: SuiteDisputeObservationInput;
  readonly sameSet: boolean;
}): SuiteDisputeLater {
  return suiteDisputeLaterSchema.parse({
    ...keyOf(input.key),
    type: 'later',
    countId: input.countId,
    producedBy: { name: input.producedBy.name.slice(0, NAME_CHARS), tier: input.producedBy.tier, viaFallback: input.producedBy.viaFallback },
    observation: observationOf(input.observation, input.sameSet),
  });
}

/**
 * Appends under the member's cap. A counted entry is what the run stat
 * counts, so it displaces the newest later entry when the member is full; a
 * later entry never displaces anything. Returns whether `entry` was kept.
 */
export function appendSuiteDisputeEntry(entries: SuiteDisputeEntry[], entry: SuiteDisputeEntry): boolean {
  if (entries.length < SUITE_DISPUTE_TRACE_ENTRIES) {
    entries.push(entry);
    return true;
  }
  if (entry.type === 'later') return false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.type === 'later') {
      entries.splice(index, 1);
      entries.push(entry);
      return true;
    }
  }
  return false;
}

/* ─────────────────────────────── the tolerant reader ─────────────────────────────── */

/** An array whose unreadable items are dropped, never the whole list. */
function tolerantArray<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((items) => items.flatMap((value) => {
    const parsed = item.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  }));
}

const observationReaderSchema = z.object({
  observedAt: count.optional().catch(undefined),
  subjectDigest: z.string().optional().catch(undefined),
  workspaceDigest: z.string().catch(''),
  status: parentTestStatusSchema,
  cause: parentTestCauseSchema.optional().catch(undefined),
  passed: count,
  failed: count,
  skipped: count,
  sameSet: z.boolean().catch(false),
});

/** The reader's key: any version (a later writer's entry keeps the fields this binary knows). */
const keyReaderShape = {
  v: z.number(),
  id: z.string().min(1),
  at: count,
  attempt: z.number().int().positive().optional().catch(undefined),
  branchId: z.string().optional().catch(undefined),
  suiteDigest: suiteDigestSchema,
};

export const suiteDisputeCountedReaderSchema = z.object({
  ...keyReaderShape,
  type: z.literal('counted'),
  owner: z.object({ name: z.string(), tier: z.number().int() }),
  failingChild: z.string(),
  phase: z.string(),
  task: z.string(),
  suite: z.object({ requirement: z.string(), cwd: z.string(), source: z.string() }),
  excerpt: z.string(),
  counts: z.object({ observations: count, subjects: count }),
  observations: tolerantArray(observationReaderSchema),
});
export type SuiteDisputeCountedRead = z.infer<typeof suiteDisputeCountedReaderSchema>;

export const suiteDisputeLaterReaderSchema = z.object({
  ...keyReaderShape,
  type: z.literal('later'),
  countId: z.string().min(1),
  producedBy: z.object({ name: z.string(), tier: z.number().int(), viaFallback: z.boolean() }),
  observation: observationReaderSchema,
});
export type SuiteDisputeLaterRead = z.infer<typeof suiteDisputeLaterReaderSchema>;

export const suiteDisputeEntryReaderSchema = z.discriminatedUnion('type', [suiteDisputeCountedReaderSchema, suiteDisputeLaterReaderSchema]);
export type SuiteDisputeEntryRead = z.infer<typeof suiteDisputeEntryReaderSchema>;

/**
 * Reads a trace's `suiteDisputes` member. Total: an absent member is no
 * entries, a member that is not an array is one malformed item, and each
 * entry the reader refuses is counted, never thrown.
 */
export function readSuiteDisputeEntries(member: unknown): { readonly entries: SuiteDisputeEntryRead[]; readonly malformed: number } {
  if (member === undefined) return { entries: [], malformed: 0 };
  if (!Array.isArray(member)) return { entries: [], malformed: 1 };
  const entries: SuiteDisputeEntryRead[] = [];
  for (const item of member) {
    const parsed = suiteDisputeEntryReaderSchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return { entries, malformed: member.length - entries.length };
}
