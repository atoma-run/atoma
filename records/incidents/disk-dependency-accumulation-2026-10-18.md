# Repeated dependency installs exhausted the production volume

On 2026-10-18 `/home/atoma` reached 99% (56 GiB used on a 59 GiB
filesystem; only 583 MiB available during remediation). Inodes were not
exhausted. Attica starts had failed with ENOSPC, including
`c2f6db88-7b84-4df8-893c-cac351d62534`, whose admission lease also remained
until its absent child process group was verified and the exact orphan row
was removed after a SQLite backup.

A whole-filesystem traversal attributed 26 GiB to state (24 GiB of Attica
runs), 25 GiB to the mender (23 GiB in twelve retained worktrees), 3.2 GiB
to releases and 2 GiB to Haystack. Separate Docker directory measurements
count shared files differently; they must not be added to those totals.

Two sources of repeated installs were confirmed:

- `seedWorkspace` excluded only the top-level `.atoma-runs` directory.
  Each successor inherited installed `node_modules` and `.atoma-scratch`
  copies, despite a published Attica delivery of approximately 4 MiB.
- Refused mends deliberately preserved their worktree for human inspection,
  but also preserved its roughly 1 GiB root dependency install.

The owner authorized cleanup and prevention. Eleven ended, refused mender
worktrees lost only their root dependency directory; their tracked diffs
were compared before and after. Twenty-five ended Attica deliveries lost
only dependency directories excluded from their artifact manifests. Every
manifest file was hashed before and after. Active runs and their referenced
bases, mounted workspaces, and workspaces named by saved checkpoints were
excluded. No services were restarted, no historical data or traces removed,
and no worktree source edits discarded. The volume then measured 32 GiB
used, 25 GiB available, 57%. The host operation log is
`/var/tmp/atoma-dependency-cleanup-20261018.jsonl`.

The fix excludes installs at every depth and top-level run scratch from
ordinary seeding, at launch and deepening. It preserves sources, lockfiles,
built deliverables, data, the inherited probe manifest and relative links.
Sealed checkpoint restoration uses its separate snapshot path and is unchanged.
Retained mender worktrees now discard their root install after executable
commands and containers settle, while still holding their existing lease.
Cleanup errors are warned and do not mask the recorded outcome or prevent
lock release. Symlinks/junctions are unlinked explicitly.

Adversarial checks covered nested installs, authored directories with similar
names, original seed immutability, relative and escaping links, and a retained
mender install linked to an external directory. Sources and tests survive the
refusal; the external target is untouched. The three new regression cases
failed on the original code. After the fix, 90 seed/inherited-check/mender
pipeline tests passed, along with both TypeScript configurations, lint and
documentation checks. CI remains the full release gate.

A follow-up traversal found six ELF core dumps in retained worktrees,
1.2–2.3 billion bytes each (sparse files consume less allocated storage).
These are archived with gzip on the separate system volume, with a complete
decompressed SHA-256 check before each original is unlinked. Their host
archive directory is `/var/tmp/atoma-core-archives-20261018` (mode 0700).
Future mender containers set both the soft and hard core limit to zero;
the existing real container isolation test reads `/proc/self/limits` to
verify this production boundary. CI builds and tests that container.
