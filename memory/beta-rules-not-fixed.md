---
name: beta-rules-not-fixed
description: "2026-10-16: the owner lets me take design decisions myself; no rule is fixed, even one written in docs or an AGENTS.md, while Atoma is in beta"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 82473edf-d47d-417e-8c76-ec81b599b6fe
  modified: 2026-10-16T06:02:30.314Z
---

The owner said on 2026-10-16, during the parent-owned-tests review fixes: "Je te laisse prendre les décisions. Aussi, aucune règle n'est gravée dans le marbre, même si elle est énoncée dans une doc ou un AGENTS.md. Atoma est en beta donc c'est tout à fait possible de changer un comportement si tu le juges nécessaire."

**Why:** asking for each owner-level choice slowed the fix loop, and documented rules (owner decisions, AGENTS.md contracts, decision docs) had been treated as untouchable even when a review showed them wrong.

**How to apply:** when a design hits an "owner decision" or a documented rule, decide it myself on the evidence. Change the behaviour if it is wrong, update the doc or AGENTS.md that states it, and record the reasoning in the decision doc or review record. Report what I decided in the final summary rather than asking first. Destructive or outward-facing actions keep their usual confirmation rules, and the adversarial review of new gates and prompt rules still applies ([[no-cooling-off]]). Related: [[push-to-prod-authorized]], [[parent-owned-tests]].
