import {
  PARENT_TEST_SNAPSHOT_ALLOWANCE_MS,
  PARENT_TEST_TIMEOUT_MS,
  parentTestObservationSchema,
  parentTestSuiteDigest,
  type HeldParentTestObservation,
  type ParentTestCause,
  type ParentTestObservation,
} from '../contracts/parentTests.js';
import { createHash } from 'node:crypto';
import { parentTestSuperseded } from '../contracts/parentTestRecord.js';
import { abortedForLanding } from './limits.js';
import { baseExecutorOf } from './attestation.js';
import type { Logger, Result, RunContext, Task, Verdict } from './types.js';

let lastObservedAt = 0;
/** Wall-clock ms, strictly increasing in this process: two lanes never tie. */
function observedNow(): number {
  lastObservedAt = Math.max(Date.now(), lastObservedAt + 1);
  return lastObservedAt;
}

/**
 * Canonical bytes stay on the control plane. Only disposable copies cross into
 * the worker. The observation rides `Result.parentTests` and nothing else: it
 * is never written into `summary` (the gates that read the head of a summary
 * went blind behind it, review 2026-10-16) and never into `refusal` (a
 * delivery is refused by its judge, not by an observation).
 */
export async function verifyParentTests(task: Task, result: Result, ctx: RunContext): Promise<Result> {
  const suite = task.acceptanceTests;
  if (!suite) return result;
  if (!abortedForLanding(ctx)) ctx.signal.throwIfAborted();
  const suiteDigest = parentTestSuiteDigest(suite);
  let observation: HeldParentTestObservation = {
    suiteDigest, suite, workspaceDigest: '', status: 'unavailable', cause: 'no-executor', passed: 0, failed: 0, skipped: 0,
    details: 'No shell executor is available for the parent-owned suite.',
  };
  if (result.unfinishedPhases?.length || abortedForLanding(ctx)) {
    observation = { ...observation, cause: 'landing', details: 'Not run: the plan landed with unfinished work or exhausted its run budget.' };
  } else if (ctx.tools?.has('run_shell')) {
    try {
      // The child's window plus the copy's allowance, under one deadline the run's clamps.
      const granted = PARENT_TEST_TIMEOUT_MS + PARENT_TEST_SNAPSHOT_ALLOWANCE_MS;
      const timeoutMs = Math.max(1, Math.min(granted, (ctx.deadlineAt ?? Date.now() + granted) - Date.now()));
      const raw = await baseExecutorOf(ctx.tools).execute('run_shell', {
        command: 'atoma-verify', args: [JSON.stringify(suite)], timeoutMs,
      });
      const parsed = parentTestObservationSchema.safeParse(raw);
      if (parsed.success && parsed.data.suiteDigest === suiteDigest) {
        // Only a hang that had the child's whole window is the code's. One the
        // run deadline or a slow copy cut short is the host's; a worker that
        // reported no window is read the same way.
        const shortened = parsed.data.cause === 'timeout' && (parsed.data.windowMs ?? 0) < PARENT_TEST_TIMEOUT_MS;
        observation = { ...parsed.data, suite, ...(shortened ? { cause: 'deadline-timeout' as const } : {}) };
      } else {
        observation = { ...observation, cause: 'invalid-observation', details: 'The verification worker returned no valid observation for this suite.' };
      }
    } catch (error) {
      if (!abortedForLanding(ctx)) ctx.signal.throwIfAborted();
      observation = { ...observation, cause: 'executor-error', details: `Verification unavailable: ${String(error).slice(0, 1000)}` };
    }
  }
  if (!abortedForLanding(ctx)) ctx.signal.throwIfAborted();
  // Stamped when the host has it, after the run: the superseded rule's clock.
  return { ...result, parentTests: [...(result.parentTests ?? []), { ...observation, observedAt: observedNow() }],
    ...(abortedForLanding(ctx) && observation.status !== 'passed'
      ? { unfinishedPhases: [...(result.unfinishedPhases ?? []), `acceptance tests: ${task.description}`] } : {}),
  };
}

