import { z } from 'zod';

/**
 * THE BROWSER-SAFE HOME of a persisted parent-test observation: its shape, the
 * superseded rule and the one projection every reader draws from (viz result
 * view, the receipt card, `atoma_run_review`). No Node import may enter this
 * module: the GPU client bundles it. The suite digest needs `node:crypto` and
 * stays in `parentTests.ts`, which re-exports everything here for the server.
 */

/**
 * Why an observation is what it is, typed by the code that saw it, so no
 * reader classifies blame from text the code under test printed.
 * `src/core/parentTests.ts` maps each cause to one consequence.
 */
export const parentTestCauseSchema = z.enum([
  'ran', // the runner produced a valid report (passed or failed)
  'timeout', // tools: the runner was killed by its timer
  'exited-without-report', // tools: the runner exited on its own and wrote no report
  'source-changed', // tools: the suite file differs, or vanished, after the run
  'report-oversize', // tools: the report exceeds 8 MiB
  'report-invalid', // tools: the report is not JSON or not the expected shape
  'report-tampered', // tools: the report path is not a regular file after the run; the host cleared it before
  'snapshot-link', // tools: a link resolves outside the project
  'snapshot-bounds', // tools: more than 100,000 entries, depth 128 or 512 MiB
  'snapshot-timeout', // tools: the window ended while the project was being copied
  'snapshot-special-file', // tools: a FIFO, socket or device in the project
  'worker-missing', // tools: the compiled acceptance worker is not installed
  'assertions-tampered', // tools: a host-tagged assertion-integrity violation during the run
  'runner-error', // tools: any other host failure
  'no-executor', // core: no shell executor in this context
  'invalid-observation', // core: the executor returned no valid observation for this suite
  'executor-error', // core: the executor threw
  'landing', // core: the run budget ended first
  'deadline-timeout', // core: a timeout in a child window below PARENT_TEST_TIMEOUT_MS (the run deadline or the copy cut it)
]);
export type ParentTestCause = z.infer<typeof parentTestCauseSchema>;

export const parentTestStatusSchema = z.enum(['passed', 'failed', 'unavailable']);
export type ParentTestStatus = z.infer<typeof parentTestStatusSchema>;

/** What the runner keeps of a suite's requirement and of the host's details text. */
export const PERSISTED_REQUIREMENT_CHARS = 600;
export const PERSISTED_DETAILS_CHARS = 1500;

const count = z.number().int().nonnegative();

/** The WRITER shape (`persistedParentTests`): no suite source, no child output. */
export const persistedParentTestSchema = z.object({
  suiteDigest: z.string(),
  workspaceDigest: z.string(),
  status: parentTestStatusSchema,
  cause: parentTestCauseSchema.optional(),
  passed: count,
  failed: count,
  skipped: count,
  judged: z.literal(true).optional(),
  requirement: z.string().max(PERSISTED_REQUIREMENT_CHARS).optional(),
  details: z.string().max(PERSISTED_DETAILS_CHARS),
});
export type PersistedParentTestObservation = z.infer<typeof persistedParentTestSchema>;

/**
 * The READER shape, derived from the writer's: a cause this binary does not
 * know keeps its row (cause read as unrecorded), and strings are bounded by
 * the projection's slice, never by rejection, so a record written under a
 * looser bound still shows.
 */
export const persistedParentTestReaderSchema = persistedParentTestSchema.extend({
  cause: parentTestCauseSchema.optional().catch(undefined),
  judged: z.boolean().optional().catch(undefined),
  requirement: z.string().optional(),
  details: z.string(),
});

/**
 * A non-passed observation that a later (higher index) PASSED run of the same
 * suite replaced. The index is RECORD order (aggregation concatenates
 * subtasks in order), not time, and the key is the suite digest alone, across
 * workspaces: core's gates and every display read this one rule.
 */
export function parentTestSuperseded(
  observations: readonly { readonly status: ParentTestStatus; readonly suiteDigest: string }[],
  index: number,
): boolean {
  const observation = observations[index];
  if (!observation || observation.status === 'passed') return false;
  return observations.some((later, at) => at > index && later.status === 'passed' && later.suiteDigest === observation.suiteDigest);
}

export const parentTestRowSchema = z.object({
  suiteDigest: z.string(),
  workspaceDigest: z.string(),
  status: parentTestStatusSchema,
  cause: parentTestCauseSchema.nullable(),
  passed: count,
  failed: count,
  skipped: count,
  judged: z.boolean(),
  superseded: z.boolean(),
  requirement: z.string().nullable(),
  details: z.string().nullable(),
  detailsTruncated: z.boolean(),
});
export type ParentTestRow = z.infer<typeof parentTestRowSchema>;

/** Suites by the status of their LAST record. */
export const parentTestCountsSchema = z.object({ total: count, passed: count, failed: count, unavailable: count });

