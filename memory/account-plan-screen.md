---
name: account-plan-screen
description: Settings → Your plan shipped 2026-10-15 — Pro/Team greyed, no prices; since 2026-10-16 an operator can place an org on Pro/Team (auth set-plan), which removes the Atoma mark
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

Since 2026-10-16 the plan is stored per organisation (`auth_org_plans`, no
row = Free) and set only by the operator: `npm run auth -- set-plan --org
<id> --plan <free|pro|team>`, journaled `org.plan_changed`. The one effect so
far: Pro/Team remove the "Powered by Atoma" mark (web badge on previews and
hosted apps, terminal banner, new repo description) — owner request
2026-10-16. Nothing else is plan-dependent yet; limits stay instance-wide.
