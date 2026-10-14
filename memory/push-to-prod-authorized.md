---
name: push-to-prod-authorized
description: "The user durably authorized me to push to main (= production deploy) myself, 2026-09-30"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 56b05e49-ebf1-4e72-bf9d-fc1b5ba7ebcf
  modified: 2026-09-30T15:44:21.900Z
---

I may push to `origin/main` myself, which deploys to production, without asking each time ("tu peux pousser en prod je te fais confiance", 2026-09-30).

**Why:** the user trusts the checks (CI + deploy preflight) and does not want to be the push step; asking again every change slowed the loop.

**How to apply:** still verify before pushing (tests/typecheck/lint/docs:check as relevant, `git diff --check`), rebase on origin/main, stage only my own paths, never touch another session's dirty files, then watch CI and the deploy and report the outcome. A classifier may still block a push; then say so. Related: [[deploy-pipeline-state]].

Gotchas: a parallel agent and the i18n bot (`[skip ci]` locale commits) push to main too, so always `git fetch` and rebase right before pushing. A test that reads the local store (e.g. an MCP smoke calling `atoma_registry_list`) passes on a dev machine and fails on CI's clean checkout; use `tools/list`-shaped checks.
