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
  used the full 120-second window, a rewritten suite file, a report over 8 MiB),
  rejects mechanically at every tier, at compiled dispatch and at root acceptance.
  The rejection names the failing assertions, so identical failures escalate and
  progress does not.
- A suite the workspace content kept from being copied (a link leaving the
  project, a special file) is coached once with the path, then reviewed.
- A suite that did not run for a host cause (no executor, a missing worker, a
  runner error, an exit without a report, an invalid report, a snapshot over its
  bounds, a window the run deadline cut, a landing) never rejects: it forces a
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
later passing run of the same suite supersedes an earlier failure. Parent tests
no longer write `Result.refusal`; a landing keeps its unfinished phase. Durable
resume does not carry observations: completed phases are historical context.
The persisted run result keeps them without source or child output.

**New reading awaiting owner confirmation.** This document first said "failed or
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

This runner supports Node module and in-process API tests. Test workers cannot
spawn processes, create further workers, load native addons, or access the live
workspace through Node filesystem APIs. The coordinator loads Atoma's installed
native compiler. The existing container is the OS boundary; Node permissions are
defence in depth, not a replacement for that boundary. Network policy remains the
worker's policy; suites must mock external services. Browser interactions and CLI
process behavior still use their existing probes. Project dependencies must
already be installed. A snapshot over 100,000 files or 512 MiB is unavailable,
not a pass, and so are the other host causes above. Generated harness files
exist only in the disposable copy.

## Mandatory planning review and discovery

The first Attica trial exposed a missing admission boundary: a root plan could
promise later tests and review in prose while its actual implementation branch
carried no executable suite. L3 root plans now receive a mandatory tool-free
review using the validation model before dispatch. The reviewer classifies every
subtask and integration as Vitest-testable, inspection, or another proof method,
and states whether useful independent work exists. The host requires complete,
unique indices and refuses missing classified suites or a serial plan when the
review identifies independent work, even beside an affirmative verdict. Scope
classification and test quality remain semantic judgments, not file-extension or
keyword detectors. Non-code work and browser/process checks retain their own proof.

A rejected root plan gets bounded planning repair (three candidates total), not
unreviewed execution or direct fallback. L2 plans under parent suites receive the
same contract check within the existing L3 review, including trusted cells. Exact
approved-plan reuse remains; changed contracts are reviewed again.

When interfaces are unknown, L3 may emit `replanAfter: true` on an inspection-only
plan without outputs. The host executes it read-only, then asks L3 for a new plan
with bounded discovery observations and the original task. Only one discovery
round is allowed. It is not registered as a completed implementation checkpoint,
so the new plan never skips its first branch. Saved sequential plans are reviewed
for remaining work on resume; DAG checkpoint support is unchanged.

Incident and adversarial controls: [Attica planning review](../../records/reviews/attica-delegation-contract-2026-10-16.md).