/**
 * What a non-passed observation does to the result carrying it:
 *
 *  - `reject` — executed and independent of content: the suite failed, or the
 *    code under test stopped it from finishing (a hang the child's whole
 *    window could not interrupt, a rewritten suite file, a replaced or
 *    runaway report, a changed assertion machinery).
 *  - `reject-once` — content the child controls may have kept the suite from
 *    a result: the workspace could not be copied (an escaping link, a special
 *    file, permissions that refuse the workspace owner), or the runner ended
 *    without a valid report. Measured on the real runner (third review
 *    2026-10-16): Vitest intercepts `process.exit` in imported code, which
 *    reads `failed`/`ran`; only a killed or signalled process or one out of
 *    memory ends without a report, and code under test can do both, as can a
 *    host crash. The child is coached once; a repeat is reviewed, like every
 *    `reject-once` result gate (second review 2026-10-16).
 *  - `review` — a cause only the host owns: the child cannot act on it, so
 *    rejecting would be the wrong gate. The suite established nothing; a full
 *    review decides on the other evidence.
 *
 * None of them grants trust, skill credit, distillation or promotion.
 */
export type ParentTestConsequence = 'reject' | 'reject-once' | 'review';

const SUBJECT_CAUSES: ReadonlyMap<ParentTestCause, string> = new Map([
  ['timeout', `the suite did not finish within ${PARENT_TEST_TIMEOUT_MS / 1000} s; make every path it exercises terminate`],
  ['source-changed', 'the code under test changed the suite file; never write atoma.acceptance.test.ts'],
  ['report-oversize', 'the failure/print output exceeded 8 MiB'],
  ['report-tampered', 'the code under test replaced the runner report; never write atoma.report.json'],
  ['assertions-tampered', 'the code under test changed Vitest\'s assertion machinery (named in the details): never patch built-ins such as ' +
    'Object.is or iterator methods, extend or replace expect matchers, or return objects with an asymmetricMatch method from application code'],
] as const);

const COPY_COACHING =
  'Remove the link or special file named above and keep the dependencies inside the project ' +
  '(install them there rather than linking a shared store), or explain in your result why that is impossible.';
const PERMISSION_COACHING =
  'Restore read permission on the file or directory named above (the workspace owner must be able to read every project entry), ' +
  'or explain in your result why that is impossible.';
const REPORT_COACHING =
  'The runner ended without a valid report: its process was killed or signalled, or ran out of memory. Code the suite exercises ' +
  'must not kill or signal the process (process.kill, process.abort), must bound the memory it allocates, and must not write ' +
  'atoma.report.json; or explain in your result why the runner could not report.';
/** Content the child controls may be the cause: coached once, then reviewed. */
const ONCE_CAUSES: ReadonlyMap<ParentTestCause, { readonly what: string; readonly coaching: string }> = new Map([
  ['snapshot-link', { what: 'could not be copied', coaching: COPY_COACHING }],
  ['snapshot-special-file', { what: 'could not be copied', coaching: COPY_COACHING }],
  ['snapshot-unreadable', { what: 'could not be copied', coaching: PERMISSION_COACHING }],
  ['exited-without-report', { what: 'produced no valid report', coaching: REPORT_COACHING }],
  ['report-invalid', { what: 'produced no valid report', coaching: REPORT_COACHING }],
] as const);

/** THE one mapping from a typed observation to its consequence. */
export function parentTestConsequence(observation: ParentTestObservation): ParentTestConsequence | null {
  if (observation.status === 'passed') return null;
  if (observation.status === 'failed') return 'reject';
  if (observation.cause && SUBJECT_CAUSES.has(observation.cause)) return 'reject';
  if (observation.cause && ONCE_CAUSES.has(observation.cause)) return 'reject-once';
  return 'review';
}

