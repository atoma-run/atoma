# Coding-theory delivery accepted with a wrong distance — 2026-10-03

The owner requested further production experiments outside executable apps.
Two projects were created and exhaustive references recorded before starting
any run: a finite binary code and an integer temporal-constraint problem.
The first result exposed another false approval, so the unrelated temporal
runs and planned ambiguity follow-up were deferred. A targeted diagnostic
audit follows the defective entry; this is not a new unrelated batch.

## Preregistered reference

The encoder is E(a,b,c)=(a,b,c,a XOR b,b XOR c,a XOR c,a XOR b XOR c).
Eight codewords and all 24 distances were computed outside Atoma, before
the run. All 28 distinct codeword pairs have distance 4. The received word
R2=1110100 has three nearest data words, 101/110/111, at distance 2.
R3=0111010 is the codeword for 011. Its distance to E(100)=1001011 is 4:
positions 1, 2, 3 and 7 differ.

[recompute.py](evidence-new-domains-2026-10-03/recompute.py) independently
enumerates the finite reference without model calls or model-authored code.
The [initial coding request and reference](evidence-new-domains-2026-10-03/code-preregistration.json)
and [temporal request and reference](evidence-new-domains-2026-10-03/time-preregistration.json)
precede execution. The temporal problem has exactly five feasible tuples;
its tightened E<=5 follow-up is infeasible, and the minimum feasible deadline
is 6. These are references, not observed Atoma successes: those runs did not
start.

## Observed failure

Project: 3b0a64ec-3989-4d7e-af04-1a0dcc88af3b.
Run: 2ff3b86f-66b2-4b7b-be0a-d5b81bac81e1.
Actual release: 7d2f6fcd93848fa164e8c206a2ff7af042ba94ea.
Model pins: Luna execution, Terra L2/root text review, Sol L3, through
the host subscription. Delivered after 279.185 seconds, 14 LLM calls,
9 Jev calls and $0.2236 subscription accounting; no root remediation.

The router chose creation. The platform tissue author used
sub:openai:gpt-5.6-sol and created Sclerenchyma. Its plan delegated two
sequential reasoning phases to Sclereid: construct a draft, then independently
recompute and audit it. The first used Adrenaline, the second created
Hemoglobin. Both executed with Luna and both reported the same wrong R3 row:
(4,4,4,0,6,4,4,4), instead of (4,4,4,0,4,4,4).

Intermediate Luna reviews approved the wrong table. The final Terra review
also approved, explicitly marking all 24 distances correct. The complete
body reached that reviewer; this was neither a truncated result nor a model
routing failure. The output contradicts its own correct claim that every
distinct codeword pair has distance 4, because R3 itself is a codeword.

The codebook, R1/R2 rows, nearest sets, correction positions and rejection of
the technician's unconditional uniqueness claim are correct. Nevertheless,
the task explicitly requires every distance: 23/24 correct is a failed
delivery, regardless of the platform's delivered status.

The two model passes are not evidence of independent arithmetic. They share
the model and the second sees prior work. Their matching error demonstrates
correlated failure on this run; it does not establish which input caused it.
Upgrading the root reviewer fixed the earlier observed editorial cases but
does not guarantee exact mathematical verification.

Full paged metadata, summary and LLM events:
[code.json](evidence-new-domains-2026-10-03/code.json). Earlier wrong drafts
and all approvals are preserved, not replaced with the corrected reference.

## Targeted diagnostic

The [audit request](evidence-new-domains-2026-10-03/audit-request.json) supplies
the two strings and the prior contradictory claims, asks for all seven bit
pairs and the differing-position set, and limits the response to this entry.
It changes the task; any success is assisted recovery, not a repeat of the
original workload or evidence that the platform defect is fixed.

Run ce1c7dbe-eafa-41a4-ada4-5c3ffd9e1b10 reuses Sclerenchyma through Jev,
then Sclereid/Hemoglobin. It delivers the correct seven bit comparisons,
the set {1,2,3,7}, and the explicit correction 6 to 4. It takes 87.859
seconds, five LLM calls, five Jev calls and $0.0498 accounting, with no
root remediation. [Full evidence](evidence-new-domains-2026-10-03/code-audit.json).

