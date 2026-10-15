---
name: shared-checkout-staging
description: "Shared checkout with peer sessions (Codex too): never stage from a git status listing, never reset --hard/stash the tree; a peer can sweep MY hunk into THEIR push too (2026-10-01, 2026-10-04, 2026-10-15)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e82e9669-4aba-430d-ba86-145d0c444324
  modified: 2026-10-15T04:40:00.000Z
---

On 2026-10-01 I staged with `git add -- $(git status --porcelain | awk '{print $2}')`. The checkout C:\Users\mgf\dev\atoma is shared with the peer session (atoma-e4), so that command swept four of the peer's uncommitted viz files into my commit: src/viz/client-gl/{GpuApp,OrgModelsForm,PlatformLimitsForm}.tsx and the en.json locale. I caught it before pushing. I ran `git reset --soft HEAD~1` and `git restore --staged <their files>`, then recommitted. Their working tree was untouched.

**Why:** a push to main deploys to production, so committing someone else's half-finished work ships it and takes it out of their hands. The standing rule says to stage only my own paths. A `git status` listing is the whole tree, which is the same as `git add -A`.

**How to apply:**
- Stage only paths I name explicitly, from my own edit list.
- Before every commit, read `git diff --cached --name-only` against that list.
- After the commit, check `git show --stat HEAD` for any path outside my change, src/viz and the locales above all.

On 2026-10-04 I ran `git status --porcelain && git reset --hard origin/main` in one chained command to sync a diverged main. The peer, a Codex session working on GPU shadow batching, had an uncommitted edit in src/viz/client-gl/gpu-renderer.ts. Its status lines printed, but the chain did not stop on them, and the reset wiped the edit. The Codex session re-applied it within minutes. Use `git cherry` to check whether "diverged" commits are already upstream; that day all were, except mine.

- Never `reset --hard`, `checkout -- .`, `stash` or rebase on the shared tree. To sync, cherry-pick in a separate worktree, or check the tree is clean in its own step and read the result before acting.

The hazard runs the other way too. On 2026-10-15 a peer session committed and pushed 8b8b0193 while I was mid-change: it staged src/atoms/L2Atom.ts whole and took my two-line hunk (an import of a constant that only existed in my unstaged prompts.ts), so origin/main failed typecheck until my commit 7c9514f5 landed eleven minutes later. Signs to watch for: a file I edited that `git status` no longer lists, or a HEAD that moved while I was working.

- When a file I edited drops out of `git status`, run `git show --stat HEAD` and `git show HEAD -- <file>` before anything else; if my hunk is in a peer's commit, push the rest of my change at once so main compiles again.
- A multi-file change touching a shared hot file (L1Atom/L2Atom/L3Atom, prompts.ts, the locales) is best committed in one go as soon as it typechecks, not left unstaged across a long verification.

That peer was me in another session (fe0cae40 → 8b8b0193): I had checked my own edit list but `git add <hot file>` stages the WHOLE file, and the peer's hunk was already on disk.

- On a hot file, run `git diff -- <file>` before staging; if it holds hunks I did not write, stage only mine (`git diff -- <file> | <keep my hunks> | git apply --cached`) and read `git diff --cached -- <file>` afterwards.

Third direction, same day: a peer's `git commit` took the SIX files I had just
staged (6c817b42 carries my assayer isolation fix under a viz message), because
the index is shared too, not only the worktree. So stage and commit in ONE
command (`git add <paths> && git commit`), never leave files staged across a
verification, and read `git show --stat HEAD` after every commit on this tree.

Fourth, 2026-10-15 afternoon: I edited runs.ts and chip-layout.ts for a
typography change and staged them by name. Both already carried a peer's
UNCOMMITTED proposal (the dense branch strip, marked "PROPOSAL, uncommitted"
in comments); its third file, copy.ts, stayed unstaged. My local typecheck
passed because the worktree had all three; origin/main failed on
`timelineBranchLabel` (15cbcd69, fixed by 66f95248 from a scratch worktree
cherry-pick, since the tree held other peer edits). A name-listed `git add`
is still a whole-file add.

- A "PROPOSAL (uncommitted)" comment in a file I am about to touch is a
  peer's live work: diff the file against origin/main before editing, and
  either push their whole set with them or stage only my hunks.
- To push while the shared tree is dirty with a peer's edits: scratch
  `git worktree add --detach <path> origin/main`, cherry-pick or apply my
  hunk, symlink node_modules for the hook, push `HEAD:main`, remove the
  worktree. Never pull --rebase or autostash on the shared tree.

Phantom modifications (2026-10-15 13:30): after a `reset --soft origin/main`
+ `reset` realignment, every file the skipped commits touched keeps its OLD
bytes and shows as modified, reverting main. Checked: 23 such files each equal
an older main version. After moving HEAD, restore exactly those files:
`git diff --name-only <old HEAD> origin/main`, confirm none holds a peer's
live edit, then `git checkout origin/main -- <files>`.

Related: [[push-to-prod-authorized]].

The index is shared too (2026-10-15, second incident). I ran `git add <my paths>` and then a plain `git commit`, which swept six files a peer session had already STAGED (assayer, server.ts, supervisor AGENTS.md) into my commit. Checking `git diff --cached --name-only` before committing would have shown them. Separately, a peer's `reset` to origin/main dropped my unpushed local commit from main; its changes survived in the working tree.

- Commit my paths with `git commit --only -- <paths>`: it takes exactly those paths and leaves a peer's staged entries staged.
- If a mixed commit is local only, run `git reset --soft HEAD~1` (the index stays as it was) and recommit with `--only`.
- After a peer's reset, find a dropped local commit with `git reflog`. Check its diff is still in the working tree before recommitting.
