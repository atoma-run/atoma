# Compute worker with escaped process-group reaping — 2026-10-25

Rollout record for the worker change in b6f13c5c (run 9e134e49's exhausted
Compute worker). The pins were adopted in 567218bf.

| Item | Value |
|---|---|
| Source revision | `b6f13c5c926d9edd2006ec4049f9c82d7c283b74` |
| Image workflow | Compute images run 40163976550, tag `compute-images-20261025-escaped-groups` |
| Worker, arm64 | `sha256:1a6f95fc7671cfeb1907092e85ca427d38ca1b0336f4d475b10fd133657c6111` |
| Worker, amd64 | `sha256:668f926c3d97f7238ac52465a0fa6540e5931c879759e36ffab0167da15e2743` |
| Desktop release | `compute-desktop-preview-567218bf9f23`, version 0.4.123 |
| Installer, mac arm64 | `Atoma-Compute-0.4.123-mac-arm64.dmg`, sha256 `fe90e3e3cfd1df5958207081247352491914ef6d65c86a1ec78f90718dd348b9` |

The two receipts beside this file are the workflow's verified architecture
receipts; their `.sha256` files check. The published arm64 worker passed the
escaped-group container regression (`tests/container-isolation.test.ts`)
before adoption. Workspace, preview and retrieval pins are unchanged.

Production admission received version 0.4.123 and both worker digests, with
earlier entries retained and a backup of the environment file kept on the
host. It takes effect with the executor generation deployed after this record.
