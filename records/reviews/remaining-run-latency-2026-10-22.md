# Remaining run latency changes: adversarial review, 2026-10-22

Scope: preserve work on short-to-deep routing, remove duplicated prompt payloads,
version the semantic-detector corpus, repair Attica browser-test lifecycle, and
observe transport and host stages. No acceptance gate or production model pin
is relaxed. This is a mechanism review; no live speedup is claimed.

## Evidence and attempted counterexamples

The original nine terminal Attica runs include 070688f0 (18m08s spent before
short-to-deep escalation), c4d800e0 (browser command timed out at 300381ms),
89k–213k-character prompts, and repeated reporting/verification work. The first
two recommendations were deployed separately in f488de32. This review also
checks the historical failure classes documented in the inherited-check,
read-runs, checkpoint, production-run and parent-owned-test contracts.

- **Accepted: retain drained files, never retained approval.** The same existing
  workspace checkpoint capability seals two consistent bounded walks on the
  execution machine, including shutdown writes, installed dependencies and modes.
  A new backend must preserve provenance and the seal's digest. A missing drain,
  remaining process, cancellation, mutated read-run copy, unsafe/oversized tree or
  concurrent write refuses replacement. No destructive fallback or repeated seed
  read is permitted. Process-boundary regressions retain a server's shutdown
  writes and reject mutation during backend replacement; the runner tests reap a
  resistant child and succeed even when its original seed disappears. Existing
  attempt-scoped proof checks remain, and all original criteria are judged again.
  The temporary seal is discarded after the in-place transition; no state is
  replaced, so an additional `.prevN` copy is unnecessary. Snapshot limits may
  refuse very large dependency trees; failure retains their bytes.
- **Accepted: exact duplicate rendering only.** The renderer removes large
  byte-equivalent JSON payloads from its temporary original-input projection,
  never from either Task. Conflicting values stay visible. Original criteria,
  safety guidance and ordinary small values remain. A versioned corpus reference
  is coaching to inspect actual cases, not evidence that coverage is complete.
- **Accepted: executable capability diagnostic.** Both arms use the existing
  single-agent baseline, same tool protocol, corpus/seed digests and wall budget,
  fresh stores/workspaces and disabled learning. Held-out cases live outside the
  model workspace and execute through the production parent-test harness. Both
  constant-true and constant-false implementations fail; a structural fixture
  executes all eight assertions successfully. A banner, skipped test, transport
  failure or scorer failure never yields correctness. Errors retain receipts and
  later arms still run. Model pins are never promoted automatically. This measures
  candidate L1-model capability in the single-agent control, not a supervised
  L1 topology or a general model ranking. Provider caches and run order can bias
  one pair; the protocol states these limits. Dry-run spends no quota.
- **Accepted: fix the application harness at its real entrypoint.** The distinct
  Attica repository is explicitly authorized. Reproduction exposed production
  ten-second page delays in synthetic fixtures and an unbounded wait for resumed
  navigation without satisfying the real control API's verification gate. Tests
  now inject zero fixture pacing, share the durable store, assert the 425 refusal,
  verify access explicitly, and only then resume. Production pacing and API gates
  stay unchanged. Every fixture/browser resource registers cleanup before the
  next fallible await; HTTP waits are bounded. A real child-process regression
  demands successful exit with all assertions, and another deliberately fails
  Chromium launch after fixture startup and demands a nonzero exit without leaked
  handles. The real browser command passes ten tests with zero skips.
- **Accepted: observation does not decide.** Callbacks cannot change execution,
  approval or cleanup. App-server lease release, retries, tool ordering and caps
  remain identical. First token is observed only from a real text delta; the text
  transport's completed-message timing is separately labelled first response.
  Internal response envelopes include tools; elapsed unions avoid summing parallel
  work twice. Missing instrumentation is unknown, not zero. Per-call timing is
  bounded with an omission count. Late process/transfer/naming timings are optional
  host-owned sidecars, not a rewrite of the sealed child trace. Failed observation
  writes cannot grant delivery, release a lease early or alter publication.

A full-suite review caught a macOS alias-path regression: canonicalizing the
runner's public workspace path changed its authorization receipt. The one
canonical-path helper now lives with checkpoint filesystem operations and is
re-exported for compatibility; workspace runtimes pin that path before execution,
while project receipt strings keep their existing identity. The real container
transition regression now drives `deepenBackend`, retaining the heartbeat file
while proving that the old SIGTERM-resistant process cannot keep writing it.

## Regression and release evidence

Focused checks: 217 tests across runner/process/workspace/context/transport/
coordinator boundaries; an additional 79 checks cover text transport, the real
held-out scorer and timing diagnostics. Attica's full check passes 68 Vitest and
94 Node tests; its browser entrypoint passes 10 real/synthetic browser tests.
Release readiness and exact production revision are verified after this review;
workflow identifiers belong in the session receipt, not reader-facing docs.
