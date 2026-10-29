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

The earlier strict replay also exposed two complete criterion verdicts with
missing global `reasoning` (58dd3075) or `reason` in its place (8d2d7dea).
The parser now copies the unambiguous supplied global reason, or joins the
existing explained criterion reasons when no entry was discarded or duplicated.
It never supplies `approved`, `met`, a criterion id or missing evidence, changes
no criterion, makes no model call, and leaves present canonical reasoning alone.
Reading envelopes are ineligible. A missing/duplicate/unexplained judgment still
fails the ordinary focused review; a negative criterion still binds root even
beside a global approval. This is format normalization, not an independent review
or a retroactive approval of either historical run. Raw responses remain intact.

Final format verification: the compiled parser reads both exact private recorded
responses and preserves their decisions and criterion values relative to the same
responses with an explicit canonical field. No provider calls. The full release
passes 8,572 tests (44 gated skips); the seven additional regressions cover both
formats, negative judgments, missing/duplicate reasons and binding root refusal.

## Follow-up: independent replay 03f5cf43

Source 36e940ba delivered on the same immutable initial snapshot (276 entries,
251 files, 4,496,267 bytes); an independent whole-workspace comparison found only
the two permitted files changed. Its focused recovery suite passed 8 tests,
causal mutants failed original assertions, final full-browser suite passed 31,
and the clean root-only check passed with browser dependencies absent.

The hosted replay ended inconclusive at $0.2527196, below 8M tokens and 30 minutes.
Its first shell command already failed creating the scratch HOME with ENOSPC;
all 52 shell calls failed, so none establishes verification. A disposable worker
without any project mount reproduces this. Containerd actually stores its layers
on /mnt/HC_Volume_104738584 (49 GiB, zero available), independently of the free
product-state volume. No run evidence or application image has been removed.

Raise only the Compute validation cost fence from $0.25 to $1, retaining 8M
billable tokens including cache reads and the 30-minute wall. Regression feeds
the observed pre-acceptance cost through RunBudgetMeter/BudgetGateLlmClient,
and still proves both independent ceilings refuse further transport calls.
This is bounded review headroom, not a bypass of acceptance or token accounting.
Automatic review initially rejected shared cache cleanup. The owner then approved
the exact older-than-24h operation retaining 8GB; it reclaimed 493.9MB, and the
unprivileged worker still reproduces ENOSPC. Keeping 4GB of unused cache, including
recent entries, is the pending replacement authorization. Images and run evidence
remain intact.

Follow-up verification: npm ci and the entire official release definition pass
(static half plus all 8,572 tests / 44 gated skips at four workers). Two preceding
full-suite failures under the default 12 workers concerned only the Docker
fixture's readiness/removal timing; the isolated test and final complete suite
passed without source changes or weaker assertions. Both failures are retained.
