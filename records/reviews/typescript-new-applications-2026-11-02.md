# Narrowed TypeScript rule, workspace-path probes and the scorer replay — adversarial review 2026-11-02

Reviewed before landing, on the uncommitted diff of `feat/direct-depth`, by an
independent reviewer that read the code and the archives and ran targeted
tests, no paid call. Three changes were under review:

1. `APPLICATION_TYPESCRIPT_GUIDANCE` narrowed to new applications
   ([decision](../../docs/decisions/typescript-new-applications-2026-11-02.md)).
2. `record_probe` omitting output that names the workspace directory.
3. The tabstat and wclite scorers replaying non-CLI manifest entries as
   commands instead of as CLI arguments.

No blocker was found. Each finding and what was done with it:

| # | Finding | Disposition |
|---|---|---|
| 1 | `PARENT_TEST_PLANNING` still asked for suites on TypeScript work only, while the reviews now refuse JavaScript plans without them: a mechanical refusal and a replan | Fixed: "JavaScript or TypeScript application work" |
| 2 | The root match had no left boundary: `src/workspace/x`, a URL path or `/home/u/workspace` counted, and on a host each project run, not every run, has its own directory | Fixed: whole-path match after removing colour codes; the rationale rewritten to what holds (per-run host directories, archives, scorer copies; in a worker, the runner's timings) |
| 3 | Reports with timings but no path (`node --test`, Jest, `npm ci`, a fresh-copy check) are still recorded, and the model had no lever | Fixed: `recordOutput: false`, asked for in the description; the omission reason is returned. Round 17 pre-registers how such a miss is reported |
| 4 | The scorer's 180 s per entry exceeded `score-round.mjs`'s 120 s; the copy leaked on a throw | Fixed: 90 s per entry, ten minutes per scorer, cleanup on process exit |
| 5 | CLI lines with shell syntax were still split on whitespace | Fixed: a line with shell syntax replays through bash in the copy |
| 6 | "New application" against "existing project" was undefined (monorepo package, new directory in a repository) | Fixed: defined in the rule |
| 7 | "Type stripping is not proof" could refuse the only functional evidence a lone `challenge.ts` allows | Fixed: not proof of type correctness; such a module is judged on functional checks |
| 8 | The scorer runs recorded commands with the operator's environment | Fixed in part: minimal environment, HOME in the copy. Commands still run on the host, as `node tabstat.js` always did |
| 9 | Replays share one copy in manifest order | Accepted, pre-registered as a threat |
| 10 | Entries without a recorded stdout are not replayed, so their exit code is not re-checked | Accepted, pre-registered: the instrument of rounds 13 to 16 |
| 11 | `verify-maint.mjs` named rounds 13 to 16, which it never scored | Fixed: "earlier rounds" |
| 12 | "Defines check and build" missed an application with only `build` and `test` | Fixed: every check, build, typecheck, lint and test script it defines |
| 13 | Tests asked of a JavaScript project with no runner | Fixed: `node:test`, no dependency |
| 14 | `run_shell`'s description still nudged toward skeleton adaptation | Fixed: the scaffold is for a new application |
| 15 | TypeScript-era recipes (`migrate-cli-to-strict-ts`, the compiled `verify-node-quality-gates`) stay in the skill store | Open: the direct default reads no recipe and learning is off, so neither reaches a default run; the production catalogue needs an audit before deep runs rely on it |
| 16 | A seeded manifest keeps a root-naming stdout recorded before this change | Accepted: re-recording the command replaces it; no reader is harmed beyond what it was before |
| 17 | The model was not told why output was omitted | Fixed: `recordedOutputOmittedBecause` |
| 18 | The helper split `recordProbeTool` from its comment and used a different realpath | Fixed: moved, `realpathSync.native` as the sandbox does |
| 19 | Native Windows roots printed with forward slashes are not matched | Accepted: hosts and workers are POSIX |
| 20 | The decision linked a review record not yet written | Fixed: this file |
| 21 | Attica's project context may still record the 2026-10-16 policy as a decision, which the new clause would honour | Open: the production MCP needed re-authentication; to be read before the next Attica run |

Checked and fine, by the reviewer: no other prompt, checklist drafter, result
gate or root acceptance text demands a migration, the skeleton or a fixed
check and build; reviewers lose nothing from the omission, since attestations
keep the full output; re-recording replaces a stale stdout; both benchmark
arms use `record_probe`; among all archived tabstat workspaces only
`build.prev17` and `build.prev59` hold non-CLI entries with stdout, both still
stale on `npm run check`.
