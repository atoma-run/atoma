# Compute validation dependency installation blocked by network isolation

Attica source run `38bfe415-018e-406f-8609-326779646429` completed on Compute.
Its automatic hosted verification `fc4a9b26-e6ef-4e56-9a5c-e4262ba84886`
started at 2026-10-28T16:37:12.111Z. The retained initial workspace includes
the source and lockfiles, but installation still needs the package registry.
Two `npm ci` attempts (16:38:03Z and 16:39:23Z) failed with `EAI_AGAIN`
for `registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz`.
A later command piped installation output into `tail`; its zero exit was not
installation success, since the output still contained the same error.

The supervisor deliberately selected `container` isolation, which passes only
`--container` to the runner and creates a worker with no network. Ordinary
hosted project runs and resident recipe assays already use controlled egress.
The correction selects that existing `container-egress` mode for Compute
verification too. It does not alter the retained initial state or infer network
authority from device receipts. No historical attempt is retried or rewritten.

## Boundary review

The launcher passes `--container --egress`; commands remain in the worker.
Only the host proxy policy controls destinations. Host allowlists remain in
the host environment; the captured data-only initial environment cannot
introduce network settings, model pins or credentials. The existing proxy
rejects IP literals, private addresses, deceptive hostname suffixes and
unapproved destinations; the worker cannot bypass it through a host gateway.
This permits package downloads with the ordinary host policy, not arbitrary
device-selected connectivity. External connector captures remain blocked.
Initial bytes and host-controlled execution policy are separate contracts.

## Regression verification

Before the fix, three launcher assertions failed: isolation was `container`,
`--egress` was absent, and the real spawned runner resolved `egress: false`.
After the fix, all 92 tests in Compute validation, proxy policy, HTTP/CONNECT
proxy and container/sidecar lifecycle suites pass. The new regression crosses
the queue, production launcher and actual npm child process, then resolves
the observed CLI arguments through the runner's backend parser. It also checks
that the host allowlist survives that process boundary.

`npm ci` followed by `npm run release:check` passes: 589 test files,
8,518 tests, with 4 files/43 tests intentionally skipped. A real Docker worker
using the existing immutable local image `47705e7f6323` also passes the compiled
release smoke: npm HTTP 200, control-plane hostname denied, direct host gateway
unreachable. The shared Compute worker tag was not rebuilt or changed.

The original attempt closed `inconclusive` at 16:53:00Z: 37 events and 30
complete archives retained, decoded and verified (190,087 bytes), four model
calls, $0.03197732 API equivalent. No counter or recipe changed. The runner
refused delivery after failing to finish root acceptance within its landing
budget; installation never succeeded. The queued Compute run `5ff2e4df` started
at 16:53:01Z after this lease was released. This is not production success for
the corrected egress path; deployment and subsequent verification remain separate.

## Cold runner admission gap found by the owner-requested retry

The owner explicitly requested stopping the old-version verification and retrying
the same Attica capture on the corrected release. The old shadow `a5cdee15`
had already ended inconclusive at 17:13:09Z (five calls, $0.03135426). All
42 events and 25 complete tool archives were retained and read. A private
online store backup and copy of its complete attempt directory precede the
attributed manual retry event. Snapshot `5f3c80fc-a2f8-4bec-be66-e73a06ea0be5`
remains immutable, digest `c1edcd0dbd0908af446794b21d80aece7bf045d312bc72d9f59c2a67fa30dfa5`.

Attempt `8b76bba0` on deployed release `1d120c7d` then stopped before any
model call: `startTask` still rejected `args.egress` at two admission checks.
The earlier launcher regression used a fixture npm script and therefore never
crossed these checks. The earlier cold-runner continuation regression also
silently omitted the launcher's egress flag. The previous correction was
incomplete; neither passing test established real runner admission.

