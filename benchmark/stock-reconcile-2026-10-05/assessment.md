# Warehouse run assessment — 2026-10-05

Run: `22af997d-1440-49b1-8b65-01c41f6ef7ad`. Production revision: `684500b92480079aeb6d257bbfb22ba5293abecb`. Published repository: `mgtf/atoma-stock-reconcile-20261005`, verified checkout `9655fa0b5a8b5342fdb38c0466f9e742c72aea00`.

The production record reports delivered: 332.642 seconds, eight LLM calls, $0.1388 subscription-equivalent accounting. All 77 events and complete paginated metadata are preserved in `live-evidence.json.gz`. The seven shipped subprocess tests also pass independently under Node 24.20.0. The fixed example succeeds. These facts do not establish full acceptance.

## Reproduced violations

`independent-checks.json` preserves exact inputs, expected success, exit status, stderr and produced stock for five independent CLI executions:

- A fully released reservation ID can be reused (required rejection, observed exit 0).
- The same reservation ID can be created for two SKUs (required rejection, observed exit 0).
- Event quantity `00` is accepted although positive quantity is required (observed exit 0).
- A valid quoted final field followed by another record is rejected as malformed quoting (observed exit 1).
- A new reservation ID equal to its event ID is refused, although the contract defines separate uniqueness constraints (observed exit 1).

Reservation validation checks event IDs (`seen`) instead of a global reservation registry. Quantity validation rejects only the literal `0`, rather than numeric zero. CSV parsing leaves `afterQuote` set after a record terminator.

## Evidence quality

The final root validator claims passing tests cover conflicting duplicates. The shipped test named “conflicts…” contains no conflicting duplicate case. Audit determinism is not compared across executions (only stock is compared). The quoted final-column test has only one event, so it misses the parser's next-record failure. Seven passing test names were interpreted as broader proof than the assertions support.

Earlier failures and corrections remain in the archive. Successful edits only repair test escaping, a missing fixture header and a malformed assertion; production CLI source was not repaired during this run. This is consistent with correcting erroneous tests, but it did not establish complete behavioral coverage.

This run uses one root phase and does not establish the new cross-phase observation handover in production. Its runtime cannot be used as a controlled speed comparison with earlier web runs.

## Conclusion

Delivered and published, but acceptance is false-positive. Next product work should address the validator's unsupported coverage claims with this archived incident and a regression on the actual validation path, rather than merely repairing the generated CLI or launching another run.

## Correction and exploratory replay

The root's actual prompt showed a 1,200-character test-file head followed by keyword-matched lines. The last matching line was `const cases=[`: the test names were visible but the relevant cases were not. Root read-back now preserves complete files up to 6,000 characters, with the existing four-file bound. Larger files retain the existing explicitly incomplete excerpts. No additional tool invocation or model call was added.

Shared executor/validator guidance now connects coverage claims to setup, actions, assertions and observed execution. Root criterion reasons ask for concrete evidence or missing proof rather than a 15-word label. The validator's older instruction to approve a “plausible” result based on a location was aligned with its evidence requirement.

The regression calls production `acceptRootResult` with the exact published test file and checks that the model receives its complete body. Its mocked refusal proves plumbing, not model behavior. The two archived source snapshots preserve the published bytes with `.txt` suffixes; `node benchmark/stock-reconcile-2026-10-05/reproduce.mjs` repeats the five independent CLI counterexamples in temporary directories.

Eleven tool-free calls used gpt-5.6-luna: three alternating baseline/candidate pairs on the archived production request, then five candidate controls. Baseline approved incorrectly 3/3; candidate refused 3/3, each naming the missing conflicting-duplicate test. All five controls matched expected decisions, distinguishing missing evidence, wrong refusal cause, a demonstrated defect, and two valid verification forms. Requests, responses, model usage and hashes are archived; see `replay-protocol.json` and `replay-summary.json`. Run the replay with the pinned Node runtime, `--import tsx`, and `ATOMA_REPLAY_CODEX_BINARY` naming the installed Codex binary. `--live` spends quota.

### Adversarial review and remaining limits

- No lexical coverage classifier or automatic rejection gate was added. Test names, criterion vocabulary and frameworks are not enforced. Equivalent direct observed checks can pass.
- Complete short files preserve context; long-file truncation remains explicitly unknown. Missing proof must not be described as a demonstrated implementation defect.
- No historical observation is promoted to fresh proof. No supervisor executes model-authored shell commands. Existing path restrictions and read limits remain in effect.
- These are development cases selected after the incident, not an independent reliability benchmark. Candidate criterion judgments still overstate some coverage, notably audit determinism. Refusing this run reliably in three replays does not show every defect will be diagnosed or every criterion judged correctly.
- The generated warehouse artifact is preserved as evidence, not silently repaired. A new production run after deployment remains necessary to test end-to-end remediation. No such run was started during this correction.

Local verification on Node 24.20.0: `npm run check` passed (408 test files passed, one skipped; 5,364 tests passed, nine skipped). `npm run release:check:static` passed, including audit, build and compiled release/auth/CLI smokes. The archived five-case reproduction passed. The short-file reader regression and the existing long-document excerpt regression both pass.
