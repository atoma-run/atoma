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

## Validation and observed production results

Commit `196e6bbb` passed 77 targeted tests (depth routing, reasoning delivery,
Jev calibration), both TypeScript configurations, changed-file lint and docs
checks. Full clean Linux CI 37114927320 passed; deployment 37115164783
installed that exact revision. Concurrent README-only commit `cab9c700`
deployed after the first replay; the other three record that revision. The
review implementation is identical across those two revisions.

| Replay | Run | Calls | Seconds | Accounting USD | Root remediation | Independent result |
|---|---|---:|---:|---:|---:|---|
| False poem audit | 64d5478e-cb44-4892-8d45-1d9ee6ee1228 | 12 | 190.254 | 0.2002 | 1 | Correct after refusal |
| Four editorial cases | cf0ab5ec-eb44-462e-9a56-986420a96470 | 12 | 148.705 | 0.1828 | 1 | All four correct after refusal |
| Fair division | a53f6d4d-bb44-440b-9caf-1376bdbe644f | 10 | 184.977 | 0.1077 | 0 | Correct first pass |
| Stratified analysis | de0ee27b-9205-4556-98f3-9e6a42b39716 | 6 | 83.595 | 0.1025 | 0 | Correct first pass |

The table totals **40 calls**, 607.531 seconds and $0.5932 in
subscription accounting, not a separate API invoice. All seven recorded
execution calls use Luna, and all six run-root reviews use Terra. The six
reviews account for $0.1690528; recovery also replans and reexecutes, so
validation-call cost alone does not represent the full cost of correction.
All manifests declare text with zero files and no publication.

The poem's first Luna output repeats the false thaw/sun endings. Terra
refuses it with actual welcome/quietly and unmet criteria c2/c3. The one
remediation returns all sixteen counts, correct acrostic and actual endings,
and concludes noncompliance; Terra approves that corrected audit.

The editorial first pass gets A's first ending wrong and falsely disagrees
with D's correct author claim. Terra refuses those precise defects. The
second pass returns A/C noncompliant, B/D compliant, with every count,
initial and ending correct and author agreement only on D.

The fair-division control preserves all six utility rows, thirteen dominance
relations, frontier ab/ac, unique sum/product maximizer ac (27/180), and
envy-free ab/ac/bc. Terra accepts it without remediation. The statistical
control preserves all rates (90/20/95/80; pooled 83/83; standardized
55/87.5; 32.5 percentage points) and explicitly refuses unsupported causal
inference. It too is accepted without remediation.

Full summaries reach nextOffset=null; metadata and the selected root plans,
execution calls and result reviews were paged to completion. Both failed
first drafts remain in `evidence-text-root-review-2026-10-03/` beside their
successful corrections. Root refusals are recorded as rootRemediations even
though the phase-level refusals counter remains zero.

The known counterexamples are now contained and corrected on these replays,
with no false refusal on the two positive controls. This is not proof of
universal accuracy: the reviewer remains fallible, text-plan omission keeps
the legacy tier, phase trust is not retrospectively corrected, and shared
L1/L2 pins would not separate models. No semantic mechanical gate or global
execution-model upgrade was introduced.
