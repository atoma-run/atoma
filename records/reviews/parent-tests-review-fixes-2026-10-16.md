# Parent-owned tests: critical review and fixes

Scope: a critical review of the three commits that introduced parent-owned
acceptance tests and the delegation contract — b3af7c1e (parent-owned Vitest
suites, `dependsOn` parallel branches), de1ee85f (mandatory root
delegation-contract review, `replanAfter` discovery) and 8b9d990b (discovery
scope across delegation). Each group below states the defect, the mechanism
that replaces it, the countercases it was checked against, and its tests.
Contract: [parent-owned tests](../../docs/decisions/parent-owned-tests-2026-10-16.md);
original design review: [parent-owned tests](parent-owned-tests-2026-10-16.md).

## Group A — observation channel, unavailable semantics, one home

### Defects

- **Point 2, the only channel was model-visible summary text.** `verifyParentTests`
  prefixed `PARENT ACCEPTANCE TESTS (...): <observation JSON>` to
  `result.summary`, suite source included (up to 32,000 characters). That
  summary flowed into `previousStepSummary`, `dependencyResults`, aggregates and
  root acceptance at every hop, while the typed `Result.parentTests` was
  rendered nowhere. A molecule with no suite could write the same prefix and be
  indistinguishable.
- **Point 3, `unavailable` was `failed`.** No executor, a snapshot over bounds,
  an escaping (pnpm-style) link, a missing worker, a runner timeout or a missing
  report all became `parentTestRefusal`: an ephemeral rejection coaching "Repair
  the implementation", which the molecule could not act on — the wrong-gate
  direction the repository forbids.
- **Point 8, two homes for one rule.** `superviseLoop` short-circuited on
  `parentTestRefusal(result)` and `RESULT_GATES` held a `parent-acceptance-tests`
  row; at L2 the row never fired, elsewhere the short-circuit never did.
- **D0, the prefix hid the gates that read the head of a summary** (most
  serious). It was added for every status, `passed` included, inside `run()`
  before validation, so `non-json-envelope`, `internal-validation-failed` and
  `read-only-validation-failed` (`resultGates.ts:400, 417, 541`) and
  `executorSummary`'s restoration check (`resultGates.ts:611`) stopped firing
  whenever a task carried a suite; the anti-redispatch signature
  (`L2Atom.ts:1035`) hashed the prefixed summary.
- **D1, `verifyParentTests` wrote `Result.refusal`** for every non-passed status
  (`core/parentTests.ts:39`), which `isLanded`, the dependency predicate, the
  checkpoint and the runner outcome all read: once `unavailable` stops
  rejecting, an approved phase would have been `partial`.
- **D2, Decision calibration** counted validations of results carrying parent
  tests as eligible (`jevCalibration.ts:344-417`), though Decision is never
  asked for them (`L2Atom.ts:2696`, `L3Atom.ts:1594`).
- **D3, non-depth runs had no judge** for the root's integration suite
  (`runner.ts:1263`, `L3Atom.ts:809`): only `refusal` made such a run partial.
- **D4, root distillation ignored parent tests** (`depth.ts:401`).
- **D5, durable continuation ignored them** (`checkpoint.ts:482`), and
  `completedPhaseSchema` keeps no observations.
- **D6, some `unavailable` outcomes were caused by the code under test** — a
  synchronous hang killed by the timer, a rewritten suite file, an oversized
  report — reported as free text the reviewer would have had to classify.

### Mechanism

- **Typed causes.** `src/contracts/parentTests.ts` adds `parentTestCauseSchema`,
  an optional `cause` and a child-controlled `output` tail to the strict wire
  schema, `PARENT_TEST_TIMEOUT_MS` and one `parentTestSuiteDigest`. The runner
  (`src/tools/parentTests.ts`) sets a cause on every return path, checks the
  suite source before reading the report, separates host text (`details`) from
  the runner's stdout/stderr tail (`output`), types the snapshot failures and
  removes the random snapshot path from failure text so identical failures
  repeat byte-identically. Core maps a runner timeout under a window the run
  deadline clamped to `deadline-timeout`, and types its own fallbacks.
- **One home: `src/core/parentTests.ts`.** `parentTestConsequence` is the only
  mapping: `failed` and the subject causes (`timeout` over the full window,
  `source-changed`, `report-oversize`) reject; `snapshot-link` and
  `snapshot-special-file` reject once; every other cause, or none, is review.
  Core is the home because `superviseLoop` must enforce it for any
  `Supervisor` (tests use mocks) and core cannot import atoms, while atoms,
  run and the checkpoint already import core. Every path calls it:
  - three `RESULT_GATES` rows (`parent-acceptance-tests` reject,
    `-workspace` reject-once, `-unavailable` requires-review, all delegated),
    which cover L2 leaves, compiled dispatch, L3 delegated results and root
    acceptance; L3 now passes the run's one-shot memo so reject-once works there;
  - `withParentTestConsequences` in `superviseLoop` and compiled dispatch, a
    safety net that overrules an approval past a rejecting observation and
    sets the host-only `PositiveVerdict.parentTestsUnverified` otherwise;
  - `refuseUnreviewedParentTests` at the runner's non-depth settle (D3);
  - `parentTestsGrantNothing` at root distillation (D4) and durable
    continuation (D5).
