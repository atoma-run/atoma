# Complete evidence retention and model-sized review contexts

Owner request, 2026-10-22: retain complete evidence, let validators request
complementary recorded pages, and size active context to the selected model.
[Decision and implementation boundaries](../records/decisions/complete-evidence-reading-2026-10-22.md).

Full attested requests/results and host read-back replies are gzip/Base64 archives
with byte length and SHA-256. The 24k/48k evidence retention ceiling is gone.
Native tool/page limits still bound what was actually returned; legacy lost bytes
cannot be recovered. Initial excerpts are presentation windows, not retention.

Validators can request ids, UTF-16 offsets, lengths and literal searches from
host-whitelisted immutable snapshots. No tool replay or new execution credit.
Superseded read/write/edit bodies stay archived but out of current judgement.
Protocol faults never blame the child or trigger implementation replay at root.
Parallel criterion batches settle before a fault leaves the run.

Large host presentations also keep a complete host_review_context archive.
Only their token-measured preview is reduced; original task/criteria and policy
stay mandatory. These snapshots bypass active proof/credit and are trace-only.

Capacity comes from transport-specific model metadata or the host snapshot's
ATOMA_MODEL_CONTEXT_WINDOWS. Local o200k_base BPE estimates input tokens,
reserving output and 15% tokenizer/protocol headroom. Other tokenizers can differ;
unknown capacity is explicitly unverified. Never treat gzip as fewer model tokens.

Sequential checkpoints retain historical archives in the existing product store's
run_checkpoint_evidence rows, outside the bounded plan payload. Restored ids resolve
by get() only; forAttempt/forBranch remain fresh. New traces retain historical tags.
Live trace deltas omit attestation archives; full canonical traces preserve them.
Bounded MCP projections keep their own materialization limits and are not resume readers.

Adversarial Bugbot review covered protocol faults, stale preview/page/write bodies,
checkpoint restoration, sibling model calls after errors, delta amplification and
snapshot config forwarding. Regressions cross real runner processes with mocked
providers, including a >200k archive read after cold continuation.
