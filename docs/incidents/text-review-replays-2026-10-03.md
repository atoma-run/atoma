# Text review and continuity: production replays, 2026-10-03

## Revision and method

Commit `51c1574e09bd9168a72fc92797a07963238b4b49` passed Linux CI
`37119350290` before main. Main CI `37119680534` initially had one failure
in the existing Codex parent-crash/process-seat test (5,275 tests passed).
Its failed jobs passed on one unchanged rerun; deployment `37120184792`
succeeded. Both archived production traces identify that exact revision.

Requests and independent finite oracles were recorded before launch in
[the evidence directory](evidence-text-review-history-2026-10-03/).
Every summary page and all LLM, registry and verdict events were read and
archived. Costs below are subscription accounting, not API invoices.

| Run | Result | Calls | Seconds | Accounted USD |
|---|---|---:|---:|---:|
| `c7fce1a1-2a46-4661-b366-6181bd3da760` | All numbers correct; completeness false approval | 10 | 272.233 | 0.1710 |
| `6aa9cf08-ac82-4146-9026-bbc8bde20823` | Context-dependent R3 follow-up correct | 5 | 65.406 | 0.0947 |

## Complete coding replay: numeric recovery is not complete compliance

The same goal and Luna/Terra/Sol pins produced all eight correct codewords,
24 correct distances, the correct three-way R2 tie and correction positions.
Sclerenchyma delegated sequentially to Sclereid and Idioblast; both reused
Hemoglobin. Trust shortcuts were active, but root acceptance still ran.

The independently generated Terra reference was **wrong**: it encoded 101 as
1011110 instead of 1011100 and propagated that error into distances and
nearest sets. The final reviewer accepted the correct candidate rather than
copying that reference. This confirms why the reference cannot be ground
truth, a vote or a mechanical rejection trigger. Its verdict did not explain
the disagreement, so it does not establish how the reviewer resolved it.

The final answer omitted the explicitly requested definition of Hamming
distance. Approval therefore remains a completeness defect, even though all
three narrower user criteria were marked met. It also leaves the absence of
an error-bound guarantee for R1/R3 implicit. The new-domain batch was paused;
the related continuity regression was completed to separate the two fixes.

The next adjustment keeps the shared validation system prompt and its cache
prefix intact, but ends root text review with an explicit coverage audit:
locate the requested components in the actual output, not in the question,
summary or reference; explain omissions even when the listed criteria pass;
resolve reference disagreements from source. The blinded reference must
inventory requested components before calculating. This adds no model call,
model upgrade, lexical detector or mechanical gate. Mocked regression tests
prove prompt routing and preservation of a refusal with all criteria met;
only another production replay can establish model compliance.

## Historical continuity: observed through the real child process

The new prompt deliberately did not repeat the encoder or R3 bits. The run
received the original run and its audit through `previousRunResults`, not the
comparison replay. Planning and execution could use the actual source
definition. Its concise answer correctly identified R3 as E(011)=0111010,
distance zero, no correction, and differing positions 1,2,3,7 against E(100).
It explicitly corrected the historical claim of six to four.

This is evidence for bounded seed-lineage continuity, not unlimited project
memory. The reference and root review were both present. No files or GitHub
publication were produced by these text runs.
