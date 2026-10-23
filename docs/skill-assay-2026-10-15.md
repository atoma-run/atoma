# The assayer: a recipe judged by execution — owner decision 2026-10-15

Status: decided and implemented, stage 4 of the supervisor. This record states
what the stage does, the decision rule it was registered with before its first
run, the adversarial review of that rule, and what it gives up. It claims no
measured gain; the first measurement is listed at the end.

## The decision

> Skill creation and improvement are automatic, may spend quota when they
> improve Atoma globally, and need no operator step. The with/without
> comparison of Anthropic's skill-creator is to be built as a supervisor
> stage, not left to the sentinel or the mender.

The [trigger evaluation](skill-trigger-eval-2026-10-15.md) judges whether a
learned recipe is PICKED. Nothing judged whether a picked recipe HELPS: the
outcome evidence was the credit counters, earned on customers' runs. The
sentinel cannot hold this stage (it holds no model and no power) and the
mender cannot (it changes code through a pull request a person merges; a
recipe is platform data). The analyst has the right shape — scheduled, off
the path of every product run, under the idle predicate and the lease,
spending on its own account and journaling every action — so the assayer is
built beside it, in `src/supervisor/assayer.ts`.

## What one assay is

| Step | What happens |
|---|---|
| target | a task recipe whose current surface (kind, `when_to_use`, body) has no `skill_assays` row and has at least one credited task |
| cases | up to 2 of its credited tasks, newest first, from `skill_trigger_samples`; the lesson it was distilled from is recorded there at learn time |
| arms | each case runs twice through `npm run run:build`: on a catalog copy holding the recipe, and on a copy without its folder |
| isolation | one online snapshot of the store, copied per arm; own workspace, own runs directory; learning, promotion, event skills and the trigger evaluation off; `--container --egress` on the resident host (the CLI's `--container`) |
| judge | the runner's machine epilogue (delivered / partial / failed / error) after the same root acceptance every product run gets; `matched` is a runtime `skill` event in the arm's trace |
| record | `supervisor/assays/<ns>__<id>__<digest>__<attempt>/assay.json`, the arms' logs and traces beside it; one `skill_assays` row; one `supervisor.assay` journal row |

## The pre-registered rule

Over the cases where the `with` arm matched the recipe:

- none matched: `not-reached`, keep;
- deliveries with > without: `helpful`, keep;
- deliveries with = without: `neutral`, keep, costs recorded beside;
- deliveries with < without: `harmful`; RETIRE only when at least two cases
  matched and the recipe delivered on none of them, otherwise keep.

Retirement is `SkillRegistry.drop`: folder, then row and `skill-drop` event.
It is the one power this stage holds, and the only write to the commons an
assay makes.

## Hosts and gate

- `npm run assayer -- --once | --skill <ns>/<id> | --dry-run`, or watch mode.
- The resident shell in the viz server, on by default wherever the server
  holds the three `ATOMA_MODEL_L*` pins, off on `ATOMA_VIZ_ASSAYER=0`. A
  server without the pins says so in its banner and runs no assay.
- The analyst's gate: `anyRunActive` before, the machine-global lease during,
  preemption by a product run through `yieldBackground`. A member's run is
  refused behind an arm as it is behind an analysis, or preempts it.

## Adversarial review of the rule

1. **Two runs are a small sample.** A recipe can fail twice for reasons that
   are not its own (a flaky model, a provider outage). That is why the
   retirement needs the `without` arm to have delivered on the same tasks,
   at the same time, on the same models: the control absorbs the day's noise.
   What remains is the recipe. A `harmful` on one case keeps the recipe and
   records it; the next surface change re-opens the assay.
2. **The recipe never reached the plan.** A planner may decompose the goal so
   that no subtask matches the recipe. Those cases are `not-reached` and
   decide nothing; the record keeps them, because a line the trigger
   evaluation passed and a real run never picked is a finding in itself.
3. **The runs write back into the commons.** Every arm runs on a copy of the
   store and the catalog, in its own runs directory, with every lifecycle
   stage off. The test asserts the environment of every launch. The one write
   is the decision, and it goes through the registry.
4. **The arms hold the machine.** They do, like a burn-in batch: the idle
   predicate refuses to start beside a run or a pending deployment, the lease
   refuses a product run behind them, and a product run preempts the arm in
   flight through its process group. Fifteen minutes per arm is the ceiling.
5. **The log can be forged by the goal.** It is echoed into the log, so the
   outcome is read from the runner's machine epilogue only and the match from
   the trace's runtime skill events, never from text.
6. **A failed launch reads as a failed recipe.** Error/cancelled arms or
   missing readable traces invalidate the comparison. The attempt is archived
   with no recipe judgement and leaves the surface pending. The resident pauses
   an hour on technical failure rather than retrying every minute.
7. **Retiring a recipe the credit counters favour.** The counters are earned
   on the same recipe's matches, so a recipe with many credits and a harmful
   assay is a contradiction worth seeing: the journal row names it, the
   ledger keeps the `skill-drop`, and `skills` history keeps the body. A
   retired recipe is not re-learned by its own id while a visible namespace
   holds it; once dropped, a later run may distill it again, and it will be
   assayed again.
8. **Spend without end.** One assay per surface, ever: the row closes it.
   The cost is bounded by `2 × cases` runs per NEW surface, and the owner
   authorised it.

## What it gives up

- It judges deliveries, not quality beyond delivery: two delivered runs are
  equal to it however good either artefact is. Cost is recorded beside the
  verdict and decides nothing yet.
- It runs whole goals, so a recipe matched inside a late phase is judged with
  everything before that phase: fair to the product, noisy to the recipe.
- It does not compare a revision with the body it replaced; a revision is a
  new surface, assayed on its own.

## First measurement

After the first ten assays in production: the share of `not-reached`
(the trigger evaluation's blind spot), the share of `harmful`, whether any
retirement happened and what the retired recipe's counters said. A
`not-reached` share above half says the cases are not the tasks a planner
writes; the remedy is in how cases are sampled, not in the rule.

## Invalid execution evidence — correction 2026-10-23

A technical launch failure is not `not-reached`. An error/cancelled arm or a
missing readable trace invalidates the whole comparison: no judgement, retirement
or closing `skill_assays` row is allowed. The resident reports failure and pauses
before retrying. A valid run that never selected the recipe remains `not-reached`;
ordinary failed/partial deliveries with traces remain part of the comparison.
The delivery/retirement rule over valid comparisons is unchanged.

Every attempt has a unique evidence directory; retry and preemption preserve
previous logs. Legacy rows whose records demonstrate invalid execution reopen
for the current recipe surface. Superseded surfaces are historical evidence,
not recipes to restore. Unreadable/missing records do not authorize a retry.

Platform administrators can inspect the Assayer section in Sentinel, or use
`atoma_assayer_health`, `atoma_assays_list` and `atoma_assay_show` (record, paged
arm log or paged trace). These readers spend no quota. Failure status and a null
judgement supersede invalid legacy verdicts in the view, without editing archives.
