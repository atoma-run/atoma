---
name: mcp-two-eras
description: "2026-09-30 atoma /mcp moved to MCP SDK v2 + zod 4 and serves protocol 2026-07-28 beside 2025-11-25; what was kept, where the SDK is worked around, what is open"
metadata:
  node_type: memory
  type: project
  originSessionId: 56b05e49-ebf1-4e72-bf9d-fc1b5ba7ebcf
  modified: 2026-10-03T20:49:07.181Z
---

Pushed to main on 2026-09-30 (70d80ec..937b8b2, user ran the push — the auto-mode classifier refuses `git push origin main` from me, see [[readme-video-upload]]).

- Both protocol eras on `/mcp`: 2025-11-25 keeps sessions/replay/tasks/subscriptions/run log (tests drive it with the real v1 client); 2026-07-28 is stateless via `createMcpHandler`. Decision record `docs/mcp-two-eras-2026-09-30.md`.
- SDK v2 has NO task runtime on either era: tasks are ours (`src/mcp/tasks.ts` model, `taskWire.ts` wires). The task path wraps the SDK's internal `_requestHandlers` 'tools/call'; 2026 `tasks/*` are answered by the host because the SDK refuses them (-32601).
- `@modelcontextprotocol/sdk` v1 stays only for the Claude Agent SDK (llmClaudeCli) and 2025 tests.
- `health().clients` counts `<version> <client>` — the evidence to decide when 2025 support can be dropped. Nobody had checked which version production clients speak.
- A project run's task is the run (`project-run:<project>:<run>`), bound to principal+org (piste 1, commit 254cf19).

**Why:** user asked to improve the MCP against the spec, and to keep 2025 clients.
**How to apply:** before removing 2025 support, read `health().clients` on prod. Since bfee277 (2026-09-30): `atoma_mcp_health` (platform tier) reads `health().clients` — first reading after deploy: only `2026-07-28 claude-code`. CAUTION: the counters reset on every deploy, and Codex (2025-11-25 by default) is ALSO a production client (Codex sessions on 2026-10-02/03, see [[mcp-review-2026-10-03]]). CIMD OAuth supported (src/auth/clientMetadata.ts, reviewed adversarially). Elicitation for destructive tools judged redundant (destructiveHint already prompts) — that decision exists only here, not in the repo. resource_link built since 968c9087; still not built: MCP Apps (ui extension), traceparent. The build worktree was removed the same day; when a worktree's node_modules is made of junctions to main's (to spare disk), delete the junctions with `.Delete()` BEFORE `git worktree remove`, or a recursive delete empties main's node_modules. Also relevant: [[machine-setup]], [[mcp-one-surface]].
