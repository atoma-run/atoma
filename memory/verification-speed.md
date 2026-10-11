---
name: verification-speed
description: "Don't block a push on the ~10-minute full WSL verification; targeted tests + lint/typecheck/docs, then push and let CI gate the deploy"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 56b05e49-ebf1-4e72-bf9d-fc1b5ba7ebcf
  modified: 2026-09-30T18:06:14.193Z
---

Don't wait for the full WSL run (build + smokes + whole vitest suite, ~8–10 min) before pushing ordinary changes ("ça prend mille ans la vérification WSL", 2026-09-30).

**Why:** CI runs the full hermetic suite on every push to main, and production deploys only when CI is green, so a local full run duplicates the gate and just delays the user.

**How to apply:** run the tests of the touched area (the tests that cross the changed boundary, in WSL when POSIX-only), typecheck, lint, docs:check, `git diff --check`; then fetch/rebase and push, and watch CI + deploy. Keep a full local run only for risky, wide changes (release path, container, security-sensitive gates) — and say why when doing it. Related: [[push-to-prod-authorized]].
