# Execution effort — batch result, 2026-10-07

Read with `atoma_jev_calibrate({ auditsOnly: true, since: "2026-10-06T21:29:00Z" })`
after the twelve goals of `batch.md` ran in order (2026-10-06 21:30–22:06 UTC),
saved verbatim as `rows.json`, evaluated with `evaluate.mjs` unchanged
(`results.json`).

## Validity

- All twelve runs delivered on revision `23302752`, which contains `fe5228d8`
  (the holdout) and leaves `src/core/jevQuestions.ts`, `src/core/jev.ts` and
  `src/atoms/jevOutcomes.ts` as they were in `fe5228d8`; the only later
  commit before the read is a `[skip ci]` translation. L1 was
  `sub:openai:gpt-5.6-luna` on every run.
- No run was dropped or relaunched. Two starts were refused (409) while the
  previous run's publication still held the instance slot, and were resent.
- Every row's requested effort matches its arm (`requestedMismatch` 0).

## Verdict

**Inconclusive for both levels**, as the pre-registered rules decide below 8
known-result first-attempt rows per arm. Behaviour and holdout stay as they
are; the next reading is on ordinary runs at 40 rows per arm.

| level / arm | rows | approved | refused | median execute | median output tokens |
|---|---|---|---|---|---|
| low / applied | 3 | 3 | 0 | 10.3 s | 669 |
| low / held out | 0 | – | – | – | – |
| high / applied | 0 | – | – | – | – |
| high / held out | 1 | 1 | 0 | 174.7 s | 9 031 |

Apart: 9 undecided rows (all first attempts, all approved), no retry, no failure.

## What the batch did show (descriptive, decides nothing)

- **Jev was decisive on 4 of 13 executions.** `low` on three of the seven
  executions of spelled-out goals (S1, S3, S6), `high` on one of the six
  open-problem goals (H2). S2, S4 (twice), S5 and H1, H3, H4, H5, H6 read in
  the middle band. The applied-`low` executions took 9.4–10.6 s; the
  undecided executions of spelled-out goals 11.8–40.6 s (S2 includes a browser
  check). Different tasks: not a comparison.
- **No execution was refused.** All thirteen were credited on their first
  attempt (the one root remediation, S4, was decided above the molecules).
  The primary outcome had no variance on this population, so a larger batch
  of the same kind would stay inconclusive on refusals; the ordinary-run
  reading needs the harder tasks where refusals occur.
- **`high` is rarely decisive.** Five of six open-problem goals read in the
  band. One candidate cause, unmeasured: the state carries the molecule's
  approved plan, which spells out steps even for a hard task, so
  `spelled_out` rarely falls to 0.2. Changing the question needs its own
  measurement.
- The draw put all three `low` readings in the applied arm (probability 1/8
  at a 0.5 rate) and the one `high` reading in the held-out arm.
