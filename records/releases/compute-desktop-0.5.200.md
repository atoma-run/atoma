# Compute 0.5.200 admission — 2026-10-28

The native installers were built from `ab37530889ad50e6cc6d5aee986b5676f17adc2d`
and published by [Compute desktop 40656517567](https://github.com/atoma-run/atoma/actions/runs/40656517567).
All three native jobs and the publication passed. Both published macOS DMGs
were downloaded, their SHA-256 checked, and their ICNS compared with the verified
native icon. The ten decoded representations passed the macOS regression.

The installed client reported `0.5.200`, while the server's exact-version
allowlist ended at `0.4.150`. The computer remained connected and idle, but a
new run stayed queued: admission correctly refused the unapproved version.
The existing workspace image identity was already admitted:
`sha256:24f58a20822b93c15b4cf7b48d143337b168089020d368bab65bfc70f2f14fcb`.

Approve only `0.5.200`, retaining every existing app version and image digest.
The environment change has a private, reversible backup and preserves the
file's ownership and permissions. No wildcard, protocol exemption, membership
change, state reset or run recreation is needed. Normal CI deployment activates
the updated policy; verify it in both processes and follow the already queued
run into execution. Preview publication requires this approval too.

Published macOS checksums:

- `Atoma-Compute-0.5.200-mac-arm64.dmg`: `48a06cf4ed1f00a792382f539093a974c6de188985e94b552419db41f6f60814`
- `Atoma-Compute-0.5.200-mac-x64.dmg`: `94028c24860b35f6a50dbf478338f91c59abe29ef2dc05eb9566da5645baf0a3`
