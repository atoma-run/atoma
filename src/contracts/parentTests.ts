import { z } from 'zod';

/** Parent-authored checks; never parsed from a child's result or workspace. */
export const parentTestSuiteSchema = z.object({
  requirement: z.string().min(1).max(4000),
  cwd: z.string().max(240).default('.').refine(p => p === '.' || /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/.test(p), 'Use a relative project directory'),
  source: z.string().min(1).max(32000),
}).strict();
export type ParentTestSuite = z.infer<typeof parentTestSuiteSchema>;

export const parentTestObservationSchema = z.object({
  suiteDigest: z.string(),
  suite: parentTestSuiteSchema.optional(),
  workspaceDigest: z.string(),
  status: z.enum(['passed', 'failed', 'unavailable']),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  details: z.string(),
}).strict();
export type ParentTestObservation = z.infer<typeof parentTestObservationSchema>;

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
export const delegationReviewEnvelopeSchema = z.object({ delegationReview: delegationReviewSchema });

export const PARENT_TEST_PLANNING = `PARENT-OWNED ACCEPTANCE TESTS:
For TypeScript application work, define acceptanceTests on each implementation subtask BEFORE execution:
{"requirement":"the assigned behavior and its observable interface","cwd":".","source":"import { test, expect } from 'vitest'; import { add } from './src/add.ts'; test('adds', () => { expect(add(2, 3)).toBe(5); });"}.
The source is one TypeScript Vitest file placed at the project root in a disposable workspace copy. Use relative imports of real application modules. Node environment only; subprocesses, nested workers and native addons are unavailable inside assertions. Test importable modules and in-process APIs; real browser and CLI process checks remain separate.
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
