# Wit for agent deliverables — 2026-11-10

The owner requested zboralski/wit and explicitly selected agent deliverables,
not Atoma's own documentation/CI. The worker compiles upstream revision
`554cd59de19bf6a31770b14a624e6ca0701ce1a0` with Go 1.26.3, ships the MIT notice,
and exposes `wit` through the existing `run_shell` allowlist and declaration.
Usage: [witnessed deliverables](../docs/witnessed-deliverables.md).

No new element, supervisor replay, acceptance gate, trust credit or paid call.
Both Wit modes execute document commands under the ordinary worker boundary.
Local non-container backends require an operator installation on PATH.

Validation: typecheck, clean-copy lint, docs checks and build pass. The 51
shell/closure tests and all 46 container-isolation tests pass, including the
three Wit cases, on the fully rebuilt worker image `atoma-worker:wit-554cd59`.
The default local image is restored after testing; the tested image remains.

## Release follow-up — 2026-11-10

The owner requested fixing both release blockers and deploying Wit. Pin
ag-psd 31.0.3 through an override (the reader still requests ^30.2.0); retain
its API with a real PSD browser fixture and an allocation-limit regression
resolved from the reader's dependency path. The regression uses at most
2 KiB even on the vulnerable version, and also proves a valid small layer.

The activity test now asserts the exact author label instead of rejecting
commas anywhere in a row, and runs at fixed recent and old dates. It must
not depend on when the suite runs or reject punctuation in a timestamp.

Clean npm ci and release:check pass: no audit findings, 601 test files and
8,743 tests passing (four files/45 tests skipped by their environment gates).
The real file-reader browser smoke passes on 16 files, including PSD; the
full viz browser smokes also pass.
Production uses the ordinary main CI → Deploy production pipeline; verify
its exact revision and worker binary, never infer activation from a push.

## Deployed — 2026-11-10

Deploy production run 42777919623 activated `cfad746c` at about 08:00 UTC.
Checked on the host: release and executor of that revision active, worker
image `atoma-worker:cfad746c…` present, `/usr/local/bin/wit` and its licence
inside it, and `wit` answers with its usage line in a `--network none`
container.

Another session had been told the same morning to deploy everything except
Wit until the owner's own test. Told that Wit was already live, the owner
chose to keep it in production and test it there. Nothing was reverted.

## Platform reporting — 2026-11-10

Owner requested a platform-admin reporting page. Admin → Wit projects existing
trace tool receipts, read-only, behind the platform flag and audited foreign
reads. No new store, run execution, gate or trust rule. Ten indexed runs per
cursor page; bounded event/receipt/output projection explicitly counts omissions.
Counts are per page, never platform-wide success rates. Both GPU and semantic
DOM use the same response; the source action opens the recorded tool event.

Refresh feedback: the page uses the shared loading crystal for every in-flight
query, including cached refetches (`isFetching`, not only initial `isLoading`).
Its status row stays outside the scroll mask, old receipts remain readable,
and refresh/paging controls are disabled until settlement. No artificial delay.

## Evidence handover — 2026-11-10

Owner prioritizes Wit in evidence exchanged between agents, not only final
deliverables. `WIT_HANDOFF_GUIDANCE` in the shared runtime task context teaches
producers to bind computed Markdown claims to sources and pass observed checks;
receivers inspect source relevance, failures and freshness through the existing
transport receipts. No supervisor replay, automatic document creation, new gate
or extra model call. Internal evidence respects output scope and stays separate
from reader-facing docs. Tests exercise sequential nested handover and result
review for success, STALE and UNAVAILABLE without replay or inherited tool credit.
