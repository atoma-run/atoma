# Parent-owned tests and parallel branches

Owner decision 2026-10-16: L3 MUST delegate useful independent branches to
multiple L2s in parallel. L3 owns per-branch acceptance and final integration;
L2 proposes its L1 contract tests, which L3 reviews before that branch executes.
Reviewed test revisions require another review; rerunning unchanged checks does
not. Test execution is runtime-owned, not direct supervisor tool use.

Implementation contract: [decision](../docs/decisions/parent-owned-tests-2026-10-16.md).
Typed `acceptanceTests` and earlier-index `dependsOn` extend the existing plans
and shared supervision/dispatch. The fixed Node Vitest runner uses disposable
copies. Non-code, real-browser and subprocess checks retain appropriate probes.
Attica test `fec4ef6a-e0a1-4227-ae5b-21cdd307da63` exposed root plans without
executable tests and a fictional prose-only post-inspection replan. Cancelled
before implementation, 0.3236 USD subscription equivalent. Owner explicitly asked
to fix, push/deploy, start a new Attica run and follow it. The correction adds
mandatory classified root review, structural checks on required suites and
parallelism, and one host-driven read-only discovery/replan. See
[review](../records/reviews/attica-delegation-contract-2026-10-16.md).

G1 (2026-10-16, reverses choice (b)): an APPROVED dependency landing
(`blockedPhases`, no budget-cut phase) in a deep attempt with the pass and the
clock left opens the run's one extra root pass with `rootDependencyLanding`
(no refusal, no scope, every criterion). Every exit after a judged pass lands
on it (cut or failing follow-up → earlier pass; approved + planned follow-up
phases added as unfinished). Lessons follow the last verdict on their work,
one enqueue per run. Report-blind reviewers strip `REMEDIATION_INPUTS`. The
60 s floor is unmeasured for a root pass; `unjudgedRemediations` measures it.
