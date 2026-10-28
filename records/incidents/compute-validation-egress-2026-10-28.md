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
