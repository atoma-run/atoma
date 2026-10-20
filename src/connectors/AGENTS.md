# Connectors — AGENTS.md

`src/connectors/` owns an organisation's own MCP servers: the connection
store, Atoma as their OAuth client, the one outbound request to a customer
URL, the launch hand-off to a run and the run's sessions to them.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/tools`](../tools/AGENTS.md) — the two host elements a run calls them through
- [`src/projects`](../projects/AGENTS.md) — the coordinator that hands a run its servers
- [`src/viz`](../viz/AGENTS.md) — the Settings and Project settings doors
- [`src/mcp`](../mcp/AGENTS.md) — Atoma's OWN MCP server; nothing here is part of it

Decision of record:
[docs/decisions/customer-mcp-servers-2026-10-16.md](../../docs/decisions/customer-mcp-servers-2026-10-16.md).

## The shape

- An organisation CONNECTS a server once (`org_mcp_servers`, Settings → Your
  MCP servers, `org:admin`+), and a project ENABLES it
  (`project_mcp_servers`, Project settings, `org:admin`+, compare-and-set on
  the set the editor saw). Removing a connection removes every project's
  availability of it in the same transaction. Both tables live in the
  primary product store; their foreign keys are enforced.
- A run reaches them through two FIXED host elements, `list_mcp_tools` and
  `call_mcp_tool` ([src/tools](../tools/AGENTS.md)), never one element per
  customer tool: element names are wire contracts, positional identities and
  members of the closed vocabulary, and they are persisted on atom types in
  the SHARED registry. For the same reason no persisted prompt names a
  server: the run's servers reach planners as the task input
  `availableMcpServers` (identifier, name, availability — no URL, no
  credential), read with `MCP_SERVERS_GUIDANCE`
  ([src/atoms](../atoms/AGENTS.md)).
- The canonical molecule `bootstrap-canonical-connectors` holds the
  file-scribe scope plus both elements, and loses them in a run without
  servers, as the project-docs molecule loses search. The root tissue gets
  them through the run's host tools; a child it creates may keep them
  (`scopeTools` narrows).
- `ConnectorService` is the ONE body every door calls: role checks,
  organisation scoping and journal rows (`org.mcp_server_added`,
  `_updated`, `_removed`, `_authorized`, `project.mcp_servers_changed`,
  never a URL path, header or token). Do not re-check a rule in a door.

## Secrets

- A header value, an OAuth client secret, a dynamic registration and tokens
  are AES-256-GCM envelopes (`src/core/secretCrypto.ts`) under the operator's
  secret-encryption key, with an AAD binding the organisation, the
  connection, the field, a digest of the URL and the key id. A row copied to
  another organisation or pointed at another URL behind the store's back
  does not decrypt. Without the key, only unauthenticated servers can be added.
- Secrets are WRITE-ONLY: no route, view or journal row returns one. Members
  read names, hosts, status and tools; only managers see the URL, because a
  path may itself be a credential.
- A changed URL, auth kind or client id forgets every credential,
  registration, discovery state and tool list of that connection, and every
  OAuth write is guarded by the URL it was obtained for: a token minted for
  one server is never presented to another.

## The one outbound request

- `guardedFetch.ts` is the only code that sends bytes to a customer URL: the
  MCP transport, OAuth discovery, registration and the token endpoint all
  receive it as their `fetch`. HTTPS only (any port), every resolved address
  public and not this machine's own, checked in the socket's own lookup
  (`guardedLookup`, shared with `src/auth/clientMetadata.ts`), `agent: false`
  (a proxy agent would resolve the name itself), a DNS name only (an IP
  literal never reaches the lookup: the review of 2026-10-16 connected to
  127.0.0.1 through one), no redirect followed by this fetch (the SDK may
  re-issue a same-origin 307/308, which comes back through every check),
  bounded body and time. `loopbackForTests` is a constructor option that no
  configuration can reach.

## OAuth

- Atoma is a client of the customer's authorization server through the SDK's
  `auth()`; `RowOAuthProvider` reads and writes the row. Redirect URI fixed
  at `${ATOMA_VIZ_PUBLIC_ORIGIN}/api/org/mcp-servers/oauth/callback`. A
  pending authorization is memory-only (dies on restart), expires after ten
  minutes, is consumed by its first callback whatever happens, and is bound
  to a digest of the browser session token, the principal and the
  connection; the callback refuses any other. An authorization endpoint that
  is not HTTPS is refused before the browser is sent there.