- **Unavailable is reviewed and earns nothing.** `parentTestsUnverified`
  withholds atom trust, skill credit, distillation and promotion in L2's and
  L3's `onApproved` and in compiled dispatch, without the
  `uncovered-obligation` statistic that `proofUncovered` drives. L2/L3 already
  skip trust and Decision for any result carrying observations; the review
  finding forces the root's review too.
- **Judged once, superseded by a pass.** `markParentTestsJudged` marks every
  observation of a result the supervisor directly above approved; tiers above
  see it as context only (the `declared-unverified` precedent, review
  2026-10-10). A non-passed observation followed by a passing run of the same
  suite is superseded. `judged` is not in the wire schema.
- **The host block.** `src/atoms/parentTestsBlock.ts` renders
  `== PARENT ACCEPTANCE TESTS (HOST-OBSERVED) ==` after the transport evidence
  in `llmVerdict`, at L2, L3, root review and focused criteria review. Content
  lines start with `- ` or two spaces, child-controlled strings are
  JSON-encoded on one line and sources sit behind `    | `, so nothing inside
  can open a line with `== ` (which ends a section for the calibration reader)
  or forge `RESULT: `. Phase tiers show only the source of an unjudged suite
  that did not run and is not the task's own (already in the task context);
  the root shows unjudged sources first, then judged passed ones. The
  validation system prompt gained one sentence: parent-suite evidence exists
  only in that block. The summary carries nothing.
- **Calibration.** `INELIGIBLE_MARKERS` gains `'PARENT ACCEPTANCE TESTS ('`,
  matching the block's header and the historical prefix: no backfill.
- **Persisted evidence.** The runner's result keeps `parentTests` without
  source or child output (`persistedParentTests`, `VizRun['result']`), the
  first typed reader for viz, MCP review readers and the analyst. Before this,
  nothing typed reached the trace: `superviseLoop`'s `execute` entries stay on
  the in-memory `Result.trace`, and the summary prefix was the only channel.
  The root acceptance record already lists gate ids, so
  `parent-acceptance-tests-unavailable` shows in the client review. A dedicated
  event kind and client view are a follow-up.

### Adversarial countercases

- **Wrong-gate rejection** (2026-08-14 review): only host-caused non-runs move
  to review; subject causes keep a mechanical rejection decided from a typed
  cause, never from prose.
- **A child dodging a failing suite**: a hang runs the full window and is
  rejected; a rewritten suite file and a flooded report are rejected; an
  escaping link is coached once, then reviewed without credit. `process.exit`
  in the code under test gives `exited-without-report`, reviewed without
  credit — the residual risk below.
- **Trust fast path approving unexamined work** (run dfa20873): every unjudged
  non-passed suite takes the full review at L2, L3 and the root.
- **Re-judging at higher tiers** (review 2026-10-10, run bad74240): the judged
  mark keeps a leaf's finding from coming back at L3 and the root.
- **Titles without assertions** (Attica 85cc4e83, f74c140a): the root shows the
  integration suite's source whole and passed sources while its budget lasts.
- **Forged evidence** ("a title does not authenticate", `verdict.ts`): the block
  is outside the RESULT, child bytes are encoded, `judged` is not on the wire,
  the verdict flag is stripped from model output.
- **Stale proof** (verification-replay 2026-09-15): workspace digests and "later
  edits are not covered" are in the block; supersession needs a later pass.
- **A landing turned into a refusal or a loss** (progressive runs 2026-09-21,
  run 6ab0ae3b): `unfinishedPhases` is unchanged; parent tests no longer write
  `refusal`.
- **Read-only restoration banners** (production runs 2026-09-28): D0 is fixed.
- **Concurrent lanes**: the flag rides the verdict, the judged mark new objects.
- **Repeat escalation during progress**: the rejection is keyed on the sorted
  failing names with their first failure line.

### Tests

`tests/parent-tests-observations.test.ts` (mocked LLMs; the real runner where
named), `tests/parent-tests-runner.test.ts` (the real runner boundary through
`startTask`), and additions to `tests/parent-tests.test.ts`,
`tests/result-gates.test.ts` and `tests/run-checkpoint.test.ts`:

- D0 through `superviseLoop` with a real cell: an internal-validation or
  non-JSON banner rejects at no model cost under a passing suite; a read-only
  restoration banner still reaches its gate.
- The block at L2: header, counts, digests and requirement in the prompt, no
  prefix on the RESULT line, the child's summary delivered, no `refusal`,
  observations judged; the calibration reader keeps its sections, a forged
  `== GROUND-TRUTH` line in a suite source is encoded, both eras are ineligible;
  a suite-less molecule writing the old prefix gets no block.
- Provenance at L3 with a judged leaf observation and a passing or host-caused
  unavailable plan suite; supersession.
- A host-caused unavailable suite at L2: one model call, Decision not asked,
  child output encoded, approval, trust and skill credit withheld, no
  `uncovered-obligation`.
- A failed suite: no model call, the assertion named; three identical failure
  sets escalate, three different ones do not.
