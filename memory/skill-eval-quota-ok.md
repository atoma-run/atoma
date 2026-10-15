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

Not built: the skill-creator's with/without EXECUTION comparison. Owner is fine
with its quota; design it as a separate evaluation job (own budget and
workspace), never a supervisor replay.

**Why:** the owner rejected an operator-curated skill workshop; Anthropic's
skill-creator is adapted as an automatic loop in TypeScript (no Python in
production).

**How to apply:** bound the spend per candidate and record it, but do not
refuse evaluation on cost grounds alone. First measurement after a week:
`triggerRejections` in run stats and `evaluation.revisions` in provenance.
Related: [[compiled-skills-prod-state]], [[jev-decisions-state]].
