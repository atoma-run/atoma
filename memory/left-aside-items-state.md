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
- e2e95077 (rebased SHA may differ): `.atoma-runs` mounted read-only in the worker (guarded realpath, `--mount`; service mode uses volume-subpath). Real-engine tests ran on Docker Desktop only; CI proves Linux runc. Not built: a real-engine symlink test and a service-mode volume test.
- 36446555: suite-dispute trace record, `atoma_suite_disputes` (60th tool), `projects disputes`, and the pre-registration in benchmark/suite-dispute-2026-10-17/. The owner blind-relabels 5 units at 20 disputes.

All five items shipped; nothing is paused.

**Why:** none of these six commits had an adversarial review. The owner asked to work one task at a time on 2026-10-17.

**How to apply:** review the six shipped commits one at a time, the read-only mount first (security boundary) and the conversation's read-run proposals second (consent). Fix confirmed findings with regression tests. Related: [[read-runs]], [[suite-dispute-measurement]].
