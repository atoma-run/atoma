---
name: jev-decisions-state
description: "Decision (TypeSafe Jev) decides in EVERY run of every org (owner, 2026-09-30, 76e1c51), with TypeSafe's documented questions at measured thresholds (e83f5ce); ATOMA_JEV=0 is the platform off switch; atoma_jev_calibrate MCP tool; reading due ~2026-10-13"
metadata:
  node_type: memory
  type: project
  originSessionId: f34a9765-841f-4d1f-98ad-4ad119855337
  modified: 2026-10-01T18:04:03.524Z
---

Owner decision 2026-09-28: Decision (TypeSafe's Jev typed decision model, api.typesafe.ai/v1/systemone, pinned `jev-1.13.0`) DECIDES, not just shadows. Record: docs/decisions/jev-decisions-2026-09-28.md (holds every measurement below).

- Decides: prefilter pick (L2 child, L3 hint, recipe); APPROVAL half of plan/result validation at L2/L3 only where a fast path is admissible; twin guard before saving a learned recipe. Never root acceptance.
- A Decision-only approval sets `viaJev` → credits trust but distils no new recipe — my line beside the owner's decision.
- Owner decision 2026-09-30 (76e1c51, deployed): EVERY organisation, existing or new, and EVERY run (operator, local, benchmark attempts too) — "ce n'est pas optionnel". Host with TYPESAFE_API_KEY ⇒ on; `ATOMA_JEV=0` on the host is the one platform switch. ATOMA_JEV_ORGS is no longer read (still in /home/atoma/config/atoma.env; boot line says it can be removed). Owner was told third-party orgs' data now reaches TypeSafe and chose it anyway; docs/platform-commons-terms.md now declares TypeSafe; the privacy notice (outside the repo) must too.

2026-09-29, after a full read of docs.typesafe.ai: 7239b70 (documented questions in src/core/jevQuestions.ts, client retry/request id), 8a04636 (`atoma_jev_calibrate`, platform MCP tool; body src/atoms/jevCalibration.ts), 18ab2b4 (questions fixed after measurement 1), e83f5ce (THE SWITCH). Thresholds: requirementShown 0.7, requirementCovered 0.8, flag 0.3, pickConfidence 0.5, fit 0.7, noFit 0.2, twin 1.5.
- Measured on 170 model decisions (2026-09-26→29), asked twice: drift median 0.00, max 0.17. Plans 84% of model approvals / 1 false (a server-stop plan); results ~48% / 0 false (old question 87% but on its 0.5 coin-flip line); prefilter Decision takes ~half the picks, 16% disagreement vs 33%; twins 6/6 vs 5/6.
- Measured and REMOVED: `contradicted_by_evidence` (no signal), `needs_undeclared_tool` (Decision sees tool names, not semantics).
- Calibrating: the MCP tool list is cached per Claude Code session — after a deploy that ADDS a tool the user must `/mcp` → atoma → Reconnect. Big `details` pages spill to tool-results files; analyse them with a local node script.

2026-09-30 loop (see records/incidents/production-runs-2026-09-30.md): 4f686a7 audit sample (10 % of Decision approvals re-judged by the model in background, role `jev-audit`); first real Decision approvals + first audit came only once a prompt patch reset Ammonia's trust (trusted types never reach Decision); the first audit AGREED. ff7242b: when Decision hands a SKILL pick to the model, recipes it reads as contradicting the task on files are withheld (`JevChoiceDeferral`, jev event `withheld`); measured 3 recipe deferrals in 14 runs, 2 with a clash, model wrong once (0a989a58). Known limit: whole-catalog prefilter cache is still served before Decision.

Working constraint learned 2026-09-30: in auto mode the classifier denies, as "Data Exfiltration", every step of a change that sends third-party orgs' data to TypeSafe — even commands covered by allow rules (a `git add` was denied) — and editing .claude settings as "Self-Modification". The owner had to commit/push it. Committed `.claude/settings.json` must hold no `Bash(...)` rules (tests/claude-settings-security.test.ts fails CI); shell approvals go in the ignored `.claude/settings.local.json`.

**Why:** owner wants speed/cost and accepts Decision errors; measurements decide questions and thresholds, never feel.
2026-10-01, owner approved (ba878b06): the cell's prefilter and planner catalogs now end each molecule with a sorted `tools:` continuation line, and Decision's choose() gets the same descriptions. Decision's prefilter INPUT changed mid-window: split the ≈10-13 prefilter reading at ba878b06's deploy.

**How to apply:** the reading counts from e83f5ce (≈2026-10-13), the prefilter part split at ba878b06; after the switch the model only sees what Decision defers, so `atoma_jev_calibrate` needs `includeJevRuns` and measures only deferrals. Rollback = `ATOMA_JEV=0` + restart; Decision-earned trust persists. See [[production-runs-2026-09-26]], [[deploy-pipeline-state]].
