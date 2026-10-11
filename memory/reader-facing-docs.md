---
name: reader-facing-docs
description: "Owner decision 2026-09-30: a delivered README/doc carries no verification evidence (observed values, digests, line numbers, source quotes) — READER_FACING_DOC_GUIDANCE shipped f82ee3ad; recipes to drop after deploy; verification run"
metadata:
  node_type: memory
  type: project
  originSessionId: e82e9669-4aba-430d-ba86-145d0c444324
  modified: 2026-09-30T19:12:48.965Z
---

On 2026-09-30 the user chose "Aucune preuve dans la doc". Shipped as f82ee3ad after an
adversarial review. `READER_FACING_DOC_GUIDANCE` in src/atoms/prompts.ts goes to every molecule
that writes documentation:
- the scribe and static guidance;
- the HTTP L1 and full-stack L1 prompts;
- the L2 and L3 fallback-execute prompts, only when that executor has tools.

What a verification observed goes in the result summary, unless the task asks the document to
record it. Usage examples, example output and exit codes stay, stated as behaviour. Planners never
carry the rule: tests/reader-facing-docs.test.ts pins that, the rewording of the L3 DOCUMENTATION
planning line, the project-docs "In your result, cite…" line, and validator Example 11.

**Why:** cdc34023's README ended on a "Verification evidence" section (smoke values, a SHA-256,
line numbers, source quotes). The pomodoro repo mgtf/atoma-jev-verification-20260929 still has
that section plus "The verified static entry point…".

**Decision 2026-10-01 ("Retirer à l'édition"):** the verification runs 1ed071e3 (pomodoro) and
9854553c (CLI) wrote clean new text. Both kept an earlier run's evidence section, which is now
false: the pomodoro README cites the old page's SHA-256 and line numbers, and the CLI list has no
--exclude. The user chose to extend the rule so that a molecule editing a document removes what an
earlier verification recorded in it, while what the document states as behaviour stays.
"Preserve unrelated content" does not protect such a section. Adversarial review first. Accepted
risk: a measurement an old task asked for could go.

**Shipped a5d66759 (2026-10-01) after 2 review rounds:** the rule is RUNTIME text in L1Atom plan+execute for any molecule with write_file/edit_file/run_shell (+ L2/L3 fallback executors); REMOVED from all stored prompts (one home; canonical trust reset once more). Removal only when the task writes/updates a README or doc (never page/code/data); keep only if the task asks the doc to keep/record it; recording docs keep entries. Validator: own section before PLAN vs RESULT. Next: verify on a README-editing run that the old evidence sections disappear.

**How to apply:**
- DONE 2026-09-30: dropped `write-verified-readme` (l1 Ammonia, 18 successes, force) and
  `record-node-app-probes` (l1 Glucose, 0 successes). A reset is not enough because it keeps the
  body.
- DONE: the verification runs on 153c3e37 and 9af0bfba. Earlier plan:
  - the new text is free of observations;
  - whether the old evidence section is removed or kept. Its removal conflicts with "preserve
    unrelated content"; if the section is kept, that is a question for the owner.
- Non-canonical molecules keep their old prompts until the host runs
  `node --import tsx scripts/repair-atom-prompts.mjs --db <store> --apply`. tsx may be missing on
  the host (npm ci --omit=dev). Canonical molecules refresh at bootstrap and lose their trust
  streak once.

Related: [[read-only-phases]], [[verification-speed]].

**Verification 2026-10-01:**
- c1d1b230 (pomodoro): evidence section removed by edit; one "verified" line kept.
- fa8b6ce3 (CLI): evidence removed, but the README was REWRITTEN whole. The --json example and the outputs of --min-length and --exclude were lost, and the error messages were not restated.
- Cause: the build task constraint "via the write_file tool" turned into the planner's "full on-disk file write"; the build recipe build-text-frequency-cli was also injected into the doc phase.
- de4a7f48 shipped: the constraint now says edit_file for existing files, and the rule says "wherever it sits, a single verified line".
- A CLI README repair run was launched (agent) to restore the lost examples and errors.
