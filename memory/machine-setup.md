---
name: machine-setup
description: "mgf's Windows machine — WSL2/Debian, Node installs, Claude installs, quirks that shaped past debugging"
metadata:
  node_type: memory
  type: reference
  originSessionId: 4ce9c95d-912e-4d9a-a02e-e85e063b3414
  modified: 2026-09-14T12:52:17.981Z
---

Windows 11 Home. WSL2 present with Debian 13 trixie (ext4, ~1TB), default distro since 2026-08-31 (was docker-desktop — which has no bash; that was the real cause of `execvpe(/bin/bash) failed`, not a missing distribution). Docker Desktop 28.3.2; Debian has the docker CLI integrated and mgf is in the docker group. Git Bash exists at `C:\Program Files\Git\bin\bash.exe` but only `Git\cmd` is on PATH, so bare `bash` resolves to the WSL relay.

Node: the repo pins **24.20.0** (`.nvmrc`, `engines >=24`, CI) since early September 2026. Windows host has nvm-windows with v24.16.0. Debian has Node 22.13.0 at `~/.local/node22` (on PATH via `~/.profile`) AND, since 2026-09-14, Node 24.20.0 at `~/.local/node24` (tarball, no nvm) — prepend `$HOME/.local/node24/bin` to PATH for atoma work. Under Node 22 the pinned better-sqlite3 13.0.3 prebuilt SEGFAULTS on `new Database(...)`: `require` succeeds, the open dies with exit 139, and vitest only says "Worker exited unexpectedly" with zero test output — not a code defect. The `~/dev/atoma` clone still works under 22 only because its node_modules are the Aug 31 install (better-sqlite3 11.10.0). Scratch clone with Node 24 deps: `/tmp/atoma-backup-check` (origin = the Windows repo via /mnt/c; apply a `git diff` patch from the scratchpad, run vitest there).

Debian is the PRIMARY atoma dev host since 2026-08-31: clone at `~/dev/atoma` (ext4, LF, remote=git@github.com:mgtf/atoma.git, pull AND push verified 2026-08-31), `.env` copied and CRLF-stripped.

SSH: the identity GitHub accepts for this account is **`id_rsa`**, NOT `id_ed25519` (both exist in `C:\Users\mgf\.ssh`; verified with `ssh -vT git@github.com` → "Server accepts key: .../id_rsa"). No ssh-agent runs on Windows — Git Bash reads the key file directly. `~/.ssh/id_rsa` was copied into WSL (mode 600) so Debian pushes with the same identity; no passphrase (BatchMode auth succeeds). Beware the confusion that cost a round trip: Git Bash shows `mgf@srv MINGW64 ~/dev/atoma` with `HOME=/c/Users/mgf`, Debian shows `HOME=/home/mgf` — same-looking `~/dev/atoma`, two different checkouts and two different keystores. Installed via apt: git 2.47.3, python3 3.13.5 + Pillow, Chrome's 20 shared libs, lsof/curl/unzip. Chrome 151 seeded into `~/.cache/puppeteer` by tar-streaming the `atoma-verify-pptr` docker volume (no re-download). claude CLI 2.1.251 via `npm i -g @anthropic-ai/claude-code`, logged in → `npm run doctor:dev` says READY (provider claude.ai · firstParty). Gate status there: fully green since 2026-08-31 pm — `npm run check` rc=0 at full parallelism AND at --maxWorkers=4 (240 files / 2897 tests), after the contention-budget fixes landed in the worktree (see [[windows-portability-state]]). The Debian clone carries LF copies of those worktree files, synced by script, not by git — after the Windows-side commit lands, realign it (`git pull` needs SSH keys there, still absent). `start_static_server` spawns python3 — a runtime dep doctor does not preflight.

Claude Code: two win32-x64 installs — WinGet 2.1.248 (registry PATH entry, `WinGet\Links` shim dir is empty) and the Cursor extension 2.1.251 (what actually runs). `Get-Command claude` empty in a shell usually means stale process PATH, not a broken install. `.claude/settings.json` in atoma is macOS-shaped (`/tmp`, `/private/tmp` in additionalDirectories).

Quirks that cost time before: `core.autocrlf=true` comes from Git for Windows' SYSTEM gitconfig; Defender real-time scan plausibly explains typecheck 187s-vs-96s (container); `wsl` output from PowerShell needs UTF-16 handling (`-replace "\0"`); heredoc-style multi-line via `wsl -- bash -c "..."` breaks on `$HOME` (PowerShell doesn't expand `\$` — write .sh files LF-normalized to the scratchpad and run those instead).

Devcontainer image `atoma-devcontainer:test` built locally; named volumes atoma-verify-work / atoma-verify-pptr hold a clone + node_modules + Chrome (npm ci in container ≈ 9 min cold).

- Windows host (PowerShell/Git Bash): the pinned Node 24.20.0 lives at `C:/Users/mgf/AppData/Local/nvm/v24.20.0` (nvm-windows); the default PATH node is 24.16, so prepend that directory for npm/vitest per AGENTS.md. Known win32-only red suites on 2026-09-15: EPERM `rmSync` cleanup in viz-auth-gate (assertions pass), symlink EPERM in viz-run-index and viz-benchmark-runs.

- Driving WSL from the Git Bash tool: `$HOME`/`$PATH` in a `wsl.exe -- bash -lc "..."` string expand on the WINDOWS side (PATH with spaces/parens then breaks the WSL shell), and `/mnt/c/...` arguments get MSYS path-converted. Write an LF script to the scratchpad and run `MSYS_NO_PATHCONV=1 wsl.exe -- bash /mnt/c/<script>`. A fresh POSIX verification clone lives at WSL `~/dev/atoma-platform` (2026-09-15; `~/dev/atoma` is someone else's in-progress clone, do not use it).

- WSL test worktree: ~/.cache/atoma-ro, driven by ~/.cache/wsl-sync.sh <paths…> then ~/.cache/wsl-tests.sh <test files…>. wsl-sync RESETS the worktree to the Windows HEAD and overlays ONLY the paths named, so pass EVERY uncommitted file each time; a partial list silently tests old src against new tests (false failure, 2026-10-01).

**Disk space (C: hit 0 GB on 2026-09-29):** each WSL verification clone with node_modules is ~1.3 GB and WSL fails with I/O errors when C: is full. Check `Get-PSDrive C` before any clone or `npm ci`; reuse ONE verification clone (fetch + reset) and remove it at the end. The WSL ext4.vhdx was never compacted (Windows 11 Home has no Optimize-VHD).
