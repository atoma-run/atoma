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
