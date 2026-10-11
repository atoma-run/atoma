---
name: worktree-junction-hazard
description: "Never junction/symlink node_modules into a temporary git worktree and then `git worktree remove --force` — on Windows it deleted the main checkout's node_modules (2026-10-11)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 7f8e1401-022c-4c27-80f8-737bb447be7a
  modified: 2026-10-11T03:08:54.437Z
---

On 2026-10-11 I created a temporary worktree of HEAD to run one Chrome test at HEAD, linked `node_modules` into it with `cmd /c mklink /J`, and removed it with `git worktree remove --force`. The removal followed the junction and wiped `C:\Users\mgf\dev\atoma\node_modules` (0 entries left); the next `npx tsc` silently installed a bogus `tsc@2.0.4` package instead of running the project's TypeScript. Recovered with `npm ci`.

**Why:** a junction is a directory to `rm -rf`-style removal on Windows; git's worktree removal does not know it is a link.

**How to apply:** to test at HEAD, prefer `git stash`-free options that need no node_modules link: compare behaviour by reasoning, run the test on the current tree with the change reverted in a scratch copy of the file, or use the WSL clone (see [[machine-setup]]). If a worktree with dependencies is unavoidable, remove the junction FIRST (`rmdir node_modules` inside the worktree, which removes only the link) and only then `git worktree remove`. After any tooling surprise ("package not found, will be installed" from npx), check `ls node_modules | wc -l` before trusting a green result. See [[shared-checkout-staging]].
