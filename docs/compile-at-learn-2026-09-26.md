# Compile at learn, dispatch at first match — owner decision 2026-09-26

Status: decided and implemented. This record states what changed, what still
guards a compiled script, and what the change gives up. It does not claim a
measured saving; none has been measured yet.

## The decision

> If a recipe can be compiled into a script, it is compiled immediately; it
> does not wait for trust. Everywhere, and the script dispatches directly too.

Before this date a learned `kind: llm` recipe went through two earned stages.
It needed three credited successes with no failure before one compile call, and
promotion was frozen on from-scratch runs unless a seed or
`ATOMA_SKILL_PROMOTE=1` enabled it. The compiled script then had its counters
reset and had to earn three validated runs through the L1 tool loop before it
could run with zero model calls.

After this date:

| Stage | Before | After |
|---|---|---|
| Compile | after 3 credited successes (`ATOMA_PROMOTE_THRESHOLD=3`) | at learn time, right after the draft is saved (threshold `0`) |
| Promotion policy | off on from-scratch runs, on with `--seed` | on for every run |
| Deterministic dispatch | after 3 clean validated runs of the script | from the first match, unless a failure is on record |

## What changed in the code

- `SkillLifecycle.learnSkillFromRun` saves every draft of the response, then
  calls `tryPromoteSkill` on each one. The compile example is the subtask and
  result the recipe was distilled from. The static scan reads the home
  namespace's declared tools, as the credit path does.
- `TRUST_PROMOTE_THRESHOLD_SUCCESSES` is `0`. `ATOMA_PROMOTE_THRESHOLD` remains
  an operator knob with a floor of `0`, so a run can still ask for the old
  wait (`=3`) for a controlled comparison.
- `resolveSkillPromotion` returns `default-enable` when nothing is configured.
  `ATOMA_SKILL_PROMOTE=1` is the explicit opt-in. Any other explicit value
  disables promotion, and `--no-promote-skills` is the final veto. The seed no
  longer takes part in this decision.
- `shouldTrustSkill` is `failures === 0` and a non-empty `_fallback.md`.
  `ATOMA_TRUST_THRESHOLD` now governs molecule types only.
- Readers follow: `skills stats` and `skills show` no longer print a trust
  distance for scripts, the MCP skill payloads echo only the thresholds their
  statuses read, and the curriculum no longer proposes `script-maturation`
  targets.

Unchanged: the compiler's refusal and its generation-scoped stamp, the static
scan, the counter reset at promotion, the `failures > 0` block on
re-promotion, demotion after `ATOMA_DEMOTE_AFTER` (2) deterministic contract
failures back to the `_fallback.md` every compiled script carries, the
anti-redispatch memo, the match-time capability filter, the before/after
deliverable gate, and the `--no-direct-skills` / `ATOMA_SKILL_DIRECT=0` kill
switch. Direct library use of the L2 hooks stays opt-in (`=== '1'`), like
learning.

Update, 2026-10-01: the lifetime `failures > 0` compilation veto is removed.
Jev assesses the current recipe at each eligible opportunity; its refusal is
temporary, and an uncertain/unavailable answer falls back to the compiler.
Demotions instead stamp the generation that produced the failed script.
The owner authorised deployment followed by live MCP calibration. See the
[compilation eligibility decision](jev-decisions-2026-09-28.md#compilation-eligibility-owner-decision-2026-10-01).

Update, 2026-10-03: production held one script among 30 task recipes. Every
other task recipe had been refused by the compiler or was not yet assessed;
no trust wait held any of them back. Forcing compilation past a refusal and
giving compiled scripts a browser were examined and rejected. See the
[compiled-script limits decision](compiled-script-limits-2026-10-03.md).

Update, 2026-10-06: item 1 below is answered. A dispatched script's result is
validated like a molecule's (gates, ground truth, Jev, then the model), after
the one production script's replay of the probe manifest was delivered twice
for phases that asked for more. A script set aside in a phase is no longer
handed back to the L1 to run. See the
[script dispatch validation decision](script-dispatch-validation-2026-10-06.md).

## Why the old wait could go

The 2026-08-07 threshold experiment (batches 14–15) found that the success
count never changed the compiler's verdict. Compilable recipes compiled at their
first attempt, and irreducible-reasoning recipes were refused with the same
rationale at any count. The count bought a match-surface sample: only a recipe
that had actually been matched and credited paid for a compile. It never bought
a better script. The record is in the comment on
`TRUST_PROMOTE_THRESHOLD_SUCCESSES` in `src/atoms/cost.ts`.

## What the change gives up

1. **Unwatched first runs.** The three validated runs were the only point at
   which a model judged a compiled script's output before it ran unwatched. The
   2026-07-25 `document-cli-from-source` incident (recorded on
   `SkillRegistry.promoteToScript`) is exactly what the counter reset was added
   to prevent: an inherited 5/0 armed dispatch on the script's first match. That
   is now the default behaviour, by decision. The remaining gates are mechanical
   and none of them judges content. A script that exits 0, prints a well-formed
   envelope and changes the named files is accepted and credited. Demotion needs
   a contract failure or an escalation, and a content rejection upstream stops
   re-dispatch only within the run.
2. **A compile call per learned draft.** Every draft pays for one compile,
   including twins and recipes that will never match again. It runs on the
   post-approval path with its own 120 s budget, so it adds latency to the phase
   that learned it. On Codex-served tiers a compile measured 42–51 s at low
   effort.
3. **Hand-authored scripts lose direct dispatch.** `src/skills/AGENTS.md`
   said a script without `_fallback.md` must be refused before dispatch, but
   nothing enforced it; the three-run wait kept such a script from running
   unwatched. With the wait gone, `shouldTrustSkill` now requires the
   fallback, so a hand-authored script never dispatches directly and always
   runs through the validated loop, whatever its record.
4. **Some phases lose their recipe.** The match-time capability filter now sees
   every script. A phase whose named files a script cannot write gets no recipe
   at all, where it used to get the script injected into the validated loop.
5. **The prose evidence changed meaning.** Statements such as "promotion has to
   be earned twice" and "compiled only when a run continues existing work" were
   true before this date. Historical records keep them. Current documents were
   updated.

## Measuring it

No measurement backs this decision yet. A controlled comparison needs both arms
on the same day and code path: `ATOMA_PROMOTE_THRESHOLD=3` and
`ATOMA_SKILL_DIRECT=0` for the earned-run arm can reproduce the compile wait
and suppress unwatched dispatch, but no knob reproduces "dispatch after three
validated script runs" any more. Record the threshold variables with the
results, as for every round.
