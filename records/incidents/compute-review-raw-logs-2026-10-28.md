# Compute reviewer protocol recovery and raw log retention — 2026-10-28

The preceding [MCP validation](compute-validation-mcp-attica-2026-10-28.md)
ended inconclusive on a prose-wrapped evidence-read request. Its worker also
redirected raw check/browser logs into `/tmp` and returned only grep excerpts;
container removal lost the raw files. The owner requested both defects fixed,
verified and deployed before retrying the same immutable Attica checkpoint.

## Review protocol recovery

An isolated, completed, schema-valid reading envelope wrapped in prose may
receive one tool-free re-emission request per complete review. Detection never
executes the extracted JSON. The model must respond again with an exact,
completed reading request; a verdict cannot replace that pending read. Inventory,
recorded pages, criteria and evidence remain unchanged. This extra call uses the
same model, signal, context budget and accounting, with `verdict-repair` role.
The eight actual reading rounds remain bounded separately.

Adversarial review checked the proposed acceptance mechanism, not just rejected
alternatives: mixed verdict/read objects, nested requests, multiple envelopes,
invalid ranges, unfinished replies, repeated wrapper faults and a correction
that tries to approve all remain unjudged reviewer faults. A second wrapper
does not obtain another correction. Cancellation propagates before spend.
No elements execute, work is not replayed, and the correction grants no trust.
Existing criterion-shape disagreements and real failed assertions retain their
ordinary decisions. This fixes serialization recovery, not acceptance policy.

Regression coverage follows the actual focused criterion-review path through
an initial page, prose-wrapped continuation, exact re-emission and final complete
judgment. Other tests exercise every refusal above and the unchanged branch/
attempt archive boundaries. No model was paid to produce test verdicts.

## Retaining raw redirected logs

The worker image enables command-log capture on its private `/tmp`. The host's
in-process tools and a directly started worker do not enable it by default.
Before each shell command the collector records file identities; after the
command settles and its process groups are reaped, changed top-level `.log`
files are snapshotted into the returned tool result. `record_probe` composes
the same shell implementation and retains the same result metadata.

Only single-link regular UTF-8 files are read, through no-follow/nonblocking
descriptors whose identities are checked before and after bounded reads. Limits
are 8 MiB raw, 4 MiB encoded and 32 captured files per call, with at most 256
listed paths. Removed, unsafe, unreadable, binary, changing and over-bound files
are explicit omissions. The encoded bound and bounded omission list were added
during adversarial review to prevent a successful capture from exceeding the
worker frame budget. No recursive dependency crawl or arbitrary host path read.

Each file retains raw byte count and SHA-256, plus the existing length- and
digest-checked gzip archive of its complete text. The parent transport receipt
and run trace retain those archives before any model-facing excerpting or worker
removal. No application file, probe manifest or second product store holds them.
The file-name convention is explicit in the worker's live tool declaration;
other filenames and subdirectories are outside this capture policy.

Result/criterion reviewers can page a captured log by a derived inventory id,
scoped to a parent receipt already visible to that judgment. These snapshots
are untrusted file contents: they invent neither an exit status nor current
test freshness. The parent command and its actual status remain necessary.
Corrupt or legacy archives remain unavailable rather than being reconstructed.

Tests cover full redirected text through persisted transport archival, deletion
and paged review; ordinary host opt-out; unsafe links and binary/oversized files;
removed/excessive paths and encoded transfer bounds. A real freshly built worker
test reads a redirected `/tmp/check.log` after engine-confirmed container drain.
CI's existing fresh-worker job includes this regression alongside isolation and
egress tests. The local image uses a separate tag, preserving active agents'
images and checkouts.

## Verification and production follow-up

The first complete `npm ci` / `release:check` passed 8,550 tests, 44 skipped,
before the final encoded-bound hardening. The final `release:check` passed
8,551 tests, 44 skipped, including both TypeScript configurations, lint,
documentation checks, audit (zero vulnerabilities), build and compiled release
smokes. A separate final worker image, built from packaged `dist/` over the
unchanged cached worker runtime, passed 19/19 closure and log-retention tests,
including real engine-confirmed removal. The full release Dockerfile build and
CI fresh-worker isolation/egress proof remain distinct from that cached-runtime
test. Deployment receipt and the next MCP validation are recorded after completion.
