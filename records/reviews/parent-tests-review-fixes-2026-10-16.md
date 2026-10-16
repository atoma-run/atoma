# Parent-owned tests: critical review and fixes

Scope: a critical review of the three commits that introduced parent-owned
acceptance tests and the delegation contract — b3af7c1e (parent-owned Vitest
suites, `dependsOn` parallel branches), de1ee85f (mandatory root
delegation-contract review, `replanAfter` discovery) and 8b9d990b (discovery
scope across delegation), window `b3af7c1e..8b9d990b`. Each group below (A–F)
states the defect, the mechanism
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
approve a delivery whose suite did not run, and it can be published. On 2026-10-16 the
owner delegated the choice; it was decided as recorded there.

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
  (Historical: G3 replaced `ownFallbackBlockedBy` with the `spentLadder`
  stamp, written by the supervise loop rather than derived by `markLanded`.)
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
  before and is out of scope. *Closed by G3* (see "Follow-up: Spent ladders
  that are not recognised").
- **A mutualized peer's fallback** carries another name, so it does not mark
  the ladder spent. *Closed by G3.*
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

## Group D — Root delegation review robustness and unparseable root plans

Problem points 5 and 6 of the critical review. Owner decisions kept: the root
review is mandatory, there is no unreviewed fallback, and independent work must
fan out.

### Findings

1. **The 0d3739dc retry only covered L1 plans.** `superviseLoop` asks again on a
   `ValidationError`, but `L2Atom.plan` and `L3Atom.plan` used `parseTwoJson`
   plus `schema.parse`, which throw `SyntaxError`, a plain `Error` or
   `ZodError`. A test source holding `\d`, a raw newline or an unescaped `"`
   ended the run at L2, at the L3 root and at the SHORT root
   (`shortRootHandle` had no retry at all).
2. **`parseTwoJson` amputated plans silently.** Its truncation path closes an
   open string and the brackets: a reply cut inside `acceptanceTests.source`
   came back schema-valid with the suite cut short and the later subtasks gone,
   and a reply cut inside the plan got a synthesised placeholder plan.
   `parsePlanWithFallback` is only used by fallback `selfPlan`, where the suite
   rides `task.acceptanceTests` and the supervisor's run wrapper verifies it; it
   does not drop a declared suite, and it is unchanged.
3. **Reviewer failures counted as plan failures.** A review whose stop reason
   was not `end_turn`, or an approval with no classification or bad indices,
   became a refusal that asked Opus for a new plan coached about the reviewer's
   own failure. An unparseable verdict (`parseVerdict` → `ValidationError`)
   escaped `prepareRootDelegation` and ended the run.
4. **Ollama broke the stop-reason vocabulary.** It returned `stop`/`length`
   where every other transport maps to `end_turn`/`max_tokens`. On Ollama every
   delegation review read as unfinished, and so did the client-question and
   criteria reviews.
5. **Validators are capped at 2048 tokens**, and Sonnet 5 counts adaptive
   thinking inside `max_tokens`; moving the root review to tier 2 needed its
   own parameters.

Probe evidence: findings 1–5 were traced in the code at `8b9d990b` (line
references in the group D design: `supervisor.ts:289-296`, `L2Atom.ts:700-703`,
`L3Atom.ts:753-755`, `runner.ts:107-111`, `json.ts:469-490`, `verdict.ts:629`
and `:1072`, `llmOllama.ts:253,269`). The regression tests below were checked
against the fix by mutation (see Tests); they were not replayed on the base tree.

### What changed

- **Root review on tier 2** with `ROOT_DELEGATION_REVIEW_PARAMS`
  (`STRATEGY_MAX_TOKENS`, `effort: 'medium'`), resolved lazily so an L3 builds
  without `ATOMA_MODEL_L2`. Child-plan reviews stay on the validation model.
  The constant lives in `cost.ts` beside `STRATEGY_MAX_TOKENS`, not in
  `verdict.ts` as designed: `cost.ts` imports `verdict.ts`, and a top-level
  constant across that cycle would hit the temporal dead zone on one load order.
- **Typed refusal kinds**, set by the host on `NegativeVerdict.delegationRefusal`
  and never parsed from the model: `reviewer` (cut at `max_tokens`/`pause_turn`,
  unparseable verdict, missing classification, incomplete or duplicate
  indices), `plan` (discovery misuse, missing classified suites) and `fan-out`.
  `enforceParsedDelegationReview` is the mechanical half, reused on resume.
- **`L3Atom.reviewedRootPlan`**, one bounded loop for the fresh and resumed
  paths: three iterations; a `PlanParseError` spends one with
  `planParseFeedback`; a reviewer fault re-reviews the same plan on the
  validation model with `VALIDATION_PARAMS`, with no plan call; a plan refusal
  replans; on a continuation a fan-out refusal is terminal at once.
- **`parsePlanPair`** reads a strategy+plan reply exactly as written or throws
  `PlanParseError` (a `ValidationError`) prefixed `plan reply unparseable:`:
  the parser message with an 80-character excerpt around the position
  (`jsonParseExcerpt`, extracted from `describeInvalidArguments`); a distinct
  message for a repaired reply cut at `max_tokens` (asks for a shorter reply)
  and for an unbalanced finished one; schema errors bounded to 600 characters.
  L2 and L3 `plan()` use it; L2 now commits its strategy only after the plan
  parsed. `parseTwoJson` keeps its behaviour for `viz/report.ts` and the index.
- **SHORT root**: three attempts around `cell.plan`, on `PlanParseError` only.
- **Ollama** maps `stop` → `end_turn` and `length` → `max_tokens`.
- **Planning guidance**: `PARENT_TEST_PLANNING` now says how to write a test
  source inside a JSON string.
- **Checkpoint approval record**: `root.approval = { digest, from, review }`,
  written in the same `planned()` write as the plan. The digest binds the review
  request, a hash of `VALIDATION_SYSTEM_PROMPT`, the reviewing model, `from`, the
  plan as a checkpoint restores it (JSON then `planSchema`, so key order and
  host-only keys cannot break the match), the task's inputs, description,
  criteria and constraints, and the actor's name, id and registry version. A
  resume whose record binds against either current reviewing pin re-runs the
  mechanical enforcement and executes with no model call; otherwise it reviews
  the remaining slice as before. A refused legacy plan, like a client answer,
  replans only a sequential suffix (a non-sequential reply is feedback, not an
  exception). Every resumed branch calls `planned()` before `execute()`.

### Salvage: admitted and refused

Admitted: raw control characters inside strings, escaped by the existing
`escapeControlCharsInStrings` from the first `[`/`{` on, kept only if the whole
pair then parses with no repair and both schemas accept it. It is lossless: the
decoded string is what the model wrote between the quotes. It is tried only
when the reply did not parse as written (extraction error or repaired read);
it can never win over a clean reply, and never over truncation, since a
truncated reply still needs a repair after escaping. Adversarial cases, each
with a test or a traced path: a stray unescaped quote inverts the in-string
tracking, so escaping hits structural whitespace, the pair fails and the planner
is asked again (`does not salvage raw newlines beside a stray unescaped quote`);
a backslash before a raw newline is left as is and fails; `\d` and other invalid
escapes are untouched and fail; prose before the JSON is outside the slice.

Refused: doubling invalid escapes, inferring unescaped quotes, and executing a
truncated or repaired pair. Each would author contract bytes on the model's
behalf (src/core: "never repair or reinterpret executable arguments"); the
`salvageResultEnvelope` fuzz (685 of 20,000 envelopes fused wrongly) is the
precedent. Asking again with a positional message loses nothing.

### Counterexamples checked

- **fec4ef6a**: a tier-2 or Haiku approval still runs the mechanical
  enforcement; a recorded approval is re-enforced on resume and bound to the
  exact plan, so a plan promising tests in prose cannot pass.
- **12bdcf19**: raw newlines are escaped losslessly; quotes and invalid escapes
  are asked again with an excerpt, at L2, at the L3 root and at the SHORT root.
- **Truncation history** (`plan-truncation-recovery`,
  `l3-truncated-plan-aggregation`): complete replies keep their defaults
  (L3's `sequential` for an omitted aggregation, read from the raw plan); only
  repaired replies are refused. The 2026-08-08 fused emission still parses.
- **The 39-character summary**: the same "schema-valid but amputated" class.
- **"Proof is always fresh"**: the approval judges plan bytes before execution,
  like the saved plan and strategy; root acceptance stays fresh.
- **Saved actor changed** (code review 2026-10-09, 1.4): still refused before
  any approval is read, and the actor is in the digest.
- **Client-answer crash after plan**: `planned()` runs after the approval, so
  the successor resumes without judging again (asserted).
- **Discovery**: never checkpointed. **Fallback**: `parsePlanWithFallback`
  untouched. **Fan-out on resume**: terminal at once, zero plan calls.

### Tests

All mocked; the checkpoint cases cross the process boundary with the real
runner and store.

- `tests/delegation-contract.test.ts`: the root review's model and parameters
  and the child review's; an L3 built without `ATOMA_MODEL_L2`; four reviewer
  faults each re-review once on the validation model, and three in a row end the
  run unexecuted; through the real `L3.plan`, an invalid escape is asked again
  with the parser message and never reviewed, three end the run naming the
  parser, raw newlines are salvaged on the first call with the exact suite
  bytes, and a reply cut at the cap is never reviewed or executed and is asked
  to be shorter; the escaping sentence reaches the L3 and L2 plan prompts; an
  in-process resume runs a recorded approval with no model call, reviews again
  after a criteria change, and after a recorded classification that no longer
  enforces.
- `tests/json.test.ts`: `parsePlanPair` cases (clean, fused, no aggregation,
  cut at the cap, unbalanced, placeholder, invalid escape with excerpt, bounded
  schema error, raw-newline salvage, stray-quote refusal; `parseTwoJson`
  unchanged).
- `tests/supervision.test.ts`: a real L2 cell's unparseable pair gives one
  `plan-unparseable` entry and no escalation, and the executed strategy is the
  parsed reply's.
- `tests/llm-ollama.test.ts`: `stop` → `end_turn`, `length` → `max_tokens`.
- `tests/run-checkpoint.test.ts` (separate process): the restart stores an
  approval classifying both phases and the resume makes zero root reviews; a
  legacy payload (`json_remove`) is reviewed once and delivers; a changed saved
  subtask or changed saved inputs are reviewed once; a resume with
  `--pause-after-phase 3` fails in `planned()` with zero reviews (proving the
  recorded branch records the plan); a refused legacy plan replans one suffix
  and the prefix is not replayed; an always-refused one ends with "Saved
  delegation plan requires a new run"; a fan-out refusal ends with zero plan
  calls; the client-answer cases make one review, and none after the post-plan
  crash; the SHORT root retries once and gives up after three.
  Mutation checks: with the recorded-approval branch disabled, the restart, the
  two post-plan-crash and the in-process recorded-approval tests fail; with
  reviewer faults treated as plan refusals, the four re-review tests fail; with
  repaired pairs accepted, the cap, unbalanced, placeholder and root truncation
  tests fail.

Criteria tampering is asserted in process rather than across the boundary: the
fixture's checklist is empty, and a non-empty one would change final acceptance
as well as the digest.

### Critique disposition

Adopted: the tier-2 cap and effort with a Haiku re-review on a reviewer fault;
host-typed refusal kinds; terminal fan-out on a continuation; the digest binding
(request, system-prompt hash, model, task fields, actor); the run-checkpoints
decision edit; the L1 wording; the SHORT root retry; Ollama normalisation; the
control-character salvage only when the whole pair then parses unrepaired; the
lazy tier-2 resolution; `stopReason` in the truncation feedback;
`PlanParseError`; `planned()` in every saved branch; the cost upper bound and
the `models.ts` comment. Adopted in part: rollback stays a documented one-way
change inside the strict payload (a two-step deploy and a sibling table were
rejected). Rejected: keeping Haiku until measured; the cost rule and the root
acceptance precedent support tier 2, and the Haiku re-review keeps today's
finishing behaviour as a floor.

### Measurement triggers

- the root `validate-plan` `stopReason` and output tokens on the first deployed
  runs (a `max_tokens` on Sonnet at 8000 means the cap or effort is wrong);
- how often a `reviewer` fault falls back to the validation model;
- `plan reply unparseable` warnings, split into truncation and other;
- root refusals overturned on replan.

### Open items

- A child-review `reviewer` refusal repeated in `superviseLoop` still hits
  `planRepeat` and gives `EscalationSignal('repeat')`, branching a type over a
  reviewer failure.
- An unparseable verdict in a child plan review still throws.
- L1 `parseWith` still accepts repaired payloads.
- A change to `VALIDATION_SYSTEM_PROMPT` or the review request invalidates every
  recorded approval: those resumes take the legacy review, by design.
- Sonnet under the 8000-token cap at medium effort is unmeasured; a run ends
  only after three consecutive reviewer faults.
- Plans with many suites can exceed `STRATEGY_MAX_TOKENS`; three truncations
  now end the run where an amputated plan used to execute. A cell whose replies
  keep truncating escalates once its plan budget is spent.

## Group E-routing — point 7, DAG-aware cross-bucket verification routing

b3af7c1e made `routeCrossBucketVerification` return any plan holding `dependsOn`
or `acceptanceTests` untouched, which disabled browser/shell capability routing for
every plan shape the planning prompts now request. Routing was built (guestbook,
2026-08-12) to split verification checkpoints; applied to an implementation node it
replaced the node with two VERIFICATION ONLY parts, copying outputs and suites and
dropping the build prose (one-phase fixture of run 04ea696f), and on a concat plan it
manufactured a declared-output collision the planner was then coached about.

Now routing classifies by typed contract. A node with `acceptanceTests`, non-empty
`outputs`, or the planner's only subtask implements and is never split: it is
rerouted whole only to a cell holding validate_html, run_shell and
start_node_server and every tool of the planner's cell, else left alone (a browser-only
static node keeps the older reroute to a web cell). An output-less node of a
multi-phase plan is a checkpoint and keeps the browser-then-shell split. An omitted
or unregistered preferredChild is kept, since a fresh cell inherits the tissue's
tools. Every `dependsOn` is remapped; dependents of a split checkpoint wait for
both parts; in parallel modes the shell part depends on the browser part, which keeps
`enforceDelegationReview`'s independent-pair check sound (host parts never form a
new independent pair). Mode, plan suite and read-only counting are unchanged.

