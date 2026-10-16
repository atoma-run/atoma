---
name: parent-tests-review-fixes-state
description: "2026-10-16: parent-owned-tests review fixes and follow-ups are DONE and deployed (066638d3); open limits and one deploy-pipeline gap remain"
metadata:
  node_type: memory
  type: project
  originSessionId: 82473edf-d47d-417e-8c76-ec81b599b6fe
  modified: 2026-10-16T08:48:24.611Z
---

All work is done and deployed (production at 066638d3, 2026-10-16 ~17:55): the critical review's eight points, two independent review rounds and their fixes, and follow-ups G1–G6 (approved-landing remediation, runner integrity, spent-ladder stamp, plan-size cap, verification split routing, viz/MCP visibility). Full suite, container tests on a unique image and viz:smoke passed before the push. The decisions and limits live in docs/decisions/parent-owned-tests-2026-10-16.md and records/reviews/parent-tests-review-fixes-2026-10-16.md.

**Open limits (documented, not fixed):** assertion forging is narrowed, not closed (code under test can still rewrite runner records); a same-uid process can rewrite the verification copy before the suite runs (needs a separate user or namespace); the spent-ladder stamp awaits its pre-registered production measurement (G3 section of the record).

**Deploy-pipeline gap seen 2026-10-16:** 7a94b880 was deployed by a workflow_run event although its own CI was red (a test-isolation failure, fixed by 066638d3). The deploy likely followed the previous commit's green CI while main had moved on. Check deploy.yml uses the triggering run's head_sha, not main's HEAD. See [[deploy-pipeline-state]].

**CI gotcha:** CI runs with TMPDIR unset; macOS sets it. A test that overrides TMPDIR must delete it on restore when it was unset. Reproduce with `env -u TMPDIR npx vitest run <file>`.

The worktree .claude/worktrees/review-fixes-parent-tests can be removed (its own node_modules is a real directory). Related: [[parent-owned-tests]], [[beta-rules-not-fixed]].
