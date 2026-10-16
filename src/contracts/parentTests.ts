import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The Vitest child's own window. Only a hang that had all of it is the code's:
 * the runner caps the child at this, and core reads a timeout in a shorter
 * window (the run deadline or the copy cut it) as the host's.
 */
export const PARENT_TEST_TIMEOUT_MS = 120_000;

/**
 * What core grants the snapshot copy on top of the child's window, under the
 * same one deadline: a copy that takes longer leaves the child a shorter
 * window, and its timeout is then the host's (second review 2026-10-16).
 */
export const PARENT_TEST_SNAPSHOT_ALLOWANCE_MS = 60_000;

/** Parent-authored checks; never parsed from a child's result or workspace. */
export const parentTestSuiteSchema = z.object({
  requirement: z.string().min(1).max(4000),
  cwd: z.string().max(240).default('.').refine(p => p === '.' || /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/.test(p), 'Use a relative project directory'),
  source: z.string().min(1).max(32000),
}).strict();
export type ParentTestSuite = z.infer<typeof parentTestSuiteSchema>;

/** One digest for one suite, computed identically on the control plane and in the worker. */
export function parentTestSuiteDigest(suite: ParentTestSuite): string {
  return createHash('sha256').update(JSON.stringify(suite)).digest('hex');
}

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
  'runner-error', // tools: any other host failure
  'no-executor', // core: no shell executor in this context
  'invalid-observation', // core: the executor returned no valid observation for this suite
  'executor-error', // core: the executor threw
  'landing', // core: the run budget ended first
  'deadline-timeout', // core: a timeout in a child window below PARENT_TEST_TIMEOUT_MS (the run deadline or the copy cut it)
]);
export type ParentTestCause = z.infer<typeof parentTestCauseSchema>;