Routing stays inside `L3Atom.plan`, before `acceptL3RootPlan` and the mandatory
review: the reviewer classifies exactly the dispatched indices and sees the cells
that will run them. Host parts carry an internal `routedFrom` marker (not in
`planSchema`); `routingIndexNote` tells the reviewer and the replanning planner
which routed indices belong to which planner subtask and how to keep a checkpoint
whole. The note rides the review prompt (`llmVerdict`, beside the review request)
and the rejection feedback of `reviewedRootPlan`, computed on the slice the
reviewer saw. The review is not relaxed for host parts.

Deviation from the design: a `preferredChild` naming a type of another tier is
not treated as unregistered. The dispatcher throws on it rather than creating a
cell, so routing keeps treating it as lacking every cell capability, as before.

Decided 2026-10-16 under the owner's delegation: this reverses "Routing cannot split a node holding tests
or dependency references" (parent-owned-tests record, line 13) for checkpoints in
DAG plans; suite nodes are still never split. "Routing does not own dispatch
topology" now admits one host edge inside a split checkpoint in parallel modes.

Remaining: checkpoint parts still copy criteria and proof obligations to both parts
and keep only regex-matched prose (pre-existing); a browser part may land on a web
cell without a server (notes-app 2026-09-07 class, pre-existing for checkpoints);
parallel checkpoint parts are not read-only, like any planner-written parallel
checkpoint; resume reviews a slice whose sequential `dependsOn` keys are not rebased,
and the answer continuation does not shift them (no gate reads them in sequential
mode); the triggers stay regex-based (`requiredPassingCommands` sees only
`node X.js`); a suite node needing a browser on a cell without one, with no
superset full-stack cell, relies on the cell's prefilter redirect and root
acceptance, as before. Signal to watch: a rejection citing a `routedFrom` index
three times in one run.

Counterexamples checked: guestbook 2026-08-12; forced sequential on concat
(code-review-2026-08-14); omitted preferredChild (notes-app 2026-09-07); one-phase
split marked read-only (run 04ea696f); whole-task criteria (run 76a9486c);
verification doubling (phase-redundancy 2026-08-22); Attica index-based
classification (attica-delegation-contract-2026-10-16).

Critique disposition: an implementation split (a writable verification lane
after the suite, duplicated browser verification, re-firing detectors, lost
sequential handover, whole-task criteria demoted) is removed at its cause, since
implementation nodes are never split. A web-only target for a server-backed
node is excluded by the superset full-stack rule. An unregistered
`preferredChild` is kept. Rejected: an exemption for host parts in the review
(state and a gate path without an observed incident; the note gives the planner
the lever), and dropping the host browser→shell edge (host parts would then
form an independent pair and let a linear planner DAG pass the mechanical
fan-out check).

Tests: `tests/plan-verification-guidance.test.ts` (a DAG checkpoint split with
remapped dependencies, `planSchema` round trip and no output collision; the
independent-pair check refusing a linear planner DAG both before and after
routing; implementation nodes kept or moved whole; in-place reroute; invented
cell, no browser work, full-stack cell and dangling dependency left alone;
sequential remap without a host edge; the bounded note).
`tests/delegation-contract.test.ts`, through the real `handle`, `plan`, review,
dispatch and cells: the reviewed plan is the recorded and dispatched plan, the
review prompt carries the note, six root branches with the shell part after the
browser part and the README after both, the module suite run once; a review
classifying planner indices refused; a rejection mapped back to the planner,
whose full-stack checkpoint then runs unsplit; three rejections fail closed; a
sequential two-phase plan counted as two planner phases with both checkpoint
parts read-only and the implementing phase not. `tests/read-only-phase.test.ts`:
the one-phase 04ea696f fixture now runs as one branch.

## Group F — hygiene: calibration exclusions, scoped TypeScript guidance, neutral criteria prompt, readable tests

Group F landed last, after A–E, so its reformatting and its line counts are
taken on the final files.

### Findings

