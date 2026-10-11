---
name: mcp-review-2026-10-03
description: MCP-advances review of Atoma (2026-10-03) and its fixes, pushed 2026-10-04 (7ccc8646..67e95d0b); what remains open is owner decisions
metadata:
  type: project
---

Review of Atoma against MCP 2026-07-28 and the current clients (2026-10-03). The verified conclusion: the gains were corrections, not new protocol features. At "corrige tout", I implemented everything that needed no decision, as 8 commits pushed to main on 2026-10-04 (69c1854a..67e95d0b):
- 7ccc8646: claude-cli strictMcpConfig on EVERY query, plus ENABLE_CLAUDEAI_MCP_SERVERS=false; the element bridge serves schemas verbatim (low-level handlers).
- 80a18ed7: run-start contract.
  - Settings Codex table gets tool_timeout_sec=10800. The October 300 s cuts were Codex's fixed deadline.
  - A re-sent identical start re-attaches to the caller's live run (coordinator.startOutcome / store.findLiveRunForSameRequest).
  - Refusals name the caller's own run. run.started is journaled only on creation.
  - responseMode 'sse' on 2026, plus a 2026 progress wire test.
- 54a91a9d: instructionsFor(tier) at most 2,048 chars, essentials within 512; atoma_goal hands the start back; looseObject output schemas; requiresUserInteraction on the 4 platform writes; resources/list lists the newest runs.
- 85652b10: 2026 tasks — empty ack when cancelling an ended task (SEP-2663); Mcp-Name and capabilities checked.
- 62941084: compiled release smoke covers 2026-07-28.
- 57073e06: a project task reads the run row (projectRunState), no longer a full trace parse every 2 s.
- 72113673: OAuth — frozen /oauth answers temporarily_unavailable; DCR registration extended to its grant's lifetime; RFC 7591 codes; consent wording.
- 67e95d0b: atoma_github_installations + typed atoma_project_create (41 tools).

**Why:** the user asked what the latest MCP advances could improve, then "corrige tout".
**How to apply:** do not redo these. Still open, OWNER decisions:
- "detach" start for claude.ai's 240 s cap (gates MCP Apps and the directory);
- Codex: block for 3 h vs re-attach;
- requiresUserInteraction on starts;
- provenance of criteria arriving over MCP (stored as 'user');
- tier cap on grants;
- graceful SIGTERM (none exists; blocks persisted telemetry and refresh during the freeze);
- reader for delivered files;
- why SDK 2.3.0 was installed and reverted on 2026-10-03, before upgrading it.

Windows test noise (EPERM cleanup, POSIX paths, pid lock) predates this work. Related: [[mcp-two-eras]], [[push-to-prod-authorized]].
