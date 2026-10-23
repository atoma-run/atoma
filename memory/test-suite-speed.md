---
name: test-suite-speed
description: 2026-10-23 test suite speed work — 299 s to 95 s on the 14-CPU Mac; what was measured, what is left, and the oversubscription limit
metadata:
  type: project
---

On 2026-10-23 the full vitest suite went from 299 s to 95 s on the owner's
14-CPU, 24 GB Mac (commit 3251821c): worker cap 4 → availableParallelism()-2,
`start_static_server` bound to 127.0.0.1 (an unbound python http.server
reverse-resolves the host name, 5.3 s per boot on macOS), and
run-checkpoint split into three files around tests/helpers/checkpointFixture.ts.

**Why:** the suite is now CPU-bound (≈910 s of file time over 12 workers);
14 workers took 127 s with a timing failure, 16 took 171 s with four. More
workers is not the lever any more.

**How to apply:** the next gains need less total work, not more parallelism:
viz-auth-gate (57 s, process-level server boots) and parent-tests-snapshot
(39 s) are the longest files; tsx child cold starts (2–5 s) dominate
checkpoint and inherited-checks-runner. Measure with
`npx vitest run --reporter=json --outputFile=<f>` and rank files by
endTime-startTime; never measure while another agent's vitest runs in the
shared checkout ([[shared-checkout-staging]]) — it doubled file times.
