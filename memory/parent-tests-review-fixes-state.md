---
name: parent-tests-review-fixes-state
description: "2026-10-16: parent-owned-tests review fixes DONE and deployed (066638d3); existsSync permission fix b8b2fd86 (2026-10-17); open limits and one deploy-pipeline gap remain"
metadata:
  node_type: memory
  type: project
  originSessionId: 82473edf-d47d-417e-8c76-ec81b599b6fe
  modified: 2026-10-16T08:48:24.611Z
---

All work is done and deployed (production at 066638d3, 2026-10-16 ~17:55): the critical review's eight points, two independent review rounds and their fixes, and follow-ups G1–G6 (approved-landing remediation, runner integrity, spent-ladder stamp, plan-size cap, verification split routing, viz/MCP visibility). Full suite, container tests on a unique image and viz:smoke passed before the push. The decisions and limits live in docs/decisions/parent-owned-tests-2026-10-16.md and records/reviews/parent-tests-review-fixes-2026-10-16.md.

**Open limits (documented, not fixed):** assertion forging is narrowed, not closed (code under test can still rewrite runner records); a same-uid process can rewrite the verification copy before the suite runs (needs a separate user or namespace); the spent-ladder stamp awaits its pre-registered production measurement (G3 section of the record).

**existsSync under the runner's permissions (fixed 2026-10-17, b8b2fd86):** run 760fef4c was refused at delivery because `node --permission` makes `existsSync` THROW `ERR_ACCESS_DENIED` outside the readable set (a module probing `/usr/bin/chromium` at import never loaded: "failed 0/0"). The setup file now answers false, holding `node:process` ESM bindings across `syncBuiltinESMExports` (Vitest replaces `process.exit`). Still open, documented: `statSync(p, {throwIfNoEntry:false})` and `accessSync` still throw there, and a traversal test aimed outside the copy proves nothing. Replay of two recorded root reviews: same approval rate with the new scope text (2/3, 1/3); the review itself is that noisy on one plan.

**Not a deploy gap (corrected 2026-10-17):** a Deploy production run listed under red 7a94b880 had in fact deployed green 6270cd45 (its REVISION and CI_RUN_ID). GitHub lists a workflow_run run under main's HEAD at trigger time; deploy runs are now named after the revision they ship. See [[deploy-pipeline-state]].

**CI gotcha:** CI runs with TMPDIR unset; macOS sets it. A test that overrides TMPDIR must delete it on restore when it was unset. Reproduce with `env -u TMPDIR npx vitest run <file>`.

The worktree .claude/worktrees/review-fixes-parent-tests can be removed (its own node_modules is a real directory). Related: [[parent-owned-tests]], [[beta-rules-not-fixed]].