- The real runner: `timeout`, `source-changed`, `snapshot-link` (with its path,
  coached once then reviewed at L2 and at L3); `deadline-timeout` is review,
  a full-window `timeout` rejects.
- Mock supervisors: a failed suite is overruled, an unavailable one carries the
  flag to `onApproved`. Compiled dispatch: no script credit when the suite did
  not run; a failed suite sets the script aside and the molecule hears the
  failing assertion.
- Root acceptance: an unavailable integration suite forces review with the
  block in both reviews and the gate on the record; a failed one refuses
  mechanically naming the assertion; a ~30,000-character source is shown whole.
  `runDepthTask` delivers an approved unverified suite without distilling it.
- Runner boundary without depth: a failed integration suite is `partial` with
  the `REFUSED AT DELIVERY — no root acceptance ran` head, a passing one is
  delivered, and the persisted observations carry no source.
- Checkpoint: an approved phase whose suite did not run disables continuation.
- One mapping, three rows: for every status and cause, the gates (leaf and
  delegated) and the safety net agree with `parentTestConsequence`.

### Limits

- `exited-without-report` and `report-invalid` stay review: code calling
  `process.exit` can turn a failure into "did not run". It earns nothing, but a
  lenient reviewer can approve it on other evidence. Hardening the worker
  against exits is a follow-up.
- `snapshot-bounds` is review: large legitimate dependency trees exist.
- A mock or third-party supervisor gets the rejection and the withheld credit,
  but neither a forced review nor reject-once.
- Supersession and ordering are positional; parallel branches flatten in index
  order, not time order.
- The budgets (12,000 / 32,000 characters of suite source, status lines half as
  much again) are unmeasured.
- Historical traces keep the summary prefix; calibration handles them through
  the marker.
- Until group B changes the dependency predicate in `src/atoms/dispatch.ts`, an
  approved predecessor carrying a judged host-caused `unavailable` observation
  still blocks its dependents. Group B (below) changed it.

### Token cost

Unmeasured. Phase: at most about 12,000 characters of source (≈3k tokens) plus
status lines, per validation of a result that carries observations. Root: at
most 32,000 characters of source (≈8k tokens) plus status lines, per root
review call, up to three calls (review, focused review, rare reread). Removed:
the full observation JSON with its source, which the summary carried into every
RESULT line, `previousStepSummary`, `dependencyResults` and aggregate at every
hop. The validation system prompt gained one sentence: one cache miss.

### Owner decision

The decision document's earlier sentence "failed or unavailable tests cannot
grant acceptance" now reads differently for host causes: semantic review can
approve a delivery whose suite did not run, and it can be published. It is
recorded there as a new reading awaiting owner confirmation.

## Group B — a refused dependency lands

### Finding

`src/atoms/dispatch.ts` (`8b9d990b`, lines 165-166) threw for a dependent
whose predecessor carried a refusal, unfinished phases or a non-passed suite:

```ts
if (predecessors.some(result => result.refusal || result.unfinishedPhases?.length || result.parentTests?.some(check => check.status !== 'passed'))) {
  throw new Error('Dependency did not complete with accepted evidence');
}
```

After `allSettled`, line 205 rethrew any rejection that was not the deadline,
so every completed sibling was discarded with the dispatch:

- **At the root.** `L3Atom.execute` rejected and the run recorded `failed`.
  `previousSeedRun` skips failed runs, so nothing seeded the next run: the
  shape of `6ab0ae3b`.
- **Under a root phase.** The throw escaped the tissue's `superviseLoop`,
  which catches only escalations, and the run failed the same way.

Under the owner decision "one ladder per root phase, judge what exists", a
refused branch is kept and judged, and its dependents must not start.

### Mechanism

- **The predicate.** `dependencyBlocker(result, dispatcher)` returns one of:
  - `failed-suite`: a rejecting observation that no later pass of the same
    suite superseded, judged or not;
  - `landed`: the predecessor has unfinished phases of its own;
  - `unverified`: the predecessor is unapproved (the dispatcher's own fallback,
    or `phaseBudgetSpent`) and carries an unjudged observation that did not
    pass.

  An approved predecessor whose suite did not run for a host cause does not
  block. It reads typed fields only.
- **The dispatch.** Dependents block transitively, each as soon as its own
  producers settle, through a `Blocked` sentinel that is never a rejection.
  `dispatchWithAggregation` returns `{results, unfinished, blocked}`:
  - `unfinished` stays budget-only;
  - a throw keeps its meaning;
  - a dependent decided after the deadline is unfinished, not blocked;
  - sequential dispatch never blocks.

  The signature takes `{ dispatcher, checkpoint? }`.
- **One landing field.** `markLanded(result, unfinished, blocked)` adds the
  held-back entries to `unfinishedPhases` and to `blockedPhases`, and adds a
  summary clause. A budget-only landing is byte-identical to before. It sets
  `ownFallbackBlockedBy` when a root cause is the dispatcher's own fallback.
  `ownFallbackBlockedBy` is runtime-only. Entries name their prerequisite by
  description, cut to 120 characters, never by index.
- **Aggregates.** Both aggregates and `keptWithoutSynthesis` carry
  `blockedPhases` up. `keptWithoutSynthesis` now also carries `phaseBudgetSpent`,
  which it used to drop.
