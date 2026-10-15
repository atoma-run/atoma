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
| `6c40fad5-86ad-4ec0-9a83-a165bcbfd987` | Complete coding replay correct, including definition and guarantee limits | 10 | 343.685 | 0.1737 |
| `d1de150f-a1f2-4da3-9fe2-d56ce73a3445` | All five timing solutions and explanations correct | 8 | 172.407 | 0.1202 |
| `369f13be-0010-4213-b8e8-f19a6570a893` | Tightened deadline proof and minimal repair correct | 5 | 66.902 | 0.0716 |
| `a3d9b044-e751-4490-9b2f-636ed6d18e90` | Museum label and audio script compliant | 7 | 115.913 | 0.1248 |
| `fb5a4bcf-7de7-44aa-bfb8-1e1c47c8dc6a` | Museum fact correction and narrower scope preserved | 8 | 97.451 | 0.1073 |

Seven completed runs: 53 LLM calls, 1,133.997 seconds of run time and
$0.8633 in subscription accounting. Six final outputs passed independent
review; the first replay remained a completeness false approval and is
retained as such. This is a development series, not a controlled benchmark.
Full final status receipts are archived in `run-statuses.json`.

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

## Coverage replay and new timing domain

Commit `f953df2ab3fdd84db820b9c533c10206c01f10d0` passed full CI
`37120883107` on its first attempt and deployment `37121128422` succeeded.
The subsequent traces identify this revision. The same coding prompt and
same three model pins now produced the full requested definition and the
explicit distinction between guaranteed correction under the one-flip bound
and a nearest-neighbour guess without it. Every codeword and distance is
checked by the offline script. The reference again contained an error, this
time for data 011; the reviewer explicitly identified it and accepted the
correct candidate. A malformed execution answer needed coaching and a retry;
that recovered failure remains in the trace and in the 343.685-second cost.
The synchronous MCP start timed out at 300 seconds; the server run continued
and was followed by its original ID, without a duplicate start.

This is a successful observed replay, not proof that every future omission
will be rejected: the final candidate was already complete, so no root
remediation was necessary on this run.

For the new timing problem, Jev reused Xylem. Its two sequential phases used
Adrenaline; no web application or file delivery was imposed. The final output
is a structured text object containing exactly the five independently
enumerated solutions, tight intervals, valid extreme witnesses, and a joint
infeasibility counterexample inside every marginal interval. It correctly
rejects both the proposed B=4,D=4 pair and B=4 itself under the full system.

The next run changed E<=7 to E<=5. Its concise answer derives B>=2, D>=4,
E>=6, proves impossibility at 5, and supplies the minimal replacement deadline
6 with witness (0,2,3,4,6). It preserves the requested update-only scope and
does not repeat the preceding solution table. No new failure was observed in
either timing run.

## Museum interpretation and a corrected historical fact

A new project asked for an object label and audio script from a closed
record about a palm-sized wooden bird, unknown maker and original colour,
found in a school cupboard in 1978, with one missing wing. Jev reused
Mesophyll and Protoplast; Adrenaline authored the output. The final two
sections contain 60 and 111 whitespace-separated words, within the requested
45–65 and 90–120 limits. Manual review found no invented provenance, date
of manufacture or cause of damage. The imagined sound is optional and
explicitly distinguished from evidence. The reviewer accepted varied
creative wording rather than requiring a single reference answer.

The follow-up supplied one corrected fact: discovery in 1981, superseding
1978. It asked for only the label, retaining the other historical facts and
uncertainties without repeating them in the new prompt. The result is one
59-word label, with 1981 and no 1978, audio script, change log or invented
correction mechanism. Planning received the preceding source through the
new history envelope. Current task scope and explicit corrected facts
therefore prevailed over the previous answer in this observed case.

The planned R2 extra-bit follow-up was not launched in this series; the
museum revision provided a different history/scope experiment instead.
All seven project runs reached a terminal state. The platform analyst may
subsequently hold its own lease; no experiment is left running.

## Limits and remaining observations

- Two coding references contained mathematical errors. The correct
  candidates survived, once with an explicit disagreement in the verdict.
  The extra reference is a fallible review aid, not an arithmetic guarantee.
- The latest complete coding output did not need root remediation. It does
  not prove that the revised reviewer will reject every future omission.
- One execution-format error was recovered by existing coaching, and one
  synchronous MCP wait expired while its run continued. Neither is hidden
  from the saved evidence or run cost.
- This series exercises text reasoning and editorial outputs. It establishes
  no new result for executable applications or file publication.
