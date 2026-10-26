# Compute worker for socket links and the 120 s shell default — 2026-10-26

Rollout record for the Compute half of the fixes from Attica run 51c4e71d
(commit d63cbdc6, [incident](../../incidents/attica-run-51c4e71d-2026-10-26.md)):
the parent-test copy skips sockets, FIFOs and links to them (Chromium's
`SingletonSocket`), and `run_shell` defaults to 120 s. Both execute inside the
worker image, so only the worker pin changes.

| Item | Value |
|---|---|
| Source revision | `d63cbdc6c96f12a4a9b179da629a8ac7afe8f34d` |
| Image workflow | Compute images run 40299640178, tag `compute-images-20261026-socket-links` |
| Worker, arm64 | `sha256:d3f0de678c4be18aa097382a10b4797f702cedd6a1e8807c029d85da7c8567aa` |
| Worker, amd64 | `sha256:bd2cc20b2f6f48c269ff3b37696301e5e8b4a3e9d28f1d992eed24da604e81a0` |

The two receipts beside this file are the workflow's verified architecture
receipts; their `.sha256` files check. The published arm64 worker contains the
socket skip and `SHELL_TIMEOUT_MS = 120_000`, and passed
`tests/worker-thread-headroom.test.ts` and `tests/container-isolation.test.ts`
on a developer Mac before adoption. Workspace, preview and retrieval pins are
unchanged: these fixes do not reach them.

Order, as `src/launcher/AGENTS.md` states it: the server shipped first
(d63cbdc6), then this pin with the desktop app built from the commit that
adopts it, then the worker digest and app version in production admission.
