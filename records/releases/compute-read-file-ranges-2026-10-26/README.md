# Compute worker for unrefused read_file ranges — 2026-10-26

Rollout record for the Compute half of commit `fc42ffbe` (read_file refuses no
range: a file or range longer than `MAX_FILE_READ_CHARS` comes back in parts
with `nextOffset`). The tool executes inside the worker image, so only the
worker pin changes; workspace, preview and retrieval pins are unchanged.

| Item | Value |
|---|---|
| Source revision | `fc42ffbe73939fc5a37df3d832564cf1b4e49f44` |
| Image workflow | Compute images run 40363654045, tag `compute-images-20261026-read-file-ranges` |
| Worker, arm64 | `sha256:24f58a20822b93c15b4cf7b48d143337b168089020d368bab65bfc70f2f14fcb` |
| Worker, amd64 | `sha256:31dd43cd602cd09b38ddef286bda73b0658864d2899220737ba8b7fd7283eb8e` |

The two receipts beside this file are the workflow's architecture receipts;
their `.sha256` files check. The published arm64 worker holds
`MAX_FILE_READ_CHARS = 60_000` and no `MAX_FILE_PAGE_CHARS`, and inside it,
as the unprivileged user without network, `read_file` answered the two ranges
run 9d36e988 had refused (`offset 0, limit 12000` and `offset 7000, limit 3000`
on a 25,000-character file) with 12,000 and 3,000 characters and the right
`nextOffset`.

Order, as `src/launcher/AGENTS.md` states it: the server shipped first
(`fc42ffbe`), then this pin with the desktop app built from the commit that
adopts it, then the worker digest and app version in production admission.

| Desktop release | `compute-desktop-preview-b199f6e71948`, version 0.4.150 |
|---|---|
| Installer, mac arm64 | `Atoma-Compute-0.4.150-mac-arm64.dmg`, checksum verified against its `.sha256` |

Production admission received version 0.4.150 and both new worker digests,
with earlier entries retained and a backup of the environment file kept on the
host (`atoma.env.bak-20261026-read-file`). It takes effect with the executor
generation deployed after this record. `COMPUTE_CLIENT_ARCHIVE` was not
bumped: no reply shape changed.
