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
test. The full Dockerfile build subsequently passed the same 19/19 tests. Allowed
npm-registry egress returned HTTP 200; access to a private destination was denied.
All containers and networks created by these checks were drained.

Commit `172e3a565604cb2771d707ee98a9af2a307eb57a` passed
[CI 40762106982](https://github.com/atoma-run/atoma/actions/runs/40762106982),
including every test shard and fresh-worker isolation/egress, and all three
[CodeQL analyses](https://github.com/atoma-run/atoma/actions/runs/40762109124).
[Deployment 40762924563](https://github.com/atoma-run/atoma/actions/runs/40762924563)
succeeded for that exact revision. The production assayer reported that executor
idle and healthy before admission. The
[Compute workflow](https://github.com/atoma-run/atoma/actions/runs/40762106874)
also succeeded on macOS ARM, macOS Intel and Windows; the
[0.5.213 preview installers](https://github.com/atoma-run/atoma/releases/tag/compute-desktop-preview-172e3a565604)
and checksum sidecars are published. Active agents' checkouts and deliberately
local changes were not included.

## Same-checkpoint production retry: completed

The owner-authorized `atoma_compute_validation_retry` call used the authenticated
production MCP, source `5ff2e4df-32fc-4ab5-8096-2e985bc77640`, project
`07864f7c-d8f2-4023-9fca-afd8a7a51e52`, and idempotency key
`attica-compute-validation-mcp-20261028-02`. Its attempt is
`293f7277-cdcd-4c34-8892-9d48bd59281f`: created at 20:26:20.936Z,
claimed at 20:26:59.344Z and **completed** at 20:34:06.387Z on 2026-10-28.
Execution took approximately 7 minutes 7 seconds from claim to terminal receipt.
The trace itself spans 20:27:03.874Z–20:34:01.196Z (417,322 ms).
Thirteen model calls cost $0.12402084: ten GLM-4.5-Air execution/review calls and
three subscription GPT-5.6-terra learning calls. There was no budget, token or
deadline stop. Repeated reads used the same key and created no further attempt.

The retained initial snapshot remains
`5f3c80fc-a2f8-4bec-be66-e73a06ea0be5`, SHA-256
`c1edcd0dbd0908af446794b21d80aece7bf045d312bc72d9f59c2a67fa30dfa5`.
Independent read-only recomputation before and after execution, including the
materialized starting workspace, confirmed 276 entries, 251 files, 4,496,267 bytes
and root mode 0755. Initial-context payload SHA-256 remains
`773f20daff47633f9d4f30ee1d234f88271e7b748b353055ee5d587954e44b5d`.
This source is seed-based (`capturedContinuation: false`); no continuation plan
was invented. The final workspace preserves all 250 other initial files and
their modes. Only `vitest.config.ts` changes, 459→516 bytes, with final SHA-256
`b13afa283f989c1489199d8f1c1fbfa0766712d08ceb60915864df44fe9eeff2`.

Root acceptance event `14ec8a3b-d568-4914-987a-5d9ea69819c2` approves all six
criteria. Global review `02ac5b46-6965-46e7-9494-ee4756262fed` and final focused
reviews `215c2ce6-04c7-465b-ae76-0b4a9693d26b` (c1/c2),
`fd13e1a4-13ad-4a43-b479-58d5f041d5ac` (c3/c4), and
`9918a2b7-6875-4aa3-a292-a9a1d2cd1df3` (c5/c6) complete normally. Evidence-read
requests were exact JSON in this attempt; no `verdict-repair` call was needed.
Thus production demonstrates completed evidence review, while recovery of the
earlier malformed envelope is demonstrated by the production-path regression
tests, not by claiming it happened during this attempt.

The complete logs and unchanged test assertions establish:

- Root-only locked installation, with `browser/node_modules` absent before and
  after `npm run check`: typecheck, lint, **121 Vitest tests and 89 Node tests**,
  plus build pass. A nested three-test Vitest summary is not the Node total.
- After a fresh build in the main isolated workspace, the browser runner passes
  **6 files / 29 tests**, including both announcements files and all five focused
  cases, using `/usr/bin/chromium`. Assertions cover case-insensitive matching,
  counts/no-match, exact restored IDs, unchanged HTTP-200 exports during filtering,
  no collection/navigation, and exact new IDs, query, focus and unique keys after
  polling. Successful command receipt: `95339fdb-a6e1-4df1-a19c-a0afa742f51f`.

### Recovered failures and limits of the verdict

All intermediate failures remain in the trace and the reading archive:

- Direct `git diff` was refused by the element allowlist; independent checkpoint
  hashes and host read-back establish the final file change.
- An initial `/workspace/attica` copy used a nonexistent path and suppressed its
  error. The next call inspected the real `/workspace` before copying.
- The first isolated copy excluded all browser source, causing TS2307 and related
  type errors (`34f19c97-58e3-47b2-b175-443856691868`). Copying browser source
  without its optional dependencies repaired that temporary copy
  (`c6ebd00c-649b-4e44-8f5d-684348950bf1`); the complete subsequent check passed
  (`092ec68d-6b9e-49e4-8bff-906af946a203`).
- Root/browser installations succeeded, but their trailing multi-file `tail -2`
  failed. Receipt `b1c57073-b211-4422-86a9-667f97ccb35c` therefore has actual shell
  exit 1 despite an earlier printed `exit=0`. Both complete install logs survive.
- The first browser run failed one recovery test, at
  `attica-control-recovery-ui.vitest.test.ts:373`: expected `progress.active`
  false, observed true (`c13b4d4d-5e64-44a9-949e-b333c7f6ed33`). The model and
  acceptance prose attribute this to a stale seeded build. **That cause is not
  established.** The test takes its status snapshot before waiting for the page
  and listings, making a timing race plausible; a passing run after rebuilding
  does not distinguish those explanations. Its assertions and application source
  were unchanged. Report the final passing observation and retained failure,
  not a deterministic repair of that separate browser-test behavior.

The validation earned one Sucrose type-success. Independently reviewed prompt
consolidation amended Sucrose v5→v6 with source-copy/isolation discipline and
reset that type's trust; the cell amendment was unchanged. The MCP flags
`countersChanged` and `recipesChanged` are both true. The latter includes the
type patch: the proposed recipe already existed and was not overwritten, and
no new recipe-save event is present. Source client acceptance at 19:19:06.300Z
and publication at 19:19:20.657Z (commit `3a003a7d7728678ae83cb1e0d357479b9208fb7e`)
remain unchanged. This retry did not create another customer run or publish a
new Attica delivery.

## Complete retained evidence

The MCP supplied the terminal retry receipt and source status. Its public trace
reader returned `no trace at 293f7277-cdcd-4c34-8892-9d48bd59281f.json` for this
private supervisor corpus. After recording that exact capability gap, read-only
SSH retrieved the attempt's original trace and host log. The complete trace is
1,428,393 bytes, SHA-256
`90d948df8123a8ed0d66233ee458d680fbf553e92864ab60f3156e86b67d76c0`.
All 54 events, 13 model responses, prompt pages, 31 attestations and complete
archives were read. The archive index contains 47 occurrences / 29 unique
SHA-verified bodies (177,047 unique decoded bytes; 342,524 indexed occurrence
bytes). Identical previously read bodies are referenced by verified hash/range;
the local archive includes those reference bodies. An independent pass verifies
331 references and coverage of 2,364 prompt lines. The complete 20,977-byte host
log was also read through shutdown.

Eight complete raw-log versions across seven filenames survive in the original
production trace: install logs, failed and successful `attica-check.log`, failed
`browser-ui.log`, successful `browser-ui2.log`, and `build.log`. All **43,868 raw
bytes** were decoded, size/hash checked and read, with no capture omissions.
Both versions of the overwritten check log remain distinct. A read-only engine
inspection at 20:46:51Z found no worker mounted from this attempt; the retained
trace and decoded logs remain accessible after its removal. This directly
closes the earlier loss of redirected `/tmp` logs.

A private local archive, `attica-validation-293f7277.tar.gz`, holds the immutable
trace snapshots, initial integrity receipts, terminal MCP receipt, raw logs,
decoded archives, reading coverage, prior reference bodies, complete host log,
local verification logs and GitHub receipts. All **97 payload files** were
verified against its internal `SHA256SUMS` after packaging. Its archive SHA-256
is `df1e9c234da606b52f1bc39ed3f69cf22636ca63c15f7c24c8a54578587ccf4d`;
permissions are 0600. It is retained with this chat's local artifacts, not in
the public repository. No extra private-payload upload was attempted. Original
production evidence remains under the source's `attempts/293f7277-…/` directory.
