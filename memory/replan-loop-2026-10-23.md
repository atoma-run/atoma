---
name: replan-loop-2026-10-23
description: Diagnosis of slow, replan-looping runs (1622/b920) and the reviewed fix plan; owner must choose between the safe train (15-21%) and the structural one
metadata:
  type: project
---

2026-10-23: owner asked why runs are far too slow and revalidate endlessly. Measured on 1622e44b and b920faf6: nothing executes for the first 31-37 minutes; root admission (astra plan + terra refusal, one new defect per round, plan discarded each time, ROOT_PLAN_ATTEMPTS=5) costs 18 min / 52% of dollars on 1622; cell plan ladders reviewed blind (no previousRefusals at L3Atom.ts:1846) burn their 4-plan budget then the tissue runs tools itself; L1 results retried against refusals a retry cannot change. 0 of 20 refusals read concerned the product change: all were suite-sufficiency/size demands of the parent-owned-tests contract.

Plan and refutations: records/designs/replan-loop-2026-10-23.md. Adversarially-honest expected effect of the safe train (M2 size host fact, M1, M3 typed deltas, M4-A/M5 repair-not-refuse behind ATOMA_REVIEW_REPAIR): 1622 -10..-14 min (15-21%). The 30%+ gains need owner decisions: reviewer-authored suites (stage B) or skipping decomposition for narrow repairs (conflicts with the run-family rule and parent-owned-tests decision).

**Why:** twenty patches 10-16..10-22 added context or rounds; none reduced refusal count or refusal price.
**How to apply:** implement M2 first (zero-token, 3 offline replays of 009f114d as the merge gate); never raise attempt counts or add a wall-clock cap on the root loop; no workspaceDigest/eventId in repeat keys. Related: [[attica-five-hour-session-2026-10-22]], [[parent-owned-tests]], [[validator-prompt-replay]].

2026-10-23 07:30 UTC: owner asked for the simplest fix so an Attica run can be relaunched and the plan/replan loop observed to stop. Pushed 3211ff91 (exhaustive one-verdict refusals in DELEGATION_REVIEW_REQUEST; cell reviews read their own refusals via `cellReviewRefusals`; suite size 8k-12k is a host fact, never a refusal) + 7365ba63 (the record). Pushed from a scratch worktree; the shared tree still shows the same seven files modified against its older HEAD. Next: relaunch ONE Attica CAPTCHA/lint run (same goal as 1622e44b, never duplicate) and read P12 rounds-to-root-approval and P5 cell recordFailure from its trace.
