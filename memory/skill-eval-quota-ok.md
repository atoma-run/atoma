---
name: skill-eval-quota-ok
description: Owner decision 2026-10-15 — automatic skill creation/evaluation may spend quota; trigger evaluation shipped, execution comparison not built
metadata:
  type: project
---

On 2026-10-15 the owner decided that automatic skill creation and improvement
may spend model quota (held-out trials, candidate vs current comparison) as
long as it improves the product globally. No operator review step.

State: the TRIGGER evaluation shipped the same day (`src/skills/triggerEval.ts`,
record `docs/decisions/skill-trigger-eval-2026-10-15.md`): the production selector
judges each learned draft's `when_to_use` on held-out cases, revises it twice
at most, rejects what still steals a sibling's task. Switch
`ATOMA_SKILL_TRIGGER_EVAL`. The corpus `skill_trigger_samples` fills from
credited matches after deployment.

Also shipped 2026-10-15: THE ASSAYER, stage 4 of the supervisor
(`src/supervisor/assayer.ts`, record `docs/skill-assay-2026-10-15.md`): the
with/without execution comparison. Two ordinary runs per credited task on
copies of store and catalog, judged on the runner's epilogue; retires a recipe
only on the pre-registered rule (harmful, 2+ matched cases, zero deliveries).
Hosts: `npm run assayer`, and the viz server resident ON by default when the
server env holds the three ATOMA_MODEL_L* pins (`ATOMA_VIZ_ASSAYER=0` off).
Open: confirm the production viz service env carries the pins (banner says
"assayer: on/off"); first measurement after ten assays (not-reached share).

**Why:** the owner rejected an operator-curated skill workshop; Anthropic's
skill-creator is adapted as an automatic loop in TypeScript (no Python in
production).

**How to apply:** bound the spend per candidate and record it, but do not
refuse evaluation on cost grounds alone. First measurement after a week:
`triggerRejections` in run stats and `evaluation.revisions` in provenance.
Related: [[compiled-skills-prod-state]], [[jev-decisions-state]].
