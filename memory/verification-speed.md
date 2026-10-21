---
name: verification-speed
description: "Verify thoroughly before pushing; inspect every relevant CI, packaging and deploy result through completion (owner feedback 2026-10-20)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 56b05e49-ebf1-4e72-bf9d-fc1b5ba7ebcf
  modified: 2026-09-30T18:06:14.193Z
---

## Owner correction — 2026-10-20

The owner showed an inbox containing repeated failed CI, Compute desktop and
Deploy production notifications and said: « Ça c'est pas possible, note qu'il
faut vérifier à tort et à travers ».

Thorough verification takes precedence over the earlier speed preference below.
Before pushing, verify the changed behavior and its affected integration,
packaging and release boundaries; run the full release checks when the release
path is affected. Do not skip a necessary check to save time. After pushing,
follow every relevant workflow for the exact revision through completion,
including desktop packaging and production deployment when applicable. A push,
a published preview or one green job is not proof of success. Read failed job
logs, fix causes within the authorized scope, and verify the correction. Report
any remaining failure or verification blocker explicitly; never claim completion
while the relevant checks are pending or red.

## Earlier guidance — subordinate to the correction above

Don't wait for the full WSL run (build + smokes + whole vitest suite, ~8–10 min) before pushing ordinary changes ("ça prend mille ans la vérification WSL", 2026-09-30).

**Why:** CI runs the full hermetic suite on every push to main, and production deploys only when CI is green, so a local full run duplicates the gate and just delays the user.

**How to apply:** run the tests of the touched area (the tests that cross the changed boundary, in WSL when POSIX-only), typecheck, lint, docs:check, `git diff --check`; then fetch/rebase and push, and watch CI + deploy. Keep a full local run only for risky, wide changes (release path, container, security-sensitive gates) — and say why when doing it. Related: [[push-to-prod-authorized]].
