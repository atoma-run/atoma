# Execution effort at the `high` bar 0.6 — holdout measurement, pre-registered 2026-10-13

Fixed before any decision at the new bar is read. The revision that adds this
file is the one that lowers `high` from `open_problem` ≥ 0.8 to
`effortOpen` = 0.6 (`src/core/jevQuestions.ts`); no run had started on it.
Why the bar moved: [decision record](../../docs/decisions/jev-decisions-2026-09-28.md#the-high-bar-2026-10-13),
from the 159 readings in `baseline.json` (2026-10-07→12, all at the old bar).

The 2026-10-06 protocol ([`../jev-effort-2026-10-06/`](../jev-effort-2026-10-06/PREREGISTRATION.md))
is unchanged and keeps its rows. Its rules are reused here word for word; what
differs is the sample and the reading size.

## What is compared

A decisive reading is `low` (`spelled_out` ≥ 0.8, `open_problem` ≤ 0.2, first
attempts only) or `high` (`open_problem` ≥ 0.6, `spelled_out` ≤ 0.2).
`JEV_EFFORT_HOLDOUT_RATE` stays 0.5: each decisive reading is applied, or held
out at random and the call keeps its own effort. For each level, **applied**
against **held out**.

## Units and data

One row per `execute-effort` decision, read with
`atoma_jev_calibrate({ auditsOnly: true, since, until })` → `outcomes[].effort[]`,
saved verbatim with its run id, the run's `provenance.revision` and its L1
tier model into `rows.json`. Only runs whose revision is the one adding this
file, or a later one that leaves `src/core/jevQuestions.ts`'s effort questions
and thresholds, `src/core/jev.ts`'s effort path and `src/atoms/jevOutcomes.ts`
unchanged, count. A run on another revision is reported apart.

The L1 is `gpt-5.6-luna` on the Codex transport (`sub:openai:` or
`own:openai:`), whose own effort is `medium`. Rows on another L1 are reported
apart.

`result`, the primary analysis (first attempts, arms `applied` and
`held-out`) and the rows reported apart are as in the 2026-10-06 protocol.

## Outcomes

- Primary: the refusal rate, refused / (approved + refused), per level and arm.
- Secondary: the median execute duration (ms) and median output tokens per
  level and arm.

## Decision rules

Unchanged from 2026-10-06, applied by `evaluate.mjs`:

`low`:
- **Withdraw low** when the applied refusal rate exceeds the held-out one by
  at least 0.20 AND applied has at least 2 more refused rows than held out.
- **Keep low** when the applied refusal rate is not more than 0.20 above the
  held-out one AND the applied median duration is at most 0.85 × the held-out
  median.
- Otherwise inconclusive.

`high`:
- **Keep high** when the held-out refusal rate exceeds the applied one by at
  least 0.20 AND held out has at least 2 more refused rows than applied.
- **Withdraw high** when the refusal rates differ by less than 0.20 AND the
  applied median duration is at least 1.5 × the held-out median.
- Otherwise inconclusive.

## When it is read

Ordinary production runs, none launched for this measurement. The first
reading is taken once each `high` arm holds at least **20** known-result
first-attempt rows (the 2026-10-06 floor of 8 and its follow-up of 40 bracket
it: at the baseline's rate, 20 per arm is about two weeks). An inconclusive
level keeps its behaviour and the holdout and is read again at 40 per arm. A
conclusive level sets its holdout to 0 in the commit that writes the result
up. `low` is expected to stay inconclusive: no baseline reading came near it.

## Limits

- One L1 model and one transport; Claude's default effort is already `high`.
- Jev's readings drift (up to 0.17 measured on other questions): a reading
  near 0.6 is decisive by chance as much as by its task.
- Production tasks differ by organisation and molecule; the random holdout,
  not the population, is what makes the arms comparable.
- Duration includes tool waits (servers, browsers), not only reasoning.
- Pairing goes by molecule name and lane, as in 2026-10-06.
