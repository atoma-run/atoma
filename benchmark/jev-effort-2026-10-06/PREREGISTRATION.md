# Execution effort — holdout measurement, pre-registered 2026-10-06

Fixed before any execution-effort decision is read. None existed when this
was written: the decision shipped in `064acfe4` (2026-10-06, about 23:00
UTC+3) and no run had started after it.

## What is compared

Jev sets a molecule execution's reasoning effort from two Nouls
(`spelled_out`, `open_problem`, `src/core/jevQuestions.ts`). A decisive reading
is `low` (first attempts only) or `high`. In the revision that adds this file,
`JEV_EFFORT_HOLDOUT_RATE` = 0.5: each decisive reading is applied, or held out
at random and the call keeps its own effort. On the batch below the L1 is
`sub:openai:gpt-5.6-luna` on the Codex transport, whose own effort is the
`medium` floor; each run's recorded tier models are checked, and a run on
another L1 is reported apart.

For each reading level, `low` and `high`: **applied** against **held out**.
The two arms hold readings alike; only the effort differs.

## Units and data

One row per `execute-effort` decision, read with
`atoma_jev_calibrate({ auditsOnly: true, since })` → `outcomes[].effort[]`,
saved verbatim with its run id and the run's `provenance.revision` into
`rows.json`. Only runs whose revision is the one adding this file, or a later
one that leaves `src/core/jevQuestions.ts`, `src/core/jev.ts`'s effort path
and `src/atoms/jevOutcomes.ts` unchanged, count.

A row's `result` is `jevOutcomeReport`'s: `approved` when the molecule is next
credited, `refused` when it is next blamed or another execution runs in its
lane, `unknown` otherwise (an approval whose credit was withheld, a run cut
short). Unknown rows are reported and excluded from rates.

Primary analysis: first attempts (`firstAttempt: true`), arms `applied` and
`held-out`. Rows with arm `retry`, `undecided` or `failed`, and later attempts,
are counted and reported apart.

## Outcomes

- Primary: the refusal rate, refused / (approved + refused), per level and arm.
- Secondary: the median execute duration (ms) and median output tokens per
  level and arm.

## Decision rules

No rule decides with fewer than 8 known-result first-attempt rows in EACH arm
of a level; that level is then inconclusive.

`low`:
- **Withdraw low** (a `low` reading keeps the call's effort) when the applied
  refusal rate exceeds the held-out one by at least 0.20 AND applied has at
  least 2 more refused rows than held out.
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

An inconclusive level keeps its current behaviour and the holdout, and is
read again on ordinary runs at 40 known-result first-attempt rows per arm.
A conclusive level sets the holdout to 0 for it (or for both, once both are
decided) in the commit that writes the result up.

## Sample

The twelve goals of `batch.md`, launched one at a time in that order as
project runs at depth `short`, each in its own new private project, with no
acceptance criteria supplied (each run drafts its own). Every launched run is
analysed; none is dropped or relaunched for its outcome. A run that fails to
start is relaunched once and reported.

## Limits

- Twelve runs of 2–6 executions each give small arms: only a large effect can
  reach a rule above, and inconclusive is the expected verdict for a small one.
- The result is per execution, not per delivery; root acceptance is reported
  per run, not used as an arm outcome.
- One transport and one L1 model. Claude's default is `high`, not `medium`:
  nothing here transfers to it.
- Pairing goes by molecule name and lane. Two parallel lanes of one type can
  mis-pair; every row keeps its event ids for audit.
- Duration includes tool waits (servers, browsers), not only reasoning.
- Jev's readings drift between identical calls (up to 0.17 measured on other
  questions); a reading near a threshold is decisive by chance as much as by
  its task.
