---
name: suite-dispute-measurement
description: Pre-registered rule before any model reads a SUITE DISPUTE or it routes (2026-10-17); count suiteDisputes, classify from traces
metadata:
  type: project
---

Since 21b0e5ce (2026-10-17) superviseLoop counts a parent suite that failed with the same failing set on 3+ runs over 2+ `subjectDigest`s (`suiteDisputes` in run stats, one `[parent-tests] suite dispute` warning in the run log). Nothing reaches a model and nothing routes.

**Why:** a first version put a "SUITE DISPUTE (host fact)" line in the spent-ladder hand-up and atop root acceptance's refusal; the adversarial review found it in all 24 model calls of the next pass, inviting children under a correct suite to contest it, while the signal is weak (a rebuilt dist/, data files, logs move the digest; three wrong implementations failing one assertion look identical).

**How to apply:** for each counted dispute, join the warning's suite digest with the persisted records and the trace and classify: wrong suite (as in 2e6bdcfc), wrong implementation, or undecidable. A model-facing line or routing back to the owner lands only if, over at least 20 counted disputes, at least half were wrong suites, and then with a holdout so its effect can be measured. The plan-time regex check already refuses the 2e6bdcfc class. Related: [[parent-tests-review-fixes-state]], [[attica-run-delegation]].