Its last paragraph calls the received-word/codeword comparison a different
statement from the distinct-codeword assertion, saying the value happens to
equal 4. This misses that R3 is itself E(011). However, the diagnostic request
omitted the encoder, and the execution input contains that new request and
an empty starting repository, not the previous text answer. The run has a
seed receipt pointing at its predecessor, but this is not evidence that the
previous text was provided to the model. Do not attribute that missing link
solely to arithmetic ability: this follow-up is context-limited. The observed
recovery establishes the corrected distance, not full contextual continuity.

## Same-goal model comparison

A comparison rerun of the original complete problem changes only the L1 pin
to Terra, keeping L2 Terra and L3 Sol. The comparison API retains the original
goal, criteria and starting workspace; it never publishes or seeds another
run. The [request](evidence-new-domains-2026-10-03/terra-comparison-request.json)
is recorded before launch. Registry knowledge and trust have changed since
the first run, so this remains diagnostic evidence, not a controlled estimate
of a model effect. Changing L1 also changes the cheap review/routing call sites
that use that pin; it does not isolate the execution call alone.

Run 12cf7e36-8d24-43e9-ade9-92cbf58e3a4c finishes on the same release
after 405.973 seconds, 18 calls and $0.5660 accounting, with one root
remediation. Its first execution misencodes 101 as 1011110, propagating
errors into three distances and the nearest sets. Its second execution
repairs that codeword but reports R3-to-110 as 5. Terra root review refuses
that specific entry and requests a recheck. The remediation delegates
sequentially to two different L2 cells, Trichome and Protoplast, both using
Hemoglobin. The final output has all eight correct codewords, all 24 correct
distances, correct nearest sets and changed positions, and a valid minimum
distance argument. This is recovered arithmetic, not an error-free run.

The final text still omits the explicitly requested definition of Hamming
distance. That definition appeared in its earlier draft but disappeared from
the final response. The supplied three acceptance criteria cover numerical
correctness and the claim audit, not that standalone definition. Thus all
three criteria pass, but full goal compliance still has a presentation
omission. Do not report this run as perfect.

[Full comparison evidence](evidence-new-domains-2026-10-03/code-terra.json)
preserves every LLM call, including failed intermediate answers and both root
verdicts. [check-deliveries.py](evidence-new-domains-2026-10-03/check-deliveries.py)
reads the actual final text of both complete runs and recomputes the eight
encodings and 24 distances. It confirms exactly one baseline mismatch and
none in the comparison. This bounded archive checker is not a general text
validator and does not check every prose requirement.

The MCP start call timed out after 300 seconds, while the server continued.
Read-only status and trace calls followed the same run to completion; no
duplicate start was issued. The
[transport record](evidence-new-domains-2026-10-03/transport-timeout.json)
distinguishes a client call timeout from a run failure.

## Findings and remaining work

| Run | Calls | Seconds | Accounting USD | Independent assessment |
|---|---:|---:|---:|---|
| Original Luna execution | 14 | 279.185 | 0.2236 | Wrong distance approved |
| Focused Luna audit | 5 | 87.859 | 0.0498 | Arithmetic repaired; prior text absent from input |
| Original goal, Terra L1 | 18 | 405.973 | 0.5660 | Arithmetic repaired after root refusal; definition omitted |

Total: 37 LLM calls, 773.017 seconds and $0.8394 subscription accounting,
not an additional API invoice. All three runs are finished. There are no
file artifacts or publication receipts. The prepared temporal project
6eef0d8f-5e6d-4cda-853a-86a1cf8fc47b remains unrun; its planned tests and the
original ambiguity follow-up are explicitly deferred.

Creation through the platform L3, subsequent Jev reuse, and delegation to
multiple L2 cells all occurred in production. They do not establish
correctness: false reviews also earned phase trust, and later trust fast
paths appear in the trace. Root review remains outside that shortcut and
caught one error in the comparison, but missed another in the baseline.

Before another unrelated batch, investigate the exact-reasoning false
approval and text-result continuity across project runs. This series
deliberately prohibited tools to test reasoning-only delivery; it does not
measure a tool-assisted verification workflow. A generic fix must respect
that constraint and the existing supervision boundary. Do not add a
coding-theory-specific production detector, label all text verified, or
upgrade every execution model based on this one comparison. No runtime
source or account model defaults changed here.

Validation: both quota-free Python scripts pass; docs:check and
git diff --check pass. Complete trace summaries were paged to nextOffset=null,
and metadata/event detail pages were joined through nextTextOffset=null.
The incident evidence is saved before any future live batch.
