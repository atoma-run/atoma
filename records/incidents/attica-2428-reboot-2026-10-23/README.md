# Attica 2428d930: reboot interruption and avoidable recovery, 2026-10-23

Run `2428d930-5008-41eb-a13a-ee0e61735377`, production revision
`36877f8f2308b4b5b2739ca775a534ead46c6363`, short route, customer device
`9bafcb10`. Investigation only: no run restart, product patch, publication,
model replay or acceptance was performed. The browser counterexample below
executes saved UI code with synthetic data and no external requests.

## Evidence coverage and accounting

Identified from the production MCP project's newest runs. All 168 summary events
were retrieved to `nextOffset=null`; all 143 non-start events plus metadata and
runner log were read completely over 220 detail pages, retaining snapshot tokens
while paging. The 25 start events are covered by the summary, including the final
unfinished plan. All six negative model verdicts were read, as were all 92 tool
calls, source/test edits, receipts and context events. Journal pagination ends at
`nextBefore=null`. Review and the existing analyst verdict were also read.

The immutable capture is `trace-evidence.json.gz`; `analysis.json` is its event
ledger and computed aggregates; `supplemental-evidence.json` contains MCP journal,
review and analyst evidence. File hashes are in `HASHES.sha256`. Full prompts
remain in the compressed capture rather than being repeated in this report.

Project elapsed: 1,601.540 s (26m41.540). Trace elapsed: 425.744 s (7m05.744).
Before the trace: 45.721 s; after the trace: 1,130.075 s (18m50.075).
The recorded setup stage is 40.122 s. Retrieval preparation took 31.639 s and
overlapped execution; it is not an additional serial 31-second delay.

There are 24 completed logical LLM calls: 4 routing calls (17.344 s), 6 plans
(36.073 s), 6 plan reviews (29.943 s), 3 executions (291.796 s), 5 result reviews
(35.811 s). Executions contain tool waits, so those durations must not be added
again. All used Luna, despite the configured tier model pins. The captured
subscription-equivalent cost is $0.20801068, not an API invoice; 13 Decision calls
are listed separately by status. Cache reads total 2,001,664 tokens. This is not
the earlier expensive L3 planning loop, and differing tasks prevent a causal
speedup claim against the old CAPTCHA runs.

## Chronology (UTC; Athens is UTC+3)

- 07:39:06.182: project starts. Journal 6872 at 07:39:09.296 records repository
  synchronization, three paths taken, no conflicts. Captured base is `258318458f`.
- 07:39:51.903: trace starts. First tool at 07:40:16.974; first source edit at
  07:40:34.099, 42.2 seconds into the trace.
- 07:40:13–07:41:50: Ammonia edits the source/test, then cannot run validation
  because dependencies are absent. Result refusal is justified.
- 07:41:57–07:42:31: recovery burns two refused plans, changes Ammonia to Urea,
  and approves a promise to synchronize Git, which the worker cannot perform.
- 07:42:31–07:44:15: Urea rereads state, attempts Git, installs root and browser
  dependencies, fixes test invocation, builds and passes the four-test file.
- 07:44:16–07:44:42: cell and holistic root approve; independent criterion review
  refuses insufficient stale-response evidence. This refusal is justified.
- 07:44:42–07:45:13: remediation reroutes, plans, is refused again for Git, and
  replans. The broad compound criterion keeps the original repair in scope.
- 07:45:13–07:46:44: Urea refactors working source, adds nondeterministic negative
  assertions, reruns build/type/lint and the four-test file, then the focused case.
- 07:46:45–07:46:53: cell refuses the strengthened test for the same real proof
  gap and asks for deterministic ordering. A fourth execution is not recorded;
  only its next planning call begins before interruption.
- 07:46:57.514: client `local-close`, no pending tool commands. Server observes
  WebSocket close 1000 at 07:46:57.645. Trace closes at 07:46:57.647.
- 07:46:59.316: local client logs `stop-confirmed` with socket state 3 (closed).
- 08:05:47.493: client reconnects, generation 109→110; project finalizes failed
  at 08:05:47.722. No client cancellation was requested.

The user reports a reboot. Logs establish orderly local close, local stop and
later reconnection, consistent with that report; they do not independently name
the OS reboot cause. This differs from the previous nginx/socket-1006 incident.
The late failed status waits for confirmed remote workload stop; expiry alone
does not authorize freeing a compute slot (`src/projects/AGENTS.md`). A stop was
known locally while disconnected. Do not label the 18m50 tail as agent waste or
claim that increasing the reconnect lease makes a reboot resumable.

