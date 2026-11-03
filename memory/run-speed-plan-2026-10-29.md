---
name: run-speed-plan-2026-10-29
description: 2026-10-29/30 run-speed plan; shipped wallClock (de621926), assayer preemption (a48a82cb), review repair M3/M4-A/M5 behind ATOMA_REVIEW_REPAIR (e1878288, flag off)
metadata:
  type: project
---

Owner asked how to speed up runs (10 days of commits + Attica runs) and then to implement the points one commit each. Narrow repairs with an explicit base take 10-18 min/$0.15-0.45; broad/deep/validation runs 43 min-6 h/$3-10.

- **1 DONE de621926** (pushed): `atoma_run_trace` summary carries `wallClock` (preFirstEvent, firstToolStart, spent ms per `L<tier>:<role>`, tool ms, idle gaps >60 s, after-last-event) over ALL events incl. >32 MiB traces. Use it on the next run to measure the unmeasured fixes (embedding cache, template refresh, Compute budgets).
- **2 DONE a48a82cb** (deployed 10-30): diagnosis 10-22..29 = 262 queued min: 117 behind assayer (recipe assays + automatic Compute verifications) on the exclusive slot because coordinator.acquireLeasePreempting preempted only `analyst:` although the contract promised assayer preemption → now `/^(analyst|assayer):/`. 115 min device offline (unavoidable server-side), 30 min Compute app version not in ATOMA_COMPUTE_APP_VERSIONS (show `version-incompatible` in run status: open). 'Previous run finalizing' hypothesis REFUTED. Open owner choice: re-queue a preempted Compute verification instead of losing it.
- **3 ALREADY DONE** before the plan (7ff0284a, 2026-10-15): Haystack beside the run.
- **4 SHIPPED FLAG-OFF e1878288** (8a83f018 M3, 0e9f5e56 M4-A, f50111cb M5, e1878288 review fixes). Review removed reviewer `suite.split` from stage A (parts inherit the whole target suite → unsatisfiable; index-space bug; output collisions); reviewer deltas = dependsOn.set, aggregation.set, criteria.assign (ids), obligation.add. Full suite passes flag off (8665) and flag on. records/designs/replan-loop-2026-10-23.md still describes reviewer split (dated record, out of date there). NEXT: M0 offline replay or one observed Attica run with ATOMA_REVIEW_REPAIR=1, read wallClock L3:plan/validate-plan vs a6b98fd5 (9.8+8.3 min) and 6277e0e0.
- **5 OPEN, owner decision**: auto `short` depth for narrow repairs / no-file-change validations.
- **6 OPEN**: own:openai calls show cacheReadInputTokens 0.
- **7 OPS**: blacklist nginx in unattended-upgrades; Compute ≥ 80494669.

**How to apply:** flag activation is the next step for point 4; points 5, 6 open. Related: [[replan-loop-2026-10-23]], [[attica-haystack-startup]], [[validation-runs-too-slow]].
