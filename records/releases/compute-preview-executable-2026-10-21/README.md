# Compute preview executable identity — 2026-10-21

The verified image workflow [39611836931](https://github.com/atoma-run/atoma/actions/runs/39611836931) built source `d16f728e7329a498178ed90503867daec2abe9db`, tagged `compute-images-20261021-preview-executable`, on native Linux ARM64 and AMD64 runners. Both jobs passed packaged isolation, retrieval, transfers and preview tests before publishing these receipts.

Only the workspace references from these receipts are adopted in `computeImages.ts`: this is the image containing the preview copier. The worker, application runtime and retrieval references retain their previously verified releases. No worker allowlist or retrieval configuration change is needed.

The copier now preserves executable identity in a disposable preview. Attica's retained delivery contains executable `docker-entrypoint.sh`; stripping that bit changed the copied artifact hash and refused startup. The original volume remains read-only, and the hash check is unchanged. Regression tests open static, Node and terminal previews through real containers from exported delivery manifests containing an executable file.

Each JSON receipt has its sibling SHA-256 checksum, naming the downloadable basename. Verify the checksum before consuming a receipt. The workflow's full receipts also record the other published images; their presence here does not select them for the desktop bundle.
