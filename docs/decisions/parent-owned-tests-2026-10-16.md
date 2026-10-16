# Parent-owned acceptance tests and parallel branches

L3 decomposes software work into independent L2 branches whenever the task
permits. Each branch receives an acceptance contract. L2 proposes executable
contract tests for its L1 tasks; L3 reviews the complete L2 plan, including the
test sources, before that branch executes. Independent approved branches can
advance without waiting for unrelated reviews.

Plans use the existing aggregation modes. With `concat` or `llm-synthesize`,
`dependsOn` names zero-based earlier subtask indices. All ready tasks start
concurrently. An integration task names the branches it consumes; it receives
their results and output paths. `sequential` remains appropriate for genuinely
coupled work. File ownership and actual dependencies must justify ordering.
The scheduler does not infer independence from prose. Parallel root plans retain
the existing limitation that durable phase checkpoints require sequential mode.

Each implementation subtask can carry `acceptanceTests`: a requirement, a
project-relative `cwd`, and one TypeScript Vitest source. The source imports
application code relative to that project root. A plan-level suite checks the
joined result. Inspection, non-code work, and requirements needing other probes
retain semantic review; no keyword detector fabricates test obligations.

The approved source stays in host-owned task data. L1 can read its contract and
add application tests, but cannot replace the reference by writing workspace
files or claiming a passing result. A changed L2 plan or suite is reviewed
again. An identical previously approved plan under the same task, child and
tool context reuses its review. Trust and Decision never replace test-plan
review, nor the semantic result review following these suites.

The shared supervision loop invokes a fixed runner after execution and before
credit. Fallbacks and compiled recipes use the same verification. The runner is
an authorized host replay of a parent-owned harness, not a supervisor tool. The
parent may revise an incorrect test only by proposing a requirement-backed plan
revision. Passing a suite establishes its assertions, not untested requirements
or correctness after later edits.

Every observation carries a typed status and cause, and `src/core/parentTests.ts`
alone maps them to a consequence; the result-gate rows and the loop's safety net
for any other supervisor are projections of that one mapping:

- A failed suite, and one the code under test kept from finishing (a hang that
  used the child's full 120-second window, a rewritten suite file, a report
  path replaced by something other than a file, a report over 8 MiB, a changed
  assertion machinery),
  rejects mechanically at every tier, at compiled dispatch and at root acceptance.
  The rejection names the failing assertions, so identical failures escalate and
  progress does not.
- A suite content the child controls may have kept from a result is coached
  once, then reviewed: the workspace could not be copied (a link leaving the
  project, a special file, an entry whose permissions refuse the workspace
  owner), or the runner ended without a valid report (an exit without a report,
  an invalid report). Measured on the real runner (third review): Vitest
  intercepts `process.exit` in imported code and reports it as a failed run;
  only a killed or signalled process or one out of memory ends without a
  report, which code under test can cause as well as a host crash can.
- A red run with no failing assertion (an unhandled error or rejection after
  the assertions, a skipped test) is a failed run that names its cause in the
  rejection, from the coordinator's own record of each unhandled error.
- A suite that did not run for a cause only the host owns (no executor, a
  missing worker, a runner error, a snapshot over its bounds or one that
  outlived the window, a child window the run deadline or a slow copy cut
  below 120 seconds, a landing) never rejects: it forces a
  full review, which decides on the other host evidence.
- No suite that did not pass grants atom trust, skill credit, distillation,
  promotion or durable continuation.
- Without root acceptance (a run without depth routing), any suite nobody below
  judged that did not pass refuses the delivery.

