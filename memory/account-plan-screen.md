---
name: account-plan-screen
description: Settings → Your plan shipped 2026-10-15 — beta means one Free plan, Pro/Team previewed greyed, no prices; limits come from the server
metadata:
  type: project
---

On 2026-10-15 the owner asked for a "Your plan" screen so a client knows where
they stand. Shipped as Settings' second tab plus an account-menu row: Free is
the current plan for every organisation (badges Current plan + Beta), with the
instance's enforced limits (concurrent runs, run time, spend cap, token cap)
served on `/api/org` from `contracts/accountPlan.ts`. Pro and Team are shown
greyed, "Coming soon", with feature lists (queue priority, more concurrent
runs, longer runs, higher spend cap, support, org billing, usage reports) and
NO prices and NO upgrade button.

**Why:** the owner wants paid plans visible but not selectable during the
beta; nothing is priced yet, and a number on that screen reads as a quote.

**How to apply:** when pricing or a second selectable plan arrives, change
`BETA_PLAN`/`accountPlan()` server-side and the feature lists in
`PlanPanel.tsx`; keep the limits derived from platform settings. Related:
[[project-deployment]], [[push-to-prod-authorized]].
