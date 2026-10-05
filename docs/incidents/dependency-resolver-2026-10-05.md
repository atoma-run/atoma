# Dependency resolver: lost evidence and repeated source edits — 2026-10-05

## Scope and evidence

Production project `8ac49d72-c97e-48cd-a9d7-420207d9c761`, investigated through
the production MCP. All 531 events of the three runs were read through the
end, including complete paged tool arguments/results and validator prompts.
The compact, reproducible evidence is in
[`benchmark/dependency-resolver-2026-10-05/summary.json`](../../benchmark/dependency-resolver-2026-10-05/summary.json).
[`files.json`](../../benchmark/dependency-resolver-2026-10-05/files.json) contains
all 20 final files, recovered from complete observations and checked against
the final production artifact manifest, never inferred from summaries.

There were 75 LLM calls, 275 tool calls, 26 failed `edit_file` calls, one
missing-file read, and 19 failed command executions. Runtime total was
2,567.232 seconds (42.79 minutes); reported subscription-equivalent cost
totaled $0.6911, not a claim about incremental API billing. All three runs
landed `partial` and none published. Nonzero commands were inspected in context;
these nineteen were test-suite failures, not expected CLI refusal probes.

`resolve.js` remained byte-identical across the three final manifests:
`0975d287b8729f7958ef73b9313c23ac74a6237239b09d81e9fc10c012ea911a`.
Independent subprocess verification passed 244 checks, including 180 generated
catalogues against a separately authored exhaustive oracle. This establishes
the tested behavior, not a proof of correctness for every possible catalogue.

## Run 1: initial implementation

`7a247d71-b790-46e8-9c51-d4923503fa85`: 984.473 s, 29 model calls,
65 tool calls, three edit failures and five test command failures.

- The help regex was over-escaped; test inputs then contained a literal
  backslash-n after JSON; the invocation helper incorrectly demanded stderr
  on success. These were real defects in generated tests, subsequently fixed.
- The initial suite did not prove contradictory cycles. The first acceptance
  refusal was justified. Its remediation added that coverage, but two generated
  cases labelled unsatisfiable were actually satisfiable and had to be fixed.
- Final focused review still lacked the diamond/cycle fixture bodies and
  input-preservation assertions for direct and symlink collisions. Those were
  distinct evidence/test gaps, not evidence of a solver failure.
- The original generic oracle also enumerated all packages without absence
  and represented failure as an empty lock. Later work corrected it.

## Run 2: strengthen tests

`41e069a6-79ab-4722-ba21-c02e1b600d17`: 810.268 s, 22 model calls,
62 tool calls, three edit failures, one missing `package.json` read and one
test command failure (`for (const [i, test] of cases)` needed `.entries()`).

The run added npm packaging, stronger collision snapshots, a general exhaustive
oracle and four inline examples. Final `npm test` passed. However, host source
readback selected README, test.js, the contradictory-cycle suite and resolve.js,
then omitted the fifth file, test-inline.js. Its 3,103 bytes would have fitted
within the existing 24,000-character allowance together with the other sources.
The independent file-count limit, not the character budget, hid it.

Focused review eventually accepted the diamond/cycle evidence, while the global
review still refused visibility. Node 24 execution was not explicitly observed
in a tool result; host runtime provenance did not establish the worker version.
The third run observed worker Node v24.21.0 (host provenance v24.20.0).

## Run 3: the workaround creates more work

`0a4a3e55-1df2-4cb3-8dd0-b7f69500a648`: 772.491 s, 24 model calls,
148 tool calls, twenty edit failures and thirteen test command failures.

The requested workaround split the inline tests into four files under 1,800
characters. It addressed excerpt size while overlooking file selection, and
introduced avoidable new writing work. Repeating production runs was not an
effective repair of the host evidence mechanism.

### Exact edit sequence

1. Four writes placed actual line breaks inside JavaScript single-quoted strings.
   Four Node executions failed syntax checks.
2. Four edits targeted a span occurring twice but omitted `replace_all`.
   Exact-match refusal was correct.
3. Eight edits changed the actual newline into **two** source backslashes
   before `n`. The programs now parsed but appended literal backslash-n to JSON,
   which the resolver correctly refused.
4. Sixteen edits then guessed a span containing an extra space, or the wrong
   number of backslashes. The generic diagnostic found no useful region and
   incorrectly taught that literal backslash-n must never occur in old_string.
5. A whole-file replacement switched to `String.fromCharCode(10)` but left
   quotes around that expression. Four more test failures followed. A subsequent
   edit removed the quotes; all suites finally passed.

The source matcher also had a separate deterministic defect: after identifying
a unique whitespace-normalized region it located the first and last words
independently in the original file. A repeated first word could return bytes
from an entirely different region.

### Exact acceptance failure

Old superseded reads of the repaired small proof files remained first in the
refresh queue even after fresh complete reads were visible. README and three
proof files consumed all four slots. At final acceptance, test.js,
test-impossible-cycle.js and resolve.js remained truncated despite being read
again during remediation. The global judge approved the bounded proof phase,
but focused review correctly treated unseen assertions as unverified and
refused ten criteria. Passing totals must not substitute for those assertions.

## Corrections

- Retain the existing **24,000 source-character budget**, with a separate cap
  of sixteen read attempts. Small files no longer exhaust four slots while
  substantial character budget sits unused. Unknown/omitted bytes stay labelled.