export const parentTestSummarySchema = z.object({
  /** `none` is the absence of records, never a pass. */
  state: z.enum(['recorded', 'none', 'not_recorded']),
  suites: parentTestCountsSchema,
  records: z.object({
    /** Raw entries in the result. */
    total: count,
    /** Entries the reader schema refused, or 1 for a `parentTests` that is not an array. */
    invalid: count,
    /** Valid entries after keeping the last per (suite, workspace, status). `listed + omitted = distinct`. */
    distinct: count,
    listed: count,
    omitted: count,
    supersededFailures: count,
  }),
  observations: z.array(parentTestRowSchema),
});
export type ParentTestSummary = z.infer<typeof parentTestSummarySchema>;

export interface ParentTestLimits {
  /** Rows listed, after ranking. */
  readonly rows: number;
  readonly requirementChars: number;
  readonly detailsChars: number;
  /** Rows that keep their details: the first open (rank-0) rows only. */
  readonly detailRows: number;
}

// Control characters other than \n and \t would be drawn or forwarded as-is,
// and a lone surrogate serialises as a six-character escape: both become
// U+FFFD, one unit for one, so a slice keeps its length.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT = String.fromCharCode(0xfffd);
/** Cut first, then clean: a cut through a surrogate pair is cleaned too. */
const bounded = (value: string, chars: number): string => value.slice(0, Math.max(0, chars)).replace(UNSAFE, REPLACEMENT);
/** A digest is hex; anything else is shown as not recorded. */
const digest = (value: string): string => /^[0-9a-f]{1,64}$/i.test(value) ? value : '';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function emptySummary(state: ParentTestSummary['state'], total = 0, invalid = 0): ParentTestSummary {
  return {
    state,
    suites: { total: 0, passed: 0, failed: 0, unavailable: 0 },
    records: { total, invalid, distinct: 0, listed: 0, omitted: 0, supersededFailures: 0 },
    observations: [],
  };
}

/**
 * The one projection of a run result's `parentTests`. Pure and total: it
 * never throws, never parses `details` (child-controlled, often cut JSON) and
 * never reads summary prose, so a historical trace reads `none`.
 */
export function summarizeParentTests(result: unknown, limits: ParentTestLimits): ParentTestSummary {
  if (!isPlainObject(result)) return emptySummary('not_recorded');
  if (!('parentTests' in result) || result['parentTests'] === undefined) return emptySummary('none');
  const raw = result['parentTests'];
  if (!Array.isArray(raw)) return emptySummary('recorded', 0, 1);
  const valid: { readonly at: number; readonly entry: z.infer<typeof persistedParentTestReaderSchema> }[] = [];
  for (const [at, item] of raw.entries()) {
    const parsed = persistedParentTestReaderSchema.safeParse(item);
    if (parsed.success) valid.push({ at, entry: parsed.data });
  }
  const entries = valid.map(item => item.entry);
  const superseded = entries.map((_, index) => parentTestSuperseded(entries, index));
  const lastBySuite = new Map<string, ParentTestStatus>();
  for (const entry of entries) lastBySuite.set(entry.suiteDigest, entry.status);
  const suites = { total: lastBySuite.size, passed: 0, failed: 0, unavailable: 0 };
  for (const status of lastBySuite.values()) suites[status]++;
  // The last record per (suite, workspace, status) stands for the others.
  const kept = new Map<string, number>();
  entries.forEach((entry, index) => kept.set(JSON.stringify([entry.suiteDigest, entry.workspaceDigest, entry.status]), index));
  const rank = (index: number): number => entries[index]!.status === 'passed' ? 2 : superseded[index] ? 1 : 0;
  const order = [...kept.values()].sort((a, b) => rank(a) - rank(b) || b - a);
  const listedIndexes = order.slice(0, Math.max(0, limits.rows));
  let detailed = 0;
  const observations = listedIndexes.map((index): ParentTestRow => {
    const entry = entries[index]!;
    const showDetails = rank(index) === 0 && entry.details.length > 0 && detailed < limits.detailRows;
    if (showDetails) detailed++;
    return {
      suiteDigest: digest(entry.suiteDigest),
      workspaceDigest: digest(entry.workspaceDigest),
      status: entry.status,
      cause: entry.cause ?? null,
      passed: entry.passed,
      failed: entry.failed,
      skipped: entry.skipped,
      judged: entry.judged === true,
      superseded: superseded[index]!,
      requirement: entry.requirement === undefined ? null : bounded(entry.requirement, limits.requirementChars),
      details: showDetails ? bounded(entry.details, limits.detailsChars) : null,
      detailsTruncated: showDetails && entry.details.length > limits.detailsChars,
    };
  });
  return {
    state: 'recorded',
    suites,
    records: {
      total: raw.length,
      invalid: raw.length - valid.length,
      distinct: order.length,
      listed: observations.length,
      omitted: order.length - observations.length,
      supersededFailures: order.filter(index => superseded[index]).length,
    },
    observations,
  };
}