## Findings and remedies

### 1. Host-completed Git synchronization becomes a repeated child obligation

Plan verdicts `d221878b`, `2daf0a57` and `3c791849` demand synchronization before
editing. The journal proves it already happened. The reviewer prompts have no
`repositoryBase` or synchronization receipt, only task prose and starting file
inventory. The first plan had been approved without this demand. Recovery is
blocked until the model promises Git; actual execution then reports `ENOENT`
(`cb694c4e`) and later an allowlist error followed by `git: command not found`
(`da68dc0e`, `567d7e75`). One registry failure and a branch follow the first pair.

This is a demonstrated host/agent context ownership failure, not a missing Git
feature to implement inside the sandbox. `coordinator.ts` prepares repository
sync before launch; `runner.ts` injects inventory, not that receipt;
`taskContext.ts` explains inventory freshness but not synchronization ownership.
Three rejected plan/review pairs account for 35.120 s of completed calls, before
the extra branch setup and futile inspection. This is observed occupied time,
not a measured counterfactual saving.

Remedy: carry a typed host receipt (base SHA, sync outcome/conflicts, completed
stage) into planners and reviewers and preserve it across recovery. Test the
production coordinator→runner→prompt boundary, including explicit old-version
selection, unresolved conflicts and resumed runs. Do not infer sync from goal
text or automatically approve a plan based on a repository name.

### 2. Fresh sandbox dependencies are discovered by failing commands

`2394817d` spends 46.693 s on `npx vitest` fetching unpinned 5.0.5 instead of the
repository's 3.2.4, then exits 126. Typecheck/lint/build then fail for absent
executables. The cached new Vitest also fails on a missing native binding.
The next executor first tries offline install (uncached tarball), then installs
174 packages in 20.839 s; browser Playwright needs a separate 3.691 s install.
Only after a failed test run is that second missing package recognized.

Seed copying intentionally excludes `node_modules` (`src/run/AGENTS.md`); an
inherited source tree or past passing test is not an installed runtime. The goal
forbids pointless `npm ci/check` repeats, not indispensable dependency setup.
Remedy: explicitly tell the executor what launch excluded, inspect the required
package roots once, prepare pinned dependencies once, then validate. Do not
solve this by copying arbitrary dependency trees across machines or suppressing
environment failures as successes.

### 3. Wrong test entrypoint and unnecessary old-case reruns

After installation, `68198e68` finds no tests because default Vitest excludes
the browser UI file. `697c9a90` switches to `vitest.browser.config.ts` but still
lacks Playwright. The correct entrypoint was available in package/config files.
Successful runs `e1addaaf` and `4b1cc0cf` each run all four cases, including old
CAPTCHA/resume behavior, despite the scoped request. `8fe6a014` finally selects
the new test with `-t`, without intervening edits since the previous success.
That last invocation costs 1.725 s; this duplication is small, not the main delay.
Use the existing browser config and exact focused test from the first invocation.

### 4. The stale-response proof really is insufficient, twice

Cell `7f1059c0` and holistic root `8008a0d9` approve the first proof. Criterion
review `0ac58129` correctly notices that final fresh state permits a transient
stale overwrite. Recovery adds `initialStatusFulfilled` and negative `expect.poll`
checks (`565fd6f4`, `91a85341`, `20ce903e`). Fulfillment is not proof of browser
consumption; an eventual negative assertion is not a continuous invariant.
It can pass before the stale render or after the fresh render repairs it.
Cell `a0a6c19a` therefore reasonably refuses the second proof.

Executed counterexample: `stale-proof-experiment.mjs` loads the recorded compiled
UI in Chromium with a synthetic fetch implementation and blocked external
requests. One arm keeps the guard, one removes only the refresh version guard.
Both satisfy the recorded final/negative predicates after fresh state arrives;
the mutant visibly renders `Ancien état`/`old` in between. A deterministic
assertion after old-response processing, before fresh-response release, passes
the original and fails the mutant. Results and DOM histories are saved in
`stale-proof-results.json`. This is a controlled counterexample, not an exact
replay of the original Playwright/Vitest runner or a frequency estimate.

