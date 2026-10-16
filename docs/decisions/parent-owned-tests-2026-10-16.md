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
credit. Fallbacks and compiled recipes use the same verification. Failed or
unavailable tests cannot grant acceptance or credit; their observations survive
aggregation and reach root acceptance. The parent may revise an incorrect test
only by proposing a requirement-backed plan revision. Passing a suite establishes
its assertions, not untested requirements or correctness after later edits.

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
not a pass. Generated harness files exist only in the disposable copy.

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
