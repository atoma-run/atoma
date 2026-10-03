# Text review and project result continuity — 2026-10-03

The owner requested fixes for the [coding-distance false approval](incidents/coding-distance-false-approval-2026-10-03.md).
Two independent defects were observed: a mathematical answer approved with
a wrong table entry, and a follow-up receiving no preceding textual result.
The same-goal comparison also lost a requested definition during correction.

## Changes

The project coordinator hands over text results along the actual seed
lineage (at most three hops), oldest first. The bounded environment envelope
contains each original goal, answer, run identity, delivered/partial status
and explicit truncation/unavailability markers. It crosses into Task.inputs
through the runner, including the original-task context passed to descendants.
Current goal text is unchanged. A comparison uses its origin's seed rather
than the latest project run; an imported repository snapshot inherits no
workspace-history context. Results remain untrusted historical work, not
instructions or proof. No knowledge, trust or cross-organisation sharing
is introduced.

The source trace remains the sole answer store. This reader is separate from
the shape-only trace validation that decides delivery. It reads only completed
seed runs, checks trace identity and a regular file under MAX_TRACE_BYTES,
bounds the model context, and reports unavailable content instead of silently
replacing it with a summary. Very long history is explicitly incomplete.

A recorded text delivery now receives one bounded, tool-free L2 reference
call before the existing L2 root verdict. The reference sees the task, source
inputs and criteria, but not this pass's answer, summary, plan, approvals or
remediation feedback. It derives expected checks and intermediate witnesses
rather than voting on an answer. The final reviewer sees the reference
labelled as fallible model text and must resolve disagreements from sources.
It has no mechanical authority, proof credit, new tool surface or model pin.
The existing one-remediation limit and partial landing remain unchanged.

Runtime text guidance also requires checking the entire current task,
including definitions and explanations missing from a checklist, and keeping
those requirements in the final correction. It reaches existing registry
molecules without rewriting their persisted prompts.

## Adversarial design review

- Wrong reference versus correct candidate: the reviewer may approve the
  candidate; reference disagreement alone never refuses or counts as a vote.
- Earlier false audits, incorrect tables and adversarial quoted instructions:
  the reference is blinded to the current answer; historical work is labelled
  untrusted and disputed claims must be recomputed.
- Creative writing, subjective criteria and missing external source data:
  no single mandatory answer is invented, uncertainty is explicit, and the
  existing reviewer uses actual delivery evidence. No keyword classifier or
  domain-specific arithmetic gate is added.
- Truncated reference or historical result: omissions establish nothing.
  The model-visible excerpt is bounded and labelled; a missing trace yields
  an unavailable entry with run identity, not an invented empty success.
- File tasks and mechanically refused outputs: they make no new reference
  call. Only the host's recorded text delivery activates it; a result body
  cannot select its own review route.
- Cancellation and budgets use the same run client and signal. The new call
  is not retried or moved outside accounting. This adds up to one L2 call
  per text acceptance (two if the run uses its remediation), with 4,096
  maximum output tokens and no effort override. This is a measured-cost
  trade to test against the false approvals, not a zero-cost guarantee.
- Cross-project seeds, comparisons, expired traces and partial results:
  lineage is org/project checked, comparison outputs never seed, and the
  original status remains visible. No history is inferred from a prompt.
- Continuity is bounded, not unlimited memory. Older or truncated facts may
  still need retrieval or an explicit request for missing information.
- Model reasoning remains fallible. Mocked regression tests verify isolation,
  context transport and decisions, not mathematical intelligence. Only live
  replays can establish whether the observed false approvals are recovered.

## Validation

Pending targeted tests, both TypeScript configurations, release checks and
production replays of the complete coding problem and a context-dependent
follow-up. No production success is claimed from these source changes alone.