- "Authorize" always asks the person (stored tokens are ignored), so a broken
  refresh token cannot hide behind a silent refresh.

## Launch

- The coordinator asks `launchFor(orgId, projectId, validUntil)` in the SERVER
  process during preparation, with the run's own budget as horizon, and
  writes `ATOMA_MCP_CONNECTORS` into the child's allowlisted environment —
  the channel organisation provider keys already take. The child receives an
  ACCESS header only: the refresh token never leaves the server process,
  which owns rotation. The primary-store credential mutex serializes refresh
  and interactive authorization across web and executor generations; each
  refresh re-reads the row after acquisition. OAuth discovery/registration/token
  exchange share a 60-second deadline, within the web shutdown grace.
- Best effort past a token's lifetime: a server whose tokens live an hour
  cannot cover a two-hour run, so the freshest token still valid is handed
  over and an expiry mid-run surfaces as `unavailable` on a call. A token
  obtained in the last minute is not refreshed again.
- Every connection of a launch is resolved together, within 30 s and the
  preparation's cancellation: launch holds the organisation's run slot. A
  comparison rerun gets none (it would repeat its origin's changes). Only the
  server process refreshes: the operator CLI hands over a still-valid token
  or none (`refreshTokens: false`).
- An interactive authorization never invalidates the stored tokens or
  client: a failed second "Authorize" (an expired code, a registration
  another admin replaced) leaves the working credential in place.
- A connection without a usable credential is handed over as `unavailable`
  with its reason, never dropped: the molecule reports it instead of
  concluding the system holds nothing. A resolver failure starts the run
  without servers and is logged; a connector never blocks a run.
- The runner reads the variable once, refuses it outside a tenant project
  run or for another project, and DELETES it from its own environment before
  anything else is spawned ([src/run](../run/AGENTS.md)).

## The run's sessions

- `runtime.ts` opens one session per server on first use, reused for the
  run; a protocol answer (`McpError`) keeps it, a transport failure drops it
  and the next call reconnects. Sessions belong to the RUN: a deepening
  rebuilds the backend over the same service, and the runner disposes it once
  at teardown.
- Before EVERY call the run asks the store, read-only, whether the project
  still enables the server, whether the tool is still enabled and whether the
  connection still has the URL the run was launched with
  (`openConnectorAuthority`): an admin's switch stops the next call of a run
  in flight.
- A call that may change data (no server `readOnlyHint`) is made ONCE per run
  with the same arguments, timed-out calls included; a repeat is refused as
  `duplicate` with the earlier result. The memory is keyed by the run's
  service, so it survives a deepening's new backend.
- EVERY tenant run carries both elements, an empty service when its project
  enables none: the shared molecule's tool set must not flip between
  concurrent runs (a flip resets its trust and strips the elements from a run
  that has servers).
- What the model and members read about a failure says what kind it was
  (`describeConnectorError`), never a URL, path or response body. `list_mcp_tools` lists the live `tools/list` minus disabled
  tools; the snapshot on the row is Settings' display only.
- Verification stays read-only: no validator, acceptor or replay calls a
  customer tool, which may write. A connector result is untrusted data and
  never attested proof; a molecule that needs it in the delivery writes it
  to a workspace file.

## Intentional choices and rejected shortcuts

- One element per customer tool (`linear_create_issue`): refused. It would
  persist one organisation's tool names in the shared registry, fall outside
  the closed vocabulary and the periodic identities, and change the tool
  list a molecule is cached and trusted on with every Settings edit.
- stdio servers: refused. A command chosen by a tenant would execute on the
  control plane.
- Handing the run process the refresh token or the encryption key: refused.
  Two writers of a rotating token lose the authorization at the first race,
  and the key opens every organisation's secrets in a process that executes
  model-chosen work.
- Following redirects "because discovery documents move": refused. A
  redirect is reported as a status; the Authorization header must never
  reach a host the organisation did not name.
- Letting validators call a connector to check a claim: refused, as every
  supervisor replay of model-authored effects is.
- Refusing writes in read-only phases, and keeping connector executions out
  of skill learning: not built, owner choices recorded in the decision.
- Refusing a connection whose token cannot outlive the run: refused. The
  run would lose a server that works for the first hour; the expiry is
  reported where it happens.
