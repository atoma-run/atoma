---
name: ci-critical-path-state
description: CI = time to production; sharded test job since 2026-10-24, the static job is now the longer half; how the 7→11 min growth was diagnosed
metadata:
  type: project
---

2026-10-24: the deployment's critical path is the CI wall (Deploy itself < 1 min). `npm test` grew 313 s → 598 s between 10-15 and 10-24 on one 4-vCPU runner: 96 new child-spawning test files oversubscribed the 4 workers (same suite at 4 workers on the Mac: 217 s vs 225 s, no growth). Fix pushed: the test job runs as three `--shard`s; the DiscoveryReporter narrows its queue per shard; `application:skeleton:smoke` runs its three kinds concurrently. Measured on 38ff57d3: CI wall 10.4 → 4.7 min, shards 2.7–3.5 min, summed test CPU −25 %. The floor is now mender isolation (4.7 min, Docker build) and the static job (4.2 min: typecheck 67 s, lint, build, smokes).

**Why:** runner noise is ±30 % on identical commits; only daily medians and per-file CPU sums from the job logs tell growth from noise. tsx is not the children's cost (0.5 s vs 0.25 s compiled), so no CI-only precompile.

**How to apply:** read CI timing from `gh api repos/atoma-run/atoma/actions/jobs/<id>/logs` vitest summary lines (wall, import, tests CPU) and compare per-file durations before blaming a commit. Record: records/incidents/ci-critical-path-2026-10-24.md. Related: [[test-suite-speed]], [[deploy-pipeline-state]].
