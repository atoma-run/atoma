# Hosted application grant continuity — 2026-10-29

Attica's application server remained ready with 1,015 stored listings after the
platform release, but an existing browser tab showed an expired-access message
and disabled its controls. Reopening through its Atoma project restored the same
application and data without starting a collection. A fresh tab observed between
13:39:37 and 13:41:08 UTC showed the 1,015 listings; after the 13:48 platform
deployment, the same unreloaded tab showed expired access at 13:49.
The readonly 13:49:43 server receipt confirmed all six data hashes and hosted
code were unchanged. Independently, the gateway
code establishes a deterministic release failure: its accepted browser grants
exist only in the web process's PreviewClaimRegistry, so replacing that process
forgets even an actively renewed grant. Hosting survives platform releases; its
visitor authorisation did not.

Preview grants intentionally fail closed when their ephemeral generation ends.
That contract remains unchanged. Hosted grants now use an injected primary-store
collection behind the same registry. Only SHA-256 token hashes and their typed
binding/expiry persist. Raw opening claims remain one-use and memory-only.
No cookie attribute, lifetime, membership rule or application isolation changes.
The new table is additive; no token from the previous memory-only release can
be reconstructed, so visitors of that rollout must reopen once through Atoma.

Adversarial review:

- Grant persistence does not authorise an arbitrary cookie: the hash must exist
  and org, project, generation and exact hostname must still match.
- Membership is checked on every HTTP request and desktop upgrade, including
  after a held update. Logout revokes the persisted grants through the existing
  callback; a subsequent web process cannot recover a revoked token.
- Renewal cannot revive a concurrently revoked or expired grant. Each complete
  registry operation, including read/renew and expiry/read/delete, runs inside
  one SQLite immediate transaction. A second process cannot interleave its
  revocation or renewal between those statements. No process caches the grants.
- Expiry is retained exactly across store reopen and never extended by opening
  the database. Only existing authorised traffic renews it. A forged token,
  another organisation or another generation remains refused.
- Ephemeral previews still use their default private Map and forget every grant
  when their registry restarts. Persisting hosting does not opt previews into
  persistence. One-time opening claims do not enter the product database.
- Registry iteration materialises the rows before deleting or renewing them;
  expiry and revocation do not mutate an active SQLite iteration cursor.
- Rolling back to an older memory-only gateway requires invalidating the
  remaining persisted grants, documented in the operator hosting guide. That
  older binary cannot persist logout revocation for a later upgrade. Existing
  five-minute expiry remains the bound; it is not replaced with a long token.

A regression uses the actual HTTP gateway, SQLite store and three separate Node
processes. It exchanges a browser claim, stops the first process, reuses the
same cookie on the second without reopening, verifies membership loss and
logout, then verifies the token remains refused in the third process. Other
focused regressions cover exact expiry and the memory-only preview default.
The cycle memory records the actual verification and deployment outcomes.

Release verification completed: 8,608 tests passed, with 45 existing skipped
cases; the full static release checks, both TypeScript configurations, lint,
audit, build and compiled smokes passed. Main CI succeeded; the branch's worker
job alone hit a Docker removal refusal, with its complete first-attempt log
preserved and one unchanged-source replay subsequently passing. No cleanup
assertion or isolation rule was weakened.

Production activated af7906b4. Renewing access through Atoma restored the existing
Attica tab without reloading it, with 1,015 listings and enabled configuration
commands. A private, unsubmitted 14:45 schedule draft now exercises continuity
through the next platform release. No collection or schedule write was issued.
The pre-release receipt records exact data hashes and modes, the active revision
and a double-hashed grant fingerprint, never a raw browser credential. The
following release's outcome must be observed before claiming production
continuity; this entry records preparation and the verified first activation.

The record-only follow-up 5ba0d539 did not deploy: both fresh-worker jobs failed
while all hermetic checks passed. The complete first-attempt logs are retained.
One repeated the engine-confirmed-removal refusal in a terminal preview; the
other interrupted the low-disk fixture's setup. The latter used a call-count
mock: after its first capacity answer, every check returned zero, including the
periodic check while cold Docker was still preparing and writing the fixture.
Its fault is now explicitly enabled only after the proof-file write completes.
The unchanged assertions still require actual workload exit, retained volumes
and an indeterminate server assignment until reconciliation.

The worker job now runs its nine test files sequentially on their shared Docker
daemon. Explicit concurrent-browser, transport and thread-headroom tests within
each file remain unchanged, as do all cleanup and isolation assertions. This
removes unrelated Docker lifecycles competing beside bounded cleanup probes;
it does not change production cleanup timing or assert absence on a timeout.
The corrected low-disk case passed locally through real TLS and Docker in
10.7 seconds using existing immutable images and a test-owned random machine.
No shared image was rebuilt. The complete release check also passed again:
8,608 tests, 45 existing skips. The next CI must establish the full real-image
result; these local results do not substitute for it.
