---
name: parent-tests-review-fixes-state
description: "2026-10-16: handoff for the parent-owned-tests review fixes — worktree, commits, what is verified, the eleven follow-up points still to do, pushed 2026-10-16 ~13:00"
metadata:
  node_type: memory
  type: project
  originSessionId: 82473edf-d47d-417e-8c76-ec81b599b6fe
  modified: 2026-10-16T08:48:24.611Z
---

State on 2026-10-16 ~13:00. The branch was PUSHED to main around 13:00 (see git log for the ten commits ending with "fix(core): never end a run on a child plan reviewer fault"). Items 1–11 below are still TO DO; item 12 is DONE (non-fatal reviewer refusal, tests/plan-review-fault.test.ts).

**Where:** worktree `/Users/mgtf/dev/atoma/.claude/worktrees/review-fixes-parent-tests`, branch `review-fixes-parent-tests`, based on origin/main 8b9d990b. Its own `npm ci` node_modules (real directory, not a link). Pushed to main on 2026-10-16; the worktree can be removed once the follow-ups land.

**Commits on the branch (oldest first):** ece5c24a (A: typed host block for parent-test observations, unavailable split by cause, one mapping), 51cd1564 (B: refused dependency lands, dependents not started), 58deb1a0 (C: async snapshot copy, pinned vite/vitest/rolldown in the worker image), 93e091c9 (D: root delegation review on tier 2, approval kept across resume, unparseable root plans retried), f5ce37cb (E: DAG-aware cross-bucket routing, implementation nodes never split), 14b8ba31 (subsystem AGENTS budget 700 → 800, owner decision), d772b7e7 (F: calibration counts Decision-free validations apart, no TS guidance in reasoning mode, task-neutral criteria prompt, readable tests), 2b0629ff (docs: choices marked decided). The review record is `records/reviews/parent-tests-review-fixes-2026-10-16.md`.

**Verified at d772b7e7:** full suite 6,859 passed / 15 skipped, typecheck, lint, docs:check, build, container tests 38/38 on a uniquely tagged worker image (removed after).

**Review round 1 fixes committed:** d6f3835f. Round 2 review was running at 12:10.

**Not done (subagent quota hit at ~12:20):** the second independent review round and its fixes never ran. Run one before or with the follow-ups.

**History, in flight at ~11:50:** workflow wf_d3cd8ca8-8b5, review round 1 fix stage (17 findings, 34 refutation votes), then a second verify. Check `git log` on the branch and the workflow journal under the session's subagents/workflows dir; if the fix commit is missing, the findings were: timeout cause misclassifies a slow copy as a hang (copy now shares the 120 s window); CSS stub only on spelled extensions; delegation-review completeness guard became a denylist of stop reasons; failingExcerpt breaks past 8,000 chars of details; tautological table test and approval-digest test.

**Follow-up still to do (owner asked for all of it):**
1. Approved dependency landing with blocked phases and budget left → open the remediation pass (choice (b) reversed).
2. `exited-without-report` / `report-invalid` causes sit in review; reconsider (reject once then review).
3. Code under test can redefine Vitest matchers (expect.extend) in the same thread → detect and report.
4. L3 re-runs an L2 [A, C] branch without dependencies whose own fallback fails; a mutualized peer's fallback never counts as a spent ladder.
5. Plans with many suites can exceed STRATEGY_MAX_TOKENS → three truncations end the run; bound suite size or raise the root cap.
6. Child plan review: a repeated reviewer-fault refusal branches a type; an unparseable child verdict still throws.
7. Split verification parts: browser part can land on a web cell without a server; criteria copied to both parts (read-only in parallel plans is likely infeasible — say why).
8. parentTests not shown in viz or the MCP; run viz:smoke on a real machine for the new "partial run" card copy.
9. Hard runner exit leaves `atoma-acceptance-*` temp copies.
10. A suite importing a tsconfig alias stays red; apply the same alias resolution to the suite.
11. Docs: (b) wording after item 1.
12. d6f3835f (review round 1 fixes) made a SECOND reviewer fault on a child plan review throw ValidationError, which fails the whole dispatch/run. Too harsh: prefer a plain rejection without type escalation, or a re-review on another model, never ending the run on reviewer flakiness.

After the push: full suite 6,954 passed / 15 skipped post-rebase, container tests 38/38 on a fresh unique image, viz:smoke fails at "focused view frame composite is invalid" ON MAIN TOO (pre-existing, not this branch) — worth its own fix. Update [[parent-owned-tests]] with the new semantics. Decisions taken under [[beta-rules-not-fixed]].
