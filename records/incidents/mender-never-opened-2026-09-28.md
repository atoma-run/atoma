# The mender never opened a pull request — 2026-09-28

Three weeks after the mender became a production service (2026-09-06), it
had opened no pull request. Until 2026-09-27 that was policy: every finding
the analyst filed was a `mechanism_candidate`, and only a `defect` was
mendable. Candidates became mendable that day (82c1d99), and the first real
attempt still produced nothing. Looking into why found three
contradictions inside the mender itself, any one of them enough.

## What happened

- `cc922a60#0`, a high-confidence candidate, took the run slot at
  15:09:16 UTC on 2026-09-27. Its Codex session ended at 15:27:49.6 and the
  attempt was recorded `refused` at 15:27:50.1, half a second later. Nothing
  but the diff policy runs in that window: no test had started.
- The next attempt (`c4c270f9#0`) was killed by a manual stop at 15:36, and
  94fabe8 then limited watch mode to candidates analysed after 16:00 UTC.
- From 21:11 to 00:22 the mender service used 13 s of CPU: it attempted
  nothing, the verdicts on that night's three delivered runs carrying no
  eligible finding. Nobody could tell: a refusal pushed no notification, and
  the operator account used for the investigation cannot read
  `supervisor/` or the journal without sudo.

## The three contradictions

1. **The harness's exit check could not pass on the host.** The harness ran
   the full `npm run check` inside the mender container: 2 GiB, one CPU,
   `NODE_OPTIONS=--max-old-space-size=1536`, one Vitest worker. Reproduced
   locally with the exact flags of `menderIsolation.ts` at 0d8998d, the
   production revision:

   | phase | result |
   |---|---|
   | `npm ci` | exit 0, 252 s |
   | `npm run docs:check` | exit 0, 3 s |
   | `npm run typecheck` | exit 0, 118 s |
   | `npm run lint` | **exit 134 after 191 s: V8 heap out of memory** |
   | `npm test` | exit 0, 1068 s (361 files passed, 3 skipped) |

   Unbounded, `eslint .` peaks at 3.5 GiB resident (854 files, 114 s on a
   desktop core); three files peak at 1.1 GiB. The production host has
   3.8 GB of RAM and two Skylake vCPUs. Every mend that got past the diff
   policy and its failing-before test would have been refused with "the full
   check is red after the fix".
2. **The prompt asked for what the diff policy refuses.** Prompt `m2` told
   the model to record a candidate's choice "in the subsystem `AGENTS.md` you
   changed", while `PROTECTED_PATH` refuses every `AGENTS.md` at any depth.
   The refusal of `cc922a60#0` half a second after its session matches this;
   its record was not read to confirm.
3. **The prompt asked for a check the model cannot run.** A model could report
   `fixed` only after a green `npm run check` of its own, and each of its
   commands is bounded to 120 s.

## What changed (632e3f1, 5707c5a, a670fae)

- The harness runs `npm run check:changed -- <files>`
  (`scripts/check-changed.mjs`): the docs check and typecheck of the whole
  tree, ESLint and the tests of the change — 152 s in the same container
  for an 11-file change. CI runs the full `npm run check` on the pushed
  branch and the pull request, and the ruleset requires it before a merge.
  CI on a `mender/` branch has no secrets (the i18n job is `main`-only) and
  deploys nothing (`deploy.yml` requires `main`).
- The scope the model reads (`MENDABLE_SCOPE`) and the patterns the harness
  enforces are built from the same lists; the prompt (`m3`) no longer points
  a candidate's choice at an `AGENTS.md` and names the checks that fit the
  command bound.
- `ATOMA_MENDER_GIT_AUTHOR` names the person who authors the commits: the
  required `cla` status resolves the author, and the old default
  `atoma mender <mender@atoma.invalid>` is nobody's account.
- `mender.refused` now pushes to platform admins, as `mender.failed` does.

## Upstream: findings the analyst could not make mendable

Read once the operator MCP had platform access (11:20 UTC): the journal
shows that on 2026-09-27 FOUR candidate mends were refused for an
`AGENTS.md` edit alone (`src/atoms`, `src/core` twice, `src/run`), and
four were declined. The retry of `cc922a60#0` on 2026-09-28 passed the
diff policy and its failing-before test, and was refused as "the harness
check is red": the host's `mender.env` still set
`ATOMA_MENDER_CMD_CHECK` to the whole-tree `npm run check` (the start-up
warning of 209ee82 now names it). Meanwhile two high-confidence DEFECTS
(`c949f7e7`, `d162ee31`) carried no `proposedFix`, the analyst writing that
`src/atoms/AGENTS.md` "was empty in the provided evidence": its reader's
literal filter was case-sensitive, and a lowercase query matches none of
the file's lines (reproduced locally). R6's high-confidence candidate has
no `proposedFix` either, without saying why.

## Still open

- No mend has yet run end to end on the new contract in production.
- The reproduction's worktree stayed clean after the full suite: the check
  writes nothing that would trip the harness's tree comparison.
