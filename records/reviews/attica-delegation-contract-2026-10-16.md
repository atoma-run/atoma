# Attica delegation contract — 2026-10-16

## Evidence

Production run `fec4ef6a-e0a1-4227-ae5b-21cdd307da63`, revision
`b3af7c1eddc183c2d805408dad9538ec38e67839`, was cancelled after 165 seconds
(0.3236 USD subscription equivalent), with no delivery or publication.
All 79 summary events were read through the final page. Root plan event
`8f0be124-c1c1-42e1-9a3c-b3a281810e70` contained inspection, one broad migration
branch, then verification, sequentially. No acceptanceTests appeared. The text
promised parent review and a revised plan after inspection; the dispatch runtime
had no corresponding operation. Inspection itself was valid; claiming the later
implementation contract existed was not. Event
`952f20b0-b1c2-4f27-b439-d0733f1c1271` approved the inspection cell plan through
trust, which was permissible for inspection and not evidence of reviewed code tests.

## Adversarial design review

Read the atoms/core/contracts contracts and the prior parent-owned-tests review.
The accepted mechanism is mandatory review plus structural enforcement of the
reviewer's classifications. It does not guess application work from prose or
extensions (the vocabulary-frozen gates rejected in the August review). It does
not demand Vitest for documents, browser interactions, or CLI subprocesses.
A wrong semantic classification is still possible; the runtime does not claim
that an approving model proves complete coverage. Trivial suites still require
semantic rejection; a presence check is not a quality check.

Countercases checked: an approval with missing suites; omitted, duplicate and
out-of-range classifications; grouping independent work into one branch; a linear
DAG with artificial dependencies; genuine single-module coupling; non-code
outputs; integration tests omitted; discovery mixed with writes or implementation;
repeated discovery; discovery failed or landed; a trusted L2 omitting leaf suites;
changed tests after an approval. No root-plan failure may execute an unreviewed
fallback. Cancellation and incomplete reviews cannot grant approval.

The discovery handoff is runtime-driven and bounded, preserves the original goal,
and marks observations historical/untrusted. It cannot fabricate acceptance from
the child's report. Discovery has no completed checkpoint prefix to misapply to
a new DAG. Existing sequential-only checkpoint limitations remain explicit.
The correction removes obsolete prompt language treating any shared repository
or integration phase as a reason to serialize all work. It does not duplicate
superviseLoop, replay model commands, add supervisor tools, or alter worker egress.

## Validation

Behavioral regression tests exercise L3.handle and L3.validatePlan, including
rejection before execution, bounded repair, and inspection followed by a real
second plan. The existing isolated Vitest runner tests remain part of the checks.

The real three-tier discovery regression also writes through the leaf executor:
its bytes must be restored before the second L3 planning call. It checks that a
single discovery branch receives root criteria as context, while implementation
receives them as requirements. L3 explicitly carries the read-only mark into L2;
L2 already carries it into L1. This catches an inheritance gap that a mocked
L3.execute test alone could not establish.