Observations are typed `Result.parentTests` entries, never summary text: until
this change a prefix hid the banners the result gates read at the head of a
summary. They reach validators only as the bounded host block
`== PARENT ACCEPTANCE TESTS (HOST-OBSERVED) ==`, outside the child's RESULT,
with every child-controlled string encoded. The supervisor directly above
judges them once and marks them judged; tiers above see them as context. A
passing run of the same suite that the host OBSERVED later (`observedAt`, set
when core records it) supersedes an earlier failure; record order decides only
for records that carry no clock. A parallel aggregate lists its branches in
subtask order, so a pass that ran first on an older workspace sat after a
sibling's later failure and hid it (third review). Parent tests
no longer write `Result.refusal`; a landing keeps its unfinished phase. Durable
resume does not carry observations: completed phases are historical context.
The persisted run result keeps them without source or child output. Every
display reads them through one projection, whose contract lives in
[src/contracts](../../src/contracts/AGENTS.md#parent-test-records).

**New reading, decided 2026-10-16.** The owner delegated this choice and it
was taken on the evidence below. This document first said "failed or
unavailable tests cannot grant acceptance". A suite that did not run for a host
cause now leaves the decision to semantic review: root acceptance can approve
the delivery on its other evidence, and it can then be published. Rejecting a
result its child cannot repair would be the wrong gate the repository forbids;
before this change a molecule spent its whole retry ladder on a missing worker
or a crashed runner, coached to repair an implementation nothing had judged. The unverified suite stays visible as the
`parent-acceptance-tests-unavailable` gate in the acceptance record, and it
still grants no credit. Review:
[parent-test fixes](../../records/reviews/parent-tests-review-fixes-2026-10-16.md).

`run_shell` exposes the deterministic `atoma-verify` utility without adding an
element. Atoma supplies the suite, copies the project to a temporary directory,
and uses its own pinned Vitest and configuration. Application scripts and Vitest
configuration do not run. The runner records source and workspace digests, counts,
and assertion outcomes. It rejects empty, skipped, focused, failed or incomplete
runs and cleans its process group and temporary copy.

This runner supports Node module and in-process API tests; what a suite may
rely on is stated once, in `PARENT_TEST_RUNNER_SCOPE`
([src/contracts/parentTests.ts](../../src/contracts/parentTests.ts)), which the
planning text and the delegation review both read (run 7a7af324: the review had
not been told, and demanded a suite drive a browser). Test
workers cannot spawn processes, create further workers, load native addons, or
access the live workspace through Node filesystem APIs. The existing container
is the OS boundary; Node permissions are defence in depth, not a replacement
for that boundary. Network policy remains the worker's policy; suites must mock
external services. Browser interactions and CLI process behavior still use
their existing probes. Project dependencies must already be installed.

The copy is a bounded, asynchronous snapshot: at most 100,000 entries, depth
128 and 512 MiB, links recreated inside the copy and never followed, and one
deadline for the copy and the run together. Core grants that deadline the
child's 120 seconds plus 60 for the copy; the child never gets more than 120
and reports the window it had (`windowMs`), so a hang is blamed on the code
only when it had all of it. Over its bounds, or past the
window, it is unavailable, not a pass. Unreachable links are skipped and files
that kept changing are copied as last read; both are counted in the details.
Generated harness files exist only in the disposable copy.

No project code runs in the coordinator, the process that loads Atoma's native
compiler and writes the report.

**The assertion-integrity guard (G2, 2026-10-16).** Code under test runs in
the same Vitest thread as the suite, so it could forge a pass: replace a
matcher, patch `Object.is` or an iterator, return an object with an
`asymmetricMatch` method, or plant one on `Array.prototype` (review F6). A
host-written Vitest setup file, `src/tools/parentTestSetup.ts`, loads before
the suite module and therefore before any code under test. It locks the
framework objects (the Assertion prototype, the matcher tables, `expect`,
`test`, `describe`, `vi`, each test's own `expect`), wraps every matcher, and
before and after each one checks the built-ins equality reads
(`src/contracts/assertionIntegrity.ts`, present or absent) and scans the
actual value and the arguments for asymmetric matchers Vitest did not make.
`expect.extend` ignores a built-in name, tags a new name taken first with
different text, and refuses custom equality testers and snapshot serializers.
A violation throws a tag carrying a per-run nonce; the host reads it, from
the report or the coordinator's stderr, as `assertions-tampered`, which
rejects. The flag is sticky: a violation the code catches still fails the
file. Two nonces travel on the coordinator's stdin, never argv or env, and
leave the thread's provided context before the suite loads: only the setup's
own nonce, which no closure keeps, can produce `runner-error`, and only with
zero tests; a run whose guard never reported ready is a `runner-error` too,
never a pass. The cost, measured: `toBe` 22 µs against 4 µs unguarded,
`toEqual` on 3,000 nodes 0.79 ms against 0.37 ms.

The parent's own use of what the guard refuses is refused earlier, at plan
time and zero tokens, by the mechanical half of the delegation review
(`src/atoms/parentSuiteCheck.ts`): custom equality testers, snapshot
serializers, file snapshots, hand-made `asymmetricMatch` objects, an
`expect.extend` of a built-in name or of one name twice, and `vi.spyOn` on a
watched built-in. The child is never rejected for the parent's choice. Vitest
runs with `update: 'none'`, so a missing inline snapshot fails and none is
written, and the host removes a child-written `__snapshots__` before the run.

What a determined adversary can still do (the one list; other documents link
here):

- Rewrite the runner's records: `afterEach(ctx => ctx.task.result.state =
  'pass')`, `__vitest_worker__.rpc`, or Vitest's own modules imported by path
  (`@vitest/runner`, `@vitest/snapshot`).
- Stateful evasion: a Proxy, getter or iterable that shows the scan an honest
  value and `equals` a matcher; a forgery installed and removed inside one
  `equals` call; a node past the scan budget of 10,000 keys and nodes.
- Mutate a mock passed into the code under test, for example its `mock`
  record.
- A value a matcher obtains itself and the scan never sees: the error
  `toThrow` catches from the function under test.
- Expected values taken from the code under test (`toEqual(app.DEFAULTS)`)
  that are honest objects of the wrong value: semantic, not mechanical.
- Built-ins outside the watched set, re-derived on each Vitest bump.
- Read the suite file and register its custom matcher's exact text first: the
  guard reads the same text as a re-registration.
- Leak the guard nonce: that can only produce a rejection.

False alarms that remain: a forced polyfill replacing a watched built-in, and
a value under test that is itself an asymmetric matcher, unless it is checked
with the identity matchers (`toBe`, `toBeDefined`, …). The details name the
property in both cases. The container and semantic review of the imported
modules remain the real defence: F6 is narrowed, not closed.

A process outside the suite can also change the copy (third review). The copy
lives in the worker's temporary directory, owned by the uid every tool child
runs as, and Node permissions confine only the Vitest child: a server the L1
started with `start_node_server`, which outlives its execute, or a parallel
sibling's `run_shell` can rewrite `atoma-acceptance-*/project` between the
snapshot and Vite's import. The suite then runs bytes the live workspace does
not hold while `workspaceDigest` names the live ones, and the forging code sits
in a file the suite never imports, so semantic review of the imported modules
does not see it. Stopping the phase's servers before the snapshot was not done:
later probes and phases rely on them. Closing it needs the copy outside that
uid's reach (a separate uid or mount namespace for the runner), which the
worker image does not provide today.

A runner killed hard (`SIGKILL`, an OOM) used to leave its copy and its
coordinator behind. The coordinator now exits when its stdin pipe from the
runner ends, or at its window plus 5 s. Copies are named
`atoma-acceptance-<pid>-…`; the first verification in a process sharing the
temporary directory removes, in the background and at most 32 at a time,
copies this user owns whose process is dead and which are at least 10 minutes
old. Bounded, not closed: a copy waits for a later verification. A copy the
code under test left a directory in without the owner's write bit is removed
too: the owner restores its own access first (third review). After the run the
owner also takes back the copy root, the suite file and the report before
reading them, so a `chmod` by the code under test reads as a changed suite or a
tampered report, never a host `runner-error`; the suite file is compared by size
before it is read.

Unsupported, each an honest red rather than a pass:

- Vite or Vitest configuration, plugins, `setupFiles`/`globalSetup`, jsdom or
  browser environments.
- CSS processing and hashed class names: stylesheets load as empty stubs.
- `?worker` imports, native addons and subprocesses inside tests.
- Aliases defined only in `vite.config`, and a tsconfig whose `extends` leaves
  the project. A suite's own bare imports resolve as the application modules it
  imports resolve them (project source named by a tsconfig `paths` alias beats
  a package of the same name), then through each root `tsconfig*.json` as data,
  `tsconfig.json` first, with a host note when another one decided. A
  resolution outside the copy is refused.
- Hard links to files outside the project are still copied as bytes; inside
  the container none can be created (`EXDEV` across the workspace mount).

Review: [group C-runner](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#group-c-runner--asynchronous-snapshot-no-project-code-in-the-coordinator),
[G2](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#follow-up-matcher-forging-leftover-copies-suite-aliases).

## A failed branch lands; its dependents do not start

A branch that declares `dependsOn` starts once its own producers settle. Until
the 2026-10-16 review, a producer that failed its checks made its dependent
throw, the parallel dispatch rethrew that error once its siblings settled, and
the whole run failed: completed branches were discarded and the workspace seeded
nothing. That was the 2026-09-21 loss again, this time with the clock still
running. Under "one ladder per root phase, judge what exists", the producer is
now kept and judged like any work in hand, and its dependents land unstarted.

`dependencyBlocker` (`src/atoms/dispatch.ts`) reads typed fields only. It never
reads `refusal`, the summary or the `[PHASE LADDER SPENT` prefix. It enforces
typed failure, not acceptance:

- **Any producer whose suite rejects** blocks its dependents. Rejecting means
  `parentTestConsequence` is `reject` (a failed suite, or one the code under
  test kept from finishing) and no later pass of that suite superseded it.
- **A producer that landed** with phases a typed failure held back
  (`blockedPhases`) blocks its dependents. One that landed on the run budget
  alone (unfinished phases, none held back: the phase floor declined a phase
  while the clock still ran) blocks nothing: its dependents settle unfinished,
  like any phase the budget did not reach (`landedOnBudget`; third review).
  Every reader of `blockedPhases` says a check failed, and none had.
- **An unapproved producer with any unjudged suite that did not pass** blocks
  its dependents. Unapproved means the dispatcher's own fallback (`viaFallback`
  under the dispatcher's name) or a root phase handed up spent.
- **An approved producer whose suite did not run for a host cause** does not
  block. Its approver weighed that suite.
- **An unapproved producer with a passed suite, or no suite,** does not block.
  This matches sequential mode, and the root judges the whole result.

Blocking is transitive and has no wave barrier: each dependent decides as soon
as its own producers settle. A dependent behind a held-back branch is held back
behind the same root causes. Held-back branches are listed in `blocked` with
an entry naming their prerequisite by description. `markLanded` adds each entry
to `unfinishedPhases`, so `isLanded` and every existing reader see a landing,
and to `blockedPhases`, so readers that explain a landing can tell a held-back
phase from one the clock cut. A budget-only landing is byte-identical to
before. A producer that threw still fails its dependents and the dispatch. The
deadline keeps its own semantics: a dependent decided after the deadline is
unfinished, not blocked. The refusing producer is always among the results, so
a dispatch that completed no phase still never lands. Sequential dispatch is
unchanged and never blocks.

**Under a root phase.** At L2, every possible blocker is the cell's own
fallback: an approved molecule cannot carry a rejecting suite. That fallback
carries the stamp the supervise loop writes where a ladder ends
(`spentLadder`), and the cell's aggregate keeps it (`withSpentLadder`), so
`ladderSpent` reads it. Since G3 (same day; the field was first
`ownFallbackBlockedBy`, derived from the landing) the plan's shape no longer
matters, a landing included or not: `[A, B dependsOn A]`, `[A, C, B dependsOn
A]` and `[A, C]` alike, and a phase the cell mutualized to a peer whose
fallback ran (`relayPeerLadder`). The tissue that refuses that phase hands the
whole phase up once (`phaseBudgetSpent`), with no second run of the cell's
ladder — when, and only when, root acceptance will judge the run
(`RunContext.rootAcceptance`, set by depth routing); without a root judge it
retries the phase as before. In short mode a tier-2 fallback deepens before it
runs, so no cell lands this way there.

**At the root.** Every dependency landing carries an observation that did not
pass, and the refusing producer is kept, so the root's reject gate usually
refuses the landing mechanically. Depth then opens its one extra root pass.
Since G1 (same day) it opens that pass for an APPROVED dependency landing too,
when the landing is pure (the budget left no phase unfinished), the attempt is
deep, and a pass and the clock remain. The pass carries
`inputs.rootDependencyLanding`, built from typed fields only:

- the phases that never started;
- the suites that did not pass;
- a fixed instruction that depends on the verdict and never names it. After a
  refusal: repair the failed phase against its suite, then complete the phases
  that never started. After an approval: complete the phases that never
  started and re-run a listed check rather than rebuilding kept work, or, with
  no check listed, complete them without rebuilding kept work.

After an approval the pass hears no refusal and no single-criterion scope, and
keeps every criterion: a landed approval's criterion judgements are never
checked against coverage, so filtering on them could drop the criteria of the
phases that never started. A refused dependency landing gets no
single-criterion scope either, since "keep the deliverables" contradicts
"complete the phases that never started".

If no pass is left, or the wall clock cannot pay for one, a refused landing
ends refused and `partial`, and an approved one ends `partial`; either way its
workspace seeds the next run. Every exit after a judged pass lands on it: an
extra pass the deadline cuts, or one that fails on its own, returns the earlier
pass's result (refused, or approved with the follow-up's planned phases added
as unfinished and unverified), and an acceptance of the extra pass that fails
keeps that pass's work refused. Deepening, a `PhaseBoundaryPause` and an
explicit cancellation still end the attempt; a cancellation during the extra
pass forfeits the seed, because the runner's teardown records `cancelled`
whatever the depth runner returns.

A dependency landing that reaches a validation call hears
`DEPENDENCY_LANDING_GUIDANCE` instead of the budget-landing block, and it is
never approved mechanically. Without a run deadline, a pure dependency landing
is not capped by the landing window, because it happened with the clock
running. Lessons follow the last verdict on the work they came from: an
approved landing's lessons are held, then saved with the extra pass's in the
run's one enqueue when it is approved (ties go to the later pass, otherwise the
longer feedback wins), saved alone when it ends with no verdict, and dropped
when it is refused. Parallel root plans keep no durable checkpoint, so the next
run continues from the workspace and from the landing reasons.

**Choices recorded with this change** (decided 2026-10-16 under the owner's
delegation; (b) was reversed the same day, G1):

- **(a)** A spent semantic refusal whose suites passed, or which has no suites,
  feeds its dependents, as before and as in sequential mode. The alternative,
  blocking it, needed a depth rule that opens the extra pass for an approved
  result with `blockedPhases`; that rule now exists (b), so re-deciding (a) is
  open and needs evidence that such a producer misleads its dependents.
- **(b)** REVERSED (G1). An approved dependency landing used to end `partial`
  and forfeit the remaining budget, like an approved budget landing. But its
  dependents never started while the clock still ran, which is not the budget
  landing's situation: the 2026-09-21 cost argument ("the cheaper error is to
  try") applies, and ending forfeited exactly the budget that could run them.
  It now opens the run's one extra root pass under the conditions above. The
  pass inherits `outOfPhaseBudget`'s 60 s floor, which was measured for opening
  one phase, not a root pass (replan, delegation review, a phase, acceptance);
  the run counter `unjudgedRemediations` counts every extra pass that then
  ended without a verdict, and a root-pass floor gets proposed when that
  counter and the trace corpus can size it.
- **(c)** An unapproved producer with no suite does not block.
- **(d)** Customer copy: "A step of this run did not pass its checks, so the
  steps that depend on it were not started." It is written in English only;
  CI translates it.
- **(e)** The analyst's definition of `partial` names this case and, since G1,
  when an approved one still ends `partial` (prompt version
  `p10-2026-10-16-landing-remediation`).

Review:
[parent-test fixes, group B](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#group-b--a-refused-dependency-lands),
[follow-up G1](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#follow-up-an-approved-dependency-landing-with-budget-left-opens-remediation).

## Mandatory planning review and discovery

The first Attica trial exposed a missing admission boundary: a root plan could
promise later tests and review in prose while its actual implementation branch
carried no executable suite. L3 root plans now receive a mandatory tool-free
review before dispatch. The reviewer classifies every
subtask and integration as Vitest-testable, inspection, or another proof method,
and states whether useful independent work exists. The host requires complete,
unique indices and refuses missing classified suites or a serial plan when the
review identifies independent work, even beside an affirmative verdict. Scope
classification and test quality remain semantic judgments, not file-extension or
keyword detectors. Non-code work and browser/process checks retain their own proof.

A rejected root plan gets bounded planning repair (five candidates total since run
d37d2f8f, whose three sound and narrowing refusals ended it one round short), not
unreviewed execution or direct fallback. Each refusal reaches the planner with
the requests it made, and every later review reads the earlier refusals of the
delegation: one that still stands refuses again only when it is a blocking suite
defect (`PARENT_TEST_BLOCKING_DEFECTS`) or breaks another rule of the review;
any other gap is named in the reasoning and does not refuse. A suite is
sufficient by `PARENT_TEST_SUFFICIENCY`: real module imported and called,
exact values, a negative case, able to fail on what the task or its criteria
name; it need not cover cases the task never asks for. Runs 7a7af324,
aaa6b442 and 63feeb3c (2026-10-16) refused all nine root plans and executed
nothing; in two of them a round refused the plan for requests the root had
never forwarded. L2 plans under parent suites receive the
same contract check within the existing L3 review, including trusted cells. Exact
approved-plan reuse remains; changed contracts are reviewed again.

**The root review runs on tier 2** (`modelForTier(2)`), with its own parameters,
`ROOT_DELEGATION_REVIEW_PARAMS`: its own 8,000-token cap (`PLAN_REVIEW_MAX_TOKENS`,
a cap that includes adaptive thinking) and `effort: 'medium'`. It and the child re-review below are the only validators with
an effort pin. The ground is the cost rule's own: three refusals end the run with
nothing delivered, each refusal costs a top-tier replan, and the review judges
test-source quality, which is code review rather than a bounded yes/no. Root
acceptance of a recorded text plan already rides tier 2 for the same reason.
Child-plan reviews run on the validation model: their refusals stay inside
`superviseLoop`'s budget and cost a tier-2 replan. Only a child review that
failed as the reviewer is re-reviewed UP on tier 2 with these parameters, the
opposite direction to the root, which re-reviews DOWN on the validation model.

Typical cost, at catalogue prices (Sonnet 5 $2/$10 per M input/output, Haiku 4.5
$1/$5, Opus 5.5 $4/$20): about $0.03–0.05 per root review against about $0.02 on
Haiku. Upper bound per tier-2 review: about $0.04 of input for a 15–20k-token
plan plus $0.08 for the whole 8000-token output cap, so about $0.12; per run,
three reviews, about $0.36, and less in practice because a re-review after a
root reviewer fault runs on Haiku and the calls share a warm cache. Child
re-reviews add at most two tier-2 reviews per supervise cycle
(`MAX_PLAN_REVIEW_FAULTS`), each bounded like a root review (about $0.12), and
a cycle that hands the phase up after them is not branched: at most about
$0.24 per cell, or $0.48 when an earlier judged escalation already branched it. One avoided Opus
replan saves up to about $0.16; three avoid a run that delivers nothing (run
fec4ef6a: $0.32 in 165 s, no delivery).

**A reviewer fault is not a plan fault.** The host types each refusal
(`delegationRefusal: 'reviewer' | 'plan' | 'fan-out'`, never parsed from model
text). A review cut by its cap, an unparseable verdict, an approval without its
classification or with incomplete or duplicate indices is the reviewer's
failure: the SAME plan is reviewed again on the validation model with
`VALIDATION_PARAMS`, with no new plan call. Enforcement runs on whichever review
approves. Only a plan or fan-out refusal asks for a new plan. Under an L2
plan, a second reviewer fault (after the tier-2 re-review) returns to
`superviseLoop` as a `reviewer` refusal: no coaching, no repeat streak, no plan
iteration spent, traced as `plan-review-fault` rather than a refused
`verdict-plan`, and the plan is asked again. After `MAX_PLAN_REVIEW_FAULTS` (2)
the parent takes over with no trust failure recorded and no branch created
(escalation phase `review`). Counted on the plan budget (three by default),
three faults escalated, blamed and branched the child exactly as the coaching
had (third review). It never throws: one flaky reviewer must not end a run.
The same holds for a plan budget spent on unparseable replies alone: nothing
judged the child, so it is not blamed or branched.

**An unparseable root plan spends an attempt.** The reply is read exactly as
written (`parsePlanPair`); malformed JSON, a schema mismatch, or a reply that
only a truncation repair would complete raises `PlanParseError`, and the next
attempt is asked with the parser's message and an excerpt around the position.
A reply cut at `max_tokens` is asked to be shorter. The bad reply is never
reviewed. The message travels on the planner-feedback channel, the third
argument of `Atom.plan`, rendered in the strategy prompt under
`PREVIOUS PLAN ATTEMPT:`; it is never merged into the task's constraints, which
the prefilter's cache key hashes and children inherit (see Plan size below). The same parser serves L2 plans, which `superviseLoop` now asks again,
and the SHORT root, which gets the same three attempts. The planning guidance
tells planners how to write a test source inside a JSON string.

One salvage is admitted: raw control characters inside strings are escaped, and
the result is kept only if the whole pair then parses with no repair and both
schemas accept it. It is lossless, since the decoded string is the characters the
model wrote. Doubling invalid escapes, inferring unescaped quotes and executing a
repaired pair were refused: each would author contract bytes on the model's
behalf. Refusing repaired L2 and L3 pairs revises the 2026-08 truncation defence
(placeholder plans, closed strings) for plan pairs; L1 keeps `parseWith`'s repair.
`parsePlanWithFallback` is unchanged: in fallback mode the suite rides the task
and the supervisor's own run wrapper verifies it.

When interfaces are unknown, L3 may emit `replanAfter: true` on an inspection-only
plan without outputs. The host executes it read-only, joins its branches itself
(no synthesis call), then asks L3 for a new plan with each branch's own report
(an equal share of 24,000 characters), the observed tool evidence and the
original task. Run d37d2f8f (2026-10-16) showed why: the L3 synthesis dropped
the interface a branch had read, and the replan, barred from inspecting again,
planned suites against invented adapters. Only one discovery
round is allowed. It is not registered as a completed implementation checkpoint,
so the new plan never skips its first branch. DAG checkpoint support is unchanged.

**Resume does not re-judge a recorded approval** (decided 2026-10-16 under the
owner's delegation; older binaries read a checkpoint carrying the record as
incomplete, which destroys nothing and is accepted).
The approval is saved with the checkpoint's root plan, in the same write:
`{ digest, from, review }`. The digest binds the review contract text, a hash of
the validation system prompt, the reviewing model selector, `from` (the first
subtask reviewed), the plan as a checkpoint restores it, the task's inputs,
description, criteria and constraints, and the root actor's name, id and
version. A resumed root whose record still binds (against either current
reviewing pin) re-runs the host's mechanical enforcement over the recorded
classification, at zero tokens, and executes; a model that approved a plan can
no longer refuse it on resume. A checkpoint without a record (older ones), or one
whose digest no longer matches, gets today's review of the remaining work. A
refused legacy plan, like a client answer, gets a bounded replan of the remaining
work only: a sequential suffix, merged after the kept prefix, reviewed again,
five attempts in all. A fan-out refusal on resume ends the run at once:
checkpoints are sequential, so replanning cannot satisfy it. Every resumed branch
records the plan before executing it, so phase counting and
`--pause-after-phase` are unchanged.

Incident and adversarial controls: [Attica planning review](../../records/reviews/attica-delegation-contract-2026-10-16.md);
critical review and fixes: [parent-test review fixes](../../records/reviews/parent-tests-review-fixes-2026-10-16.md).

## Plan size

Plans carry whole TypeScript sources inside JSON strings, so a root or L2 plan
with several suites outgrew the 8,000-token plan cap, and since a cut reply is
refused rather than executed, such a plan failed every attempt. Decided
2026-10-16 under the owner's delegation (review record, group G4).

**Measured** with tiktoken (`cl100k_base`, `o200k_base`) on plausible replies
for a TypeScript notes app; the Claude figure applies an ASSUMED ×1.35 upper
bound, not a measurement. Escaped test code runs at 3.2–3.3 characters per
token, so characters/4 undercounts it by about 20%.

| Reply | chars | cl100k | o200k | Claude (≤×1.35) |
|---|---|---|---|---|
| Root, 5 branches, 4 focused suites (1.5–3.4k chars) | 14,346 | 4,070 | 4,158 | ≤5,500 |
| Root, 7 branches, 6 thorough suites (3–7k chars) | 32,618 | 9,728 | 9,990 | ≤13,100 |
| L2, 3 subtasks with suites | 10,582 | 2,997 | 3,069 | ≤4,050 |
| One suite at the stored bound (32,000 chars) | ~32,600 | 10,024 | 10,285 | ≤13,500 |
| One suite at the 8,000-character target | ~8,150 | 2,440 | 2,498 | ≤3,300 |

Adaptive thinking counts against the cap too, and how much a plan call thinks
at `effort: 'medium'` is unmeasured.

**One plan cap, 16,384 tokens** (`STRATEGY_MAX_TOKENS`), for every L2 and L3
plan call. Nothing known before the call says whether the reply will carry
suites, so there is no per-plan selection, and starting at 8,000 and raising
after a cut was rejected: a cut is the common case for plans with suites, and
each wastes a whole reply. 16,384 is what the transports send when a caller
names no cap, and it stays under the Anthropic SDK's non-streaming ceiling
(21,333 tokens; 8,192 for the dated Opus 4 and 4.1 ids, all retired). It is a
cap, not a target: a plan that fits in 8,000 costs what it did.

**The plan reviews keep 8,000** (`PLAN_REVIEW_MAX_TOKENS`): the root review and
the second attempt of a child-plan review. That value is UNMEASURED and grows
with plan size (one disposition per subtask, thinking over every suite); it is
not raised because caps are raised only after an observed cut, and it keeps the
$0.12 bound per review above true.

**Three suite bounds.** The stored and executed bound stays 32,000 characters
(`PARENT_TEST_SOURCE_MAX_CHARS`, on `parentTestSuiteSchema`): checkpoint
restore, the approval digest, the worker, core's observation mapping and the
run report all parse saved plans with it, and a lower one would make a
checkpoint saved before the change throw on resume. A suite written NOW is
refused over 12,000 characters (`PARENT_TEST_AUTHORED_SOURCE_MAX_CHARS`), by
`parsePlanPair` only, after both schemas accept; that is the budget that keeps
a new suite whole in a phase block. The planning text and the review rule ask
for under 8,000 (`PARENT_TEST_SOURCE_TARGET_CHARS`), more than twice the largest
focused suite measured; the gap to the hard bound absorbs a reviewer's request
for more cases. A bound on a plan's TOTAL suite size was rejected: a reply that
completed within the cap has proven it fits, and every downstream budget is per
suite. The refusal names each suite by zero-based index and length and costs
one full reply, like a cut.

**Suites are self-contained.** Each is written alone into a disposable copy,
and branch suites run when their branch finishes, before the join. The planning
text says so, asks each suite for its own branch's contract only, and the cut
message no longer advises sharing fixtures through the integration suite. No
guidance asks for fewer subtasks, which would contradict the mandatory
parallel delegation; a reviewer asks for a branch to be split rather than for a
longer suite.

**Typed refusals and the feedback channel.** `PlanParseError` carries its kind
(`syntax`, `unbalanced`, `truncated`, `schema`, `suite-size`) and its own
`feedback()`; only the two JSON-syntax kinds are told how to escape. The
`plan-unparseable` trace entry records the kind as `cause`. `superviseLoop`, the
SHORT root and the L3 root pass that feedback to the next plan call on the
channel above, so a retry reaches the prefilter as the same request (a cache
hit, and no new L2 short-circuit verdict). At the L3 root the channel carries
every review refusal so far, each with its requests, and the latest parse or
precheck message together, so a size refusal does not erase what the reviewer
asked for.

**Cost.** Output at the cap, per call: Fable 5.1 $0.40 → $0.82, Opus 5.5 $0.16 →
$0.33, Sonnet 5 $0.08 → $0.16. Worst case per run, every call at its cap: the
root makes up to 7 plan calls (two planning rounds × 3 attempts, plus one
collision replan), $1.12 → $2.29 on Opus and $2.80 → $5.73 on Fable; an L2
branch up to 6 (2 cycles × 3), $0.48 → $0.98 on Sonnet, multiplied by branches.
A plan that fits in 8,000 costs the same as before, and one between 8,000 and
16,384 now costs one complete reply instead of three wasted ones and a failed
root. A resumed run after the deploy pays one extra root review (≤ $0.12): the
review rule changed, and the system prompt is in the approval digest. A plan
call can take up to twice as long; the SDK's non-streaming timeout stays 10
minutes against an expected 7.7 at the cap.

**Known limits.** Thinking volume and Claude's token ratio are unmeasured, so a
plan with seven or more thorough branches can still be cut; it is then asked
again with feedback. The output ceilings of non-Anthropic models eligible for
L2 and L3 are unchecked; one below 16,384 would answer with a transport error.
Decision's view of a plan (`JEV_STATE_CHARS.plan`, 20,000 characters) already
cuts the largest plans. The collision coaching in `l3RootPlan.ts` still rides
the task's constraints. The 32,000-character stored bound can be lowered once
no checkpoint from before the change can resume.
