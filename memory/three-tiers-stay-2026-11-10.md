---
name: three-tiers-stay-2026-11-10
description: "2026-11-10 owner decision — the three-tier split stays the production default; the cost premise is retired in the README (321eb4b0, [skip ci]); round 15's single-agent default is DECLINED and feat/direct-depth stays unmerged; atoma is positioned for auditing runs"
metadata:
  node_type: memory
  type: project
  originSessionId: 808b5c4f-37cd-4efc-a375-b758b2567011
  modified: 2026-11-10T07:05:40.839Z
---

On 2026-11-10 the owner decided to stay with the three-tier task split and to leave production untouched: « rester avec le découpage en 3 tiers… ne pas modifier la prod qui contient bien la version avec le découpage des tâches même si les benchmarks étaient catastrophiques ». The founding premise « ne fonctionne pas financièrement, mais est utile pour auditer les runs ». Round 15's registered product consequence (single-agent default depth, inline learning off) is declined. `feat/direct-depth` (head 9bb4f6cf, with rounds 16–17) stays unmerged as an archive: do not merge it and do not delete it.

Shipped as documentation only, 321eb4b0 on main with `[skip ci]` (no CI run, no deploy; only GitHub's CodeQL ran): README status callout and a section "The cost premise, measured" in place of "Historical measurements", notes in the demo, How it works and Status sections; decision record `docs/decisions/three-tiers-stay-2026-11-10.md`; the deviation from the registration disclosed at the end of `benchmark/PROTOCOL.md`; a pointer in `docs/how-it-works.md` §8; an index row in `docs/README.md`. Root `AGENTS.md` was left alone: it sits exactly at its 500-line budget.

**Why:** the owner sees the product's value in the auditable record the split leaves (« verifying workflow »), not in cost control.

**How to apply:**
- Do not re-propose the single-agent default, and make no cost-saving claim in public copy. State the cost plainly (6.6 to 10.4 times one agent on the measured tasks) and position atoma for auditing and verification.
- Round 13's consequence still stands: no new gate, validator or heuristic until a task is found where supervision measurably buys correctness.
- What the audit record is worth is unmeasured. A claim that it catches wrong deliveries needs its own registered round.
- The request first read as its opposite ("revert back the commits… bypassing the 3-tier split" could mean ship the branch). One question before touching main settled it; ask when an owner instruction on product shape can mean ship or abandon.

Related: [[direct-depth-2026-11-01]], [[benchmark-round15-result-2026-11-01]], [[benchmark-round13-14-2026-10-31]], [[push-to-prod-authorized]].
