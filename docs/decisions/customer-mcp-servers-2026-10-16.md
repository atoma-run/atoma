# Customer MCP servers in runs — decision and contract, 2026-10-16

Owner request, 2026-10-16: an organisation connects its own MCP servers in
Settings, makes each available per project in Project settings, and a run
uses an available server when it judges it useful. Two owner choices made
the same day: OAuth is supported from the first version (beside a static
secret header), and every tool of a connected server is enabled by default,
with an organisation admin able to switch individual tools off.

## Shape

| Layer | Owner | What it holds |
|---|---|---|
| Organisation connection | `src/connectors/store.ts` (`org_mcp_servers`) | name, HTTPS URL, auth kind, encrypted secret material, discovered tool list, disabled tools |
| Project availability | `src/connectors/store.ts` (`project_mcp_servers`) | which of the organisation's connections a project's runs may use |
| Launch | `src/projects/coordinator.ts` → `ATOMA_MCP_CONNECTORS` | the connections available to this run, with a usable credential |
| Run | `src/tools/mcpConnectors.ts` | two host elements, `list_mcp_tools` and `call_mcp_tool` |

### Two fixed elements, not one element per customer tool

Element invocation names are immutable wire contracts, positional element
identities, members of the closed tool vocabulary, and are persisted on atom
types in the shared registry. A customer's tool names are none of those
things, and a registry row carrying `linear_create_issue` would leak one
organisation's tool into another's catalogue. So a run gets two host elements
appended to `HOST_TOOL_NAMES`:

- `list_mcp_tools` — the servers this run may use and their enabled tools,
  with descriptions and input schemas, bounded.
- `call_mcp_tool {server, tool, arguments}` — one call, bounded.

Like `search_project_docs`, both are intercepted on the HOST side of the run
(`withMcpConnectorBackend` around the worker executor). The worker container
never sees a URL, a header or a token, and its `network none` is unchanged.

### Who gets them

A canonical molecule, `bootstrap-canonical-connectors`, holds the file-scribe
scope plus both elements, exactly as the project-docs molecule holds search.
Its capability line and prompt name the servers available to the run, so the
planner routes work there when a server is useful and nowhere else. The root
tissue receives the run's host tools as it does today, so a child it creates
may name them in its seed (`scopeTools` narrows, never widens). A run whose
project enables nothing has neither element and the molecule loses them on
refresh, as the project-docs molecule loses search.

### Credentials never reach the run process's disk or the container

- Header secrets and OAuth material are AES-256-GCM envelopes
  (`src/core/secretCrypto.ts`) under the operator's secret-encryption key,
  bound by AAD to `(orgId, serverId, field, keyId)`.
- The coordinator (inside the server process) resolves, at launch, the
  connections the project enables: it decrypts a header secret, or refreshes
  an OAuth access token that would expire before the run's deadline, and
  hands the run process ONLY a bearer/header value in its allowlisted
  environment — the same channel organisation provider keys already take.
  The refresh token never leaves the server process, so a rotating refresh
  token has exactly one writer. Refreshes of one connection are serialised.
- A connection that cannot produce a credential (OAuth never completed,
  refresh refused, encryption key absent) is passed as UNAVAILABLE with its
  reason, never silently dropped: `list_mcp_tools` says so, and the molecule
  can report it instead of concluding the server has nothing.

### Every call is re-authorised

Before each `call_mcp_tool`, the run process re-reads (read-only) whether the
project still enables the connection, whether the tool is still enabled and
whether the connection still has the URL the run was launched with. An admin
who switches a server or a tool off, or points it elsewhere, stops the next
call of a run in flight.

### A change is made once per run

A call that may change the organisation's system (any tool its server does not
mark `readOnlyHint`) is made once per run with the same arguments: a repeat is
refused as `duplicate` with the earlier result, including after a timeout,
whose effect is unknown. The memory belongs to the run, so a deepening restart
or a remediation pass sees what the first attempt changed, and
`list_mcp_tools` reports those changes. A comparison rerun receives no server
at all: it re-runs another run's goal. The tool list a run sees is the server's live
`tools/list`, filtered by the disabled set; the discovered snapshot stored on
the connection is for Settings only.

