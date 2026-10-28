# Attica Compute validation retried through production MCP — 2026-10-28

The owner requested one retry on the same checkpoint and a complete reading
through the final verdict. The retry ended **inconclusive**: a criterion reviewer
emitted prose before an evidence-reading JSON request. Execution checks passed;
final acceptance did not. That refusal establishes no implementation defect.

## Identity and admission

- Project: `07864f7c-d8f2-4023-9fca-afd8a7a51e52`.
- Compute source: `5ff2e4df-32fc-4ab5-8096-2e985bc77640`.
- Selected seed: `38bfe415-018e-406f-8609-326779646429`.
- Retry / hosted validation: `623f69d8-5e34-4b50-a96d-e758a41e2165`.
- Idempotency key: `attica-compute-validation-mcp-20261028-01`.
- Runtime revision: `9b53b99e333222573a5c9a22ec670470f193d0af`, hosted
  Linux x64 / Node v24.22.1, verified from trace provenance.

Production MCP reads came first. The cached plugin catalogue did not expose the
new retry tool, so an authenticated SDK client discovered production tools and
called `atoma_compute_validation_retry` on `https://atoma.run/mcp`. This was an
MCP admission, not a SQL requeue. Repeating the key returned the same attempt.
Queued 19:25:58.844Z, claimed 19:26:41.613Z, terminal 19:31:19.280Z: about
4m38s after claim. Eleven `api:zai:glm-4.5-air` calls cost $0.04272880000000001:
166,219 input, 5,158 output and 127,040 cached input tokens (298,417 billable).
No cost, token or deadline stop occurred.

## Independent state checks

Snapshot `5f3c80fc-a2f8-4bec-be66-e73a06ea0be5` retained digest
`c1edcd0dbd0908af446794b21d80aece7bf045d312bc72d9f59c2a67fa30dfa5`.
Persisted context SHA-256 remained
`773f20daff47633f9d4f30ee1d234f88271e7b748b353055ee5d587954e44b5d`.
Read-only recomputation covered 276 entries, 251 files, 4,496,267 bytes and root
mode 0755; the materialized initial workspace matched. This seed-based source
has no continuation plan (`capturedContinuation: false`); none was invented.

Final comparison established 250 byte-identical initial files and unchanged
initial modes. Only `vitest.config.ts` changed, 459 to 516 bytes, adding the
browser-only proof exclusion. SHA-256 changed from
`b34bc2c4069f5ffbf6f8bd17a646e150b2284dbf4caefab4d219b091e1562cc6` to
`b13afa283f989c1489199d8f1c1fbfa0766712d08ceb60915864df44fe9eeff2`.
One ledger `type-success` credits Sucrose by Idioblast (version 4): receipt
`countersChanged: true`, `recipesChanged: false`. No root remediation, second
retry, model replay or customer run was launched.

## Execution evidence and limitations

Retained tool replies show an isolated source copy without dependencies/stale
dist, successful root-only locked installation, then `check_exit=0` with
browser/node_modules absent. The proof file was not selected. Returned Vitest
summaries show 32 files / 121 tests and another 1-file/3-test summary. The model
incorrectly called the latter the complete legacy Node test total; this excerpt
does not establish that total. The unchanged check script includes Node tests.

The separate browser runner returned `browser_exit=0`, both requested files
selected (3 and 2 tests), and all 6 files / 29 tests passed. Full archived source
was read: assertions cover exact case-insensitive matching IDs, counts/no-match,
all IDs after clearing, HTTP-200 byte-equal exports during filtering, zero
collection/navigation, and exact polling IDs/query/focus/unique keys. Tests and
browser config were unchanged. The earlier schedule failure did not recur;
this does not prove its underlying cause repaired.

The worker redirected raw install/check/browser logs into its `/tmp`, returning
only tail/grep extracts. Its container was already removed when collection was
attempted. These three raw logs are unavailable and were not read in full.
Complete retained transport replies and source assertions were read; do not
claim that every original raw test log was retained.

## Terminal reviewer failure

Event `e470b588-df4a-4b97-8099-9ff3d6b0673d` responded to c1/c2 with prose
followed by `{"readEvidence":[...]}`, requesting the remaining search assertions
at offset 7694. Full-response JSON.parse fails. Its captured prompt explicitly
requires exact JSON without prose; `src/atoms/evidenceReading.ts` rejects this
with `Evidence reading requests must be exact, unrepaired JSON`.

The c3/c4 and c5/c6 batches settled positively. They and the earlier broad
approval cannot substitute for the incomplete c1/c2 review. The terminal result
preserves work without delivery or replay. No parser salvage or acceptance
override was performed during this investigation.

## Complete reading and retention

Read all 39 events, 11 model exchanges, host attestations, result, provenance,
timings and full 18,245-byte host run.log. Verified every archive's decoded size
and SHA-256: 21 occurrences, 14 unique payloads, 126,018 occurrence bytes /
65,203 unique decoded bytes. All 236,960 UTF-16 characters of exact-line
deduplicated prompts were read; the lossless origin map retains repetitions.

Final raw trace: 1,251,771 bytes, SHA-256
`4496f46f71a1cfa791f7aad95fe12d2ddef35834efe842b68b768d63f9cb14e8`.
The ordinary MCP trace reader cannot locate the private supervisor corpus;
its exact missing-trace reply was reported before read-only SSH fallback.
Original production evidence remains under
`/home/atoma/state/supervisor/compute-validation/<source>/attempts/<attempt>/`.
No original or older-attempt evidence was replaced.

Private local archive `attica-validation-623f69d8.tar.gz` contains 39 verified
payload files: receipts, original trace snapshots, decoded archives, reading
books/origin map, host log and integrity checks. It is retained in this chat's
local visualization directory. Archive SHA-256:
`fd97e62b514eaafb94f4d28c3e8c9a0356c5873028258282da60e41ff4c029bf`.
Automatic approval review rejected an additional complete-payload upload to
production as insufficiently authorized private-data transfer; it was not
retried or bypassed. Local archive and original server evidence remain.

Before this retry, the owner accepted the source at 19:19:06.300Z and published
it at 19:19:20.657Z, commit `3a003a7d7728678ae83cb1e0d357479b9208fb7e`.
A final production MCP read confirmed those receipts unchanged. This hosted
validation did not accept, publish, unpublish or deploy the customer's project.
