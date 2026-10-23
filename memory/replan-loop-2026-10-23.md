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

2026-10-23 ~08:05 UTC: owner asked to verify the fix. Started ONE run, key `attica-captcha-lint-20261023-replanfix1` (params: memory/attica-captcha-lint-start-20261023-replanfix1-mcp.json, same goal/criteria/readRunIds as 1622e44b, deep). Production revision 7365ba63 carries the fix. If the MCP call is cut, re-send the SAME call; never a new key. Read P12 (root plan rounds before approval) and P5 (cell recordFailure) from its trace.

2026-10-23 08:20 UTC: run 00fc7063 (fix 7365ba63 live) — root approved in 2 rounds at minute 10 (P12=2 vs 5), but the SieveElement cell was refused 3 times in a row (57-88 s plans, 6-13 s luna reviews, each adding coverage no earlier refusal named, history block present) then recordFailure: the b920 ladder again. Cancelled at minute 15 ($2.09). Fix: `L3Atom.MAX_CELL_PLAN_REFUSALS = 2` — after two merits refusals of one cell planner, the next mechanically clean plan executes with the review's requests kept in the approval reasoning; reviewer faults / fan-out never count. Next run: expect no cell recordFailure from plan-only ladders.

2026-10-23 ~08:40 UTC: 4f706772 deployed (cell review bound). Started ONE run, key `attica-captcha-lint-20261023-replanfix2` (same params file suffix replanfix2). If the MCP call is cut, re-send the SAME call; never a new key.

2026-10-23 09:10 UTC: run b0a6c063 on 4f706772 (both fixes): root approved in 2 rounds (minute 18; discovery took 11 min with one Urea retry), SieveElement refused twice then its third plan executed under the bound (no recordFailure), first implementation L1 tool at minute 22 (31/37 before). L1 Adrenaline edited, built and ran tests for 12 min. Ended FAILED at minute 36: "Compute execution interrupted; workload stop confirmed" — the owner's Compute device stopped the workload (executionTarget customer-device 9bafcb10), not the orchestration; same ending as 1622e44b. The plan/replan loop is gone on this evidence; the next run needs the device to stay up (or a hosted target).

CAUSE of the b0a6c063 interruption (not the device, not WiFi): Debian unattended-upgrades upgraded nginx at 06:05:20 UTC and restarted it (stop/start), killing every proxied WebSocket incl. the Compute session; both ends saw close 1006 at 06:05:26.8. Record: records/incidents/compute-interruption-2026-10-23/README.md. Options: blacklist nginx in unattended-upgrades, or resumable executor transport. Owner to decide.

Option 2 applied 2026-10-23: resumable transport was already deployed (80494669); the Mac's Compute app was an older worktree build. Installed preview 0.4.69 in /Applications (device 9bafcb10, generation 106); regression test 8295f0b0 covers the proxy-restart-with-tool-in-flight shape. Rule: a run on a customer device needs a client build ≥ 80494669, else any socket drop ends the run.