### The one outbound request

`src/connectors/guardedFetch.ts` is the only code that sends bytes to a
customer URL — the MCP transport, OAuth discovery, dynamic client
registration and the token endpoint all receive it as their `fetch`. HTTPS
to a DNS name only (an IP literal never reaches the lookup, so it is refused;
any port), every resolved address public and not this machine's own,
checked in the socket's own lookup (`guardedLookup`, shared with the client
metadata fetch), `agent: false`, bounded body and time. It follows no
redirect; the SDK may re-issue a same-origin 307/308, which comes back
through the same checks.

### OAuth

Atoma is an OAuth 2.1 public or confidential client of the customer's
authorization server, through the MCP SDK's `auth()` (RFC 9728 discovery,
RFC 8414 metadata, RFC 7591 dynamic registration or a pre-registered client
id and secret, S256 PKCE, RFC 8707 resource). The redirect URI is fixed:
`${ATOMA_VIZ_PUBLIC_ORIGIN}/api/org/mcp-servers/oauth/callback`. A pending
authorization is memory-only, expires in ten minutes, and is bound to the
browser session, principal, organisation and connection that started it; the
callback refuses any other. Tokens are stored encrypted; the access token's
expiry is recorded so launch knows when to refresh.

### Doors and authority

- Settings → **MCP servers** (`org:admin`+, or platform admin in the active
  organisation) adds, edits, removes, connects (OAuth), refreshes the tool
  list and switches tools on and off. Members and viewers read names, hosts,
  status and tools, never URLs' paths or queries (a secret-path URL is a
  credential), never secret material.
- Project settings → **MCP servers** (`org:admin`+) enables connections for
  the project, with stale-write protection as the deployment preference has.
- Journal: `org.mcp_server_added`, `org.mcp_server_updated`,
  `org.mcp_server_removed`, `org.mcp_server_authorized`,
  `project.mcp_servers_changed` — never secret material. Exposure decisions
  are `security` severity, as the showcase and upstream changes are.

### Supervision

Verification stays read-only: validators and root acceptance never call a
customer tool, and nothing replays one — it may have effects outside Atoma.
A connector result is untrusted data, carried in the trace like a fetched
page, and is not attested proof of a deliverable. A molecule that needs a
connector's data in the delivery writes it to a workspace file.

### Launch is bounded

Every connection of a launch is resolved together within 30 seconds and with
the preparation's cancellation; one that cannot be is handed over as
`unreachable`. Only the server process refreshes tokens: the operator CLI's
coordinator hands over a still-valid token or none, so a rotating refresh
token keeps one writer. Every tenant run carries the two elements, with
servers or none, so the shared connector molecule's tool set never flips
between concurrent runs.

## Open, for the owner

- A read-only phase (a sequential phase that declares no outputs) is
  restored on the WORKSPACE only. A change it makes through a server stays.
  The runtime guidance says so and asks for changes only in the phase whose
  task asks for them; nothing refuses a write mechanically there, because a
  phase whose whole job is an external change ("open the ticket") declares no
  file output either. Refusing non-read-only tools in read-only phases is a
  product choice.
- The skills commons (owner decision 2026-09-15) learns from connector runs
  like any other: a recipe may name a server identifier or a tool. It carries
  no credential and is useless to an organisation without that server, but
  the server's data the molecule saw may appear in what is distilled. Keeping
  connector executions out of learning is a product choice.

## Rejected

- One element per customer tool: see above.
- stdio servers: a command chosen by a tenant would run on the control plane.
- Handing the run process the refresh token or the encryption key: two
  writers of a rotating token, and a key that opens every organisation's
  secrets in a process that runs model-chosen work.
- Letting validators call connectors to check a claim: verification is
  read-only and a customer tool may write.
- Following redirects: the Authorization header would go to a host the
  organisation never named.