- **The Decision calibration read decisions Decision never takes.** Since
  b3af7c1e and de1ee85f, four kinds of model validation are kept from Decision
  by POLICY, yet each still records a `validate-plan`/`validate-result` `llm`
  event that `jevCalibration.ts` sent as calibration material:
  1. the root delegation review (`L3Atom.reviewRootDelegation`, also on
     resume): it calls `llmVerdict` directly, with no `jevApproval` site;
  2. L3's review of an L2 plan under `reviewsTests` (`!reviewsTests && ctx.jev`);
     its recorded answer can also be overturned by `enforceDelegationReview`, so
     it is not even the verdict the host applied;
  3. L2's RESULT review of a suite-bearing task or of a result carrying
     `parentTests`;
  4. L3's RESULT review under the same condition (and its trust gate).

  Probe: at `8b9d990b`, `parseValidationPrompt` read every one of them as
  eligible, the two L3 plan reviews included (pinned in
  `tests/jev-calibration.test.ts`: the same production events, stripped of
  their stamp and dated after the bound, all parse as eligible). Group A then
  marked the two RESULT kinds `ineligible` through an `INELIGIBLE_MARKERS`
  entry; the two delegation reviews stayed eligible. L2's review of L1 plans on
  suite-bearing tasks is NOT among them: Decision still decides there.
- **The TypeScript application guidance reached reasoning tasks.**
  `APPLICATION_TYPESCRIPT_GUIDANCE` was in every `taskContextLines` output,
  including `executionMode: 'reasoning'` tasks, which hold no tools and build
  nothing.
- **`CRITERIA_REVIEW_PROMPT` carried run vocabulary**: "a failing scheduler
  test does not refute an independently established file deletion or
  lock-release test" (event `4327e8bf`, records/incidents/attica-validation-context-2026-10-16.md).
- **b3af7c1e dropped the rationale link** to
  [the 2026-08-16 fan-out record](../incidents/parallel-fanin-2026-08-16.md)
  when it replaced the "one phase per orthogonal group" rule.
- **Two test files were dense**: `tests/parent-tests.test.ts` and the head of
  `tests/delegation-contract.test.ts` chained statements and test bodies on
  one line, against `READABLE_SOURCE_RULE` (`src/atoms/prompts.ts`).

### What changed

- **A typed stamp, set where the skip is decided.** `JEV_EXCLUSIONS`
  (`delegation-review`, `parent-suite`) in `src/contracts/llmTrace.ts`;
  `LlmCompletionRequest.jevExcluded`; `VizLlmEvent.jevExcluded`, recorded by
  `RecordingLlmClient` from the request like `effort`, with no prompt
  archaeology. `llmVerdict` stamps every call carrying `delegationContract` at
  its one rendering site (cases 1 and 2), and `L2Atom.validateResult` /
  `L3Atom.validateResult` name the condition once (`parentSuite`), use it in
  the trust and Decision gates and stamp the model review (cases 3 and 4).
  Every `LlmClient` wrapper on the path passes the request through or spreads
  it (`RoutingLlmClient`, `MetricsLlmClient`, `BudgetGateLlmClient`,
  `ToolIterationCeilingLlmClient`), so the stamp survives.
- **Counted apart, kept in the corpus.** `decisionsOfTrace` sets
  `RecordedDecision.excluded`; `calibrate` counts it in a new
  `Calibration.excluded` per exclusion before reading the prompt, and sends
  nothing. `atoma_jev_calibrate` returns `excluded` beside `ineligible`, and
  its note says these are counted, never asked.
