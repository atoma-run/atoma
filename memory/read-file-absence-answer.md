---
name: read-file-absence-answer
description: "2026-10-13 owner choice — read_file/list_files answer an absent path or a directory instead of throwing (9558099a, in prod); measurement and the open dangling-symlink escape"
metadata:
  node_type: memory
  type: project
  originSessionId: f8ec6b73-c821-4ae0-9aed-c01d8f029c6b
  modified: 2026-10-13T04:49:49.579Z
---

Owner asked to "really fix" red read_file errors in the viz (run 351b224a read `evidence/xe-responses.jsonl`, an output its plan named, before writing it). Measured on 153 prod runs since 2026-10-05: 15/3,345 read_file failures (0.45 %), all in opening bursts of parallel reads, none retried: 4 future outputs, 3 guessed names, 2 wrong base dir, 3 EISDIR on `tests`, 2 own scratch deleted earlier. edit_file is the real friction (208 of 259 tool errors).

Owner chose "absence = observation", reversing 2026-10-06's retained ENOENT: read_file → `{exists:false, nearest}` / `{kind:'dir', entries}`, list_files → `{exists:false, entries:[]}`. `pathHeldNoFile` (src/contracts/toolOutput.ts) keeps them unattested, not a successful action (toolInvocationSucceeded), not "files read" in the attempt digest, and not content for groundTruth/resultGates. Commit 9558099a, CI + deploy green 2026-10-13.

**Why:** these were answers about the workspace shown as tool failures; the throw-dependent host readers had to stay strict.
**How to apply:** any new host reader of read_file must require string `content` (or use pathHeldNoFile), never fall back to JSON.stringify(raw) or ''.

Sandbox follow-up (owner said yes, same day): `ToolSandbox.resolve` now walks links as the kernel does — libc realpath (`realpathSync.native`) on POSIX, and a DANGLING link followed to its raw unnormalized target. Three escapes proven by write_file landing outside, all closed and tested in tests/sandbox-security.test.ts: dangling link out; `a -> inner/../x` with `inner` out; EXISTING `up -> inner/..` (Node's JS realpath resolves link content as text — predated everything). Native realpath also removed macOS case false refusals.

Closed the same day (owner: "corrige les points restés ouverts"): kernelRealpath is native on every platform (no win32 branch; both sides of the check share it, so a quirk refuses, never admits); `ToolSandbox.realPath` + inode + case-blind name make the manifest refusal hold under a symlink, dir link, hard link, dangling alias or case variant. run_shell can still write the manifest — the refusal steers, it is not a boundary.

Test-isolation trap seen: tests/project-publisher "re-drives a failed publication" uses the MACHINE-GLOBAL run lock, so it fails (ProjectRunBusy) whenever a local project run is live — not a code regression.
