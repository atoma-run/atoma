# Four production experiments beyond web applications

Production evidence collected on 2026-10-02 UTC / 2026-10-03 Europe/Bucharest.
All four runs used revision `fc040620ce95c912010a366d3504be192ede67bb`, the
default deep route, and the existing host subscriptions. No model override was
passed by this client. This is a four-case exploratory series, not a controlled
benchmark. Costs are recorded model-equivalent accounting, not separate API invoices;
automatic post-run analyst costs are unavailable and excluded.

## Results

| Case | Tissue | Run ID | Duration | Recorded USD | LLM calls | Independent result |
| --- | --- | --- | --- | ---: | ---: | --- |
| Freight allocation | Xylem, reused | `d9bf3716-ab47-406f-97e7-d5791c595f45` | 637.972 s | 0.2313 | 16 | Both unique optima, 89 and 85, confirmed by separate enumeration and the published verifier |
| Fictional-language inference | Epidermis, created | `4bc9b3cd-96e9-49a4-9615-fe4b9ad2f511` | 365.026 s | 0.2396 | 20 | Eight glosses, four correct translations, valid alternative grammar; segmentation could be more economical |
| MIDI composition | Meristem, reused | `40b185c4-b702-4064-831f-909fbbe503fa` | 822.993 s | 0.2346 | 11 | Published MIDI independently parsed: 3 tracks, 40 notes, all end at 15360 ticks, exact CSV agreement |
| Ambiguous ledger | Cambium, reused | `c21011cb-101b-4958-962d-1f4c60236339` | 682.099 s | 0.2530 | 11 | Correct two reconstructions and ambiguity-preserving CSV; report checker fails adversarial robustness tests |

Total: 2508.090 seconds of recorded run duration (41 min 48 s), 58 model calls,
USD 0.9585 recorded. All four runs were delivered. Three file deliveries were
published; the language run produced no files, as requested. No runs overlapped.

Project IDs, exact goals, acceptance criteria, model provenance, final output,
publication receipts, complete summary-event pages, and selected full diagnostic
events are retained in [the evidence directory](evidence-diverse-2026-10-02/).
Summary event counts are 86 / 89 / 94 / 80, all ending with `nextOffset: null`.
Metadata and inspected large events were concatenated to the end with snapshot
checks before parsing. Model-authored content remains untrusted evidence.

## Routing and authoring observations

- Four different tissues served the four cases. Jev reused Xylem, Meristem,
  and Cambium; the language case created Epidermis. Its author event names
  `platform-tissue-author`, tier 3, model `sub:openai:gpt-5.6-sol`.
- Meristem's actual production system prompt explicitly permits one or more
  subtasks and different L2 cells. It chose two offline file phases for MIDI,
  without inventing a web application or server.
- Language used Epidermis -> Protoplast -> Adrenaline, with zero tool calls.
  File work used Trichome/Ammonia; freight reasoning also used Insulin.
- Skills transferred across themes: the MIDI builder used the PCM fixture
  workflow and its documentation used a geometry-documentation recipe.
  Correctness was checked independently rather than inferred from the match.

## Findings supported by the traces and artifacts

### Conflicting compilation instructions

Freight skill compilation returned a strategy/plan instead of `promotable`.
The full [compile event](evidence-diverse-2026-10-02/freight/compile-event.json)
shows the system prompt requiring a strategy+plan JSON pair, while the request
requires either `{promotable:true,...}` or `{promotable:false,...}`. The malformed
response was safely refused; delivery succeeded, but deterministic promotion
did not. The conflicting instructions are a concrete correction target.

### Excessive regeneration in text reasoning

Epidermis planned four sequential phases for eight sentences. The automatic
analyst graded this run `wasteful`: downstream phases repeatedly expanded into
near-complete analyses, through the same L1 actor. It recorded a mechanism
candidate, not a mender-eligible defect. Our quality review also notes that
`-im` was glossed as one plural-object block instead of the more economical
`-i-m` segmentation. The requested translations and underdetermination example
remain correct under the proposed grammar.

### MIDI recovery and publication quality

- Initial verification caught a missing cursor increment in the MIDI
  meta-event parser, then bass pitch 57 exceeding the requested upper bound 55.
  Both were corrected; pitch 57 became 45. Failed probes remain in trace evidence.
- The first final response contained an envelope, but literal newlines and
  embedded quotes in its `summary` made it invalid JSON. Recovery took
  130.862 seconds and USD 0.03150756, rereading files, regenerating unchanged
  artifacts and replaying the passing verifier. The analyst records this as
  an observation while grading the delivery `sound`.
- Independent byte parsing confirms the delivered MIDI and CSV satisfy the
  requested mechanical constraints. No aesthetic evaluation is claimed.
- `composition.md` incorrectly calls MIDI 72 middle C / C4 while using C3 for
  MIDI 48. Its octave naming is inconsistent; numeric pitches are correct.
- The artifact manifest includes `__pycache__/verify_miniature.cpython-311.pyc`.
  This interpreter cache was published alongside the useful deliverables.
