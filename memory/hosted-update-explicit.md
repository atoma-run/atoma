---
name: hosted-update-explicit
description: "2026-10-25 owner decision — a hosted application is updated only by an explicit customer click, never automatically on acceptance; the click must be one plain \"Update the application\" action offered right after acceptance"
metadata:
  node_type: memory
  type: project
  originSessionId: 2342e190-d6b4-42e5-8b19-eccf44b5d18f
  modified: 2026-10-25T21:28:01.561Z
---

Owner (2026-10-25): updating a hosted app stops the site for about a minute, so the customer chooses the moment. No automatic update on acceptance, not even as an opt-in.

What must change instead (customers are non-technical): one "Update the application" action that runs stop then deploy in sequence (same no-two-writers guarantee), with a plain warning and confirmation; offered right after acceptance (chat run card, run page) as well as Project settings; versions described in words (run title, date), never commit hashes.

Shipped at be1790c0 (2026-10-25, CI and deploy green, gVisor container smoke passed on production): one-click update with confirmation, offered in the chat run card, run result page and settings; candidate prepared (copied, revalidated, containers created) before the stop; gateway holds visitors up to 45 s then a plain 503 page; put-back of the previous version on a failed start; boot sweep of unrecorded hosting objects. Measured outage on runc: ~11 s for a Node app without a SIGTERM handler (its 10 s stop grace), under 1 s with one. Three retired EN keys (hosting.update.ready/stopFirst, hosting.updateNotice) stay until CI fix-drift removes their translations.

**Why:** the owner walked the flow as a customer: after accepting in the chat nothing said what to do next, the update sat in Project settings, and it took two ordered buttons explained with hashes.
**How to apply:** never propose auto-deploy again; keep deploy explicit but make it one obvious step. Related: [[compute-results-plain-experience]], [[project-deployment]].
