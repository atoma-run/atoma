---
name: mcp-one-surface
description: MCP redesign 2026-09-05 — one HTTP MCP on /mcp with role tiers and bearer API tokens; stdio removed; what remains (Settings token UI, OAuth, org-admin invites)
metadata:
  type: project
---

Decided by the user on 2026-09-05: ONE MCP for everyone, tiered by role (viewer / member / admin / platform), and the "stdio-only, no HTTP port" rule is broken on purpose. Built the same day: `src/mcp/{identity,tools,http}.ts`, `/mcp` route on the viz server (Streamable HTTP, JSON responses, DNS-rebinding host pinning), bearer API tokens (`auth_api_tokens`, `/api/tokens`, `npm run auth -- token`), journal kinds `token.created/revoked`, 24 catalogue tools (operator run tools renamed `atoma_operator_run_*`; `atoma_run_*` are now PROJECT runs). Stdio entrypoint, `npm run mcp`, `mcp:dev` deleted; release smoke proves the MCP through the compiled viz server. Decision record: `docs/decisions/mcp-one-surface-2026-09-05.md`; contract: `src/mcp/AGENTS.md`.

**Why:** customers plug Claude Code / Codex into the deployed instance and need the prod viz; the stdio argument described the old on-machine product. The user wants docs and rules to evolve with the product, not be treated as fixed.

**How to apply:** do not re-add a second transport; add a tier instead. Settings panel `McpAccessPanel` built 2026-09-06. Open: OAuth 2.1 for MCP clients (deferred), org-admin invitations (product decision). Registering locally: `npm run viz` then `claude mcp add atoma --transport http http://127.0.0.1:<port>/mcp` (no token, operator tier). See [[supervisor-mender-state]] for the correction loop this MCP will be used to drive.