// THE superseded rule (record order, suite digest only) lives in the
// browser-safe contract so every display reads the gate's own rule.
export { parentTestSuperseded };

export interface ParentTestFindings {
  readonly reject: readonly HeldParentTestObservation[];
  readonly rejectOnce: readonly HeldParentTestObservation[];
  readonly review: readonly HeldParentTestObservation[];
}

/** Unjudged, non-superseded observations, grouped by consequence. */
export function parentTestFindings(result: Pick<Result, 'parentTests'>): ParentTestFindings {
  const observations = result.parentTests ?? [];
  const reject: HeldParentTestObservation[] = [];
  const rejectOnce: HeldParentTestObservation[] = [];
  const review: HeldParentTestObservation[] = [];
  observations.forEach((observation, index) => {
    if (observation.judged || parentTestSuperseded(observations, index)) return;
    const consequence = parentTestConsequence(observation);
    if (consequence === 'reject') reject.push(observation);
    else if (consequence === 'reject-once') rejectOnce.push(observation);
    else if (consequence === 'review') review.push(observation);
  });
  return { reject, rejectOnce, review };
}

/**
 * True when some non-superseded observation did not pass. `unjudged` asks
 * what this tier must still judge; `all` asks whether the result's method can
 * be trusted at all (durable continuation reads it).
 */
export function parentTestsGrantNothing(result: Pick<Result, 'parentTests'>, scope: 'unjudged' | 'all'): boolean {
  const observations = result.parentTests ?? [];
  return observations.some((observation, index) =>
    observation.status !== 'passed' && (scope === 'all' || !observation.judged) && !parentTestSuperseded(observations, index));
}

const short = (observation: ParentTestObservation): string => observation.suiteDigest.slice(0, 16);

/**
 * The failing set, sorted, first failure line each. Keyed on WHAT fails, so
 * the repeat tracker escalates three identical failures and never progress.
 * Host notes (snapshot counts, omissions) vary between runs and are no part
 * of the key; the runner keeps `details` one valid JSON array for this. A set
 * longer than the excerpt is shown cut and keyed by the digest of the WHOLE
 * set: cut alone, two sets that differed past the cut read as one failure
 * (third review 2026-10-16).
 */
function failingExcerpt(details: string): string {
  let entries: unknown;
  try {
    entries = JSON.parse(details);
  } catch {
    return JSON.stringify(details.split('\n')[0]?.slice(0, 300) ?? '');
  }
  if (!Array.isArray(entries)) return JSON.stringify(details.split('\n')[0]?.slice(0, 300) ?? '');
  const failing: { name: string; failure: string }[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.trim() && !entry.startsWith('Host: ')) failing.push({ name: '(module)', failure: entry.split('\n')[0]!.slice(0, 200) });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const test = entry as { name?: unknown; status?: unknown; failures?: unknown };
    if (test.status !== 'failed') continue;
    const first = Array.isArray(test.failures) && typeof test.failures[0] === 'string' ? test.failures[0] : '';
    failing.push({ name: typeof test.name === 'string' ? test.name.slice(0, 200) : '(unnamed)', failure: first.split('\n')[0]!.slice(0, 200) });
  }
  // Code-unit order: the key must not depend on the host's locale.
  failing.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.failure < b.failure ? -1 : a.failure > b.failure ? 1 : 0);
  const text = JSON.stringify(failing);
  if (text.length <= 1200) return text;
  return `${text.slice(0, 1170)}… (failing set ${createHash('sha256').update(text).digest('hex').slice(0, 16)})`;
}

const REPAIR_COACHING =
  'Repair the implementation; if a test contradicts the assigned requirement, explain the conflict to the parent for a reviewed revision. Do not edit or bypass its suite.';

export interface ParentTestFinding {
  readonly reasoning: string;
  readonly coaching: string;
}