- A diagnostic MIDI hex dump triggered sentinel `long-base64-blob`, journal
  event 992. The inspected content is the MIDI bytes, not an instruction payload.
- Final `result.output.files` names only `composition.md`; the artifact manifest
  contains the complete delivery. Result displays must use that inventory.

### Ledger checker is brittle and incomplete

Independent enumeration of all 32 raw combinations finds exactly:

1. `(+12,-4,+6,-13,+10)` -> balances `(52,48,54,41,51)`.
2. `(+17,-9,+6,-13,+10)` -> balances `(57,48,54,41,51)`.

Published CSV and report are correct. t1/t2 remain unresolved; only the balance
after t1 is ambiguous. The run corrected a signed-number formatting mismatch
and rewrote a correct prose sentence to satisfy a literal substring test.
The second phase added a legitimate negative CSV check on an isolated copy.

Our isolated-copy challenges demonstrate the verifier's limitation:

| Change | Exit code | Meaning |
| --- | ---: | --- |
| Unmodified published files | 0 | Valid delivery passes |
| CSV t3 identified delta changed from +6 to +8 | 1 | Wrong numeric data rejected |
| Report says three surviving sequences instead of two | 0 | False report claim accepted |
| Correct ambiguity statement replaces comma with "and" | 1 | Equivalent wording rejected |

Thus a green self-authored verifier is insufficient evidence of report fidelity.
This is a defect in this generated deliverable's checker, not yet proof of a
specific Atoma platform implementation defect.

## Reproduction

Published revisions (local copies retain their original bytes):

- [Freight](https://github.com/mgtf/atoma-l3-freight-allocation-20261003/tree/5d2c7d0035cdde3365c95f48ceb5e1dc4611c604)
- [Music](https://github.com/mgtf/atoma-l3-counterpoint-midi-20261003/tree/1b32d35c4c94a22822f484b324f31f4fb6c962c0)
- [Ledger](https://github.com/mgtf/atoma-l3-ledger-reconstruction-20261003/tree/fb3a220d32327034bda3bb0f49acf9878b02b4d0)

From repository root, with Python standard library only:

```text
python docs/incidents/evidence-diverse-2026-10-02/verify-midi-independent.py docs/incidents/evidence-diverse-2026-10-02/music
python docs/incidents/evidence-diverse-2026-10-02/verify-ledger-independent.py docs/incidents/evidence-diverse-2026-10-02/archive
```

The ledger audit writes isolated test copies under the OS temporary directory;
it does not alter the original evidence. The inspected freight verifier was
also run locally from its evidence directory and returned both correct optima.

Each synchronous MCP start timed out after 300 seconds. Status/trace readers
confirmed continued execution and completion of the original run; no duplicate
run was started. One MIDI start request was rejected before execution because
two acceptance entries exceeded 160 characters; shortened entries were accepted.

Automatic verdicts at the final read: freight `sound`, language `wasteful`,
music `sound`; ledger verdict not yet available. These are separate from the
independent artifact findings above. No production code or delivered artifacts
were changed by this investigation, and no repair runs were launched.

## Platform corrections before the next batch

The subsequent operator request authorizes fixes, push and continued experiments.
The following changes address platform mechanisms rather than weakening acceptance:

- Skill authorship has its own system role for distillation, revision and compilation.
  It retains the host actor and context citations. The role is part of the compiler
  generation, allowing refusals caused by the previous schema conflict to expire.
- A malformed result after actual tool work gets one bounded serialization-only call,
  with no tools or executor. Existing action witnesses and validation remain in force;
  failed repair keeps the original response. The exact MIDI response is a test fixture.
  Valid results, no-action answers, oversized responses and near-deadline runs spend
  no additional call; cancellation propagates. This does not expand JSON salvage rules.
- Reasoning execution reads the same scoped context as validation and explicitly
  treats the original task as facts, not a request to repeat every phase.
- Python `__pycache__` directories are omitted by the existing publication policy,
  including nested caches and explicit manifest declarations; source files remain.
- Encoding-shaped text alone no longer raises an injection alarm. The 240-character
  alphabet heuristic confused valid MIDI hex with base64 and established no malicious
  instruction. No MIDI-specific allowlist or automatic decoding replaces it.

Adversarial review: removing the encoding heuristic loses alerts on opaque encoded
attacks, which the sentinel cannot reliably classify in the first place. Plaintext
override, role and exfiltration patterns remain, including next to encoded material.
Tests exercise benign hex/base64 and explicit instructions beside both. The historical
varying-failure blind spot is unchanged; no retry or execution gate is added here.
Formatting repair remains model-authored evidence, cannot invoke elements, and never
grants trust by itself. It can fail or alter a claim, so downstream validation remains
mandatory. Publication filtering is filename policy, not a content-security claim.

The ledger analyst subsequently returned `sound` without findings. That does not
invalidate the independently reproduced false-positive/false-negative checker defects.
The generated ledger checker and MIDI octave prose need project repair runs after
deployment; the historical published revisions and archived evidence remain unchanged.