export const parentTestObservationSchema = z.object({
  suiteDigest: z.string(),
  suite: parentTestSuiteSchema.optional(),
  workspaceDigest: z.string(),
  status: z.enum(['passed', 'failed', 'unavailable']),
  /** Absent from an older worker; read as a host cause. */
  cause: parentTestCauseSchema.optional(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Host text, plus the runner's assertion outcomes when it reported: one valid JSON array then. */
  details: z.string(),
  /** The Vitest child's actual window, set once it is spawned. Absent: a timeout is read as the host's. */
  windowMs: z.number().int().nonnegative().optional(),
  /** The runner's stdout/stderr tail: CHILD-CONTROLLED text, never host fact. */
  output: z.string().max(6000).optional(),
  /** What the host copied before the run. Absent from an older worker and before a copy finished. */
  snapshot: z.object({
    entries: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unstable: z.number().int().nonnegative(),
    ms: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export type ParentTestObservation = z.infer<typeof parentTestObservationSchema>;

/**
 * An observation as the host holds it. `judged` is set by the host when the
 * supervisor directly above approved the result carrying it, never parsed from
 * a worker reply: the wire schema is strict and has no such key.
 */
export type HeldParentTestObservation = ParentTestObservation & { readonly judged?: true };

/** What a persisted run keeps of an observation: no suite source, no child output. */
export interface PersistedParentTestObservation {
  readonly suiteDigest: string;
  readonly workspaceDigest: string;
  readonly status: ParentTestObservation['status'];
  readonly cause?: ParentTestCause;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly judged?: true;
  readonly requirement?: string;
  readonly details: string;
}

export function persistedParentTests(observations: readonly HeldParentTestObservation[]): PersistedParentTestObservation[] {
  return observations.map((observation) => ({
    suiteDigest: observation.suiteDigest,
    workspaceDigest: observation.workspaceDigest,
    status: observation.status,
    ...(observation.cause ? { cause: observation.cause } : {}),
    passed: observation.passed,
    failed: observation.failed,
    skipped: observation.skipped,
    ...(observation.judged ? { judged: true as const } : {}),
    ...(observation.suite ? { requirement: observation.suite.requirement.slice(0, 600) } : {}),
    details: observation.details.slice(0, 1500),
  }));
}

// A reviewer classifies scope; the host checks that every classified requirement
// actually has executable bytes. Never infer testability from prose or extensions.
const testDispositionSchema = z.object({
  kind: z.enum(['vitest', 'inspection', 'other']),
  reason: z.string().trim().min(1).max(2000),
});
export const delegationReviewSchema = z.object({
  subtasks: z.array(testDispositionSchema.extend({ index: z.number().int().nonnegative() })),
  integration: testDispositionSchema,
  independentWork: z.boolean(),
  parallelReason: z.string().trim().min(1).max(2000),
});
export type DelegationReview = z.infer<typeof delegationReviewSchema>;
export const delegationReviewEnvelopeSchema = z.object({ delegationReview: delegationReviewSchema });

export const PARENT_TEST_PLANNING = `PARENT-OWNED ACCEPTANCE TESTS:
For TypeScript application work, define acceptanceTests on each implementation subtask BEFORE execution:
{"requirement":"the assigned behavior and its observable interface","cwd":".","source":"import { test, expect } from 'vitest'; import { add } from './src/add.ts'; test('adds', () => { expect(add(2, 3)).toBe(5); });"}.
The acceptanceTests source is a JSON string: write every backslash as \\\\ (a regex \\d becomes \\\\d in JSON) and escape double quotes and newlines; prefer single-quoted TypeScript strings in test code.
The source is one TypeScript Vitest file placed at the project root in a disposable workspace copy. Use relative imports of real application modules. Node environment only; subprocesses, nested workers and native addons are unavailable inside assertions. tsconfig \`paths\` aliases resolve only inside application modules their tsconfig includes; CSS imports load as empty stubs (CSS-module class names map to themselves and are not checked). Test importable modules and in-process APIs; real browser and CLI process checks remain separate.
L3 assigns criteria, interfaces and tests to EACH L2 branch. L2 proposes contract tests for EACH L1; L3 reviews them with the L2 plan before any L1 starts. Specify branch contracts before parallel implementation.
Plan-level acceptanceTests run after the branches join: L3 owns integration tests in addition to its per-L2 tests. Do not require future branches' behavior in a leaf suite.
Tests must exercise actual code and observable behavior, including relevant negative/boundary cases. Mock external services only; no trivial assertions, implementation replacement, skip/todo/only, hidden requirements or real external traffic.
A source revision is a new plan requiring parent review. Never weaken assertions to obtain green; explain a requirement-backed correction in the plan reasoning. A failing test can be wrong: challenge its contract explicitly.
The runtime owns the suite, runner, configuration and result. Children may add their own tests but cannot replace the parent's suite. No package script/config is used for these checks. Install the application's dependencies before verification.
For non-code work or repository inspection, explain the appropriate evidence in reasoning and omit acceptanceTests; do not fabricate tests. Unknown interfaces do NOT exempt a later implementation branch. At L3, if inspection is necessary first, return an inspection-ONLY plan with replanAfter:true, no outputs, no implementation or final-verification subtasks. The host executes it read-only, then asks L3 for a fresh implementation plan using the observations. Only one discovery round is allowed; never promise a future plan revision in prose. L2 cannot request replanAfter.
Passing tests prove only their assertions; semantic and integration review remain required.`;

export const PARALLEL_BRANCH_PLANNING = `REQUIRED PARALLEL DELEGATION:
Whenever useful independent branches exist, delegate them to distinct child tasks and execute them in parallel; at L3 these are multiple L2 branches, not one L2 hiding all independent work.
Use concat or llm-synthesize with optional dependsOn: [zero-based earlier subtask indices]. A branch starts as soon as all its own dependencies finish; omitted/empty means independent. A join names every branch it consumes. Example: scaffold index 0; modules indices 1 and 2 each dependOn:[0]; integration index 3 dependsOn:[1,2].
Dependencies declare actual data/file prerequisites, never artificial ordering. Shared files, package manifests and interfaces need a single owner or an explicit dependency. Explain genuine coupling when choosing sequential. Branch review must not wait for unrelated siblings.`;