- **Why not `INELIGIBLE_MARKERS`, and why not a drop.** `ineligible` counts
  validations whose EVIDENCE made the fast path inadmissible (gate findings,
  uncovered proof), and its readings are quoted ("125 results ineligible",
  docs/decisions/jev-decisions-2026-09-28.md); a fixed policy folded into it
  changes what that number means. Markers are text-matched, and the
  parent-suite RESULT with only aggregated passing observations leaves no text
  at L3 before Group A. Dropping the decisions in `decisionsOfTrace` would
  hide them without a count and shift `corpus.decisions` indices, invalidating
  `nextOffset` values issued earlier. Group A's `'PARENT ACCEPTANCE TESTS ('`
  marker therefore moved out of `INELIGIBLE_MARKERS` into the historical
  reader below: one home for the policy. Group A's test
  (`tests/parent-tests-observations.test.ts`) now asserts the exclusion.
- **Historical traces.** A trace started before
  `JEV_EXCLUSION_STAMPED_FROM` (`2026-10-17T00:00:00Z`, midnight UTC after this
  commit) without a stamp is read by `historicalExclusion`, from host-rendered
  structure only: (1) a PLAN review whose `== REQUIRED DELEGATION CONTRACT
  REVIEW ==` line (`DELEGATION_REVIEW_HEADER`, now exported and used by the
  request) follows the one-line `PLAN: ` payload — every multiline text a model
  controls renders before it; (2) a RESULT review whose task context holds the
  parent-suite line (`PARENT_SUITE_CONTEXT_PREFIX`, now exported), whose host
  block header follows the payload, or whose `RESULT:` line carries b3af7c1e's
  `PARENT ACCEPTANCE TESTS (` summary prefix (the RESULT line only: an earlier
  phase's summary reaches the inputs without its observations); (3) an L3 PLAN
  review whose context or payload carries a suite, b3af7c1e's `reviewsTests`
  for the b3af7c1e..de1ee85f window. No production trace is known to need (3):
  the only known run on b3af7c1e, `fec4ef6a`, planned no suite. A trace started
  from the bound on is read by its stamp alone; its text never decides.
- **Reasoning tasks skip the TypeScript guidance.** `taskContextLines` renders
  it only when `executionMode !== 'reasoning'`: such a task holds no tools
  (L1 `reasoningPrompt`, the L2/L3 fallback `hasTools`), and
  `delegatedTaskContext` forces reasoning on every descendant of a reasoning
  parent. `fallbackProof.ts` is unchanged: it runs only for a fallback holding
  tools. The decision doc and `src/atoms/AGENTS.md` say so.
- **Task-neutral criteria prompt.** The first sentence now reads "a failure
  observed for one requirement does not refute a different requirement that its
  own evidence independently establishes". It is neutral about the kind of
  proof, so it covers a deletion established by a listing (the `4327e8bf`
  case); the next sentence of the prompt still says which evidence counts, and
  it agrees with `ASSERTION_EVIDENCE_GUIDANCE` ("Source can establish an
  implementation property"). "Attach a failure only where it contradicts that
  criterion", the inventory sentence and `STATEFUL_EVIDENCE_REVIEW` are
  unchanged and still let a later edit or a shared-state failure contradict
  another criterion. About 20 characters of a ~6,980-character system prompt
  changed. The `benchmark/*-2026-10-05/` replays import the live prompt, so
  their recorded results stay historical.
- **Fan-out rationale restored** in `src/atoms/AGENTS.md`: `dependsOn` makes
  fan-out + join expressible at one tier; the 2026-08-16 finding (per-artefact
  serial phases serialised independent work) is what the DAG answers; fan-out
  was not always cheaper; no live run has exercised it yet. The file went from
  699 to 698 lines: the TypeScript bullet was rewrapped to make room. The
  2026-08-16 record's banner still names the "one phase per orthogonal GROUP"
  prompt rule, which b3af7c1e removed (`grep` finds it nowhere in `src/`); the
  record stays untouched as evidence.
- **Readable tests.** Both files now hold one statement per line and no
  one-line test bodies; object literals over about 100 characters are split
  by property group; every fixture string is byte-identical. Proof of no
  behaviour change: `esbuild --minify-whitespace --minify-syntax` gives the
  same SHA-1 before and after for each file (`71fc4ddf…` for
  `parent-tests.test.ts`, `62f37920…` for `delegation-contract.test.ts`).
- **Index.** `records/README.md` now lists this record, the parent-owned tests
  design review, the Attica delegation-contract review and the TypeScript
  policy and application skeleton reviews; the parent-owned tests decision
  links back here. It is NOT added to `records/code-reviews.md`, whose entries
  move the next general review's revision range.

### Decision's context cap (measured, not changed)

`APPLICATION_TYPESCRIPT_GUIDANCE` is 1,345 characters (1,359 JSON-escaped),
6.8 % of `JEV_STATE_CHARS.plan` = 20,000, which caps Decision's whole
stringified context head-first (`capped`). It renders before `inputs`, so a
tool-mode task's inputs are now cut past roughly 18,000 characters instead of
roughly 19,400: the cut point moves, no new cut is created, and reasoning tasks
get the room back. The bigger finding is the parent-suite line: up to 4,000
characters of requirement plus 32,000 of source (`contracts/parentTests.ts`),
before escaping, also rendered before `inputs`. Decision still decides L2's
review of L1 plans on suite-bearing tasks; with a suite over about 18,000
characters its context loses `originalTask`, previous-step inputs, the phase
criteria and the "Execution mode" line (constraints still arrive as separate
state). Possible fixes, not built: render the suite line after `inputs` and
the criteria, or switch Decision off there as L3 does.

### Countercases checked

- [parallel-fanin-2026-08-16](../incidents/parallel-fanin-2026-08-16.md):
  serialised catalog build phases took 362.7 s against 145.5 s for digest's
  grouped one (two different tasks, not a controlled comparison), yet digest
  cost more in total ($0.75 against $0.54), and a rerun in which one molecule
  wrote all three generators took 103 s against 145 s fanned out, at a third of
  the run cost. The coupled `fanin` tasks correctly stayed sequential.
- [attica-delegation-contract-2026-10-16](attica-delegation-contract-2026-10-16.md):
  `fec4ef6a` (b3af7c1e) had no acceptanceTests and still planned one broad
  sequential migration branch.
- The run-actor exclusion precedent in `decisionsOfTrace` (root acceptance,
  criteria batches, text reference and router left out, counted as 42 %
  "unparsed" before 2026-10-10).
- "125 results ineligible" (jev-decisions-2026-09-28): the meaning of
  `ineligible` stays evidence-driven.
- Event `4327e8bf`: a listing-established deletion charged a scheduler failure;
  the fixture "debug.js is absent." in `tests/attica-validation-context.test.ts`.
- `text-delivery-2026-10-02`, code review 2026-10-09 §2.6 and
  `delegatedTaskContext`: reasoning mode is inherited, so no reasoning
  descendant can need the policy.
- typescript-applications-2026-10-16: "Read-only analysis and documentation
  tasks remain scoped".
- The 2026-08-14 frozen-vocabulary finding: no keyword gate is added. New
  traces use a typed stamp; the historical reader is anchored to host-rendered
  structure and bounded by date.

### Tests

- `tests/jev-calibration.test.ts`, "the validations Decision never takes",
  through `RecordingLlmClient` and a real `TraceRecorder`: (a)
  `L3Atom.validatePlan` of a plan carrying a suite, (b) the root review through
  `L3Atom.handle`, (c) `L2Atom.validateResult` on a suite-bearing task, (d)
  `L3Atom.validateResult` of a result carrying passing observations, and two
  controls (`L3Atom.validatePlan` without suites, `L2Atom.validatePlan` of an
  L1 plan under a suite). `calibrate` reports `excluded` =
  `{delegation-review: 2, parent-suite: 2}`, `ineligible` zero, and sends only
  the two controls (four requests). Unstamped copies are excluded by the
  historical reader before the bound and kept after it, where text alone reads
  all six as eligible; a historical control whose task text carries the header
  before its payload is kept. Removing the recorder's stamp fails the test.
- `tests/parent-tests-observations.test.ts`: the host block keeps the reader's
  sections, parses eligible, and is counted as `parent-suite` (block or
  historical prefix) only in traces before the bound.
- `tests/reasoning-delivery.test.ts`: one delegated task, with and without
  `executionMode: 'reasoning'`, through `L1Atom.plan`/`execute`, `llmVerdict`
  (RESULT) and `jevApproval`'s request context: the guidance is absent under
  reasoning and present in the tool-mode control. `tests/planning-scope.test.ts`
  adds a delegated tool-mode variant beside root tool-mode and delegated
  reasoning at L2 and L3. Both fail with the old unconditional line.
- `tests/attica-validation-context.test.ts`: the criteria reviewer reads the
  neutral sentence and neither "scheduler" nor "lock-release".

### Remaining risks

- A future `LlmClient` wrapper that rebuilds requests would drop the stamp; the
  production-path test through `RecordingLlmClient` guards the current chain.
- Historical gaps: a RESULT whose only suite is aggregated passing observations
  whose prefix never reached its summary stays eligible, and unstamped runs
  started between the date bound and a later deploy are missed. Both leave only
  a few decisions counted as eligible. A production query of how many historical
  decisions each rule matches was not possible here (no production MCP access in
  this session).
- Readings taken before this change asked these calls (or, after Group A,
  counted the RESULT kinds as `ineligible`); readings after count them in
  `excluded`. The two corpora differ, but offsets stay valid: the index space of
  `corpus.decisions` is unchanged.
- A reasoning design phase in an application build no longer sees the
  TypeScript policy; its tool-mode successors and the planners still do.
- The parent-suite line truncation in Decision's context stays open (above).
- A later edit can make the reformatted test files dense again.

### Owner decisions this touches

- TypeScript (2026-10-16): the policy is unchanged; the guidance now reaches
  tool-mode tasks only, and the decision doc says so. Reverting the one ternary
  in `taskContextLines` would show it to reasoning phases again.
- Decision calibration (2026-09-28): the set of decisions sent changes and the
  excluded ones are counted; no threshold or question changes.
- "Independent work MUST fan out" is documented as it stands. It still sits
  against the 2026-08-16 finding that fan-out is not always cheaper, and no
  live run has exercised the DAG; settling that is the owner's call.

### Completeness of this record

Groups A–E each give their defect, mechanism, tests and the incidents they
were checked against. Group C-runner records its countercases as reproductions
under Findings and as Rejected alternatives rather than under a countercase
heading. Group D's heading gained the "Group" prefix for consistency; nothing
linked to its old anchor.

## Second review

A second adversarial review of this branch confirmed fifteen findings (each
verified twice, several reproduced on the branch). All were applied; where a
finding's suggested fix was narrowed, the reason is given. This section
supersedes the earlier text it contradicts: the `report-invalid` and
`exited-without-report` limit in Group A, the child-review open item in Group
D and the calibration date gap in Group F.

### What changed

- **A timeout in a window the copy shortened was blamed on the code.** One
  deadline covered the copy and the child, so the child got what the copy
  left, while core relabelled a timeout as the host's only when the run
  deadline had clamped the request, and the text said "killed after 120000
  ms". Now core grants `PARENT_TEST_TIMEOUT_MS` plus a 60 s copy allowance
  (`PARENT_TEST_SNAPSHOT_ALLOWANCE_MS`) under the same one deadline; the runner
  caps the child at 120 s and reports the window it had (`windowMs`); core reads
  `timeout` as the code's only when that window was the full 120 s, and any
  other as `deadline-timeout` (review). The details name the real window. A
  hang now costs up to 120 s plus the copy, not 120 s in total. Four findings
  (two on each file) described this one defect.
- **Details cut mid-JSON keyed the repeat tracker on the array's head.** The
  runner sliced the serialised outcome at 8,000 characters; `failingExcerpt`
  then fell back to the first 300 characters, and failing sets {a, c} and
  {a, e} produced one key. `runnerDetails` now keeps one valid JSON array
  within the bound: failure messages shrink first, then tests that did not
  fail leave, then failing tests past the budget, each omission a counted
  `Host:` note. Host notes are no part of the key. Strings are normalised
  before encoding, not after.
- **The stylesheet stub read the specifier.** A tsconfig `paths` alias or a
  package `main`/`exports` naming a `.scss` file reached `vite:css`, which
  loaded the project's forging `sass` into the coordinator and turned a wrong
  `add` green. The stub is decided on the resolved id. The three new forger
  tests fail on the previous worker and pass now.
- **A directory under a name the host writes turned a red suite into a host
  fault.** `rmSync` without `recursive` threw EISDIR, which became
  `runner-error` (review). The host now removes `pnpm-workspace.yaml`, the suite
  file and the report path whole before writing them with `wx`. A report path
  that is not a regular file after the run is the new subject cause
  `report-tampered` (reject): the host cleared it, so only code under test made
  it a directory or a link. A suite file replaced by a directory is
  `source-changed`, no longer a thrown `runner-error`.
- **Causes the child can provoke were reviewed as host causes.** Code under
  test can kill the coordinator (`process.kill(process.pid)` is not confined by
  the permission model), which yields `exited-without-report`; an imported CLI
  entry calling `process.exit` is the ordinary, non-adversarial case.
  `exited-without-report` and `report-invalid` are now `reject-once`, coached
  to keep entry-point side effects out of imported modules, then reviewed.
  Narrowed: `snapshot-bounds` stays review, since a legitimate `node_modules`
  can exceed 100,000 entries and a rejection would be the wrong gate. The
  "awaiting owner confirmation" half of that finding was already settled by
  2b0629ff (decided under the owner's delegation), so only the classification
  of child-provokable causes changed.
- **A child-plan reviewer fault coached the planner and escalated.** The L3
  review of an L2 plan carrying suites ran on the 2,048-token validation cap
  and returned reviewer faults as rejections, so their fixed text coached the
  planner and three of them escalated and branched the child's type. A fault
  (unfinished, unparseable, unclassified) now re-reviews the same plan once on
  the root review's model and parameters. The round-one fix then threw a
  `ValidationError` on a second fault, which failed the whole dispatch and the
  run over a flaky reviewer. The follow-up returns it as a `reviewer` refusal
  instead: `superviseLoop` neither coaches it nor counts it in a repeat streak,
  and asks for the plan again inside the plan budget, which escalates as
  before when spent. Tests: tests/plan-review-fault.test.ts (fails with the
  loop's reviewer branch removed) and the child case in
  tests/delegation-contract.test.ts.
- **The delegation review's completeness guard became a denylist.** Only
  `max_tokens` and `pause_turn` refused; the Claude CLI returns
  `error_during_execution` with salvaged text, which jsonrepair closed into an
  approval. The guard is again `stopReason !== 'end_turn'`, now a `reviewer`
  fault (a re-review, not a replan). src/core/AGENTS.md no longer claims every
  transport speaks the Anthropic vocabulary.
- **The calibration cutover was a calendar date.** Unstamped traces written by
  the deployed code after 2026-10-17 would have been counted eligible. The
  trace now carries `jevExclusionStamps` from the code that stamps; a trace
  without it is read by `historicalExclusion`, whatever its date.
  `JEV_EXCLUSION_STAMPED_FROM` is gone.

### Tests

- The consequence of every cause is pinned against a literal table
  (`Record<ParentTestCause, …>`, so a new cause fails to compile until it is
  decided), beside the existing agreement check between the gates and the
  safety net.
- Runner: the child's whole window with the allowance; a hang in a shorter
  window reports it and core reviews it; a directory under each reserved name
  keeps a failing suite failed; a replaced report path rejects; long failures
  stay valid JSON. Details unit tests reproduce the {a, c} / {a, e} collision.
- Root resume: the recorded approval is checked against a replica of the
  digest, then re-reviewed when the reviewing model, the root actor's version
  or id, the contract or the system prompt changed; a non-sequential remaining
  plan is asked for again with its reason, never reviewed, and three end the
  run. Each was confirmed by mutation (digest bindings removed, precheck
  always passing).
- L2 planning: a reply whose strategy parses and whose plan does not leaves
  the previous strategy in place, checked right after the failing call
  (confirmed by re-introducing the early commit). The earlier test no longer
  claims to show it.
- Delegation review: an `error_during_execution` reply is a reviewer fault at
  the root and at the child; a child fault is re-reviewed on tier 2; two
  faults throw from `superviseLoop` with no coaching, failure hook or branch.

### Remaining risks

- A child-plan reviewer that faults twice now fails the dispatch instead of
  costing the child a ladder; how often that happens is unmeasured.
- `reject-once` for an exit without a report spends one retry when the cause
  was the host's (an OOM kill, a runner crash); the repeat is reviewed.
- Traces from a deploy of this branch onward carry the marker; nothing
  backfills older ones, which keep the structural reader.

## Follow-up: An approved dependency landing with budget left opens remediation

Follow-up item 1 (G1), decided under the owner's delegation
(`memory/beta-rules-not-fixed.md`). It reverses choice (b) of group B.

### Finding

`runDepthTask` (`src/run/depth.ts` at `522d79a2`, lines 461-484) returned
every approved root result as it was. An approved result carrying
`blockedPhases` — dependents that never started because a producer did not
complete with passing checks — therefore ended `partial`, and the clock it had
left went unused. That is reachable: the reject gate refuses a `failed-suite`
blocker mechanically, but an `unverified` or `landed` blocker reaches a
validation call, and `DEPENDENCY_LANDING_GUIDANCE` tells the judge not to
refuse for the missing dependents.

Unlike a budget landing, these dependents were held back while the clock still
ran. The 2026-09-21 record (`records/incidents/progressive-runs-2026-09-21.md`)
settled the cost question for exactly this shape: opening work that might be
cut is the cheaper error.

The design's two adversarial critiques found a second defect in the same
loop, older than G1 and made worse by it. A follow-up pass that failed on its
own (not the deadline) rethrew, the attempt rethrew in deep mode, the run
recorded `failed`, and `previousSeedRun` skipped it: `6ab0ae3b`'s loss, now
reachable after an approval too.

### Mechanism

- **One test for a pass.** `passLeft(ctx, remediations)` is the refusal's old
  condition and now gates both cases: not aborted, `MAX_ROOT_REMEDIATIONS`
  not spent, not `outOfPhaseBudget`.
- **The approved branch.** The pass opens only for a PURE dependency landing
  (`!budgetLanded`: a phase the budget cut means the clock is the binding
  limit, even with the signal not aborted), only in deep mode (a short
  attempt that deepened during the follow-up would archive the approved
  workspace in `restart`), and only while `passLeft`. It counts
  `landing-remediation`, not `root-remediation`, so "Sent back by the final
  review" (`showcase.ts`) stays true.
- **The earlier pass.** `refused` became `prior`, refused or approved.
  `previousAcceptance`/`previousEvidence` are passed in both cases (run
  5dff35b0's recheck), and `onApproved` hears the earlier reasoning as
  feedback only when it was a refusal.
- **Every exit after a judged pass lands on it.** In the catch around
  `handle`, anything but a `PhaseBoundaryPause`, a deepening or an explicit
  cancellation returns the earlier pass:
  - refused: `markRefused(prior)` with "— the remediation pass was cut by the
    run deadline / failed (<ErrorName>) before it completed";
  - approved: `followUpLanded(prior)`, which appends the follow-up's planned
    root phases to `unfinishedPhases` (so `landingReasons` reports them as
    budget-unfinished and the next run reads typed facts), or, with no root
    plan yet, only adds a summary note.

  Only the error's `name` enters typed fields; the message stays in the
  trace. An acceptance of the follow-up that fails before the deadline
  returns `markRefused(followUp)`: its work is in hand and is kept, never
  delivered. Each of these counts `unjudged-remediation`.
- **Lessons follow the last verdict on their work.** An approved landing's
  lessons, the root's own included, are HELD. The follow-up approved: both
  passes' lessons go in the run's one enqueue (`skill_learning_jobs.run_id` is
  the primary key). The follow-up refused: both are dropped (fc2a68cf's rule:
  the refusal judged a workspace holding the earlier work). No verdict: the
  held lessons are saved under the finalization window, the follow-up's are
  dropped. `persistApprovedLessons` puts the current pass first, so the
  stable per-tier sort keeps the later pass on a tie and otherwise the longer
  feedback; a task lesson is kept once per (owner, child, task).
- **The follow-up's task.** `remediationTask` sets `rootAcceptanceRefusal`
  only after a refusal. After an approval it keeps every criterion: a landed
  approval's criterion judgements are never checked against coverage
  (`consistentWithCriteria` returns early on a landing), so filtering on them
  could drop the criteria of the blocked phases. `rootDependencyLanding`'s
  instruction depends on the verdict and never names it, so the next judge is
  not anchored on its own approval; an approved landing with no failing check
  (a `landed` blocker) gets a variant that says nothing of checks.
- **Report-blind reviewers.** `REMEDIATION_INPUTS`
  (`src/contracts/runLanding.ts`) is the one list of host inputs about the
  earlier pass. `reviewAcceptanceCriteria` and `textReviewReference` both
  strip it. Before this, `rootDependencyLanding` — failure details included —
  reached both reviewers, which kept hand-copied lists.

### Behaviour changes on the refused path

Two, recorded because they change runs that never see an approval:

- A remediation pass that fails on its own now lands refused on the refused
  pass instead of failing the run.
- A refused DEPENDENCY landing no longer gets `rootRemediationScope`, even
  with exactly one unmet criterion: "keep the deliverables, re-run the checks"
  contradicts "complete the phases that never started", and the scope's
  evidence (cc922a60, ed84d7be) came from complete deliveries.

### Countercases checked

| Record | Outcome |
|---|---|
| progressive-runs 2026-09-21, "the cheaper error is to try" | Supports opening the pass; its 60 s floor is reused, stated as unmeasured for a root pass |
| 6ab0ae3b, a failed run seeds nothing | Every exit after a judged pass returns a result, on both paths |
| 2026-09-25 review 1.2b | Extended to an approved earlier pass, with typed follow-up phases |
| dfa20873, `landedBeforeAnyPhase` | Its guard is now `!prior`; unchanged otherwise |
| 5dff35b0, recheck what the earlier pass listed | `previousAcceptance` passed for an approved earlier pass too |
| fc2a68cf / 2026-10-09 lessons rule | Held lessons follow the last verdict on their work |
| `learningQueue` primary key | One merged enqueue, proven on a real queue |
| bad74240, L3 retry of landed branches | Not reintroduced: this is the depth runner's existing whole-root pass; the cell ladder still runs once |
| cc922a60 / ed84d7be, single-criterion scope | Suppressed only for dependency landings |
| Short mode, `restart()` archives the workspace | Deep-only guard |
| Mixed landing with the signal not aborted | Explicit `!budgetLanded` condition |
| Explicit cancellation during the follow-up | Still rethrows; teardown records `cancelled` whatever the depth runner returns, so the seed is forfeited — documented |

### Rejected alternatives

- **`markRefused` on a cut follow-up after an approval.** Nothing judged the
  follow-up, so a typed "refused at delivery" would be false and would show
  refusal copy to the customer. The typed `unfinishedPhases` follows
  `landedBeforeAnyPhase`'s precedent.
- **A typed "why no pass" field for the analyst.** The digest reads the
  trace, not stats, and the trace already holds the evidence: a second root
  `acceptance` event marks an opened pass.
- **A root-pass floor now.** It would be an unmeasured threshold.
  `unjudgedRemediations` counts every extra pass the 60 s floor let through
  and that then ended with no verdict; a floor gets proposed when that
  counter and the trace corpus can size it.
- **Keeping the earlier pass's lessons when the refusal cites none of its
  phases.** A prose-matching heuristic over model-authored text.
- **Unifying every report-blind input list.** `textReviewReference` may need
  run history as source material, and `EARLIER_LISTED_INPUT` is
  host-observed workspace fact; both are separate decisions.
- **A "skip when every criterion is met" gate on the approved follow-up.**
  That would be a new gate; the full criteria list is kept instead.

### Deviations from the design

- The analyst sentence is reworded so it cannot read as "a dependency landing
  that got its pass and ends partial is a defect": it says the pass opens
  whether the root refused or approved, that an APPROVED landing ends
  `partial` only when the pass could not open, and how a cut follow-up shows
  (summary note, planned phases unfinished), since a cut pass leaves no second
  `acceptance` event.
- A clock-bounded acceptance failure of the follow-up (the existing "could not
  finish within the landing budget" refusal) also counts
  `unjudged-remediation`: it is an extra pass the clock ended without a
  verdict, which is what the counter measures.
- T9 (a real `L3Atom` whose blocked dependent is written on the second pass)
  was not written; the approved landing needs an `unavailable` suite on an
  approved producer, a larger fixture than the depth-runner path already
  proves. The docs say the pass opens with the typed facts and do not claim
  it runs the blocked work.

### Tests

Mocked LLMs, through the real `runDepthTask`, `acceptRootResult` and
`remediationTask` (`tests/dependency-landing.test.ts` unless named):

- An approved landing opens the pass: two `handle` calls, the approved
  instruction and `notStarted`, no refusal or scope, the full criteria, not
  landed at the end, `landing-remediation` once, `onApproved` twice (second
  with no feedback), and ONE row on a real `LearningQueue` holding pass 2's
  tier-1 and task lessons and pass 1's tier-2 lesson. A second case pins the
  longer-feedback rule.
- Refused then approved landing: pass 2 returned, no third pass.
- Under a minute left, and a mixed landing with no deadline: one pass,
  `partial`, one enqueue. Short mode: one pass.
- Deadline cuts the follow-up after its root plan: pass 1 returned unrefused,
  its follow-up phase appended to `unfinishedPhases`, `blockedPhases` intact,
  `landingReasons` naming it, held lessons enqueued, pass 2's discarded,
  `unjudged-remediation` once. Cut before its plan: pass 1's typed fields
  unchanged.
- The follow-up throws `ValidationError`: the run does not fail; only the
  class name reaches the summary. After a refusal, a plain `Error`: refused
  with "…the remediation pass failed (Error) before it completed".
- The follow-up's acceptance throws: its result kept refused, no lesson saved.
  The follow-up refused: both passes' lessons dropped. An explicit
  cancellation during the follow-up still rejects.
- The existing no-deadline test now expects two passes and two approvals.
- `remediationTask` units: no scope for a refused dependency landing, full
  criteria after an approval, both approved instruction variants.
- `tests/criteria-review.test.ts`: the focused review, reached through
  `acceptRootResult`, and `textReviewReference` never see
  `rootDependencyLanding` or its failure details (fails without the shared
  list).
- `tests/analyst-host-instructions.test.ts`: the `p10` version and the new
  `partial` sentence.

Disabling the approved branch fails eight of these tests; reverting the
reviewer list fails the report-blind one.

### Limits

- A host fault that repeats (a runner error behind an `unverified` blocker)
  costs one wasted pass, bounded at one.
- A run that ended approved and `partial` can now end refused and `partial`
  when the extra pass breaks the approved work. The label is honest.
- The acceptance trace keeps pass 1's approval while a cut follow-up's
  unverified bytes sit in the workspace; the typed `unfinishedPhases`
  carries the truth, and the customer's `run.partial.blocked` copy still
  describes pass 1's plan.
- Mid-run, `runProgress` shows `acceptanceApproved: true` while the extra
  pass builds (unchanged).
- Both approved-landing instructions are prompt rules that had the
  adversarial pass above; neither is measured in production.
- The root-pass floor is unmeasured; `unjudgedRemediations` is how it gets
  measured.

## Follow-up: Matcher forging, leftover copies, suite aliases

Follow-up group G2, decided under the owner's delegation
(`memory/beta-rules-not-fixed.md`). It narrows F6 (group C-runner), bounds the
leftover copies, and closes the suite alias item from that group's limits.

### Findings

- **F6, restated.** Code under test runs in the suite's Vitest thread. Each
  of these turned a wrong implementation into `passed` on the runner at
  `522d79a2` (shown again in the tests below through a host-only seam that
  replaces the guard with a setup that only reports ready):
  - `expect.extend({ toBe: () => ({ pass: true }) })` at import (F6a);
  - a returned object with an `asymmetricMatch` method (F6b);
  - `Object.is` replaced, and `Object.is` replaced so that it restores itself
    after its first call (F6d), which a check after the run cannot see;
  - `Object.hasOwn` replaced (equality lists keys through it);
  - `Function.prototype.call` replaced so that a custom tester answers "equal";
  - the Map iterator's `next` replaced so that the next Map walked looks
    empty, on two Maps of the same size;
  - **expected-side and prototype forgery**: `Array.prototype.asymmetricMatch`
    makes every array in the EXPECTED value a matcher, against a primitive
    actual value (`expect(3).toEqual([5])`) or nested (`{ v: [5] }`);
  - `test.each` or `vi.fn` replaced (`test.each` is a writable data property:
    `createChainable` runs `Object.assign(chain, fn)`);
  - a matcher name the suite defines, re-registered by the code under test
    after the suite's own `extend`.
- **F6c** (`afterEach(ctx => { ctx.task.result.state = 'pass' })`) rewrites
  the runner's own record, below any assertion: not addressed, a residual.
- **Snapshots were written.** Vitest resolves `updateSnapshot` to `'new'`
  outside CI and the coordinator passed no `update`: a first run wrote the
  snapshot, and a child-written `__snapshots__` file supplied the expected
  bytes.
- **Leftover copies.** The runner's SIGKILL timer lives in the runner. A hard
  exit of the runner (SIGKILL, OOM) left its `atoma-acceptance-*` copy and its
  coordinator, `detached`, running until its Vitest finished.
- **Suite aliases.** A suite importing a tsconfig `paths` alias stayed red
  ("the suite module did not load") while the modules it imported resolved
  the same alias.
- **Found while testing on the packaged runner:** importing `sandbox.ts` into
  the coordinator failed under `--permission` on Linux (its module-level probe
  of `/proc/self/fd` is refused), and the compiled guard's source map names
  `src/` files the thread may not read: Vitest, mapping a failing assertion's
  stack through it, reported the test `pending` with no failure. Neither shows
  on macOS from source; both were caught by the container test before commit.

### Mechanism

- **`src/tools/parentTestSetup.ts`**, a Vitest `setupFiles` entry the
  coordinator adds. It runs in the test thread before the suite module, so
  before any code under test, and:
  - saves every built-in it uses and calls them through the saved
    `Reflect.apply`, never `.call`;
  - reads both nonces from the provided context and deletes them there;
  - records the watched (object, key) pairs, present (data value or getter
    identity) or absent: the built-ins of `src/contracts/assertionIntegrity.ts`
    by owner, the symbol-keyed iterators, the iterator prototypes' `next`,
    selected global bindings, `asymmetricMatch` absent from every intrinsic
    prototype, `Symbol.hasInstance` absent from the watched constructors and
    `Symbol.toStringTag` at its baseline;
  - registers the prototypes of Vitest's own asymmetric matchers (from samples
    and from each factory in the asymmetric table) and freezes them;
  - wraps every function-valued member of `chai.Assertion.prototype` but
    `constructor` and `assert`, each chainable method's behaviour, and every
    property getter: a sticky violation rethrows; the wrapper scans the actual
    value (any asymmetric node is a violation) and the arguments (an
    asymmetric node Vitest did not make is a violation), checks the watched
    pairs, runs the matcher, and checks them again. Identity and type matchers
    and Vitest's own `withTest`/`withContext` are not scanned; getters are
    checked, never scanned;
  - guards `expect.extend`: a built-in name is dropped silently, a taken name
    is tagged unless its matcher has the same source text (a re-registration),
    a new name is wrapped, locked and its matcher prototype registered;
  - refuses `addEqualityTesters` and `addSnapshotSerializer` with the tag and
    freezes the testers list;
  - locks (non-writable, non-configurable, never `preventExtensions`) the
    Assertion prototype, the chainable table, the matcher tables, `expect`,
    `expect.not`, `chai.expect`, the four `Symbol.for` slots, `test`, `it`,
    `describe`, `suite` and `vi`, and each test's own `expect` in a setup
    `beforeEach`;
  - writes the tag to stderr when it first fires, through Node's primordials,
    because a forgery that breaks Vitest's runner can lose the report's copy,
    and rethrows it from an `afterAll` when the code under test swallowed it;
  - reports `[atoma-integrity-ready:<setup nonce>]` on stderr once installed.
- **Nonces.** The runner draws two (`randomBytes(16)`) and writes them with
  the window on the coordinator's stdin, one JSON line; the coordinator
  passes them as `provide`. Neither appears in argv or env.
- **Host reading**, after the report checks and before `passed`: the guard tag
  anywhere (a module message, a failure, the coordinator's output, the raw
  report) gives `unavailable` / `assertions-tampered` with the report's
  counts and a host note naming the first tagged line; the setup tag gives
  `runner-error` only in a module message with zero tests; a run whose guard
  never reported ready (watched as the stream arrives, so flooding the output
  cannot hide it) gives `runner-error`. Both tags and the ready marker are
  normalised to fixed strings: the repeat key stays byte-identical.
- **Consequence.** `assertions-tampered` joins `SUBJECT_CAUSES` (reject) with
  coaching that names patched built-ins, extended or replaced matchers and
  `asymmetricMatch` objects.
- **Plan-time suite check** (`src/atoms/parentSuiteCheck.ts`, called from
  `enforceParsedDelegationReview`): a TypeScript parse of every suite; a
  refusal of kind `plan` names custom equality testers, snapshot serializers,
  file snapshots, hand-made `asymmetricMatch` members, an `expect.extend` of a
  built-in name (`VITEST_BUILTIN_MATCHERS`, pinned and compared with the live
  prototype by a test) or of one name twice, and `vi.spyOn` on a watched
  built-in (the same contract list the guard reads). Resumed roots re-run it.
- **Coordinator.** `update: 'none'`; `__snapshots__` joins the reserved paths
  the host removes; the guard and its contract load without their compiled
  source maps; the coordinator exits on its stdin's end and at its window
  plus 5 s.
- **Copies.** `atoma-acceptance-<pid>-<suffix>`. The first verification per
  process and temporary directory starts `sweepStaleCopies` after its own copy
  is gone, unawaited: matching names only, real directories owned by this
  user, owner dead (`kill(pid, 0)` gives ESRCH) and 10 minutes old, inside
  the snapshot slots, at most 32, errors logged.
- **Suite aliases** (`atoma:suite-aliases`, the coordinator): for a bare
  specifier imported by the suite, project source found through the suite's
  relative imports wins over a different direct resolution (TypeScript's rule
  that `paths` beat packages, the subject's own); otherwise the direct
  resolution; otherwise each root `tsconfig*.json`, `tsconfig.json` first,
  read as data by rolldown's resolver, with a host note when another one
  decided or two disagreed. Every candidate found this way must lie inside
  the copy (`containedIn`, now in side-effect-free `containment.ts`), and goes
  back through Vite so the stylesheet stub still applies.

### Measurements

Measured on macOS from source, the same suite with the guard and with the
unguarded seam, two runs each:

| Assertion | Guarded | Unguarded |
|---|---|---|
| `toBe` | 22 µs | 4 µs |
| `toEqual`, 3,000 nodes | 0.79 ms | 0.37 ms |
| `toEqual`, one key | 17 µs | 4 µs |

Each full runner process stays about 0.3 s on these fixtures.

### Deviations from the design

- **A ready marker.** Not in the design. Without it, a guard that failed to
  load untagged (a missing nonce, a Vitest bump) made the suite module fail
  and read as the child's `failed`, and a guard that silently did not run
  passed everything unwatched. A missing marker is now `runner-error`. It is
  watched as the stream arrives, so a subject flooding its output cannot push
  it out of the kept tail and launder a rejection into a review.
- **A re-registration with the same text is not tagged.** The design tagged
  every taken non-built-in name, which tags an honest suite that calls
  `expect.extend` in `beforeEach` or inside each test. The cost is a residual:
  a subject that reads the suite file and registers its matcher's exact text
  first is read as a re-registration.
- **The actual value's scan is stricter than the expected side's.** Any
  asymmetric node in the actual value is a violation, Vitest-made or not: the
  design accepted registered function identities, and a subject can return
  `expect.anything()` itself, or `{ asymmetricMatch: Anything.prototype.asymmetricMatch }`.
  Genuine is decided by prototype, never by function identity.
- **Hand-made `asymmetricMatch` objects are refused at plan time.** The
  runtime cannot tell the parent's from a forgery, and would have blamed the
  child.
- **Property getters and chainable methods are wrapped too** (`.to.be.empty`,
  `.to.include`): they run assertions outside the function-valued members.
- **The watched lists live in `src/contracts/assertionIntegrity.ts`**, read
  by both the guard and the plan check, so the refusal and the detection
  cannot drift. The thread is granted read access to that one file.
- **`containedIn` moved to `src/tools/containment.ts`** and is re-exported by
  `sandbox.ts`: one home, importable under `--permission`.
- **The guard's compiled source maps are dropped** by a coordinator `load`
  hook (found on the packaged runner, above).

### Adversarial review of the new gates

- **Plan check.** A false positive needs an honest suite that uses an API
  which cannot work in this runner anyway, or a `vi.spyOn` on a watched
  built-in, which the guard would report. Names in strings and comments are
  never read, a key passed as a variable is read as unknown and refused only
  on a watched owner, and a source that does not parse is never refused. A
  false negative is obfuscated access (`expect['add' + 'EqualityTesters']`),
  which the runtime tags. A resumed plan that uses a refused API is refused on
  resume: acceptable in beta.
- **Setup tag.** Only the setup's block knows its nonce, no closure keeps it,
  and it counts only with zero tests; a subject that extracts the guard nonce
  and forges the setup tag is still `assertions-tampered` (tested).
- **Tags in output.** A subject can print the guard tag: it can only reject
  itself. It cannot print the ready marker without the setup nonce.
- **Locks.** Every honest suite in the matrix (`test.each`, `describe.each`,
  `test.for`, `vi.spyOn`, fake timers, `expect.poll`, `expect.soft`, inline
  snapshots, a context `expect`, custom matchers positive and negated) passes
  with the locks in place.
- **False alarms that remain:** a forced polyfill replacing a watched built-in,
  and a value under test that is itself an asymmetric matcher unless checked
  with an identity matcher. The details name the property.

### Tests

- `tests/parent-tests-integrity.test.ts`, through the real runner: three
  honest suites pass (the broad matrix, fake timers with spies on `Date.now`
  and `JSON.parse`, a Proxy over a Map and a 20 MB typed array); ten forgers
  pass unguarded and are `assertions-tampered` guarded, each naming its
  property; a forged setup tag stays tampering; `test.each` and `vi.fn`
  replacements pass unguarded and fail honestly guarded; an extend of `toBe`,
  caught lock errors and a child-written `__snapshots__` stay honest reds;
  tampering repeats byte for byte without a nonce; neither nonce reaches the
  suite; the seam's setup tag and a silent setup are `runner-error`.
- `tests/parent-suite-check.test.ts`: each refusal, the admitted APIs, strings
  and comments, a parse failure, the pinned matcher list against the live
  prototype, the delegation review's `plan` refusal for a subtask and a plan
  suite, and a root plan replanned three times before any child runs.
- `tests/parent-tests-observations.test.ts`: `'assertions-tampered': 'reject'`
  in the compile-enforced table, and its coaching.
- `tests/parent-tests-snapshot.test.ts`: the sweep matrix (a dead old copy
  removed; an alive owner, a fresh copy, this pid, old-style and `-image-`
  names, a matching link with its target and a matching file kept; 32 per
  sweep), a hard exit (a forked runner killed while its suite spins: the
  coordinator is gone within 20 s, and the aged copy is removed by a later
  verification), and six suite alias cases (include-scoped, solution-style
  with its host note, a nested package through a proxy, project source over a
  same-named package, an alias leaving the project, a stylesheet alias with a
  forging `sass`). Run against the runner at `HEAD` before this change, the
  four resolving alias cases and the hard exit fail, and the two refusing
  alias cases pass; nineteen of the integrity tests fail there and the four
  that pass are the three honest suites and the nonce check.
- `tests/container-isolation.test.ts`, on the packaged image (dedicated tag):
  a forged `Object.is` is `assertions-tampered`; the existing two cases pass.
- `tests/container-image-closure.test.ts`: the setup file is an entry, and
  the guard's contract and `containment.ts` are reached.

### Limits

- **F6 is narrowed, not closed.** The residual list lives once, in
  [the protocol](../../docs/decisions/parent-owned-tests-2026-10-16.md):
  runner records (F6c), stateful evasion, mocks passed into the subject,
  values a matcher obtains itself (a thrown error), expected values taken from
  the subject, built-ins outside the watched set, a copied matcher text, a
  leaked guard nonce.
- **Leftover copies are bounded:** a later verification in a process sharing
  the temporary directory removes a copy whose owner is dead and which is at
  least 10 minutes old. A machine that never verifies again keeps it.
- **Suite aliases are closed** for tsconfig `paths`; aliases defined only in
  `vite.config` stay unsupported.
- **On every vitest, vite or rolldown bump**, re-run
  `tests/parent-tests-integrity.test.ts` and the matcher-list drift test, and
  re-derive the watched set (D9).

## Follow-up: Spent ladders that are not recognised

Follow-up item 4 (G3), decided under the owner's delegation
(`memory/beta-rules-not-fixed.md`). It closes the two Limits of group B on
the ladder.

### Finding

The ONE LADDER PER ROOT PHASE rule (aa6b2956, run bad74240) read
`producedBy` and, since group B, the landing-only `ownFallbackBlockedBy`.
Two shapes slipped through, both already recorded under group B's Limits:

1. **`[A, C]` with no dependencies.** The cell's supervise loop over A spends
   its retries and its branch, then returns the cell's own fallback, which
   nothing validates. C is approved. Nothing lands, the aggregate is rebuilt
   as `producedBy {tier 2, cell, viaFallback: false}`, `ladderSpent` was
   false, and the tissue re-ran the whole phase, A's ladder included.
   `[A, B dependsOn A]` and `[A, C, B dependsOn A]` handed up after one ladder;
   `[A, C]` did not. The ladder that ran was the same.
2. **A mutualized peer.** `X.execute` returns `peer.handleDirect(task)` as it
   is. The peer's ladder and fallback run, and the result names the peer, so
   the tissue retried X, X mutualized again, and the peer's ladder ran twice.

**Evidence status.** bad74240 is an N=1 shape. No incident has been observed
on `[A, C]` or on a mutualized peer: the `[A, C]` reach lands by analogy, and
a count is pre-registered with a revert rule (below). The relay widens
nothing: it applies whichever rule already governs the peer's own result.

### Mechanism

- **One writer.** `superviseLoop`'s fallback return (`src/core/supervisor.ts`)
  stamps `spentLadder: { by: parent.name, on: [task.description] }`. It is the
  only point that proves a ladder ended. `producedBy.viaFallback` does not:
  `selfExecute` stamps it on every path, including `execute()` with a null
  `pendingStrategy` and `execute()` while `fallbackMode` is set — which an
  in-flight peer can be, since `l2Peers` holds instances still running in
  parallel root lanes.
- **Carried.** `withSpentLadder(aggregate, subResults, atomName)` puts the
  union of the sub-results' stamps naming the aggregating atom back on an
  aggregate that the sequential, concat and `llm-synthesize` modes and
  `keptWithoutSynthesis` rebuild. The N=1 pass-through keeps it by itself.
  Applied in L2 and L3 `execute`, beside `withOwnFallbackLoopFacts`, before
  `markLanded` and `verifyParentTests`, which spread it through.
- **Relayed.** `relayPeerLadder(result, peer, relay)` re-addresses a stamp
  naming the peer to the mutualizing cell, keeping the first peer in `via`.
  Applied on the mutualize branch of `L2Atom.execute` and in `mutualize()`.
- **Read.** `ladderSpent(result, cell)` is `result.spentLadder?.by === cell`:
  N=1, `[A, C]`, a landing and a relay read one fact.
- **Only under root acceptance.** `RunContext.rootAcceptance`, set by
  `runDepthTask` on the attempt context and forwarded by `forkBranch`, is the
  condition for installing `handUpRefused`. A run without depth (the baseline
  and comparison arms) has no judge, and a phase handed up there was delivered
  as if successful; it now retries as before aa6b2956.
- **The clause** is rendered from the stamp: `<by>'s ladder ended in its
  last-resort fallback on "<on…>"` (each item cut at 120 characters, three at
  most, then "and N more"), `(in <via>, to which <by> delegated this phase)`
  when relayed. It no longer claims "retries, branch" when no branch existed.
- **One provenance predicate.** `isOwnFallback(result, atom)`
  (`viaFallback` under that atom's name) replaces the copies in
  `dependencyBlocker`, `withOwnFallbackLoopFacts`, the `unvalidated-fallback`
  gate and the tissue's DIRECT framing. `verdict.ts` (DIRECT framing on any
  `viaFallback`, deciding the plan kind) and `L2Atom`'s "never learn from any
  fallback" are different concepts and stay.
- **The gate.** `unvalidated-fallback` also fires on a stamp naming the child,
  with its own text: `part of this result (<on>) is <child>'s own last-resort
  fallback[, run in <via>], which no supervisor has validated`. A fast path
  could otherwise approve an unvalidated fallback because it was only part of
  a larger result (1d42ac2a's hole, for aggregates and relays).
- **Removed.** `ownFallbackBlockedBy`, `DependencyRefusal.ownFallbackOf` and
  `markLanded`'s derivation. A blocked root cause is always kept among the
  dispatch's results (dfa20873) and carries the supervisor's stamp, so the
  stamp covers what the old derivation did.
- **Never persisted.** The runner persists an explicit field list and the
  checkpoint stores `output`, `summary` and `producedBy` only.

### Why this does not starve a healthy phase

The counter refused in aa6b2956 stopped work before any rung was spent,
handed up a fragment and left lanes running after its throw. This rule counts
nothing — every subtask keeps its whole ladder — fires only after a fallback
rung ran, hands up the whole aggregate, and is read in `handUpRefused`, after
the dispatch settled.

### Countercases checked

| Record | Outcome |
|---|---|
| bad74240 / aa6b2956, N=1 | One ladder under depth; the stamp replaces the `producedBy` check. |
| The refused counter | A phase whose subtasks were approved and that the tissue refused once runs again (test). The whole phase goes up; nothing throws. |
| Group B landing shapes | Unchanged: `[A, B dependsOn A]` and `[A, C, B dependsOn A]` still hand up once. |
| 1d42ac2a | The gate now also reviews a fallback that is part of an aggregate or a relay. |
| Depth short mode | A tier-2 fallback (a peer's included) deepens before it runs, so no stamp is written. |
| `trust-fastpath.test.ts` loop facts | Not relayed; unchanged. |
| Comparison and baseline arms | The pre-aa6b2956 tissue retry is back; that is their registered protocol. `dependency-landing-runner.test.ts` (a comparison run) still ends `partial` with the same held-back entry, now after the tissue's retries. |

### Adversarial review

- **The tissue's refusal may be about C**, whose ladder never ran out. It
  goes to root review and the depth remediation pass, and later root phases
  build on it first, as they already do for N=1. A quality risk, not only an
  unproven gain: the pre-registered count and its revert rule cover it.
- **Root dependents are held back more often** only where the predecessor
  also carries a suite that did not pass: group B's predicate.
- **The widened gate** is requires-review: one validator call where a trust
  fast path would have skipped it, only when a fallback contributed.
- **The prompt text** (the clause and the gate's partial reasoning) is
  rendered from typed data, true in every case, and bounded.
- **Provenance** is never rewritten: a relayed result still names the peer.
- **An in-flight peer** answering in `fallbackMode` walks no ladder and is
  never relayed as spent (test).

### Rejected alternatives

- Counting fallbacks, or one more tissue retry: the refused counter.
- Recognising only a suite-failed fallback: bad74240 had no suite.
- Re-dispatching only the subtasks that did not fall back: a fragment.
- Attributing the tissue's refusal to one part: parsing prose.
- `ladderSpent` reading `cell.peers`: a peer never used for this phase.
- Rewriting the mutualized `producedBy`: false provenance.
- Deriving the stamp from `viaFallback`: false positives on the null-strategy
  and in-flight peer paths.
- Refusing a spent phase in the no-depth epilogue: removes the retry for
  nothing in return.
- Reusing `deferredLearning` as the root-judge signal: one field, two concepts.
- Making the cell validate its own fallback: a protocol change.

### Deviations from the design

- **A's executions are counted as tier-1 executions not by C's molecule.**
  The cell's escalation branch is a new type with a new name, so counting by
  A's molecule name would miss the branch's three executions.
- **The no-root-acceptance tests let the tissue approve its second verdict**,
  so the retry is bounded; the mutation (dropping the condition) fails both.
- **`forkBranch` forwards `rootAcceptance`**, with a propagation test:
  forkBranch enumerates fields, and an unforwarded flag is silently absent.
- **The runner test is a new file** (`tests/spent-ladder-runner.test.ts`)
  driving `startTask --depth deep`: short mode's root is a cell and deepens at
  a tier-2 fallback. The in-memory stamp is read from a spy on
  `L3Atom.prototype.handle`, because `startTask` owns the executor.
- **`spentOn` is exported** so the clause and the gate render `on` the same way.

### Tests

- `tests/phase-budget.test.ts`:
  - `[C, A]` without dependencies, A ending in the cell fallback, the tissue
    refusing, under `rootAcceptance`, for sequential, concat and
    `llm-synthesize`: one cell plan, one cell fallback-plan, six executions of
    A and one fallback, one of C, one synthesis only in `llm-synthesize`, one
    tissue verdict, `phaseBudgetSpent`, the clause naming A, both parts in the
    summary. Without `withSpentLadder` in L2 all three fail.
  - Starvation: both subtasks approved, the tissue refuses once — two cell
    plans, no fallback, no `phaseBudgetSpent`.
  - No root acceptance, `[C, A]` and N=1: the tissue retries. Installing the
    hook without the condition fails both.
  - A mutualized peer: sequential root plan (asserted by call order), cell #1
    mutualizes P2 to cell #2, whose fallback runs once; the clause names the
    peer. Without the relay, cell #2's fallback-plan on P2 runs three times.
  - An in-flight peer in `fallbackMode`: no stamp, `ladderSpent` false.
  - Units: `withSpentLadder`, `relayPeerLadder` (a two-hop chain keeps `via`),
    `ladderSpent`, the clause in its own, relayed and bounded forms, and the
    gate's partial, foreign and whole cases.
- `tests/landed-run.test.ts`: rewritten to the stamp; `markLanded` never
  derives it.
- `tests/dependency-landing.test.ts`: the hand-up fixtures set
  `rootAcceptance`; the `runDepthTask` one does not, so depth sets it.
- `tests/spent-ladder-runner.test.ts`: `startTask --depth deep`, one root
  phase whose cell is `[CHANGELOG, add.js]` with add.js falling back. One cell
  plan, one fallback, one tissue verdict, `delivered` after the root review;
  the in-memory result carries `spentLadder`, the persisted one the prefix and
  never the stamp. Without `rootAcceptance` in `runDepthTask` the cell plans
  six times.
- `tests/branch-ctx-propagation.test.ts`: `rootAcceptance` through a double fork.

### Measurement (pre-registered, not run here)

This workflow may not call the production MCP; the count falls to the owner
or a session allowed to. Over production deep attempts since 2026-10-10,
count root phases where the cell plan had more than one subtask, a tier-2
`fallback-plan` ran, and the tissue then refused and retried. For each, record
whether the retry was approved and its wall time. Count mutualize strategies
separately.

**Rule.** If at least one in three such retries was approved, narrow
`withSpentLadder` back to an N=1 pass-through and a dispatch that landed with
dependents held back — the old reach. The relay and the root-acceptance
condition stay. Record the numbers here either way.

### Limits

- **`[A, C]` is unmeasured live**; the count above is pre-registered.
- **Mutualizing to a peer still in flight** is a pre-existing race:
  `handleDirect` overwrites `pendingStrategy` or inherits `fallbackMode`. It
  can no longer hand a phase up, but the wrong strategy can still be consumed.
- **Mutualize recursion is unbounded**, and the mutualize branch returns
  before `verifyParentTests`, so X's `plan.acceptanceTests` never run there.
  Both pre-existing.
- **The stamp can appear in the in-memory trace's `execute` payloads**, as
  `ownFallbackBlockedBy` could. It is never persisted.
