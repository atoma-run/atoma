# Compute preview classification — 2026-10-23

The verified image workflow [39942174879](https://github.com/atoma-run/atoma/actions/runs/39942174879) built source `bbf22911a6819292f6a299312eac53f13257e0c6`, tagged `compute-images-20261023-preview-classification`, on native Linux ARM64 and AMD64 runners. Both jobs passed packaged isolation, retrieval, transfers and preview tests before publishing these receipts.

Only the workspace references from these receipts are adopted in `computeImages.ts`: this is the image containing the preview copier. The worker, application runtime and retrieval references retain their previously verified releases. No worker allowlist or retrieval configuration change is needed.

The copier now takes the host's delivery classification for a delivered copy whose artifact hash matched, the entry still a usable file in the copy. A device advertises `preview-classification` only while running the workspace image its app bundles, so an installation not yet prepared keeps the previous behaviour. Before adoption, both copiers were run against the retained delivery of Attica run `84ae80d1` on its own Compute device, source volume read-only: the previous copier refused it, the new one verified the saved artifact hash and returned `node`, `browser/control-server.js`.

Each JSON receipt has its sibling SHA-256 checksum, naming the downloadable basename. Verify the checksum before consuming a receipt.
