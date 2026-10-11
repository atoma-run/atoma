---
name: shared-checkout-staging
description: "Shared checkout with peer sessions (Codex too): never stage from a git status listing, never reset --hard/stash the tree (2026-10-01 near miss, 2026-10-04 wiped edit)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e82e9669-4aba-430d-ba86-145d0c444324
  modified: 2026-10-04T06:30:29.225Z
---

On 2026-10-01 I staged with `git add -- $(git status --porcelain | awk '{print $2}')`. The checkout C:\Users\mgf\dev\atoma is shared with the peer session (atoma-e4), so that command swept four of the peer's uncommitted viz files into my commit: src/viz/client-gl/{GpuApp,OrgModelsForm,PlatformLimitsForm}.tsx and the en.json locale. I caught it before pushing. I ran `git reset --soft HEAD~1` and `git restore --staged <their files>`, then recommitted. Their working tree was untouched.

**Why:** a push to main deploys to production, so committing someone else's half-finished work ships it and takes it out of their hands. The standing rule says to stage only my own paths. A `git status` listing is the whole tree, which is the same as `git add -A`.

**How to apply:**
- Stage only paths I name explicitly, from my own edit list.
- Before every commit, read `git diff --cached --name-only` against that list.
- After the commit, check `git show --stat HEAD` for any path outside my change, src/viz and the locales above all.

On 2026-10-04 I ran `git status --porcelain && git reset --hard origin/main` in one chained command to sync a diverged main. The peer, a Codex session working on GPU shadow batching, had an uncommitted edit in src/viz/client-gl/gpu-renderer.ts. Its status lines printed, but the chain did not stop on them, and the reset wiped the edit. The Codex session re-applied it within minutes. Use `git cherry` to check whether "diverged" commits are already upstream; that day all were, except mine.

- Never `reset --hard`, `checkout -- .`, `stash` or rebase on the shared tree. To sync, cherry-pick in a separate worktree, or check the tree is clean in its own step and read the result before acting.

Related: [[push-to-prod-authorized]].
