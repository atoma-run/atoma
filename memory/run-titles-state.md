---
name: run-titles-state
description: "Short run titles (one LLM line per ended run, host api: tier 1) LIVE in prod since d1a1d71b on 2026-10-02; past runs not backfilled"
metadata:
  node_type: memory
  type: project
  originSessionId: 094e2901-4f06-4e77-b53f-0995f4248cc7
  modified: 2026-10-02T19:31:35.195Z
---

**Decision (user, 2026-10-02):** every run of every org gets a short, human-readable title, generated ONCE when the run ends, with the platform's smallest model.
Motivations:
- The run dropdown printed each run's whole goal.
- The public run-feed design (claude.ai artifact SzYfAujkMiaTysYCs8tL7B) needs short titles.

**Shipped:** commit d1a1d71b on main, pushed after the user said "commit and push". CI and the "Deploy production" run both passed. The worktree and the run-title branch were removed afterwards.

**What it does:**
- **Generator:** `src/projects/runTitle.ts`. It runs on the HOST's `api:` ATOMA_MODEL_L1 with the host credential. It refuses `sub:`/`own:`, because a tenant's goal must not cross a machine login.
- **Storage:** `project_runs.title` plus `title_receipt_json`. The call's cost lives in the receipt, so `stats` stay the run's own spend. A trigger makes the title immutable once written.
- **Coordinator:** a `runTitler` option. It runs detached, after the terminal transition and off the lease, for delivered, partial, failed and cancelled runs. `waitForIdle` waits for in-flight titles.
- **Display:** the GL run selector, its search, the project run cards and the MCP resource list show the title. The journal keeps the goal, because a title is model text.

**Not verified:**
- That prod's host ATOMA_MODEL_L1 is really `api:zai:glm-4.5-air`. Operator runs suggest it. If it is a `sub:` pin, no titles appear and stderr says why, once.
- That a real run gets named. Check the first project run that ends after the deploy.

**Open follow-ups:**
- Backfilling titles for past runs. Not built; it would need an operator CLI.
- Operator `./runs` corpus traces get no title.

Related: [[push-to-prod-authorized]], [[shared-checkout-staging]].
