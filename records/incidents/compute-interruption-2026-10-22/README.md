# Compute network interruption and Attica refusal review — 2026-10-22

Run `1622e44b-8d9f-41dc-8827-a1af7cb38353` failed at 09:09:36 UTC after
67m57s, within its 90-minute budget. The initiating event was a macOS Wi-Fi
network transition at 09:09:03–04 UTC, recorded as originating in ControlCenter.
This identifies the network transition, not the person who initiated it.
The existing TCP/WSS session then stopped receiving frames. Client lease expiry
at 09:09:28 and confirmed teardown at 09:09:29 preceded the server's expiry at
09:09:34 and a new connection at 09:09:35. There was no cancellation request.
Targeted server and power logs did not show a restart, deployment or sleep at
that time. No checkpoint or delivery manifest was confirmed for this run.

## Demonstrated defect and correction

`ComputeDeviceStore` throws `ComputeSessionExpired('Compute session expired')`
when its real deadline expires. `computeFailure` did not recognize that exact
message, so the server logged `session-invalid` with `failure: other`.
The fix maps that message to the existing `session-expired` diagnostic category.
It changes no wire shape, lease, authority check, retry, run state or execution.

The production-path regression uses the real HTTPS/WebSocket gateway and store,
leaves a workspace RPC pending on an open socket, advances the store's clock,
and waits for the real watchdog. Before the fix it fails on `other`; afterwards
it confirms the diagnostic, rejected pending work, aborted peer, expired session
and refusal of further commands. Existing redaction and lease controls remain.

Adversarial review: a later socket-close cannot overwrite the first cause;
unknown/remote messages still cannot enter diagnostics; known revoked/superseded
sessions retain their old category; expiry still fences outside the failed
transaction; no operation can be replayed or made successful by a diagnostic.
This is an exact known-error classification, not a new acceptance gate.

Validation: pinned Node 24.20.0, `npm ci`, then `npm run release:check` passed.
Both TypeScript configurations, lint, docs, audit (zero vulnerabilities), build
and compiled release smokes passed. 552 test files passed / 4 skipped;
7,879 tests passed / 36 skipped. Targeted Compute connection/lease verification:
49 passed / 4 existing conditional Docker skips. No test was weakened.

## What remains unsupported

This correction does not make an active run survive a network migration.
The documented protocol deliberately stops on lease loss and never replays an
indeterminate operation. Simply increasing the lease or reconnecting into a new
execution generation does not safely restore the old orchestration.
A resumable transport needs authenticated same-generation reattachment before
expiry, bounded acknowledged frame retention, duplicate suppression before any
side effect, fencing of stale sockets, and tests for lost request/result/ACK,
revocation, sleep and process restart. After expiry, continuation must consume a
verified checkpoint. Rejected alternatives: blind command replay; using a fresh
generation to revive old work; treating local unverified files as a delivery.
No such protocol change is claimed here, and no further paid run was started.

## Refused verdicts

All 53 saved model-review responses were read: 25 refusals (8 PLAN, 17 RESULT).
The [annotated review](refusal-review.json) contains every refusal and remediation.
These annotations classify issues, not independently proven false positives.
Complete prompts were read selectively through bounded native MCP reads.

The clearest contradictory coaching is `51a7df6e`: the current task and host
context explicitly prohibit edits, but its remediation asks to repair a failing
envelope. Its refusal also identifies genuine missing or failed evidence; the
whole verdict is not therefore false. [Bounded scope evidence](review-scope.json).
The `ec15fc95` inspection task also explicitly mentions current HTTP probes, so
it is ambiguous rather than proof that every requested matrix was out of scope.

Improvements to evaluate before changing validators:

1. Explicit phase outputs and permissions: inspection reports unknowns;
   implementation repairs; final verification executes the complete contract.
2. One versioned HTTP case table and harness for the real collector/control/store
   path across source, fresh build and saved build. Preserve exact negative cases.
3. Assert setup before dependent verdicts: real pause, detail navigation, synthetic
   cookie retention, reopened state and source/build identity. Wrong setup is not
   a product counterexample.
4. Cite existing observations by case and build, then rerun only missing, changed
   or disputed cases. The current prompt already teaches this; another reminder
   is not a demonstrated engine repair.
5. Fixed-evidence, same-model paired evaluation of any revised phase contract,
   including real-defect, stale-proof and invalid-harness negative controls.
   Score false approval, out-of-scope remediation, evidence requests and total
   retry cost. No paid replay was performed for this investigation.

## 24k / 48k measurement and limits

[Projection evidence](projection-evidence.json) retains the same-selector
numerical observations from the completed follow-up: 24 exact reconstructed L2
contexts, 399/406 latest-command receipt occurrences at 24k versus 406/406 at 48k.
All 94 known-failure occurrences survive both. The seven added occurrences are
five unique successful inspections; the three affected reviews still refused.
Counts overlap across contexts and are not independent trials. This establishes
visibility, not a causal improvement in verdicts or cost. Other engine/source
changes prevent a causal cross-run comparison.

[Retry metrics](retry-metrics.json) preserve the host-derived same-branch windows:
38 completed calls, $4.49048324 subscription-equivalent, excluding descendant and
in-flight calls. Wall intervals can overlap. This is not cap-attributable spend.
The run total was 151 completed calls / $8.08277944 subscription-equivalent;
90 calls / $5.69427636 preceded the first explicit write, 41m14.740s after start.
These are accounting equivalents, not an API invoice.

## Evidence and access

Investigation began with authenticated native production MCP status/journal
reads. The catalogue has no connection-log reader, so authorized targeted SSH
and local operational logs supplied the transport cause. Broad raw traces and
artifact exports were not retried. [Timeline](evidence.json) stores only selected
non-secret operational fields; Wi-Fi identities, credentials and frame payloads
are omitted. The original incident evidence remains untouched.

Open [report.html](report.html) for the French interactive report. Its 25-to-4
scope filter and the contradictory-remediation disclosure were checked in the
in-app browser. A loopback preview is local tooling, not product publication.
