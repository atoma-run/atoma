---
name: project-chat-deployments-2026-10-26
description: 2026-10-26 project conversation tells hosted deployments and stops asking to accept an accepted result (5e2943d8); row facts readyAt/replacedRunId; history opt-in
metadata:
  node_type: memory
  type: project
  originSessionId: e00dfcfd-ad9b-49ab-bc7f-7a835ddbddff
  modified: 2026-10-26T11:21:58.130Z
---

Owner complaint (2026-10-26, after accepting bd071108 and updating the hosted Attica app): the accepted card still said "Look at the result before accepting it", the earlier deployment was absent from the chat, and it was unclear what had been accepted.

Shipped in 5e2943d8 (pushed to main 2026-10-26):
- Card headline by state (`outcomeKey` in AssistantRunResult): awaiting / "Work finished and accepted." / "Work finished."; "accepted" said once.
- `HostingSummary.history` (max 20) built by `hostingHistory()` from row facts only. New record fields `readyAt` (first served) and `replacedRunId` (serving run at request, null if none). Rows without `replacedRunId` are pre-change: told neutrally ("Deployment of: X / Stopped."), never "switched".
- History is sent only on `GET …/hosting?history=1` (old tabs parse strictly); client parses entries tolerantly.
- `retirePredecessors()` moved out of the launch try/catch (a clean-up conflict used to stop the just-started version); `stopRows` yields to a row clean-up already stopped.
- f948dd41: the result card carries the run's title (from `atoma_run_status.title`, `AssistantView.run.title`).
- f9fc00d3: an unaccepted delivery older than an accepted run says "Not accepted; a later version replaced it."; receipts put buttons beside the text when the log is ≥520 px (`@container assistant-log`).
- Two adversarial review rounds; all confirmed findings fixed. Deliberately not done: the card's hosting offer and the deployment line may say similar things.

**Why:** the owner must be able to tell from the conversation alone what was accepted and what is online.
**How to apply:** rollback past 17fef5ac needs `json_remove(record,'$.previousRunId','$.readyAt','$.replacedRunId')` on every row (docs/project-hosting.md). Scratch worktrees have no `.husky/_`, so the pre-commit i18n invalidation does not run there; CI's `invalidate-range` blanks changed EN values instead. See [[hosted-update-explicit]], [[project-chat-acceptance]], [[shared-checkout-staging]].
