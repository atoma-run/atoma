# Parent-owned tests: design and adversarial review

Owner request: L3 owns per-L2 acceptance, reviews the tests L2 proposes for L1,
and uses its own integration checks. Useful independent L2 branches MUST run
in parallel, including when a later integration task joins them.

## Mechanisms reviewed

The existing loop remains the sole supervision protocol. Typed plan fields carry
checks; no lexical detector infers requirements. The scheduler extends parallel
aggregation with earlier-index dependencies, preserving existing sequential
handover and landing. Root output collision coaching ignores transitively ordered
writers. Routing cannot split a node holding tests or dependency references.

The canonical suite is host task data, copied and frozen at delegation. No model
result JSON can supply runtime observations. Verification uses a fixed tool-layer
runner; no model-supplied shell command or project config is replayed. The worker
receives a disposable copy and an allowlisted environment. Its Vitest child uses
explicit filesystem permissions and passes them to test threads without worker,
child-process or native-addon permission. An initial adversarial test caught that
Vitest otherwise discards execArgv, allowing writes back to the original project;
the production configuration now sets worker execArgv explicitly.

## Incident classes and counterexamples

Reviewed against the repository's historical evidence map and current atom/tool
contracts, rather than assuming every green check is product proof:

- August gate drift and September 27 layout false refusal: declaration and parent
  semantic review, no vocabulary classifier, no synthetic test for text work.
- Fan-out/fan-in August 16: separate L2 nodes; a ready dependent does not wait for
  an unrelated slow sibling. Bad/cyclic indices fail before dispatch. Shared
  outputs still require actual ordering.
- September 21 landings and October 10 spent phase ladders: preserve existing
  budget semantics and fallback observations; no new retry ladder or credit path.
- September 30 read-only phases and October 3 planning scope: run checks against
  the post-restoration state, never demand future-branch behavior in leaf suites.
- September 15 stale proof and October 3 stale files: snapshot digest labels
  historical observations, never claims proof of later bytes. L3 integration
  checks run after joining. No cross-run proof inheritance is introduced.
- September 24/27 fabricated evidence and October 9 missing execution: tests run
  actual imported TypeScript; an intentionally constant implementation fails.
  Workspace scripts/config cannot replace the harness; result JSON cannot supply
  observations; missing runner, wrong receipt, no tests, skips, only and timeouts
  cannot pass. Assertions and source accompany counts for semantic review.
- October 6 deterministic skill dispatch: the script still runs, but the same
  parent suite runs before validation and credit. Fallbacks are checked too.
- Worker import-closure and compiled-boundary incidents: include the separate
  test worker in the image closure roots and exercise the compiled worker image.
- Filesystem containment and credential incidents: sandbox-resolve the project,
  reject links escaping it, copy regular files, bound snapshot/report sizes,
  keep real HOME and parent secrets out, and clean owned processes on completion.

## Limits and rejected shortcuts

A model can still author insufficient assertions. Review must judge setup,
assertions, actual imports, negative cases and requirements; green is not semantic
approval. Do not add assertion-keyword gates or claim a live acceptance-rate gain.
There is no live project run in this change, and Attica remains stopped.

Node permissions are not a hostile-code OS jail. Container isolation remains
required for untrusted hosted applications. Existing worker network policy stays
in effect; external services must be mocked. Subprocess/native-addon/browser
checks are not supported inside this Node harness; existing probes remain.
Copying dependencies has a bounded but unmeasured production cost. Large projects
return unavailable rather than silently exclude source or dependencies. The
current checkpoint format still requires sequential root phases; DAG checkpoint
resume is not advertised. No new element, supervision loop, product store or
paid model call for test execution is introduced.

## Verification

The focused suite covers actual Vitest execution, wrong implementations,
configuration substitution, live-workspace writes, nested workers, subprocesses,
escaping links, missing reports, suite identity, fallback withholding, L3 review
and revisions, and dependency ordering. Broader verification is recorded in the
implementation session; no benchmark or production reliability claim is made.

Final local `release:check` passed: 6,691 tests passed, 11 skipped, 474 test
files passed and two files skipped. Both TypeScript configurations, ESLint,
documentation checks, audit, build and compiled release smokes passed. The fresh
`atoma-worker:parent-tests-check` image passed the dedicated real-protocol Vitest
regression (packaged runner, wrong implementation, live-workspace protection).
The container release smoke observed allowed npm-registry egress and denied
control-plane access. These checks used fixtures and no live Atoma project run.
