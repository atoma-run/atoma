# Compute worker and workspace for export refusals and thread headroom — 2026-10-25

Rollout record for the Compute half of the fixes from Attica run 40c20c5d
(merged at 824543ed): typed `export-refused` replies and byte-less entries left
out of the workspace export (workspace image), and the idle tool browser with a
fresh context per `validate_html` call (worker image). The worker task bound
(2048) lives in the desktop launcher and ships with the desktop app.

| Item | Value |
|---|---|
| Source revision | `824543ed25a612037315b56ec1894ce041c52c23` |
| Image workflow | Compute images run 40190025207, tag `compute-images-20261025-export-threads` |
| Worker, arm64 | `sha256:0afa5d2c4b0d54edc13792a021f01cc0692cc93a2b042f14b063e45b3aa52c14` |
| Worker, amd64 | `sha256:8f51999642b5e48bab6e64314d2918e894bfbd5e29b8dc7430a7f6c049d46f1c` |
| Workspace, arm64 | `sha256:4fcd991cf2cb4aec42bc751ba055dd749477de8121be533e2e34aff9f25a68c1` |
| Workspace, amd64 | `sha256:b8db70bcb83236ec82fefe8bf3a1920eff7b4a9b1ee25a5228cdef13b8a7a5a2` |

The two receipts beside this file are the workflow's verified architecture
receipts; their `.sha256` files check. The published arm64 worker and workspace
images passed `tests/worker-thread-headroom.test.ts`,
`tests/workspace-service-container.test.ts` and
`tests/container-isolation.test.ts` on a developer Mac before adoption. Preview
and retrieval pins are unchanged.

Order, as `src/launcher/AGENTS.md` states it: the server shipped first (824543ed),
then these pins with the desktop app built from the commit that adopts them.
`COMPUTE_CLIENT_ARCHIVE` (CLI-paired clients) was not bumped: an older CLI client
running these images pends on an export that leaves entries out or is refused,
instead of finishing it.
