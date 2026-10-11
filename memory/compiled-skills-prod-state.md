---
name: compiled-skills-prod-state
description: Production compiled-skill census (2026-10-03: 1 script of 30 task recipes); forcing compilation and a browser for scripts both CLOSED by owner decision 2026-10-03 (913c159a)
metadata:
  node_type: memory
  type: project
  originSessionId: ea090e0e-8181-494b-9530-3cbcdc763650
  modified: 2026-10-03T15:02:35.521Z
---

As of 2026-10-03 the production catalog holds 50 recipes: 20 event recoveries
(`recover-*`, never compiled by design) and 30 task recipes, of which ONE is
`kind:script`: `recheck-recorded-command-probes` (Ammonia), compiled at learn
time on 2026-10-01 (same run as its save, zero credited successes). 24 carry
a compiler refusal stamp (17 from an older compiler generation, retried once
at their next credited success); 5 are unstamped (a revised body clears its
stamp, and historical failures vetoed compilation until 2026-10-01).
`thresholdsInForce.promote` is 0: there is NO trust wait.

CLOSED, owner decision 2026-10-03 ("Clôture cela"), recorded in
`docs/compiled-script-limits-2026-10-03.md` and as two rejected shortcuts in
`src/skills/AGENTS.md` (commit 913c159a, pushed to main):
- no forcing compilation past a refusal — a trusted script runs with no
  validator and is credited at dispatch, so the refusal is the last content
  judgement;
- no browser for compiled scripts — only `validate_html` through the
  attesting executor is browser evidence, recorded web checks go stale, and in
  the 6 phases `serve-and-validate-static-page` served none re-checked an
  unchanged page while the browser took ~2% of the time. (I had first floated
  this lever, then retracted it.)

**Why:** keeps future sessions from re-proposing either without new evidence;
the record lists what would reopen them (deterministic task decomposition; a
typed instantiation layer for tool sequences).

**How to apply:** when asked why there are few scripts, read
`promotionRefusedReason` via `atoma_skills_show` and point to the record.
`atoma_ledger_tail` works over MCP since cb5e1246.
Related: [[jev-decisions-state]], [[push-to-prod-authorized]].