- A superseded/truncated read needs no refresh only when the latest known read
  is host-marked complete **and its event survived this judge's evidence
  selection**. Later writes, unavailable evidence and historical records lacking
  a truncation fact still require readback. This changes neither verdicts nor
  execution credit and adds no model call.
- Describe source-level escaping in the actual write/edit argument schemas.
  Never claim that a mismatched old span proves how to unescape its replacement.
  Source text still reaches disk exactly as supplied after JSON decoding.
- Match diagnostic regions with original offsets. Return bounded, JSON-encoded
  candidate regions for short/ambiguous whitespace and escape mismatches; never
  apply a fuzzy edit or invent replacement bytes.
- Refuse missing/non-string `new_string` rather than silently deleting the old
  span. Explicit empty-string deletion remains supported.

## Regression and adversarial coverage

- Production resolver source/fixtures exercise `acceptRootResult` through both
  global and focused prompts; full source and assertions must reach both.
- Five complete files within the character budget, small repaired files before
  larger unchanged tests, 24,000/24,001/100,000-character boundaries, unavailable
  paths, sixteen-attempt cap, stale/cross-branch reads, and omitted current reads.
- Unknown historical truncation facts, forged content markers, later edits and
  failed executions remain unverified; readback creates no execution credit.
- Exact escaped bytes cross the real Codex native-tool JSON-RPC handler into
  real filesystem tools, with a refused edit followed by a correct explicit edit.
  The model itself is mocked; no claim is made that every model will follow a hint.
- All twenty failed edits of run 3 are replayed against reconstructed snapshots
  in `edit-cases.json`: successful writes/edits and full reads establish those
  bytes; the intervening shell commands only inspect files. Four ambiguous
  matches remain refused, and all sixteen formerly unhelpful diagnostics expose
  real candidate bytes. Every refused edit leaves the file unchanged.
- Multiple similar regions, repeated anchor words, mixed real line breaks and
  source escapes, missing replacement, unchanged edits and explicit deletion.

No new gate, automatic repair, paid replay, deployment or GitHub publication is
part of this correction. A production rerun after deployment remains necessary
to measure model behavior and confirm end-to-end delivery.

## Verification result

`npm run check` passed documentation checks, both TypeScript configurations and
ESLint. Its test run passed 5,451 tests, skipped nine, and failed one unrelated
showcase test: `source.answer(text, text)` returned null in
`tests/viz-showcase.test.ts:250`. The complete showcase file then passed all
twenty tests in isolation. The aggregate check is therefore recorded as failed,
not retrospectively green. All resolver regression tests passed, including the
twenty recorded edit failures and the native-tool transport test. The test
models are mocked and verification made no paid model calls.

### Follow-up before deployment

The showcase failure was a fixture ordering assumption: two runs could receive
the same millisecond timestamp, so the store's UUID tie-breaker could anchor the
entry on the file delivery instead of the text delivery. The answer test now
freezes that timestamp, obtains the actual public entry id, and checks the exact
bounded answer plus the absence of an answer for the file episode under that
same entry. The separate chronological grouping test advances a controlled
clock. No production ordering or visibility rule was changed.

After `npm ci`, `npm run release:check` passed: documentation, both TypeScript
configurations, lint, audit (zero vulnerabilities), build, compiled release/auth
smokes, CLI help smokes, and 5,442 tests (19 conditional skips, zero failures).
The CI worker job remains responsible for its required Docker isolation proof.

The real browser smoke then exposed another test assumption: at 528×800, the
older run's PR link was rendered at viewport y=918. The scenario waited for an
on-screen click target without scrolling the project list. A diagnostic capture
confirmed the offscreen geometry. The smoke now wheels the real list to reveal
the link before retaining its existing pointer-click and destination assertions.
It uses the same canvas wheel event as the established scroll probe. The mobile
probe similarly targeted the offscreen centre of a partially visible run card
(y=632 in a 600px viewport); its native touch gesture now starts on the visible
title and measures that same point after the gesture. Neither correction
bypasses the production scroll handler or relaxes the interaction assertions.

The mobile investigation found two separate causes. Pixi's EventSystem sets an
inline `touch-action: none` during initialization, overriding the normal
stylesheet's `pan-y`; the canvas rule now overrides that default with
`pan-y !important`, checked through the computed browser style. Separately,
enabling touch emulation changes pointer capability and re-arms the required
handheld arrival gate. Event capture proved the project vanished before the
first movement, rather than being activated by the drag. The probe now passes
the real welcome and mobile acknowledgement before measuring its gesture.
An experimental renderer tap guard was removed once that evidence corrected
the diagnosis; the production gesture router remains unchanged.

The isolated browser account path subsequently passed the PR link, automatic
update/draft preservation, native mobile scroll without row activation, MCP
settings, and account switching. The aggregate browser smoke is still **not
green**: its wide-copy matcher now finds only the run-error label (the repository
URL is ellipsized before its repeated `m` characters), its captured Settings hit
targets were empty, and Pixi emitted bound-resource destruction warnings while
the mobile notice unmounted the scene. No WebGPU validation errors were recorded.
These are retained as separate UI follow-up evidence, not suppressed or counted
as a passing browser check. The supported release gate and CI remain separate.

Final source verification on 2026-10-06: `npm run release:check` passed all
static/compiled checks and 5,452 tests with nine conditional skips. Docker was
available for this final pass: all twenty container-isolation tests passed.
