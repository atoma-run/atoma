# Serialized OAuth renewal for Codex on macOS

When several Codex connections share an OAuth grant, a stale refresh token can
revoke the entire grant. Atoma intentionally retains refresh rotation, replay
revocation, one-hour access tokens, absolute grant expiry and live permission
checks. This client-side helper coordinates renewal without changing the server.

`scripts/atoma-codex-auth.py` supports Codex's `http_headers_helper` setting.
Install a private copy in a stable directory outside the checkout and run its
`login` command. It opens Atoma consent for a **separate OAuth grant**, using
S256 PKCE, state, a loopback callback and issuer checking. Secrets live only in
the macOS Keychain entry `run.atoma.codex-oauth.v1`; the local state directory
`~/.atoma/codex-auth` contains a process lock, not credentials. Never run the
`headers` command in a visible terminal: its stdout is intended only for Codex.
The `status` command prints expiry and state without credentials.

After successful login, remove Codex's old native OAuth credentials with
`codex mcp logout atoma` and configure the existing server:

```toml
[mcp_servers.atoma]
url = "https://atoma.run/mcp"
http_headers_helper = "/usr/bin/python3 /absolute/private/install/auth.py headers"
startup_timeout_sec = 45
```

Keep other server settings. Explicit bearer or saved native OAuth credentials
have precedence over helper headers, so do not run `codex mcp login atoma` again
while this helper owns renewal. Reconnect using the helper's `login` command.
Reload the MCP connection after changing its configuration. Existing clients
holding the old grant cannot revoke the helper's separate grant.

If disconnects return, check whether the desktop's **Connect** action recreated
native OAuth credentials. That action can override the helper without removing
`http_headers_helper` from the configuration: the configuration still looking
correct does not prove that the helper owns authentication. If the helper's
`status` is ready, remove only the competing credential with
`codex mcp logout atoma`, then verify native tool discovery through the helper.
Do not click the native OAuth Connect action again to repair this connection.
An expired or uncertain helper grant instead requires the helper's own `login`.
Never print `headers` output to diagnose either case.

The helper takes an OS file lock and **rereads Keychain state after acquiring
it**. Only an expiring access token triggers a refresh. It persists a renewing
marker before the request: after a crash, timeout, rejected grant, malformed
response or failed persistence, it fails closed and requires a new login rather
than replaying a potentially consumed credential. It neither retries a token
exchange nor follows a redirect at a credential endpoint. It never silently
switches to a static token. Absolute server expiry and revocation still require
a deliberate reconnect.

Verify the helper with `python3 tests/test_atoma_codex_auth.py` (also invoked by
the Vitest suite when Python and POSIX locks are available). Tests use fake
credentials only and exercise concurrent processes, process death, uncertain
responses, expired/revoked grants, private locking and endpoint redirects.
A native-client integration check must additionally prove that the installed
Codex version reruns the helper after a 401 and discovers the tools with the
updated header. Do not assume configuration parsing proves this behavior.

To revert, remove `http_headers_helper`, run `codex mcp login atoma`, and revoke
the dedicated helper grant in Atoma's token settings. Deleting a local Keychain
entry alone is not server-side revocation.

[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
