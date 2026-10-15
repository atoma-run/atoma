---
name: first-refusals-2026-10-10
description: "All-prod measurement of first root-acceptance refusals (118/275), their classification, and the phase-criteria change 11f4d837 that followed"
metadata:
  node_type: memory
  type: project
  originSessionId: 7f8e1401-022c-4c27-80f8-737bb447be7a
  modified: 2026-10-10T19:30:13.740Z
---

2026-10-10, read-only on prod MCP: 316 runs, 275 reached root acceptance, **118 first refusals (43 %)**, 43 rescued by remediation, 75 landed partial; 22.7 % of wall time is after a first refusal. Classified (one reader): E1 browser clause not exercised 34, E2 test assertion missing/not run 26, E3 evidence cut 8, E4 no renderer 1, D real defect 32, I incomplete pass 11, R report contradicts probes 3, M criteria review incomplete 3. Record + run lists: records/incidents/first-refusals-2026-10-10.md.

Cause of E1/E2: the checklist reached only the root planner and acceptor; phases never saw criterion text. Fix shipped 11f4d837: `Task.criteria`, subtask `criteria` ids, `delegatedCriteria` (unassigned ids = CONTEXT on last sequential phase only, none on parallel lanes), script dispatch judged without criteria, remediation keeps only unmet criteria. Adversarial review done before push.

E3 partly fixed d660862b (read-back keeps the block under a matching line, not lone lines; "test"/"spec" not match words; test scripts' string-literal fixtures read inside the 16-read cap; adversarial review applied). Long-page E3 cases (judged part anywhere in a big HTML/ICS) still open.

Later same day: 6c824f60 root read-back 48k (phases 24k); dubious approvals read back — 3 text ones were luna (fixed 10-03 by terra text review), d162ee31 → 476863ca `declared-unverified` gate (cell over the molecule only). Luna vs terra replay of 10 recorded root prompts: file deliveries terra 3 vs luna 4 false approvals / 0 vs 0 false refusals, 10× cost → root file review STAYS tier 1 (e00a7a27; replay files in session scratchpad/replay). Per-criterion review calls not replayed.

Evening: 04996fbb criteria batches concurrent + lessons grouped by owner (Codex text lease still serializes on sub:). aa6b2956+test fix: ONE LADDER PER ROOT PHASE — tissue refusing a cell's own fallback hands it up (`handUpRefused`, phaseBudgetSpent, gate phase-budget-spent → root review); owner chose "judge what exists"; per-phase counter of 8 rejected in review (starved multi-subtask phases). Not yet measured live.

Earlier open list (now addressed above): false approvals found by the collection (2b0f701b, c343e664, 8d3a16a0 wrong stanza audits approved; d162ee31 probes not run; 7761081b reload judged met on an errored check); verify on the next campaign that E1/E2 first refusals fall (confounded with same-day tool fixes reload/type-at-focus/focus pairs).

**Why:** owner said runs are far too long for their tasks; first-pass refusals were the largest avoidable share.
**How to apply:** when measuring the next campaign, re-run the same classification on first refusals and compare E1+E2 share (60/118 baseline). Collection recipe: scratchpad agents per project batch writing runs/<id>.json via atoma_project_runs + atoma_run_trace. See [[jev-calibration-2026-10-10]].
