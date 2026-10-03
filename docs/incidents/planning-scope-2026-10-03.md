# Proportionate planning and delegated scope — 2026-10-03

## Evidence and change

The [production campaign](regression-experiments-2026-10-03.md) delivered a
correct poem in five phases and 23 calls. The L3's first phase requested a
constraint checklist, but L2 delegated the complete poem. L1 received that
broader task and followed it; tightening only L1 execution cannot repair a
scope expansion that already happened during planning.

Both supervisor planners now receive one shared runtime instruction to
delegate only their current task, use the original goal as facts/constraints,
and reuse preceding work. L2's planning context strips inherited root
acceptance checklists while keeping one on a root L2 plan. Caller objects
remain unchanged.

Shared proportionate-planning guidance replaces L3's universal minimum
phase counts and reaches the platform tissue author. A compact coherent
answer can be composed and checked in one delegated task, with independent
audit where justified. Reusable workflow steps are methods to choose from,
not mandatory separate phases. Existing catalog prompts receive this policy
at runtime without rewriting their stored methods or resetting their trust.

## Adversarial review and limits

- Complex builds still need real dependency boundaries and verification.
  The prompt keeps those duties and independent checks; it imposes neither a
  maximum phase count nor a model-free classification of a task as simple.
- User-requested independent audits remain necessary even for short answers.
  Fewer calls alone are not success: the replay must meet every original
  acceptance criterion and pass independent result checks.
- Preparation can be a real requested deliverable. The scope rule explicitly
  preserves a checklist phase rather than replacing it with the final work.
- Correction remains in the existing supervision protocol; no conditional
  execution schema, extra evaluator call, trust bypass or acceptance change
  is introduced. This is model guidance, not a semantic enforcement gate.
- Root criteria must remain available to a root planner. Only inherited
  checklists are hidden from delegated planning; task facts remain available.
- Live before/after measurements are exploratory: accumulated trust and
  catalog reuse can affect call counts. They are not a controlled benchmark.

## Verification

Production-path tests exercise L2 planning with both root and delegated
checklists, L3 planning through an older five-phase system prompt, one- and
four-phase plans without truncation, and actual L3-to-L2-to-L1 sequential
handoffs carrying original facts and preceding output. The author request is
also checked for the shared policy. Live replay results will be recorded here.

## First replay: efficiency improved, acceptance was wrong

Revision `78f601b4` passed Linux CI 37084923376 and deployment 37085169702.
Poetry comparison run `f4735700-ebf5-4b71-bd76-73a49f47df0d` used the original
goal, criteria and models. Mesophyll chose two phases, not five; 10 calls and
175.841 seconds, versus 23 and 326.365 seconds. Tissue reuse also removes the
original author call, so this is not a controlled speedup measurement.

The final artifact FAILED independent checking despite status delivered:
its actual stanza endings are welcome, quietly, leaves, snow. Its audit
claims thaw, sun, leaves, snow. Both the independent phase and root validator
accepted the false audit. All sixteen word counts and the acrostic do pass.
Evidence is in `evidence-planning-scope-2026-10-03/poetry-first-replay.json`.

The follow-up shares textual verification guidance between reasoning execution
and the existing verdict system prompt: reconstruct checks from the actual
body, identify the specified units and positions, and compare observed values
instead of accepting an attached audit. It adds no poem parser, vocabulary
heuristic, gate, model call or tool access. Tests retain the exact failed text
through root acceptance and confirm the guidance reaches both roles; mocked
tests cannot prove model compliance. A further live replay is required.
The rule applies to completed text, not planned text: it must not demand
execution evidence at planning time. Counts and positions follow the user's
units; an audit requested as the deliverable remains legitimate content.
Model-reconstructed checks remain fallible claims, not host attestations.
