# Complete evidence retention and validator reading

The owner requested complete evidence retention, complementary reading by
validators, and a model-dependent context budget on 2026-10-22. This supersedes
the fixed default in [the earlier 48k decision](tool-evidence-budget-2026-10-22.md).
It does not claim that larger prompts produce better judgments or fewer retries.

## Retention and access

At the production executor seam, every attested tool result retains its complete
JSON-serialized request and result before the existing observation excerpts are
constructed. `fullEvidence` is a gzip/Base64 member with original byte length and
SHA-256, persisted in the existing run trace. Its size is not limited to 24k or
48k. Native tool limits still define what a tool actually returned: an archive
does not invent stdout a tool never returned, the rest of a requested file page,
or missing bytes in a legacy observation. Serialization failures remain explicit
unattested observations under the existing policy.

Supervisor source read-backs retain their complete captured replies too. They
use a separate host-review branch; they cannot become a worker's actions or
earn execution credit. The existing 24k/96k source excerpts and the 20k L1 tool
presentation limit remain presentation windows, not archive limits. The 24k
prior-result and discovery-report bounds apply to model-authored reports, not to
the runtime evidence archive.

Each result reviewer and independent criterion reviewer receives an inventory
and may return exact JSON requesting event ids and character ranges. The host
returns pages from the immutable snapshot, with its identity, provenance, total
length and continuation offset. It never runs commands, fetches URLs or rereads
the current filesystem in response. Only witness ids belonging to the judging
result and the latest supervisor file snapshots in its review branch are in the
inventory. Old accepted-phase witness references can resolve across attempts.
Missing, legacy and corrupt archives remain explicitly unknown. Superseded
source bodies remain archived but are omitted from current judgement; a failed
refresh cannot revive an older host snapshot. Source metadata identifies the
later write. A resumed checkpoint preserves historical records in separate
`run_checkpoint_evidence` rows of the existing product database, outside the
bounded plan payload. Their ids remain readable; lookup-only restoration never
populates the new process's branch/attempt proof counters or credits the prefix
again. The new trace copies these archives with an explicit historical marker.
Literal search within a captured JSON member can locate an assertion deep in a
large response without traversing every preceding page. A missing literal match
is not a verdict about source or behavior. Inventory pagination must make
progress even when one path or summary is long; requested pages reserve their
serialized envelopes, and any older pages displaced from active context are
listed explicitly rather than silently discarded.

Eight additional reading rounds bound a review, under the same model, signal,
deadline and usage accounting as its original call. Inventory pages and requested
bodies share the active context budget. Recent pages replace older pages only
when needed; optional reviewer notes remain fallible model text, never evidence.
A malformed/mixed request or exhausted reading protocol is a reviewer fault, not
an approval or a demonstrated artifact defect. A child review fault retries only
the review of the same completed result, then escalates blamelessly; an incomplete
root review keeps work partial without starting another implementation pass. No new automatic approval gate
is introduced. Decision defers when the compact receipt leaves archived bytes
unseen, since it cannot use the reading protocol. Reading responses do not enter
its verdict calibration corpus or the project/activity verdict counts. Live trace
delta polls omit attestations instead of retransmitting the entire archive every
second. The complete canonical trace remains available on the full-trace path.
Bounded MCP projections retain their separate 32 MiB materialization limit; that
is not an archive retention cap and is never used for checkpoint restoration.

## Model budget

The model catalogue carries optional transport-specific usable context windows.
The OpenAI subscription entries use the native Codex capability catalogue observed
on this machine on 2026-10-22: 272,000 tokens for GPT-5.6 Luna/Terra/Sol and
GPT-6 Luna/Sol/Astra. These values are not copied to their API transports.
Claude API windows follow the [provider's context documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows),
with a conservative 200k CLI allowance. An exact-selector JSON map in
`ATOMA_MODEL_CONTEXT_WINDOWS` can set deployment-specific capacities. Ollama uses
its configured request context. Unknown models retain a clearly labelled,
unverified 32,768 fallback for compatibility; operators should configure their
actual capacity. A fallback is not evidence of a provider's real limit.

Before selecting evidence, the budget subtracts the requested maximum output,
15% tokenizer/protocol headroom, system instructions and the remaining task context.
Visible text uses a local o200k_base BPE reference estimate (pinned js-tiktoken),
in bounded Unicode-safe chunks to avoid quadratic work on unbroken tool output,
with ordinary handling of special-token spellings in untrusted text. Other
provider tokenizers may differ; this is a capacity estimate, not billing usage. Inventory and reading
pages are measured after JSON serialization. Large pre-rendered host evidence
also has a full `host_review_context` snapshot, recorded directly in the trace
without entering execution-proof counters. Its preview is token-measured and
may shrink; reviewers can retrieve its original text by id/search. Original
tasks, criterion lists, mechanical dispositions, proof obligations and landing
policies stay outside this reducible presentation. Dense Unicode is covered,
not only repetitive English fixtures. An oversized base request fails
before a paid call rather than silently dropping criteria or task constraints.

## Adversarial review and boundaries

The accepted mechanism was checked against the historical failures which shaped
the selector: successful receipts lost to later noise, the latest failure of the
same command, distinct branches/arguments, superseded source, browser proofs lost
to later tuning, filtered interactions, and multiline content forging evidence
lines. Their original negative controls stay exercised at a fixed fixture
allowance; the production default is no longer that fixture's budget.

Additional attacks cover guessed unrelated ids, integrity corruption, mutable
results after observation, missing archives, oversized Unicode/escaped pages,
invalid offsets, mixed verdict/read envelopes, truncated or repaired requests,
repeated reading, cancellation, and capacities too small for the instructions.
The persistence test crosses the production executor, trace recorder and saved
JSON boundary with a middle assertion beyond 200k characters. Host source reads
are exercised through the production source read-back path; independent root
criterion reviews use the same reading protocol. These are mocked-model tests,
not a measured production accuracy or cost gain.

Rejected shortcuts: gzip/Base64 directly in a model prompt; treating compression
as fewer input tokens; giving supervisors shell tools; accepting ids from the
whole run log; describing old excerpts as complete; dropping task constraints
to fit; or counting a read request as a verdict. A larger window cannot repair
bytes discarded before capture, and an archive of a passing command never proves
every requirement or a later source generation.
