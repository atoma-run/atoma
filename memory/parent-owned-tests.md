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
Attica remains explicitly stopped; this change does not authorize its restart.
