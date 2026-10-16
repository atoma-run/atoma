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
  still blocks its dependents; B's predicate is `parentTestFindings(r).reject`.

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