- **The ladder.** `ladderSpent` also reads `ownFallbackBlockedBy`, so a cell
  whose branch landed behind its own fallback hands its whole phase up once,
  whatever the plan shape.
- **Root acceptance.**
  - `DEPENDENCY_LANDING_GUIDANCE` is the block for a dependency landing;
    `LANDED_RESULT_GUIDANCE` stays byte-identical, and a result that is both
    carries both.
  - A dependency landing always takes a validation call. A budget landing on a
    covered floor with no finding is still approved mechanically.
  - The comments that claimed every landing takes a validation call were
    false and are corrected.
- **Depth.** `remediationTask` adds `inputs.rootDependencyLanding`, built from
  typed fields only:
  - the phases that never started (at most 16, 500 characters each);
  - the suites that did not pass (at most 8, with status, cause, requirement
    and details up to 2,000 characters);
  - a fixed instruction.

  Without a run deadline, only a budget landing is capped by the landing
  window.
- **Explanation readers.**
  - `landingReasons` subtracts held-back entries from the budget reason as a
    multiset and adds its own reason.
  - The runner persists `blockedPhases`; viz types and the run index project
    it.
  - The partial-run card composes one sentence per fact, with new EN keys
    `run.partial.blocked` and `run.partial.cause.refusedAfter`.
  - The analyst's definition of `partial` names the case, and its prompt
    version is bumped.

### Countercases checked

| Record | Outcome |
|---|---|
| `progressive-runs-2026-09-21.md` (`cc894dad`, `d3098d25`) | Settled branches are kept. |
| `phaseBudget.ts`, `bad74240` and the refused per-phase counter | The cell ladder never runs twice. The whole phase goes up, not a fragment. |
| `6ab0ae3b` (a failed run seeds nothing) | The outcome is `partial`, and the next run is seeded. |
| `dfa20873` (the zero-phase invariant) | The refusing producer is always among the results. |
| The 2026-08-16 fan-in | No wave barrier. |
| 2026-09-25 review 1.2c (the synthesis signal) | The synthesis signal stays deadline-only. A synthesis error during a dependency landing stays an error. |
| `runLanding.ts`, 2026-09-24 (one `isLanded`) | Untouched. |
| `depth-routing.test.ts` at the covered-floor and landed-guidance pins | Unchanged. |
| The 2026-08-14 drift review | Typed fields only. |
| `5dff35b0` (remediation) | Unchanged; the pass gains a typed input. |
| 2026-10-09 lessons rule | An approval saves its lessons and a refusal drops them, as before. |

### Rejected alternatives

- **A second landing field** beside `unfinishedPhases`. A dozen readers would
  each need it. `blockedPhases` is a subset and never a signal on its own.
- **Parsing the `[PHASE LADDER SPENT` prefix or `refusal` prose.** Both
  continue into model-authored text.
- **`phaseBudgetSpent` as a blocker by default.** A spent semantic refusal
  whose suites passed feeds its dependents on `HEAD` and in sequential mode.
  This is owner decision (a).
- **An L3 retry of landed branches.** That is the `bad74240` re-run.
- **Forcing review on every landing.** It would change every covered budget
  landing. The forced review is narrowed to `blockedPhases`.
- **Blocking in sequential mode.** Sequential mode keeps its contract: each
  phase reads the previous one.

### Deviation from the design

The design's `failed-suite` test was "some observation has status `failed`".
The implementation uses group A's one mapping: a non-superseded observation
whose consequence is `reject`. That covers a failed suite and the subject
causes (a full-window timeout, a rewritten suite file, an oversized report),
and lets a later passing run supersede an earlier failure. The `unverified`
test reads `parentTestsGrantNothing(result, 'unjudged')`. An unapproved
aggregate can hold observations that the supervisor directly above approved,
and those were already weighed.

### Tests

All tests use mocked models.

- **`tests/landed-run.test.ts`.**
  - The predicate cases.
  - Plan `[A, B, C dependsOn 0, D dependsOn 2, E dependsOn 1]` with A's own
    fallback failing: no throw, started `[0, 1, 4]`, blocked `[2, 3]`, entries
    by description.
  - A throw still fails the dispatch.
  - Abort ordering: cut, held back, and decided after the deadline.
  - Sequential mode never blocks.
  - `markLanded`: the budget-only string pinned byte for byte, the blocked and
    mixed cases, and the subset invariant.
  - `keptWithoutSynthesis`, `ladderSpent`, and `landingReasons` with its
    multiset subtraction and the `PREVIOUS_LANDING_ENV` round trip.
  - A coordinator-boundary run that records `partial`, seeds the next run and
    hands it the held-back reason.
- **`tests/dependency-landing.test.ts`, the real tissue, cell and molecules.**
  - The cell shapes `[A, B dependsOn A]` and `[A, C, B dependsOn A]`: B never
    runs, the cell plans once and falls back once, the phase goes up spent
    with B's entry, and the tissue makes no result-validation model call.
    Without the `ladderSpent` change the second shape planned six times.
  - A root plan `[P1, P2 dependsOn P1]` with a root suite: P2 never starts and
    the root suite is "Not run".
  - Through `runDepthTask`: two mechanical refusals, and a remediation pass
    carrying `rootDependencyLanding` with P2's entry and the failed assertion,
    then `partial`.
  - Root acceptance carries the new block and never approves mechanically; a
    mixed landing carries both blocks.
  - Without a deadline, a spent landing window does not cut a dependency
    landing's acceptance but still refuses a budget landing's.
