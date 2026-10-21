# Duplicate repository discovery context — 2026-10-21

## Production evidence

Attica run `a99ef64e-ee8b-47b5-8afa-df7b6115671e`, L2 plan event `f164a2fe-59ae-4fa3-95b7-b4d6c4592e8a`, received an identical `repositoryDiscovery` value twice: once in current inputs and again in `originalTask.inputs`. The compact serialized report is 26,673 characters. The entire user request is 123,058 characters; the transport recorded 33,266 input tokens. Both values were parsed from the production trace and compared for equality, without asking a model. This establishes duplicate context, not a measured quality or billing improvement after the fix.

## Change

`taskContextLines` removes the original-task copy only when the current inputs already carry discovery. It works after checkpoint serialization, without relying on object identity. `delegatedTaskContext` also prevents a model-authored child input from replacing the host's completed discovery, as it already does for run history and read-run references. Neither stored original tasks nor checkpoints are mutated or shortened. A legacy task carrying discovery only in its original-task input keeps it.

Four regressions failed before the fix: actual planner requests at tiers 1, 2 and 3 rendered the unique report marker twice, and a child-input override replaced the inherited report. The tests cross two delegations and JSON serialization, then capture real model requests with mocked responses. They also preserve original-only discovery and unrelated facts. No paid model replay or new heuristic is involved.

## Adversarial review of the accepted mechanism

Removing the duplicate before protecting its provenance would let a child overwrite the outer copy and hide the original one. The child-input guard closes that path in the same change. Missing outer discovery must leave the original value available. Deep-cloned checkpoint values must deduplicate even though they have different object identities. Rendering must never delete data on the caller's task. These cases are exercised directly.

The patch introduces no context-size cutoff, summary, lexical detector, route, gate or model call. It keeps the complete host report and all other applicable task facts. The implementing agent reviewed these countercases; this is not an independent review or a claim that the already-running Attica execution uses the new source.

## Validation

133 tests passed across planning scope, previous-run results, read-run context, delegation contracts, Attica validation context, phase criteria and reasoning delivery. Both TypeScript configurations, changed-file ESLint, documentation contracts and `git diff --check` passed. The four regressions failed against the preceding implementation before the fix was applied.