/** The rejecting findings: a failed suite, or one the code under test kept from finishing. */
export function parentTestRejection(result: Pick<Result, 'parentTests'>): ParentTestFinding | null {
  const { reject } = parentTestFindings(result);
  if (reject.length === 0) return null;
  const reasoning = reject.map((observation) => observation.status === 'failed'
    ? `Parent-owned acceptance suite ${short(observation)} failed ${observation.failed}/${observation.passed + observation.failed + observation.skipped}: ${failingExcerpt(observation.details)}`
    : `Parent-owned acceptance suite ${short(observation)} could not finish: ${observation.cause} — ${SUBJECT_CAUSES.get(observation.cause!) ?? ''}`,
  ).join(' ');
  const details = reject.map((observation) => `${short(observation)}: ${observation.details}`).join('\n');
  return { reasoning, coaching: `${REPAIR_COACHING}\nHost observation:\n${details.slice(0, 6000)}` };
}

/**
 * A suite that produced no result for a cause the child may control (an
 * uncopyable workspace, or a runner that ended without a valid report):
 * coached once, then reviewed.
 */
export function parentTestNoResultFinding(result: Pick<Result, 'parentTests'>): ParentTestFinding | null {
  const { rejectOnce } = parentTestFindings(result);
  if (rejectOnce.length === 0) return null;
  const once = rejectOnce.map((observation) => ({ observation, ...ONCE_CAUSES.get(observation.cause!)! }));
  return {
    reasoning: once.map(({ observation, what }) =>
      `the parent-owned suite ${short(observation)} ${what}: ${observation.cause} (${observation.details.slice(0, 300)})`).join(' '),
    coaching: [...new Set(once.map(({ coaching }) => coaching))].join('\n'),
  };
}

/** A suite that did not run for a host cause: a fact for the full review, never a rejection. */
export function parentTestReviewFinding(result: Pick<Result, 'parentTests'>): ParentTestFinding | null {
  const { review } = parentTestFindings(result);
  if (review.length === 0) return null;
  return {
    reasoning: review.map((observation) =>
      `HOST FACT, not a heuristic lead: the parent-owned suite ${short(observation)} did not run (${observation.cause ?? 'cause not reported'}); ` +
      'see the PARENT ACCEPTANCE TESTS host block').join(' '),
    coaching:
      'It established nothing. Judge its requirement only on the other host evidence; approve only what that evidence establishes; ' +
      'name the suite as unverified.',
  };
}

/**
 * The safety net where a verdict meets a result: `superviseLoop` (any
 * Supervisor, a mock included) and L2's compiled-script dispatch. A real L2
 * or L3 has already applied the same mapping through its result gates, so
 * this changes nothing there; a supervisor that approves past a rejecting
 * observation is overruled, and one that approves past a suite that did not
 * run has its credit withheld.
 */
export function withParentTestConsequences(result: Pick<Result, 'parentTests'>, verdict: Verdict, logger?: Logger): Verdict {
  if (!verdict.approved) return verdict;
  const findings = parentTestFindings(result);
  const rejection = parentTestRejection(result);
  if (rejection) {
    logger?.warn(`[parent-tests] an approval past a rejecting parent-owned suite was overruled: ${rejection.reasoning.slice(0, 300)}`);
    return { approved: false, reasoning: rejection.reasoning, scope: 'ephemeral', modifications: { additionalContext: rejection.coaching } };
  }
  return findings.rejectOnce.length > 0 || findings.review.length > 0 ? { ...verdict, parentTestsUnverified: true } : verdict;
}

/**
 * Called where an approval returns a result upward: the supervisor directly
 * above has judged every observation the result carries, so no tier above
 * judges them again (the `declared-unverified` precedent, review 2026-10-10).
 * They stay visible to it, as context.
 */
export function markParentTestsJudged(result: Result): Result {
  if (!result.parentTests?.length || result.parentTests.every((observation) => observation.judged)) return result;
  return { ...result, parentTests: result.parentTests.map((observation) => observation.judged ? observation : { ...observation, judged: true as const }) };
}