- **`tests/depth-routing.test.ts`.** On a covered floor, a budget landing is
  approved mechanically and a dependency landing takes a validation call.
- **`tests/dependency-landing-runner.test.ts`, the real runner boundary.**
  It drives `startTask` without depth, with the real fixed Vitest runner on
  the real workspace. The run ends `partial` (it was `failed` on `HEAD`), the
  persisted result carries `blockedPhases`, and the epilogue carries the
  held-back reason.
- **Viz.** `tests/viz-gpu-views.test.ts` covers `landingCause` and the composed
  copy keys, and the card draws "blocked + refused after".
  `tests/viz-run-index.test.ts` checks that a held-back landing is a landing.

### Limits

- **A root suite that did not run because the plan landed** has cause
  `landing`, which group A maps to review. The mechanical refusal comes from
  the held-back producer's own failed suite. A dependency landing whose only
  observations are host-caused reaches the root's validation call instead.
- **An L2 `[A, C]` with no dependencies.** When its own fallback fails, L3
  still re-runs it: nothing lands, so `ladderSpent` is false. This existed
  before and is out of scope.
- **A mutualized peer's fallback** carries another name, so it does not mark
  the ladder spent.
- **A held-back discovery plan** is returned as the root result
  (`L3Atom.ts`, discovery): group C.
- **`llm-synthesize` prose** can overstate what landed. Only the prefix and the
  typed fields correct it.
- **Unmeasured live.** The partial-run card copy needs `viz:smoke` on a real
  machine before shipping.

## Group C-runner — asynchronous snapshot, no project code in the coordinator

Point 4 of the review (a synchronous copy in the shared worker) and the minor
point on tsconfig `paths` aliases. Investigating them found five more defects
in the same runner; each is listed with its reproduction.

### Findings

- **F1, critical: project code ran in the coordinator and could forge a pass.**
  Vite's CSS plugin loads the PostCSS configuration when the plugin is created,
  whether or not any stylesheet is imported. It executes
  `postcss.config.{js,cjs,mjs,ts}`, or the plugins named in
  `package.json#postcss`, from the project's `node_modules`. A `*.module.scss`
  import also loads the project's `sass-embedded`/`sass`. `config: false` stops
  none of it. The coordinator holds `--allow-addons` and `--allow-worker` and
  writes the report. Reproduced through the real `runParentTests` and the
  compiled worker image built before this group (`atoma-worker:parent-tests-check`):
  `add = () => 5` with a `postcss.config.cjs` that rewrites
  `atoma.report.json` and sets `process.exitCode = 0` at exit returned
  `status: passed`. The `package.json#postcss` plugin and the `sass-embedded`
  variants passed the same way.
- **F2: the link check could be escaped.** `copyProject` used Node's JS
  `realpathSync`, which resolves a link's content as text (the class of the
  2026-10-13 review). `.git/inner -> <outside>/dir` was never checked because
  `.git` was filtered out; `up -> .git/inner/..` then read as inside, and
  `cpSync` copied `<outside>/secret` as `up/secret`.
- **F3: no bound on the copy, and blocking cleanup.** The timer bounded only
  the child process. `rmSync` of the copy blocked for 0.2-0.3 s on Linux and
  1.5 s on macOS. With the local backend the copy blocked the run process
  itself: LLM streams, the watchdog, every lane.
- **F4: point 4 confirmed.** `worker.ts` dispatches requests concurrently,
  but `copyProject` ran synchronously before `runParentTests`' first `await`:
  every lane's tool calls froze for the whole copy (measured below: 9.9-10.0 s
  on macOS for a 36,395-file `node_modules`).
- **F5: dereferencing broke pnpm layouts.** `node_modules/foo ->
  .pnpm/foo@1/node_modules/foo`, where `foo` requires its sibling `bar`, failed
  with `Cannot find module 'bar'` once copied dereferenced (`cpSync`'s
  `dereference: true`), and directory links fanned out without bound: 30
  levels of `d<n>/{a,b} -> d<n+1>` is 2^30 paths, and the old runner did not
  return within 120 s on that fixture.
- **F6: matchers can be forged inside the test thread.** A module the suite
  imports can run `expect.extend({ toBe() { return { pass: true } } })`, and a
  wrong `add` passes. The coordinator fix does not and cannot close this; it is
  recorded as a remaining risk, not fixed here.
- **F7 (found while testing): a read-only source directory broke cleanup.**
  `cpSync` copied a `0o555` directory with its mode; `rmSync` in `finally` then
  threw `ENOTEMPTY` out of `runParentTests`, replacing the observation with a
  thrown error and leaving the copy behind.

### Mechanism

