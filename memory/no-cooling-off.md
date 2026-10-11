---
name: no-cooling-off
description: "The cooling-off rule (no new gate in the session that surfaced the incident) was removed from AGENTS.md at the user's request on 2026-09-27; fix incidents in-session, but keep the adversarial review"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3703b531-e7f0-4344-95e9-0f703df3bd1a
  modified: 2026-10-01T12:37:02.945Z
---

The user called the COOLING-OFF rule "stupid" and had it removed (commit 01e90c9, 2026-09-27). Do not defer a fix, a validator rule or a gate to "a later session" for that reason.

**Why:** deferring left known defects (e.g. J9, a continuation that replaced its deliverable) unfixed while runs kept going; the user wants run → fix → rerun in one loop.

**How to apply:** design the mechanism against every incident collected so far, then run an adversarial review before landing (that review caught a refusing width detector on 2026-09-27). Mechanism candidates still stay out of the mender: they need a person's design choice, not a delay. Related: [[production-runs-2026-09-26]].

A runtime PROMPT rule counts too, and so does a parser salvage. On 2026-10-01 the test-only-control rule (d667306a) shipped unreviewed and contradicted the dom-interaction obligation; run ff102525 burned 999 s oscillating on it. Three review passes then produced the one-call rule (b4f01226), which run 3cbef119 followed exactly. Review against the OTHER prompt texts the worker reads (obligation lines, execute block, validator prompt), not just the new rule.
