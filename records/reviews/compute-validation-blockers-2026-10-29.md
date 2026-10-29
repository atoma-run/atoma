# Compute validation blockers: adversarial review — 2026-10-29

Scope: the observed parent module-load failure, contradictory additive exclusion,
filtered-away shell proofs, and the replay's 1M token stop. Previous incidents in
parentSuiteCheck, PARENT_TEST_RUNNER_SCOPE/SUFFICIENCY and the frozen Attica record
were read before design. No suite-dispute routing or child-command replay added.

Accepted mechanism: enforce the existing restricted parent-runner API before
parent delegation, on AST runtime specifiers for Vite/Vitest build/config entrypoints.
Reproduced actual native-binding failure through runParentTests; a data-read suite
passes and rejects deletion of the baseline exclusion. Model approval cannot bypass
the API check. Regular application imports, strings/comments, type-only import and
export declarations, and configuration data reads remain accepted. No application
module is executed in the coordinator, no native-addon permission is granted to
test threads, no failed implementation import is converted into a pass/review.
The check does not resolve computed/transitive imports or CommonJS calls (a local
function named require need not load a module), or prove arbitrary modules
runnable: those remain runtime evidence. A plain object named vite.config.ts is also
excluded deliberately as a project configuration entrypoint; inspect its bytes.
Contradictory assertion semantics remain with planner/reviewer guidance, not a
lexical task-name detector or a new assertion-count heuristic.

Rejected shortcuts: mark all zero-test module errors as host faults (would hide
application import defects); stub defineConfig/plugins in the test thread (changes
configuration semantics); allow native code/processes (breaks isolation); rewrite
historical acceptance suites or the immutable initial checkpoint; drop cache tokens
from accounting; trust grep/tail exit 0 as a test pass; declare a mutant useful for
ReferenceError/setup failure; reuse a prior green command after final edits.

Evidence handling: one shared command-output rule teaches direct execution or a
complete redirected UTF-8 log plus saved actual status. The existing worker capture
archives logs with explicit size/count omissions, not unbounded collection. Real
process regression verifies failure exit 7 and every output byte after sandbox
cleanup and persisted gzip decoding; image test crosses worker removal. This does
not recover data intentionally discarded inside a pipeline. Live final proof must
therefore verify actual invocations and every retained raw log, not assume compliance.

Budget: only Compute validation becomes 8M tokens / 30 minutes; cache accounting and
$0.25 cost fence remain intact. Mocked production budget gate admits each measured
usage volume priced as hosted replay and still refuses token/cost overruns before
another provider call. These are ceilings, not a promise of a completed verdict.

Release audit additionally found GHSA-rmxm-3fg6-px4f. The lock now resolves
@modelcontextprotocol/node 2.1.2 (whose peer requires server 2.4.0) and one deduplicated
@hono/node-server 2.1.5. Package ranges are unchanged; npm audit reports no findings.

Verification before publication: npm ci and npm run release:check pass, including
8,565 tests (44 image/environment-gated skips), both TypeScript configurations,
lint, audit, builds and compiled release/auth/executor smokes. The compiled
precheck also refuses the exact recorded fd66eb06 suite before delegation.
The file-scribe prompt digests remain unchanged. A separate real worker build
uses an isolated tag; deployment's fresh-worker CI remains a required gate.
