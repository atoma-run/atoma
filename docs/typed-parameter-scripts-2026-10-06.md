# Typed-parameter scripts, measured — 2026-10-06

Status: measured, nothing built. The question was whether compiled scripts
that take TYPED PARAMETERS — filled from the subtask by one extraction call,
checked against a schema, then run and validated like any direct result —
would cover the work the refused recipes are actually matched to. The
protocol and its decision thresholds were fixed before any subtask was read
([pre-registration](../benchmark/typed-params-2026-10-06/PREREGISTRATION.md),
SHA-256 `d6040572…`). All data and judgements are in
[`benchmark/typed-params-2026-10-06/`](../benchmark/typed-params-2026-10-06/summary.json).

## Method

The population is every `kind: llm` task recipe in production, 34 of them.
For each one, the subtasks it really served were read through the read-only
MCP: the subtask it was learned from, and the most recent runs that credited
it. That gives 153 subtasks. No run was started and no production model was
called.

Four judges, one per family of recipes, classified each subtask:

- SAME (the recipe's job) or OTHER (a routing mismatch);
- for SAME ones, COVERED, PARTIAL or NOT by ONE parameter schema of at most
  12 fields carrying no logic or content, served by ONE program written once
  for the recipe.

An adversarial reviewer then attacked every COVERED subtask and every
PARAMETRIC verdict. Its corrections are final.

## Result

| | Subtasks |
|---|---|
| SAME | 119 |
| COVERED, after the review | 13 (10.9%) |
| PARTIAL | 24 |
| NOT | 82 |
| OTHER (routing mismatch) | 34 of 153 (22.2%) |

Four recipes are PARAMETRIC, and none carries volume:

| Recipe | Credited successes | SAME subtasks covered |
|---|---|---|
| `sync-docs-to-ui-controls` | 0 | 1/1, never matched since learned |
| `build-csv-statistics-cli` | 1 | 1/1, its one credited match was a mismatch |
| `build-node-http-replay-verifier` | 1 | 2/2, the same text twice |
| `build-schema-csv-json-cli` | 5 | 3/3: two distinct texts, three of the five credits were mismatches |

Under the pre-registered rule this lands in the PILOT band (between 10% and
25%), one subtask above the "do not build" line. The BUILD condition fails
outright: no PARAMETRIC recipe has five credited successes on SAME subtasks,
and it needed three.

Sensitivities, none of which changes the conclusion:

- Two COVERED subtasks are doubtful SAME calls. Read as OTHER, the share is
  9.4%: do not build.
- Five recipes exceed the seven-subtask cap. Capping them strictly raises the
  share to about 12%.
- Counted once, the duplicate texts leave 11 distinct covered subtasks.

## What stays uncovered

Counted per requirement, across the judgements:

| Kind | Requirements |
|---|---|
| Algorithm or business rule | 81 |
| Content or design authoring | 70 |
| Real-browser check | 54 |
| Contract or schema design | 17 |
| Other | 98 |

"Other" is mostly work on files an earlier phase wrote: extending an
existing server, editing existing tests, preserving a model-written file.
Both a recipe and a schema describe a class of job; these subtasks change a
specific artefact whose shape no schema knows.

Family by family:

- Static and web UI: 0 of 41 SAME subtasks covered. Nearly every one asks for
  a browser check, and most bind behaviour into a page that already exists.
- APIs and hardening: 2 of 25, both greenfield builds whose every value the
  subtask spells out.
- Documentation and integration: 1 of 16. Choosing where and what to write is
  authoring.
- CLI builds: 10 of 37 after the review, the only family where parameters
  carry real variance. Its matches are also the most misrouted (19 of 56
  OTHER).

## Conclusion

Typed parameters would serve about one in ten of the subtasks these recipes
are used on, almost none of them on a recipe matched often enough to pay for
a new skill kind, a schema contract and an extraction call. The refusals were
right: the variance in Atoma's work is logic, authorship and browser
evidence, not parameters. The pre-registered rule allows a pilot on one
recipe. The best candidate, `build-schema-csv-json-cli`, has two distinct
real subtasks, too few to measure a pilot against.

The larger signal is routing: 22% of the credited matches sent a recipe to a
job it does not describe. A transit timetable, an NDJSON redactor and four
constraint solvers each received a recipe written for something else. That
costs every run that receives such a recipe, scripts or not.

## Limits

These are model judgements of feasibility, not executed programs. A COVERED
verdict says a schema could carry the variance, not that the compiler would
write the program correctly. The sample is the ledger window (newest 1,000
of 1,064 events, back to about 2026-09-15), so recipes last matched before
it have no subtask: `build-node-network-dashboard`. Most schemas were fitted
after the fact to one or two texts, which favours coverage.
