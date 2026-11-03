---
name: benchmark-round15-result-2026-11-01
description: "2026-11-01 — round 15 (attica-challenge, 6 vs 6): H15 refuted, 3/6 vs 3/6 at 6.6× cost; README states the refutation; the two product defaults (single-agent depth, learning off) are owed to an owner decision, not applied"
metadata:
  node_type: memory
  type: project
  originSessionId: 45327728-5279-46b5-99cc-bb4f31b3b2b4
  modified: 2026-11-01T07:45:00.000Z
---

Round 15 ran 2026-11-01 05:48–07:13 UTC from the `atoma-bench` worktree (anchor build.prev41, `--first-archive 42`): terra control 3/6 full marks ($0.14 mean, 102 s, 1 call), atoma 3/6 ($0.93, 750 s, 25–102 calls). Every miss is the held-out `holdout-challenge` case ("Security check" heading, no "verify you are human" text); the control also missed the goal's own example twice, atoma never (case sum 43/48 vs 45/48, not a registered metric). Inline learning: one LLM recipe learned in run 1, injected in runs 2–6, no correctness change, cost rose (runs 5–6 also matched round-13 recipes and fell back). Planning is 50–60% of every atoma run's bill. Report: `benchmark/ROUND15.md`; rows and scores beside it; `benchmark/round15/`.

Instrument correction disclosed in the report and the protocol: `verify-challenge.mjs` first copied workspaces without their install and read five atoma projects as 0/1; fixed (install linked, explicit vitest config, fixed include, cache away from the archive), control rows unchanged.

Consequence state: README now says the thesis is refuted on the whole range tested. The registered product consequences (single-agent default depth, learning off by default) are NOT applied: the single-agent path is the self-certifying `--baseline` arm (no acceptance, manifest, checklist, preview, publication) and the hosted coordinator sets `ATOMA_SKILL_LEARN=1`; three standing owner decisions are in the way ([[platform-trust]], compile-at-learn 2026-09-26, approved deferred learning 2026-10-11). The owner must decide the product shape.

**Why:** a product-shape flip deploys to production on push; the measurement is settled, the shape is not mine to pick silently.

**How to apply:** if the owner says go, design the default path explicitly (what a run without supervision still owes: manifest, acceptance, preview, publication), turn learning default-off in `resolveSkillLearning` AND in `src/projects/coordinator.ts`, keep `--depth deep` as the explicit opt-in, and test across CLI, MCP and project launches. Related: [[benchmark-round15-calibration-2026-10-31]], [[benchmark-round13-14-2026-10-31]], [[typescript-rule-over-goal-prohibition]].
