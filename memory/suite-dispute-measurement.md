---
name: suite-dispute-measurement
description: Pre-registered rule before any model reads a SUITE DISPUTE or it routes (2026-10-17); disputes recorded in traces, read with atoma_suite_disputes, labelled in benchmark/suite-dispute-2026-10-17
metadata:
  type: project
---

Since 21b0e5ce (2026-10-17) superviseLoop counts a parent suite that failed with the same failing set on 3+ runs over 2+ `subjectDigest`s (`suiteDisputes` in run stats, one `[parent-tests] suite dispute` warning in the run log). Nothing reaches a model and nothing routes.

Since the suite-disputes branch (2026-10-17, not yet deployed when written) each count is also RECORDED in the trace's top-level `suiteDisputes` member (counted entry: suite source, failing set, every observation; later entries for the branch retry and fallback), and read by platform MCP `atoma_suite_disputes` / `npm run projects -- disputes`: one unit per suite digest, first-count order, outcome passed-later / revised / never-passed, `view=rows` without text plus `listDigest`.

**Why:** a first version put a "SUITE DISPUTE (host fact)" line in the spent-ladder hand-up and atop root acceptance's refusal; the adversarial review found it in all 24 model calls of the next pass, inviting children under a correct suite to contest it, while the signal is weak (a rebuilt dist/, data files, logs move the digest; three wrong implementations failing one assertion look identical). Classifying the first dispute (034d176d) by hand took a run-log grep and digests recomputed from an 18 MB trace, hence the record.

**How to apply:** after deployment, read `atoma_suite_disputes` view=rows with no `since` and a fixed `until`, save the pages verbatim to `benchmark/suite-dispute-2026-10-17/rows.json`, label units in order in `labels.json` (wrong-suite / wrong-implementation / undecidable, reason ≤280 chars citing ids, no tenant text), run `node evaluate.mjs`. The rule is read only at 20 and 40 consecutive units (legacy unit 034d176d / suite 2ce8fde4… first, entered by hand, inspected beforehand — disclosed); passed-later overrides to wrong-implementation; pass needs wrong-suite ≥ N/2 on units AND clusters; a fail at 40 closes it. Only on a pass may the switched-off model-facing variant (rate 0.5 with a holdout, decision record) be built. Related: [[parent-tests-review-fixes-state]], [[attica-run-delegation]].
