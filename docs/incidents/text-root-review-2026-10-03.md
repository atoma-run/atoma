# Separate execution and text delivery review — 2026-10-03

The owner approved testing Luna execution with Terra final review after
the [editorial comparison](audit-comparison-2026-10-03.md) found three wrong
rows approved by Luna, despite a correct L3 plan. Replacing the whole L1
selector had changed execution and review together; this change isolates
the root-review policy while retaining the original run selectors.

## Implementation and review

The depth runner captures the current pass's recorded root plan through the
existing recordRootPlan callback and still forwards it to its original
consumer. It passes the typed delivery kind to root acceptance. A text
delivery uses modelForTier(2) for its existing semantic review; files or an
omitted declaration retain modelForTier(1). No model name, provider or new
credential is introduced. Identical L1/L2 pins still mean identical models.
Text receives semantic review even if an incidental file proof floor is met.

The result body cannot select the reviewer. There is no vocabulary detector,
poem parser, extra validation call, tool execution, or new acceptance gate.
The model retains the same prompt, observed evidence and criteria. Cost changes
because the existing final call uses the configured L2 model. Phase credit
and trust are unchanged; a root refusal does not retrospectively undo them.

The captured declaration is local to each pass, so a deepening or remediation
cannot reuse a previous plan accidentally. An omitted declaration remains the
legacy path, a coverage limitation rather than a heuristic inference. The
existing one-pass remediation and eventual partial outcome remain bounded;
this change does not promise unlimited retries or automatically upgrade
execution after a second refusal. A stronger reviewer is still fallible.

Adversarial cases considered: text with research tools, structured text output,
file output represented by a string, mixed artifact/text requests, incidental
covered file floors, fake delivery fields in result payloads, omitted or
changed declarations on a retry, shared model pins, cancellation and deadline
landings. Routing uses the recorded plan, not output shape or action count;
all existing proof, deadline, cancellation and criterion rules remain active.

## Preregistered production replays

Use the original goals, criteria, starting workspaces and model selectors
(Luna/Terra/Sol); change only the deployed root-review implementation. Run
serially and preserve full outputs, review events, recovery evidence and
actual release provenance. This is a diagnostic series, not a controlled
benchmark: registry trust and nondeterministic planning can change.

1. Original false poem audit: origin 8d3a16a0-a1d4-4aca-be3a-ec74c11ad76d.
   Actual endings welcome/quietly/leaves/snow; must report noncompliance.
2. Four editorial cases: origin 2b0f701b-7977-4ab5-9536-955fd4406911.
   A/C invalid; B/D valid. All counts, endings and author disagreements matter.
3. Fair division: origin f13734c2-b7eb-4d10-aa86-ba2df4cecca5.
   Frontier ab/ac; unique sum/product optimum ac; envy-free ab/ac/bc.
4. Stratified analysis: origin 07c7aeab-a49b-4d47-b23c-8654bb3c0d7f.
   Pooled 83%/83%; standardized 55%/87.5%; difference 32.5 points;
   no causal claim without additional design evidence.

A wrong first draft caught by review is a recovered error, not an error-free
run. A still-wrong final output must not be counted correct even if delivered;
a refused partial is a successful containment but not a successful delivery.
