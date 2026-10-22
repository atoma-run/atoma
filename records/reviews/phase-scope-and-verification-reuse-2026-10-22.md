# Phase scope and verification reuse — 2026-10-22

## Trigger and decision

The owner requested the first two remedies from the Attica latency analysis:
keep phases within their assigned repair and avoid repeating successful
verification merely to complete a report, with regression coverage and no
weaker acceptance.

Production evidence was read through the Atoma MCP. In run
2df30c19-4bee-444f-a5da-205941d05252, refusals
35527d64-9bc6-421c-9b53-14aab413a47c and
9626b365-2f56-4be1-84b6-045adb9cad7b requested explicit suite/assertion
accounting. Three successful install/check/build sequences followed. Other
Attica refusals correctly identified changed source after verification,
missing final commands and deleted entrypoints. Those controls must remain.

## Implementation

- The one application policy in taskContext.ts scopes TypeScript migration
  and skeleton adaptation to requested implementation and necessary
  dependencies. Explicit whole-application migration remains valid.
  Inspection, verification-only and reporting do not become repair phases.
  Final-source check/build, effective coverage and functional acceptance stay.
- Proportionate planning names local repair with its focused regression as a
  coherent unit. It imposes no mechanical phase cap or sequentialization of
  independent work.
- The same verification-reuse guidance reaches planners, executors and
  validators through taskContextLines. Reporting omissions require inspecting
  recorded results and actual assertion bodies; missing execution, disputed
  behavior, changed relevant inputs or unknown freshness require verification.
- The existing AttemptDigest now keeps recent command results using the shared
  execution-observation parser, under count and byte bounds, with omissions
  explicit. Earlier failures remain visible while retained; the append-only
  production trace is unchanged.
- The digest reaches planning as well as execution. It survives reporting
  corrections in the same task, but never crosses run signal, executor,
  branch, depth attempt, read-only restoration or reasoning boundaries.
  No receipt becomes a new tool invocation, attestation or approval.

## Adversarial review

1. **Explicit full migration:** scope guidance must still honor a task that
   actually asks for it; it may not reduce that task to one module.
2. **Necessary transitive repair:** dependencies required by the demonstrated
   defect remain in scope. An arbitrary file-count or phase-count cap would
   refuse legitimate work; no such gate was added.
3. **Missing execution:** test titles, totals, reports and claimed hashes do
   not replace execution or relevant assertion bodies. The shared guidance
   states this and the root/parent test protocol is untouched.
4. **Changed inputs/environment:** the digest carries historical outputs,
   not a snapshot identity or a freshness attestation. It must never assert
   that a command remains valid merely because no edit_file was observed:
   shell commands, sibling work, fixtures and external state may change it.
   The real-process regression executes again after changing its source
   input; the new failure replaces the manifest entry and acceptance refuses.
5. **Zero-action retry:** earlier successful commands are not copied into
   toolCallResults. A new execution that only claims a pass still fails
   the existing observed-tool-action gate. Reading a receipt and assertion
   bodies is actual observed work, subject to ordinary semantic review.
6. **Failure then recovery:** bounded history retains both outcomes in order,
   rather than silently overwriting a failed command with its later pass.
   Omitted evidence stays explicitly omitted, and raw trace evidence remains.
7. **Prompt injection and malformed custom results:** raw outputs are encoded
   as JSON data. Serialization failure makes output unavailable instead of
   throwing from the observer or inventing a result.
8. **Parallel/deepening/run leakage:** the same task description is insufficient
   to carry a digest. Its runtime identities must match. Read-only phases
   retain no digest because restoration changes the state they observed.
9. **Credit:** current execution action witnesses and recorded-command flags
   remain current-execution only. Reusing observations earns neither new
   execution evidence nor an automatic skill extraction.
10. **Cost:** no extra model call, vote, replay or product store is added.
    At most eight recent command observations share 8,000 encoded characters;
    this context appears only on a same-task retry. Actual live latency
    improvement is not yet measured.

## Validation scope

The new production-path tests exercise L2 supervision, L1 planning/execution,
real record_probe child processes, the manifest, transport attestations and
the ordinary result gates. They distinguish report-only completion from a
changed source input and an unsupported zero-action claim. Existing
parent-suite, proof, ground-truth and root-acceptance suites remain required.

## Validation results

- Pinned Node v24.20.0, fresh npm ci completed successfully.
- Before the fix, the receipt/planning regressions produced six failures.
- The final focused run passed 243 tests across nine files, including real
  command execution, reporting-only completion, changed-source failure,
  zero-action rejection, parent tests, supervision and root depth acceptance.
- release:check:static passed: docs, both TypeScript configurations, lint,
  audit (zero vulnerabilities), build, skeleton checks and compiled smokes.
- The full npm run check reached 7,854 passing tests and 36 pre-existing
  skips, with two failures in container-isolation.test.ts: fresh.txt is not
  visible through the replaced Docker Desktop bind mount (line 86), and the
  allowed npm registry fetch times out (line 411).
- Both failures were reproduced by the same unchanged tests on a clean
  git archive of baseline 99d2c8ef, using the same installed dependencies and
  real worker image. No assertion, timeout or skip was changed. After the
  final wording-only digest cleanup, the focused tests and static release
  checks above were rerun successfully.
- No Atoma run or paid model replay was started. Tests establish the runtime
  context and protocol behavior, not a measured live model latency gain.
