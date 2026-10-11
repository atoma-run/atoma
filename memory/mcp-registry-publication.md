---
name: mcp-registry-publication
description: atoma is listed in the official MCP Registry as run.atoma/atoma (published 2026-09-30); how to republish on a version bump
metadata:
  node_type: memory
  type: reference
  originSessionId: 56b05e49-ebf1-4e72-bf9d-fc1b5ba7ebcf
  modified: 2026-09-30T16:10:33.364Z
---

Published 2026-09-30: `run.atoma/atoma` v0.4.0, status active, at
`https://registry.modelcontextprotocol.io/v0.1/servers/run.atoma%2Fatoma/versions/latest`
(the `?search=` endpoint timed out that day; the by-name lookup works).

- `server.json` at repo root; `tests/mcp-server-json.test.ts` pins its version to package.json.
- Proof of domain: DNS TXT at the apex of atoma.run (Gandi DNS, beside the SPF record):
  `v=MCPv1; k=ed25519; p=PTa/f7Afbqi4eRuvWoHEr1jiQJUcJDL5xS22OyhH0PM=`.
- Private key in WSL: `~/.config/atoma/mcp-registry.pem` (0600). Publisher: `~/.local/bin/mcp-publisher`.
- Republish (each package.json version bump): in WSL, checkout GitHub main in `~/dev/atoma-platform`
  (its `origin` is the Windows checkout, so fetch `https://github.com/mgtf/atoma.git main`), then
  `mcp-publisher login dns --domain atoma.run --private-key <hex from openssl pkey -text priv:>` and `mcp-publisher publish`.
  A version already published cannot be republished.

Related: [[mcp-two-eras]], [[public-domain-atoma-run]].
