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
