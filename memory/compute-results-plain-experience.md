---
name: compute-results-plain-experience
description: 2026-10-25 owner decision and shipped state — Compute results transfer automatically and every surface explains a waiting run in plain words (deployed 44c85654)
metadata:
  node_type: memory
  type: project
  originSessionId: 2342e190-d6b4-42e5-8b19-eccf44b5d18f
  modified: 2026-10-25T15:26:00.249Z
---

Owner (2026-10-25): customers are non-technical, "plus c'est simple mieux c'est". A run finished on a customer's Compute computer whose files still wait there must finish by itself and be explained plainly.

Shipped at 44c85654 (CI green, deployed; server-only, no Compute app release):
- The selected executor's control poll finishes pending transfers itself (`finalizeComputeRunAutomatically`, same path and authority rechecks as the button). Pacing counts failures across reconnects; no attempt while the computer is paused, and resuming on the same connection retries on the next poll. Cancellation is honoured before and after the lease. Blockers (lost access, archived project) are logged once. A self-executor web process runs the same control poll.
- Readers: stage `awaiting-results` with viewer-neutral copy, project tile "Results waiting on your computer", run card and run page with a "Get the results" button, settings rows labelled by run (interrupted, transferring, transferred, cancelling variants), typed busy refusal (`results-waiting`/`results-stalled`), one notification after a bounded wait that opens the run's card.
- Known limits: the run picker's waiting mark only knows loaded project lists; a cancelled run still holds the slot until its stop is confirmed (generic busy text).

**Why:** run 40c20c5d sat "running" 4.5 h with the org blocked and only a buried technical button ([[attica-run-40c20c5d-analysis]]).
**How to apply:** keep customer copy plain (en.json only); a new Compute waiting state needs a reader on every surface, not just one.