The continuation regression now forwards controlled egress to the real runner
in a fresh process, for both ordinary pause and answered-question continuations.
Both variants failed before the runner correction and pass after it. The runner
accepts host-controlled proxied egress while retaining its active claim,
container, non-tenant and no-replacement-input requirements. A new release smoke
also invokes the actual compiled CLI: a claimed egress launch must reach a later
invalid-timeout error, while local, tenant, seed/resume replacement and unclaimed
launches must fail their authority checks. It makes no model or Docker calls.
The smoke failed against the previous compiled output and is part of the normal
release check and the production activation preflight.

`npm ci && npm run release:check` passes with the correction: 8,521 tests
across 589 files, 43 tests/four files intentionally skipped, both TypeScript
configurations, lint, audit, build and the compiled admission smoke included.
Targeted runner, initial-state and queue verification passes 36 tests. The
original private backup passes a read-only SQLite integrity check; it remains
unchanged. Next retry must preserve `8b76bba0` as well and run the compiled
admission smoke on the active production release before requeuing.

## Final production replay: inconclusive review, successful requested checks

Runner correction `b1d30368` passed full CI after one unrelated showcase HTTP
test failed once; that suite passed all 54 tests in isolation and the failed
CI shard passed on its retry, without assertion changes. CodeQL and all three
desktop packages passed. Deployment succeeded; the active executor and its
compiled CLI were verified before the next manual retry.

Request `owner-retry-egress-20261028-02` retained the unsuccessful preflight
attempt too, then restored and hashed all 276 entries/251 files/4,496,267 bytes.
The snapshot digest and initial-context payload stayed unchanged. It requeued
only source `5ff2e4df`; no new Compute source run was created.

Hosted validation `00594723-7c9b-408a-8328-d255f16b3f0c` ran on `b1d30368`
from 17:49:00Z to 17:56:45Z. The durable verdict is **inconclusive**, with a
partial/landed trace, not delivery. It used 17 model calls, $0.10599298 API
equivalent and 670,554 billable tokens including cache reads. No budget or
deadline ceiling ended it.

Executed evidence establishes the networking and runner-admission correction:
fresh `npm ci` succeeds; the clean root-only copy passes typecheck, lint,
121 Vitest tests, 89 Node tests and build while browser dependencies remain
absent. Both focused Chromium files execute and all five tests pass with inner
`EXIT=0`. Only `vitest.config.ts` differs among the initial files (459 to 516
bytes, expected hash `b13afa283f989c1489199d8f1c1fbfa0766712d08ceb60915864df44fe9eeff2`);
250 files and their modes remain unchanged. A host probe manifest was added.
Two independent type-success events occurred; no recipe changed.

The root refused both passes because criterion verdicts failed the response
schema. Event `1d5b3b2a-f9c5-4c50-ada7-3da60b6c6ecf` uses top-level `reason`
instead of `reasoning`; event `d703b110-0efc-42c7-9ef7-ae0790107c47` omits
`reasoning`. Offline parsing of these exact recorded replies reproduces the
missing-string error with no paid replay. Their positive per-criterion prose
does not constitute a valid accepted review. Do not relabel this result approved
or infer that the implementation failed its requested behavioral checks.

An extra expanded browser run also exposes a separate failed assertion:
`tests/attica-control-recovery-ui.vitest.test.ts:383`, schedule recovery leaves
`#lastRun` as an em dash. It fails in the 29-test run and again in the isolated
six-test recovery suite. Those full failure logs are preserved. Its underlying
cause is not established by these two observations, and no application or test
bytes were changed to hide it.

All 68 events and 63 full archives were read, decoded and size/SHA-256 verified
(935,119 decoded bytes; 29 distinct archive bodies). A private reading package,
100 payload files/4,238,675 bytes with `SHA256SUMS`, is appended under the source
validation directory as `reading-00594723`. It includes both historical and new
traces, decoded archives, raw recovered install/check/browser-failure logs,
snapshot/queue receipts and the parser diagnosis. The model redirected its
focused browser log to ephemeral container `/tmp`; that unfiltered file was no
longer available after cleanup. Its full recorded transport response, inner
exit status and five-test selection remain retained; no missing raw file was
reconstructed. The source capture and earlier attempts remain preserved.
