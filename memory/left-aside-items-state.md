---
name: left-aside-items-state
description: 2026-10-17 state of the 5 "left aside" items — 3 shipped without adversarial review, 2 paused in local worktrees
metadata:
  type: project
---

Shipped 2026-10-17 (CI and deploy green). Each was verified only by targeted tests, because the owner's weekly Claude limit ran out; the adversarial reviews are owed:
- 556e7409: the assistant's compact latestRun, plus the tolerant reader for read-run proposals.
- 19bb73b7: the conversation proposes read runs (card + echo).
- a5d66c72: read-run copies at `.atoma-runs/node_modules/<id>/`.
- dc7a3d92 (rebased SHA differs): the module-reach host fact in delegation reviews. Corpus parity with the prototype is exact, and the precheck delta is 0. The container-boundary test is not written. See [[suite-module-reach]] for the stop rule.
- 36446555: suite-dispute trace record, `atoma_suite_disputes` (60th tool), `projects disputes`, and the pre-registration in benchmark/suite-dispute-2026-10-17/. The owner blind-relabels 5 units at 20 disputes.

Paused, uncommitted, in scratchpad worktrees of session 6cf2fa4b. These are lost if /private/tmp is cleared; the designs are in the same scratchpad, design2-*.md:
- The read-only bind mount of `.atoma-runs` (design2-immutable-copies.md): wt-readruns-hardening. Barely started, and that branch's base commit 5e6de8ec is already on main as a5d66c72.

**Why:** the next session should start with the owed reviews, then these two items, one task at a time (the owner asked for that on 2026-10-17).

**How to apply:** review the four shipped commits first. Then resume the two paused items; if the worktrees are gone, re-implement from the designs. Related: [[read-runs]], [[suite-dispute-measurement]].