Remedy: gate the responses separately, wait for the old response to be consumed,
assert unchanged state/rows/error with the fresh reply still blocked, then release
fresh data and assert refresh. Require a mutant to fail. Keep the actual source
guard; its correctness is not disproved by a deficient test. Blanket verdict
caching or eliminating criterion review would preserve a false approval here.

### 5. Recovery expands work and changes working code unnecessarily

The root refusal targets the test, but `1fe793e6` extracts `showRefreshedState`
from already-correct production logic. That refactor does not repair ordering
proof and necessitates a new build/verification. The single criterion c1 combines
refresh, error retention, rows and stale-response safety. Consequently
`rootRemediationScope.metCriteria` is empty: criterion-level scoping cannot
represent the already-supported parts within c1. Three executions make 32 reads
and 13 directory listings. Package JSON is read three times with identical bytes;
an absent helper `.ts` is queried twice. Some source reads legitimately follow
edits; not every repeated read is waste.

Remedy: state the exact test-only correction and preserve working files. Track
supported observations within a compound criterion, or split independently
testable requirements at task creation. A carried observation is historical,
not permanent approval after source/runtime changes. Measure resumed discovery
and unnecessary writes, not just repeated shell commands.

### 6. A recovery recipe has the wrong failure category

Event `9ea3ae43` injects `recover-rerun-all-required-baselines` at confidence 0.60
after missing dependencies. Its text asks for every baseline command to be rerun
and compared byte-for-byte. This mismatches environment setup and conflicts with
the explicitly focused request. Its trust wrapper says to ignore conflicting
steps, and the skill is injected into an Ammonia plan that never executes before
branching. Thus injection is proven; causation of Urea's later extra tests is NOT.
Remedy: review the recipe trigger/category and execution-credit evidence before
promoting it. Do not add a vocabulary blacklist based on one incident.

### 7. Weak probe substitution can produce a misleading green record

`12b59a9a` greps unminified identifier names in a minified bundle and fails.
`3d5c1cb9` supersedes it with a successful search for `human verification`, text
unrelated to the requested refresh change. The new success proves neither the
fix nor equivalent coverage. The host log preserves both calls, so this is not
erasure of trace history; it weakens the durable manifest entry and child report.
The earlier grep over compiled JS plus minified JS also succeeds solely on the
compiled file, not necessarily the served bundle.
Remedy: use the already-executed browser check of the built app, or a bundle
identity receipt, rather than source-name grep in minified output. Treat
`supersedes` as command replacement, never proof of semantic equivalence.

### 8. Budgets and observability hide the shape of the loop

Each execution has 24 tool-response iterations and records 25 response envelopes,
ending with `tool-budget-exhausted`. Their actual tool-call counts are 26/38/28,
because batched calls share iterations. All three finish with a report; the gate
forces review, not automatic refusal. A fourth plan starts at interruption.
Budget exhaustion contributes context resets, but the evidence does not establish
that merely raising the budget would yield a correct proof. Avoid that shortcut.

`stats.refusals=0` is not a count of all validation refusals: the field is fed by
skill lifecycle refusal signals (`src/skills/lifecycle.ts`), while this trace has
three negative plan verdicts, two cell result refusals, and one criterion refusal.
Rename/label that metric and expose negative judgments by stage.

The saved analyst labels the run `sound` and says shutdown prevented another
completed validator verdict. `a0a6c19a` contradicts that: the last cell verdict
completed and refused the test before shutdown. The analyst also calls the new
checks deterministic, which the counterexample refutes. It describes the Git
allowlist error as recoverable but omits the following `git`-absent response and
the earlier host synchronization. Root cause triage cannot rely on that summary.

## Before relaunch

First fix the sync receipt handoff and make dependency setup explicit for this
fresh sandbox. Next repair only the focused test with deterministic response
gates; preserve the source fix and use the browser-specific config/test filter.
Keep the original task scope and retain build/type/lint evidence with its actual
source/runtime identity. Review the misleading recovery recipe and probe
substitution separately. Show execution-ended and stop-confirmation-pending as
distinct lifecycle states rather than appearing to build for 19 minutes.

This short run had no automatic deep phase checkpoint; saved failed-run edits
are not a delivered artifact. Review exposes no manifest and no acceptance.
Do not assume a new run automatically seeds its unfinished workspace: preserve
and inspect recoverable bytes explicitly before choosing a restart base.
No relaunch was performed. These proposed engine fixes still need their own
implementation/regression and adversarial review before landing.
