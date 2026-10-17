---
name: parent-tests-review-fixes-state
description: "parent-owned-tests: review fixes deployed 066638d3 (10-16); outside-copy absent paths, suite regex check, review host facts 532d6e35 and dispute count 21b0e5ce (10-17); open limits listed"
metadata:
  node_type: memory
  type: project
  originSessionId: 82473edf-d47d-417e-8c76-ec81b599b6fe
  modified: 2026-10-16T08:48:24.611Z
---

All work is done and deployed (production at 066638d3, 2026-10-16 ~17:55): the critical review's eight points, two independent review rounds and their fixes, and follow-ups G1–G6 (approved-landing remediation, runner integrity, spent-ladder stamp, plan-size cap, verification split routing, viz/MCP visibility). Full suite, container tests on a unique image and viz:smoke passed before the push. The decisions and limits live in docs/decisions/parent-owned-tests-2026-10-16.md and records/reviews/parent-tests-review-fixes-2026-10-16.md.

**Open limits (documented, not fixed):** assertion forging is narrowed, not closed (code under test can still rewrite runner records); a same-uid process can rewrite the verification copy before the suite runs (needs a separate user or namespace); the spent-ladder stamp awaits its pre-registered production measurement (G3 section of the record).

**Runner and review limits closed 2026-10-17 (532d6e35, 21b0e5ce; each through an adversarial review and a second pass):**
- Paths outside the parent-test copy read as ABSENT (Node's ENOENT in every fs form; existsSync false; throwIfNoEntry undefined). Writes keep Node's refusal, including those that read first (open for writing, truncate, rm/rmdir with force). realpathSync never answers for an outside path. Residuals in the protocol: dirs above the copy, copyFile/cpSync/link/rename/watch, module resolution (ENOENT vs MODULE_NOT_FOUND).
- Plan-time suite regex check (run 2e6bdcfc): invalid regex LITERALS refuse every time; an escaped backslash before s/d/w/b refuses once per planner (cell: per task) and pattern, stays in the planner's feedback, then becomes a review host fact.
- HOST FACTS for every delegation review of a plan with suites: where each import resolves, from list_files ONLY. A host read_file marks files read and disarms write_file's blind-overwrite refusal (the first version did; caught by review). The "modules no suite imports" line was dropped: 14/14 corpus lines were .js twins of TS migrations.
- Suite disputes are MEASURED ONLY (suiteDisputes stat + run-log warning): see [[suite-dispute-measurement]].

**Not a deploy gap (corrected 2026-10-17):** a Deploy production run listed under red 7a94b880 had in fact deployed green 6270cd45 (its REVISION and CI_RUN_ID). GitHub lists a workflow_run run under main's HEAD at trigger time; deploy runs are now named after the revision they ship. See [[deploy-pipeline-state]].

**CI gotcha:** CI runs with TMPDIR unset; macOS sets it. A test that overrides TMPDIR must delete it on restore when it was unset. Reproduce with `env -u TMPDIR npx vitest run <file>`.

The worktree .claude/worktrees/review-fixes-parent-tests can be removed (its own node_modules is a real directory). Related: [[parent-owned-tests]], [[beta-rules-not-fixed]].
