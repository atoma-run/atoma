---
name: edge-compression-state
description: "2026-10-14 audit of atoma.run compression: app JSON/MCP left identity by app and nginx; code fix 9b54ac14 (wasm/glb Brotli); nginx gzip+brotli+http2 script prepared, host write blocked for me"
metadata:
  node_type: memory
  type: project
  originSessionId: 9ddfa141-7016-4f62-8fb4-e58dcc79a473
  modified: 2026-10-14T07:46:02.238Z
---

Audit 2026-10-14 (curl + nginx access log, 31 h window): before any fix, only JS/CSS (.br from
`scripts/viz-precompress.mjs`), traces (`traceResponse.ts`) and HTML (nginx gzip level 1) were
compressed. Uncompressed: `GET /api/runs` list (259 KB avg, 140 MB/31 h), `POST /mcp` (24 KB avg,
112 MB), `/api/projects*` (95 MB), wasm 6.3 MB, glb models. Host nginx was Debian stock: `gzip on`
only, no `gzip_types`/`gzip_vary`, no brotli module, no `http2 on`.

Code fix 9b54ac14 (deployed 2026-10-14 08:11 UTC, verified: wasm 1060019 B br, fire.glb 236570 B br): wasm/glb/ttf/svg/cjs precompressed; server serves any `.br` sibling.

nginx fix applied BY THE OWNER 2026-10-14 07:48 UTC (the classifier refuses my remote writes: apt, /etc/nginx). Script
(vhost-scoped gzip+brotli level 5 for JSON/XML/JS/SVG/wasm, `http2 on`, no compression on
`/api/tokens`, `/api/admin/invitations`, `/oauth/` for BREACH, `text/event-stream` left out,
`nginx -t` with automatic restore) validated in a debian:trixie container. Full /etc/nginx backup:
`/root/nginx-backup-2026-10-14.tgz`.

**Why:** the JSON API and MCP were the bulk of the bytes and nothing compressed them.
**How to apply:** before re-auditing, curl `https://atoma.run/api/...` with `Accept-Encoding: br`
and check `content-encoding`; if still identity the owner has not run the script. Verified live after reload: h2, br/gzip + Vary on HTML/XML/JSON, a Claude Code MCP call
(2025 era = SSE) still 14 KB identity. SSE compression tested in trixie: frames not delayed; text/event-stream
added by the owner 07:53 UTC (my first sed script exited early: its idempotence grep matched the
comment). Even then Claude Code (14352 B, same as before) and codex-mcp-client MCP POSTs stayed
identity size, although nginx compresses SDK-shaped SSE (no-transform ignored) in the container:
PROVEN 08:02 UTC by /var/log/nginx/atoma-encoding.log (owner-added log_format: ae=/ce=/ct=/ua=,
$uri only, no auth): claude-code 2.1.296 sends `Accept-Encoding: identity`, codex-mcp-client
0.155 sends none. Server side is done; only the clients can change it. Old nginx workers
from 2026-10-13 12:20 stay 'shutting down' across reloads, holding long MCP streams. See [[public-domain-atoma-run]],
[[push-to-prod-authorized]].

Follow-up a55c694d (2026-10-14): the Runs view polled the full platform `/api/runs` every 2 s and each
call re-parsed all 712 traces (471 MB) + one audit query per row. Now: settled-trace row cache in
`runIndex.ts`, body-hash weak ETag + 304 on `/api/runs`, `/api/projects`, project runs (client holds the
validator; `no-store` kept), runs poll 2 s live / 5 s idle, audit once per org. Pagination of the
admin `/api/runs` is the remaining structural fix (not done).
Then (same day, owner asked): 8df9ef65 removed the MUI client entirely (owner: "super legacy, never
used"); 3d5575aa paged `/api/runs` (limit 50 default/200 max, position cursor `before`, `projectId`),
GPU picker = infinite pages + selected project read whole; a 304 body must be DRAINED or Chrome logs
the fetch as ERR_ABORTED (caught by `npm run viz:smoke`, which passed after the fix).
