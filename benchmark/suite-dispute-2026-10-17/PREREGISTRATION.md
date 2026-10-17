# Suite disputes — classification, pre-registered 2026-10-17

Fixed before any unit is labelled, and before the record it reads is
deployed: the revision that adds this file is the one that writes it. Why the
measurement exists, and what its result decides:
[decision record](../../docs/decisions/parent-owned-tests-2026-10-16.md#a-suite-that-fails-the-same-way-on-every-implementation-measured-only).

## What is measured

A SUITE DISPUTE is a parent-owned Vitest suite that failed with one failing set
on at least 3 runs spanning at least 2 subject digests, counted where its
supervise loop escalated (`suiteDisputes` in the run stats). The question is how
often the suite itself was wrong. A model-facing line or routing back to the
suite's owner may be built only if at least half of the classified disputes are
wrong suites, and then only with a holdout.

## Units and data

- A UNIT is one distinct suite digest, its key. A resumed run or a second depth
  attempt counts the same suite again; it stays one unit, placed at its first
  count.
- A CLUSTER is the units first counted in one run with one failing set (`cluster`
  in the rows: a digest of the run id and the failing set).
- Source: the platform MCP tool `atoma_suite_disputes`, `view=rows`, with no
  `since` and `until` fixed at the reading time, paged with `offset` until
  `nextOffset` is null. Every page is saved verbatim, in order, into `rows.json`
  (one page object, or the list of pages). `rows.json` is NOT committed with
  this file: no trace holds a record before this revision is deployed. Until
  the first reading it is absent, and `evaluate.mjs` says so and writes nothing.
  It is replaced at each reading, never edited.
- Each unit carries its `outcome` as of the page's `horizon`, in the projects
  that counted it: `passed-later` (the same digest passed after its first
  count), `revised` (it never did, but a suite whose requirement is
  byte-identical on the persisted 600-character prefix passed after it;
  advisory), `never-passed`.

## The legacy unit

- Run `034d176d-3b28-4ef6-9314-3376ab8a84ef` (Attica, 2026-10-17) counted one
  dispute before the record existed (`stats.suiteDisputes` = 1), suite
  `2ce8fde45b1fc8729932427b115e091d3b25e4c49c1dfa68611a54346a8c20c6`. No trace
  entry carries it, so it enters BY HAND, first in the sequence (its count
  precedes every recorded one), as `LEGACY_UNITS` in `evaluate.mjs`: its own
  cluster, outcome `never-passed` as read on 2026-10-17 — it failed 3/3 in that
  run, and no later run of the project through `b4c281b5` (ended
  2026-10-17T12:15:01Z) recorded a pass of that digest or of a suite with its
  requirement.
- DISCLOSURE: the design's author inspected this unit before this registration
  (the run-log line, digests recomputed over the suites in the plan replies, the
  module under test) and read it, informally and alone, as a wrong suite. That
  reading is not a label. The unit is labelled like every other, under the rules
  below, and this disclosure stays with the result.
- Any other run that counted a dispute before the record shipped is listed as
  `legacy` in the rows and excluded from the sequence, whatever it holds; the
  evaluator reports how many there were.

## Labels

`labels.json` (empty at registration) holds one entry per unit:
`{ key, class, reason, by, at }`.

- `class`: `wrong-suite` (an assertion contradicts the assigned requirement or
  the interface the application already has), `wrong-implementation` (the suite
  is consistent with both and the code did not meet it), or `undecidable`.
- A `wrong-suite` label names the assertion and the requirement clause or
  interface it contradicts.
- `reason`: at most 280 characters, citing ids (run, suite digest, event id,
  file path) and never quoting tenant text.
- `by`: who labelled; `at`: an ISO date-time.
- Evidence: the unit read in full (`atoma_suite_disputes` with `suiteDigest`),
  its run's trace and its saved files. No model labels a unit: a model's reading
  is the unvalidated judgement this rule exists to calibrate.
- MECHANICAL OVERRIDE: a unit whose outcome is `passed-later` counts as
  `wrong-implementation` whatever its label; its suite was met by some
  implementation.

## The rule

Clarifications committed before any label:

1. The rule is read at exactly 20 and at 40 consecutive units of the sequence —
   the legacy unit, then the rows' units in first-count order — and at no other
   size. Labels must cover the first N units without a gap. ("At least 20" let
   a reader stop as soon as the rule passed.)
2. A reading passes when wrong-suite units are at least N/2, undecidable units
   counted in N, on units AND on clusters. A cluster is a wrong suite only when
   all its units are, a wrong implementation only when all its units are, and
   undecidable otherwise.
3. A pass at 20 decides. The reading at 40 is taken only after a fail at 20, and
   a fail at 40 closes the measurement: no model-facing line or routing is built
   on this signal.
4. The legacy unit enters by hand, as disclosed above.

`evaluate.mjs` applies the rule and writes `results.json`. It refuses — exit 1,
nothing written — rows read without a fixed `until`, pages of different lists,
a gap between pages, units out of first-count order or not hashing to
`listDigest`, the hand-entered unit appearing in the rows, a run the report
could not read (except `034d176d`'s, whose unit is entered by hand), a labelled
unit whose evidence run is still in flight, a label for a unit the list does not
hold, two labels for one unit, an unknown class, a missing or over-long reason,
and a label without `by` or an ISO `at`. A refusal is resolved by reading the
rows again or by an amendment in this directory, never by editing `rows.json`.

The owner re-labels 5 units blind, drawn by `evaluate.mjs` from `listDigest`
among the units of the deciding reading, into `owner-labels.json`. The agreement
is reported beside the result and changes nothing.

## When it is read

Ordinary production runs, none launched for this measurement. About one dispute
in six project runs was counted on the only active project, so 20 units are
expected in two to four weeks (an estimate). Run bytes expire after 90 days: a
counted run read after its expiry is a gap and refuses the reading, so readings
are taken before that.

## What a pass permits

Building the model-facing variant designed beside this measurement and switched
off (decision record): a rate of 0.5, drawn at the count and stored in the
counted entry, with its own outcomes pre-registered in the commit that builds
it. Nothing of it exists in code before that.

## Limits

- One labeller's judgement per unit; the blind re-label measures agreement on
  five units only.
- Known over-count: build outputs, data files, logs and coverage reports move
  the subject digest, and identical failures of different wrong
  implementations count. Known under-count: a dispute that first holds on the
  fallback's own run is not counted.
- Units of one run are correlated; clusters are read for that reason.
- An outcome holds as of its horizon: a `never-passed` unit can turn
  `passed-later` at a later reading.
- `revised` compares requirements on their persisted 600-character prefix, and
  a revised suite may be weaker than the one it replaced.

## Files

- `PREREGISTRATION.md`, `evaluate.mjs`, `labels.json` (empty), and
  `PREREGISTERED_AT` (their sha256 at registration).
- `rows.json`: absent until the first reading. `results.json`: written by
  `evaluate.mjs`. `owner-labels.json`: the owner's blind re-labels.
