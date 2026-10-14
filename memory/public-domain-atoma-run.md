---
name: public-domain-atoma-run
description: atoma.run is the live public domain since 2026-09-06 (DNS, nginx+certbot, ATOMA_VIZ_PUBLIC_ORIGIN, GitHub deploy vars all switched); previews need a second registrable domain
metadata:
  node_type: memory
  type: project
  originSessionId: 952555ab-800d-4cc8-ac10-e737f4ffdaab
  modified: 2026-09-06T09:47:05.144Z
---

The user bought `atoma.run` on 2026-09-06 and declared it the single public
domain of the product. Repo placeholders (`atoma.example.com`) were replaced by
`atoma.run` in `.env.example`, deployment/preview docs, the MCP address, the
`MendRequest` example and `package.json` homepage the same day.

Cutover completed 2026-09-06: DNS A -> 46.225.4.14 (Hetzner VPS debian-4gb-nbg1-1), nginx vhost + certbot, `ATOMA_VIZ_PUBLIC_ORIGIN=https://atoma.run`, GitHub `production` variables switched, platform-admin login verified on atoma.run. The old name atoma.iotanet.net was meant to redirect (301), but on 2026-10-14 its nginx vhost still proxies to 4111 and `/` answers 200. Repo commit 20da806 on main.

**Why:** one exact origin is a hard contract in this codebase (auth cookies,
OAuth redirect, MCP host pinning, SEO canonical); changing it is a coordinated
operation, not a DNS flip.

**How to apply:** never suggest `previews.atoma.run` — previews are refused at
boot under the visualizer's registrable domain; a second domain must be bought.
Check whether the cutover happened before assuming which hostname is live.
See [[mcp-one-surface]] and [[supervisor-mender-state]].
