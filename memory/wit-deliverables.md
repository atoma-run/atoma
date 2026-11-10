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

Not pushed/deployed: clean `npm ci` + `release:check` stops at the existing
high-severity ag-psd advisory GHSA-6w3r-6hpr-hp6p through @open-file-viewer/core.
The full suite also exposes an existing `viz-assistant.test.ts` assertion
rejecting the comma in an old run's formatted date. Packaging dependencies
pass after clean npm ci; the archive test passes in a clean copy with access
to Git history (the shared checkout's extra local files make its copy time out).
The first full suite used the old worker and failed the three new Wit cases;
all pass with the rebuilt image. Do not count that first suite as green.