- **`src/tools/sandbox.ts`, one home for containment.** `kernelRealpathAsync`
  (`fs.promises.realpath`: libuv, so libc's realpath) beside `kernelRealpath`;
  `openContained(path, flags, realRoot)` opens with `O_NOFOLLOW | O_NONBLOCK`
  and proves the descriptor inside before anything is read or listed — on Linux
  through `readlink(/proc/self/fd/<fd>)`, elsewhere by comparing the
  descriptor's dev:ino with the kernel realpath of the same spelling.
  `onCleanup` returns a disposer and `cleanupGeneration` counts cleanups.
- **`snapshotProject` (`src/tools/parentTests.ts`).** Every directory is opened
  through `openContained` and listed through its descriptor on Linux, with
  `Buffer` names so non-UTF-8 names survive. Entries (files, directories and
  links) are counted when a directory is listed, so a flat directory over the
  bound costs one listing; depth is checked when a directory is entered.
  Destination directories are `0o700` and never take the source mode.
  - Links are never followed. Inside the root, a link is recreated in the copy
    as a relative link to its target's copied path; the walker copies the
    target on its own pass. Outside, `snapshot-link`. No reachable target
    (`ENOENT`, `ELOOP`), or a target under an excluded name: skipped and
    counted. `EACCES` is a runner error.
  - A file is opened through `openContained`, `fstat`ed (anything else than a
    regular file is `snapshot-special-file`; `O_NONBLOCK` keeps a FIFO from
    parking a pool thread), its size counted against 512 MiB before reading,
    then read once in 256 KiB chunks that feed both the hash and the
    destination (`O_CREAT | O_EXCL | O_NOFOLLOW`). A read whose length,
    size, mtime, ctime or inode moved is retried three times, then kept as
    last read and counted `unstable`. An entry that vanished after its
    listing is skipped and counted. Only safety violations and bounds fail.
  - On the first error nothing new is scheduled and every in-flight write
    settles before the error is rethrown, so no write races the removal.
  - Digest: sha256 over records sorted with `Buffer.compare` (code units, not
    locale order): `rel \0 F \0 sha256 \0` for a file, `rel \0 L \0 target \0`
    for a link. The format changed; the digest is only a label within a run.
  - I/O slots: one semaphore shared by every snapshot in the process,
    `min(3, UV_THREADPOOL_SIZE - 1)`.
- **`runParentTests`.** One deadline drives an `AbortController` through an
  unref'd timer, and a cleanup hook (disposed in `finally`) aborts it too. A
  copy past the deadline is `snapshot-timeout` (a new host cause, consequence
  `review`); one a cleanup interrupted is a `runner-error` ("the sandbox is
  shutting down"). Between the copy's last `await` and `spawn` there is no
  `await`; immediately before `spawn` the runner refuses if the signal fired
  or `cleanupGeneration` moved. The child gets `deadline - now`, never a fresh
  window. The copy is removed with an awaited `rm`, and a removal failure is
  logged, never thrown out of `finally`. The observation carries an optional
  `snapshot` receipt (entries, files, bytes, links, skipped, unstable, ms). A
  `ran` result prepends host notes as array elements: the skipped/unstable
  counts, and `Host: the suite module did not load; no test ran.` when no test
  ran and a module message exists.
- **`parentTestWorker.ts`.** `css: { postcss: {} }` (an inline object is
  never searched for nor executed); a `pre` plugin that resolves a stylesheet
  with `this.resolve` first (an unresolved one stays Vite's own failure, so a
  missing file never passes) and returns `\0atoma-css-stub:<kind>:<hex id>` —
  a virtual id without a stylesheet extension, since a prototype that kept the
  extension still ran `vite:css` and `sass-embedded`; `?raw` and `?url` are
  left to Vite. `resolve.tsconfigPaths: true`, Vite 8's native option.
- **Image.** `docker/worker-package.json` pins `vite` 8.2.2 and `rolldown`
  1.2.6, the lockfile's versions: the image installs without a lockfile, Vite 6
  and 7 silently ignore `tsconfigPaths`, and rolldown implements the resolver,
  the CSS path and the transform.

### Measurements

Fixture: a real `node_modules` subset, 39,813 entries, 36,395 files, 41 links,
381 MiB. "Sibling read" and "DNS" are the p99 latency of a `readFile` of a
small file and a `dns.lookup('localhost')` issued every 20 ms during the copy;
the loop columns come from a 10 ms interval and `monitorEventLoopDelay`
(both cover the copy and the removal).

| Environment | Variant | Copy + hash | Loop max gap | Loop p99 | Sibling read p99 | DNS p99 | Removal |
|---|---|---|---|---|---|---|---|
| macOS APFS, Node 24.20 | before (sync) | 9.9-10.0 s | frozen | frozen | ≥ copy | ≥ copy | 1.6 s, blocking |
| macOS | final, 3 slots | 3.9-4.0 s | 16-19 ms | 11 ms | 0.3-1.7 ms | 0.7-5.5 ms | 1.2 s, async |
| macOS | 8 slots (pool 12), before the two cuts below | 3.5-3.6 s | 13-17 ms | 11 ms | 0.6-0.8 ms | 0.9-2.3 ms | 2.9-3.0 s |
| Linux container, Node 24.22, `--cpus 2 --memory 2g`, overlay `/tmp` | before (sync) | 2.7-2.8 s | frozen | frozen | ≥ copy | ≥ copy | 0.2 s, blocking |
| Linux container | final, 3 slots | 6.1-6.2 s | 65-73 ms | 12-16 ms | 0.4-0.7 ms | 0.3-0.8 ms | 0.4-0.5 s, async |
| Linux container | 8 slots (pool 12) | 7.2 s | 192-212 ms | 86-91 ms | 1.6-18.8 ms | 0.6-2.5 ms | 1.9-2.3 s |
| Linux container | design prototype, read-once c=8 | 8.0-8.2 s | 158-222 ms | 84-89 ms | — | — | 2.0-2.4 s |

- On Linux the asynchronous copy takes about 2.2x the wall time of the
  synchronous one: it is CPU bound in the worker's 2-CPU envelope (5 s user and
  10 s system CPU for 6.1 s of wall time), and every operation is a pool
  round-trip. It no longer blocks anything else, which is what point 4 asked.
  The design prototype measured 3.3-4.7 s in the same container shape on the
  day of the design; on this day the same prototype measured 8.0-8.2 s, so
  the rows of this table are comparable with each other, not with the design.
- **Deviation: three slots, not eight, and no `UV_THREADPOOL_SIZE` in the
  image.** The design raised the pool to 12 for eight slots. Measured in the
  2-CPU container, eight slots were slower (7.2 s against 6.1 s) with three
  times the loop stalls and sibling reads up to 18.8 ms. A pool of 8 with
  three slots still showed p99 loop delays of 53-80 ms (the removal used the
  larger pool). The image keeps libuv's default pool of 4, and the slot count
  is capped at 3.
- Two cheap cuts were measured and kept: no trailing 1-byte probe read (the
  second `fstat` sees a growth) and concurrent closes, 7.1-7.5 s → 6.1-6.2 s.
- The synchronous tail, sorting and hashing the records: 22 ms for 40,000
  records, 63 ms for 100,000.

### Link experiments

- **Linking `node_modules` from the live tree: rejected, shown unsafe.**
  `proj/node_modules -> live/node_modules`, run under
  `--allow-fs-read=proj --allow-fs-write=proj`: a write through the link
  succeeded and landed in the live tree. Node checks the requested path, not
  the resolved one.
- **Links recreated inside the copy: adopted.** By the same semantics, a write
  through an internal link lands inside the granted copy
  (`tests/parent-tests-snapshot.test.ts`, "keeps writes through node_modules
  and its links inside the copy"). The pnpm fixture passes with the links
  kept and fails dereferenced. Bytes are still copied, never shared.

### Stylesheets, assets and aliases in environment `node`

Measured through the real runner:

- A stylesheet import loads as `""`; a CSS module as a proxy mapping each
  class to itself; `?inline` goes through the stub (`""`); `?raw` and `?url`
  are left to Vite and both yielded `""` (Vitest's own CSS handling).
- `import logo from './logo.png'` yields `'/logo.png'`; an SVG yields a
  `data:image/svg+xml,…` URL; JSON imports load their data.
- A tsconfig alias resolves only for an importer the tsconfig's
  `include`/`files` covers. With `include: ["src"]`, or a solution-style
  `files: []` + `references` layout, a `src` module resolves `@/x` while the
  suite at the root does not. JSONC (comments, trailing commas), `extends`
  inside the project, wildcard and exact keys and `baseUrl` work.
- The resolver is rolldown's native code. Node `--permission` does not confine
  native code in a process that holds `--allow-addons`: it stats an outside
  alias target or an outside `extends`, which can reveal whether a path exists
  (the existing oxc transform already reads tsconfig natively). Outside
  content is kept out by the JavaScript loader's grant — an absolute alias to
  an outside file failed with "Access to this API has been restricted" — and
  by the container.

### Rejected alternatives

- **A `node_modules` link to the live tree:** unsafe (above).
- **`fs.promises.cp` with an async filter, then a hash pass:** 18.3-18.6 s in
  the container at design time, the slowest variant, and it still follows
  links.
- **A hand-written JSONC tsconfig mapper:** Vite 8 reads tsconfig natively,
  with `extends` and include scoping a hand mapper would have to reproduce.
- **A sandbox write lock during the copy:** a dev server or log writer in the
  workspace would stall every write tool for the whole copy; per-file
  consistency with counted instability is enough for a disposable copy.
- **Moving the report out of the project:** it does not stop code in the
  coordinator; keeping project code out of the coordinator does.
- **Restarting the copy when a file changes:** a dev-server log in the project
  would make every verification unavailable.
- **Porting `readOnlyPhase`'s held-descriptor walker:** holding a descriptor
  per pending directory needs fd bookkeeping; verify-after-open gives the same
  guarantee on Linux.

### Deviations from the design

- **Slots and pool** (above): `min(3, pool - 1)` and the default pool.
- **Paths are opened by full spelling, then verified**, not through
  `/proc/self/fd/<dirfd>/<name>`: a directory descriptor is closed right after
  its listing, so no descriptor is held per pending directory. On Linux the
  post-open `readlink` proves where each descriptor landed, so a swapped
  ancestor is caught all the same; a link's realpath is only used to place the
  recreated link and never to read bytes.
- **`kernelRealpathAsync` returns a `Buffer`**, so a non-UTF-8 name is
  compared byte for byte (`containedIn`).
- **Recreated links take the shortest relative path** (a `.bin/tool ->
  ../tool/cli.js` stays exactly that), not a path climbing to the copy root.
- **On Windows** a directory is checked by its kernel realpath and listed by
  path (Windows opens no directory descriptor); an internal directory link
  becomes a junction inside the copy and a file link is copied as bytes.
  Untested here.
- **The tests live in a new file**, `tests/parent-tests-snapshot.test.ts`,
  rather than in `tests/parent-tests.test.ts`. T1 sends the `read_file` once
  the copy has visibly started (the copy's `node_modules` exists in the
  worker's private `TMPDIR`), not in the same chunk: in one chunk the read is
  served while `runParentTests` awaits its first realpath, so a copy that
  blocked after that await would still pass.
- **`cleanupHookCount()`** is a test-facing count on `ToolSandbox`.

### Tests

`tests/parent-tests-snapshot.test.ts` (18 tests, each through the real runner
or the real worker process; each red on the code before this group unless
noted):

- **The worker boundary.** The real `src/tools/worker.ts`, forked with tsx in
  socket mode with a private `TMPDIR` over 3,000 files: `read_file` sent once
  the copy started answers before `atoma-verify`, and when it answers the
  suite file does not exist yet; the verification passes with
  `snapshot.files ≥ 3000`. With a synchronous copy substituted the second
  assertion fails.
- **The event loop.** `snapshotProject` over 3,000 files: a `setTimeout(0)`
  and a sibling `readFile` issued during the copy both complete before it, the
  read under `snapshot.ms / 4`. Red with a synchronous copy substituted.
- **Containment and shape.** The `.git/inner/..` escape is `snapshot-link`
  with no outside bytes (`runner-error` before); a FIFO, and one behind an
  internal link, is `snapshot-special-file` (green before too); a link cycle,
  a 2^30 directory-link fan-out, the pnpm layout, a preserved `.bin` link,
  a dangling and an `ELOOP` link pass together (`skipped: 2`, `links: 64`,
  the host note present; the old runner did not return within 120 s);
  100,001 directories and depth 129 are `snapshot-bounds`.
- **Deadline and cleanup.** `timeoutMs: 1` is `snapshot-timeout` with no copy
  left (`timeout` before); a `0o555` source directory passes and leaves
  nothing (a thrown `ENOTEMPTY` before); a `cleanup()` during the copy is a
  `runner-error`, spawns nothing, and the hook count returns to its baseline.
- **No project code in the coordinator.** `add = () => 5` with each forger —
  `postcss.config.cjs`, a `package.json#postcss` plugin, a `*.module.scss`
  with forging `sass-embedded` and `sass` — is `failed` (`passed` before).
- **Aliases and stylesheets.** JSONC + `extends` + wildcard and exact keys +
  CSS module + plain CSS + a throwing `vitest.config.ts` pass; the
  `include: ["src"]` and solution-style fixtures resolve in `src` and not in
  the suite (`did not load` in the details); an alias to an outside file never
  passes and shows none of its bytes; a missing stylesheet never passes.
- **Isolation.** Writes through `node_modules` and through an internal link
  stay in the copy; a concurrent appender and unlinker never make the result
  `unavailable` nor surface a raw `ENOENT`.

`tests/container-image-closure.test.ts` asserts the worker pins of `vitest`,
`vite` and `rolldown` equal the lockfile's. `tests/container-isolation.test.ts`
("compiled parent-test worker", with `ATOMA_TEST_ACCEPTANCE_IMAGE`) adds the
forging `postcss.config.cjs` and a 5,000-file `node_modules`: a `read_file` in
the same burst as `atoma-verify` answers in under `snapshot.ms / 4`, and the
forger fails. Run against an image built from this tree
(`atoma-worker:c-runner-check`): green; against the image built before it
(`atoma-worker:parent-tests-check`): the forger passed. Re-run T5/T6 and this
container test on any bump of vite, vitest or rolldown.

### Limits

- **darwin:** the open-then-verify window is narrowed, not closed; Linux
  closes it.
- **Matcher forging (F6)** is open. A matcher-table lock would be a separate
  design.
- **The minor point is partly closed.** Aliases work in application code; a
  suite that imports an alias stays red and is coached as a repair, with the
  neutral host note. A planning-side check of suite imports belongs to the
  contracts and planning group.
- **A hard process exit** leaves the temporary copy behind, as before.
- **`--allow-addons`** stays with the coordinator. A future vite or rolldown
  path that executes project code would regain that privilege; the forger
  tests pin the three paths known today.
- **Host install, for the owner:** `vitest` and `vite` are root
  devDependencies, while the host installs with `npm ci --omit=dev`. A
  local-backend `atoma-verify` on the host returns `unavailable`. Out of scope
  here.
- **Throughput on Linux** is about 2.2x the synchronous copy's wall time in a
  2-CPU container; the copy no longer blocks other lanes, but a large
  `node_modules` takes a larger share of the 120 s window.
