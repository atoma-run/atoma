# Parent-suite execution ownership — 2026-10-21

## Observed refusal

Attica run `a99ef64e-ee8b-47b5-8afa-df7b6115671e`, review event `3343b9b4-2a42-471d-a18b-01bc60eaa387`, refused an L2 plan because it did not explicitly execute and report the parent acceptance suite. The same review said the implementation and local tests were well scoped. The plan already supplied real-module Vitest assertions for the new adapter, including search, empty search, parsed detail identity and refusal cases. Its child was asked to implement the adapter and run focused project checks.

The requested additional child command duplicates runtime work. `verifyParentTests` owns `atoma-verify`, its immutable suite input, fixed runner and observation. L2/L3 execute and result validation schedule it independently of worker prose. A worker's claim to have run it is not parent-test evidence. Planning already stated ownership, but the delegation-review request did not receive that paragraph. The reviewer consequently treated the worker's missing promise as a missing verification mechanism.

## Change and verification

One shared `PARENT_TEST_EXECUTION` block reaches both planners and delegation review. It states automatic scheduling, retains dependency installation and build prerequisites, preserves separately requested project/browser/CLI checks, and distinguishes a scheduled check from an observed pass. Runtime behavior, gates, verdict parsing and retry limits are unchanged. Changing the review text intentionally changes checkpoint approval digests, so old approvals are re-reviewed when resumed.

The new regression captures the production `L3Atom.validatePlan` request for an L2 implementation with a supplied suite and no child parent-suite command. It failed before the fix on the missing execution-ownership guidance. Existing request tests additionally capture both ranks' planning and root review. Four focused files passed 173 tests after the fix, including the real fixed runner, failed implementations, unavailable checks, incomplete suites, child tampering, imports and approval binding. No paid model replay was used; these tests prove delivery of the contract, not a measured improvement in future model verdicts.

## Adversarial review of the accepted mechanism

- A plan that omits a required suite still fails classified structural enforcement. The wording applies only to supplied suites; it grants no automatic approval.
- A suite importing stale or absent built output still needs an executable build prerequisite. The new block explicitly retains it. It does not authorize a supervisor to replay model-authored commands.
- Missing project checks, browser actions or CLI probes remain unmet when requested. A parent suite does not replace them.
- A failed, unavailable, cancelled or budget-cut check is not promoted to a pass. Existing runtime observations and result consequences remain authoritative.
- A worker cannot earn evidence by copying the suite or reporting its own invocation. The ownership and host-observed-result requirements remain explicit.
- Discovery still requires its assigned observations and implementation still requires discriminating tests; this does not waive either for the inventory-report churn seen in the earlier run.

This is a review of the mechanism and countercases by the implementing agent, not an independent reviewer or a claim that the current live run uses the change. The live run retains its original code generation.
