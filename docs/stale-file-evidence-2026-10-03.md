# Current file evidence after an edit

Production run `bcf35298-b65e-4380-8994-a17431e9c564` edited README.md to add
manifest regeneration instructions, then root acceptance rejected their absence.
The old read was explicitly marked stale but its content was still shown. The
criterion said "instructions" without naming README, so the criteria-file reader
did not supply the updated document. See the
[complete incident and trace](incidents/parallel-mission-repair-2026-10-03.md).

The correction changes evidence presentation, not verdict policy. The existing
read-followed-by-write relation is factored into `supersededFileReads`. A retired
read renders its identity and superseding write but omits its old response. Raw
observations remain unchanged in the log and trace. At root, accepted records of
the current attempt also retire witnesses frozen before a later phase's edit.

Root semantic review refreshes these paths through the base executor, so its own
reads never become child proof. They share the existing four-file reader and
excerpt limits with named criteria files. Task and criterion words select useful
later lines after the excerpt head. Unavailable reads and cap omissions are
reported as unknown; neither is evidence of absence. No LLM call, model change,
automatic approval or automatic rejection is added.

## Adversarial review

- Same-phase read/edit and read in one phase followed by an edit in another:
  both must hide obsolete content and show the current host read. Tests cross
  `forkBranch`, the real attestation wrapper, `executorEvidence`, and
  `acceptRootResult` into the captured validator request.
- Current content still wrong or unreadable: the model may still refuse; no
  verdict is forced because an old observation was retired.
- More than four unreadable paths: failed reads consume the budget, with an
  explicit omitted count. This prevents an unbounded refresh on repeated errors.
- Fresh reads, unrelated paths, path aliases, and unchanged edits retain the
  existing rendering tests. A backslash in a POSIX filename is not a separator.
- Raw log content is checked byte-for-byte before and after acceptance. The
  repair does not erase recovered-error evidence or add supervisor reads to it.
- Non-simple filenames are JSON-encoded in the refreshed block. Root refreshes
  use the existing sandbox and refuse relative traversal and absolute paths.
- No shell-effect inference is introduced. Writes whose file identity is not
  attested remain outside this ordering relation; historical shell/browser
  observations are not blanket-discarded.

This closes the observed stale-read input to validation. Mock regressions prove
the evidence handed to the reviewer and preserve its refusal path; they do not
claim that a probabilistic reviewer can never make another semantic mistake.
