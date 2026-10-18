# Compute images published on 2026-10-18

Published revision: `b0e263bec4de63524a01a2c80f0820dda3e60e55`.
Tag: `compute-images-20261018-2`.
[Successful native build, tests and publication](https://github.com/atoma-run/atoma/actions/runs/39123606814).

Worker, workspace, preview and retrieval images are public on GHCR for Linux
amd64 and arm64. Each architecture passed 90 tests across six suites; the hybrid
retrieval test was skipped because the base image contains no model weights.
The published retrieval image supports BM25; hybrid weights remain separately
provisioned as documented in `docs/compute.md`.

The JSON receipts and their original SHA-256 files were downloaded from that
workflow and verified locally. After publication, all eight registry manifests
and configuration blobs were fetched with anonymous pull tokens. Their hashes,
Linux architecture, revision labels and content digests matched the receipts.
Use `reference` for client image pins and the worker `contentDigest` for the
server allowlist. Verify receipts from this directory with
`shasum -a 256 -c atoma-compute-images-linux-*.json.sha256`.

The owner approved temporarily enabling public package creation for the
organization. All four packages were made public, then the original setting
(public creation disabled, private enabled, internal disabled, repository
permission inheritance enabled) was restored and verified in GitHub settings.

Native macOS/Windows acceptance remains deferred by the owner. This publication
neither merges the feature branch nor deploys the Atoma application. No capacity
benchmark or 50% server-resource reduction is claimed.
