# Typed-parameter scripts — offline measurement, pre-registered 2026-10-06

Fixed before any subtask was read. Nothing here starts a run or calls a
production model; the data are read through the read-only Atoma MCP and the
judgements are made by Claude subagents (not by Atoma's tiers).

## Question

The compiler refuses 25 of 30 task recipes because "the recipe requires
per-task interpretation". Would a script that receives TYPED PARAMETERS —
filled from the subtask text by one cheap extraction call, validated against a
schema, then run deterministically and validated like any direct result —
cover the subtasks these recipes are actually matched to?

## Population

Every `kind: llm` task recipe in production (not `recover-*`, not the one
script): 34 recipes. For each, its real subtasks: the subtask it was learned
from (ledger `skill-save` run) and up to the 6 most recent runs that credited
it (ledger `skill-success`), read from the trace (branch label after the
`match` event, or the L1 prompt's task line). Matches outside the ledger
window are not searched for.

## Judgement, per recipe

1. Same job? Each subtask is first classified SAME (the recipe's kind of
   deliverable) or OTHER (a routing mismatch). OTHER subtasks are counted and
   excluded from coverage.
2. One schema. The judge writes ONE parameter schema S for the recipe: at
   most 12 fields; primitives, enums, lists of primitives, small records of
   primitives. Forbidden: a free-text field that carries logic, design or
   content to be authored (a "rules" or "description of behaviour" string).
   A literal the subtask itself spells out (a regex, a filename, a format
   string, a number, an exact message) is an allowed value.
3. Coverage. A SAME subtask is COVERED when every requirement it states can be
   (a) filled into S from the subtask text alone, without inventing values,
   and (b) satisfied by ONE deterministic program P(S, workspace) written once
   for the whole recipe, with no per-subtask logic. Otherwise PARTIAL (a
   minority of requirements outside S) or NOT. Each uncovered requirement is
   labelled: algorithm/business-rule, content/design authoring,
   browser/visual check, contract/schema design, other.
4. Recipe verdict: PARAMETRIC if >= 80% of its SAME subtasks are COVERED,
   MIXED if 40–79%, NOT if < 40%, UNKNOWN if it has no SAME subtask.

An adversarial reviewer then tries to refute every COVERED subtask and every
PARAMETRIC/MIXED verdict; its corrections are final.

## Decision thresholds

Over all SAME subtasks examined, after the adversarial pass:

- BUILD typed parameters if >= 25% are COVERED and at least 3 recipes are
  PARAMETRIC with >= 5 credited successes each (the volume it would serve).
- DO NOT BUILD if < 10% are COVERED.
- Otherwise: a pilot on the single best recipe only, nothing general.

Also reported, deciding nothing: the share of OTHER (routing mismatch)
subtasks, and the labels of what stays uncovered.

## Limits stated in advance

Judgements are model judgements about feasibility, not executed programs. The
sample is the credited matches in the ledger window (about 2026-09-24 on),
capped at 7 subtasks per recipe. A COVERED verdict says a schema could carry
the variance; it does not say the compiler would write P correctly.
