# Recipe routing — threshold measurement, pre-registered 2026-10-06

Fixed before any prefilter answer is read.

## Labelled set

The 153 credited recipe matches of `benchmark/typed-params-2026-10-06/`,
each judged SAME (the recipe describes the job) or OTHER (a routing
mismatch) by that measurement's judges. For each, the recorded prefilter
decision is read from the run trace: the `jev` prefilter event that preceded
the `match` (its answer: choice, confidence, `fits` per recipe, best fit,
task_changes_files) and who decided (Jev picked, the model decided, or no
Jev on that run). No Jev or model call is made.

## Candidate rules (evaluated on recorded answers only)

- R1(t): the model may reuse a recipe only if Jev's recorded `fits` for that
  recipe is >= t; otherwise the subtask runs with no recipe. t in
  {0.3, 0.4, 0.5, 0.6}.
- R2(t): `noFit` raised to t (escalate when every recipe fits below t).
  t in {0.3, 0.4, 0.5}.
- R3: when Jev's Choice is `none_of_these`, the model is not asked (no recipe).

Decisions with no recorded Jev answer are outside every rule and reported
apart.

## Acceptance

A rule is acceptable if, among the labelled matches it applies to, it
blocks at least HALF of the OTHER matches and its blocks are at least 75%
OTHER (at most one SAME lost for every three OTHER removed). Among
acceptable rules, the one blocking the most OTHER is proposed; ties go to
the rule blocking fewer SAME. If none is acceptable, no threshold changes
and the result is recorded as such.

## Limits

The labels are model judgements. A blocked SAME match costs the guidance of
a fitting recipe (the worker runs unguided); a blocked OTHER removes a
recipe that misleads. Credit-withheld matches (free rides) are not in the
set, so OTHER is undercounted.
