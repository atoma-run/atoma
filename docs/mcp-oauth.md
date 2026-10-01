# MCP browser authorization

Atoma acts as both the OAuth authorization server and the resource server for
its canonical `/mcp` URL. The existing GitHub/Google/ChatGPT web login proves
identity; its upstream credentials are never passed through to an MCP client.
OAuth is available only on an authenticated deployment, using its configured
public origin. The local ungated MCP remains unchanged.

## Client connection

Register the URL in Codex, then use `codex mcp login atoma` or the client's
OAuth authentication control. Remove any configured bearer environment variable
or static Authorization header when migrating: explicit credentials take precedence.
The browser signs into Atoma if needed, then displays the requesting client,
account, active organisation, return address and permission implications. The user
must explicitly approve. Denial returns `access_denied` with the client's state.

Use **Use another account** on that page to sign this browser out of Atoma,
choose a provider account, and return to a new consent page. The original
request is invalidated; switching neither grants access nor revokes existing
MCP connections. The new consent shows the account's provider identity,
organisation and role. The original expiry and client callback are preserved.
The provider receives `prompt=select_account` to request its account picker
([GitHub documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).

The client name is self-declared, not a verified brand. Consent includes the
caller's current MCP rights, including platform administration when applicable.
Changing active organisation does not move an already-issued grant. Revocation
is available in the existing MCP token list as `OAuth: <client>` and through the
OAuth revocation endpoint. Membership and platform flags are resolved on every
MCP request, exactly as for manually minted API tokens.

## Diagnosing a run through MCP

`atoma_run_trace` accepts the project `runId` (or an operator `file` at the
platform tier). Its default summary pages events with `offset`, `limit` and
`nextOffset`, including recorded durations, acceptance decisions and excerpts.
For the evidence behind those summaries, use the same tool:

- `section: "metadata"`: all persisted top-level trace fields except events,
  including the task, final error/result, attestations and execution provenance.
- `section: "event", eventId: "<id from summary>"`: the complete event,
  including prompts, responses, validation reasons, tool arguments/results,
  usage and durations when recorded.
- `section: "log"`: the project runner log, even before a trace exists.
  This section requires `runId`, not an operator filename.

Detail replies contain JSON-encoded `text`, a `snapshot` hash and
`nextTextOffset`. Concatenate successive text pages, passing the returned
`nextTextOffset` as `textOffset` and the same `snapshot`, then parse the joined
JSON. Offsets count UTF-16 code units. Pages default to 12,000 characters and
cap at 24,000; nothing is silently truncated. If `changed: true` is returned,
restart at offset zero because the selected evidence changed during the read.
Missing/expired files and files beyond the shared trace read ceiling are
reported explicitly. The normal organisation and platform read permissions
apply to every section; all model-authored content remains untrusted data.

New traces record the executable release's `REVISION` receipt, or the exact
checkout's Git HEAD and dirty state during development, plus the Node runtime
and platform. A missing receipt/checkout is unknown. Old traces are never
backfilled with the revision of the server reading them today. Provenance
identifies the runner, not the generated application's publication commit.

## Wire contract

- `/.well-known/oauth-protected-resource/mcp` (also root fallback): resource,
  authorization server and the `mcp` scope. Unauthenticated `/mcp` responses
  include this URL in `WWW-Authenticate`.
- `/.well-known/oauth-authorization-server`: endpoints, public-client
  authentication (`none`), authorization code/refresh grants, S256, issuer
  identification in the authorization response, and
  `client_id_metadata_document_supported`.
- Client ID Metadata Documents (the 2026-07-28 spec's preferred registration,
  since 2026-09-30): a `client_id` that is an HTTPS URL on a DNS name, the
  default port and a real path, in canonical form, is read from that URL at
  every authorization request (`src/auth/clientMetadata.ts`). The document
  must name exactly that `client_id`, a `client_name`, allowed redirects, and
  no client authentication but `none`. The fetch connects only to public
  addresses that are not this machine's own — checked in the socket's own
  lookup, every address of the answer, resolved with c-ares so a silent
  nameserver cannot hold libuv's thread pool — goes through no proxy
  (`agent: false`), follows no redirect, reads at most 5 KiB within 5 s and
  never targets this server's host. An anonymous GET can trigger it, so it is
  bounded to 5 fetches a minute per client address, 30 for the process and 4
  at once, and concurrent requests for one id share one fetch. A document is
  cached for its `max-age` clamped to 5 min–24 h and served past it while a
  new fetch cannot be read; a document that now says something else is
  refused for a minute. Only a consent that issues a code writes the client
  row the token, refresh and revocation endpoints read — metadata clients
  have their own cap (2,000) apart from registrations and last as long as the
  grant can be renewed. A withdrawn document takes effect at the next
  authorization; an issued grant runs its course. Consent shows the document
  URL whole (a domain alone would vouch for anyone publishing on a shared
  host) and warns when the connection returns to loopback.
- `/oauth/register`: bounded RFC 7591 public-client registration, HTTPS or HTTP
  loopback redirects, no wildcard matching. Registration lasts 90 days.
  Deprecated by the 2026-07-28 spec and kept for the clients that use it
  (Codex among them).
- `/oauth/authorize`: code flow only, exact registered redirect except for the
  HTTP loopback port ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252#section-7.3):
  desktop clients choose a free port), S256 PKCE,
  canonical resource, optional `mcp` scope. Five-minute pending requests; a
  same-origin consent POST is bound to the displayed browser session and org.
- `/oauth/token`: form-encoded exchange or refresh, bound to client and resource.
  The code exchange requires the exact redirect used at authorization, including
  its chosen loopback port. Codes last five minutes; access tokens one hour;
  refresh authorization 30 days absolutely. A refresh rotates both credentials. Reuse of a correctly bound
  redeemed code or refresh token revokes the grant.
- `/oauth/revoke`: RFC 7009, client-bound access or refresh token, generic success
  for unknown credentials. Existing Settings/CLI revocation also blocks refresh.

Redirect targets are never fetched by the server; the metadata document is the only client-chosen URL it reads. Metadata uses the configured
origin, never forwarded request headers. Browser consent sends no cross-origin referrer and
cannot be framed. Its form policy permits the registered callback origin so a
desktop client's separate loopback port can receive the consent redirect.
Protocol bodies, registrations, pending requests and public
request rates are bounded. Stateful authorization GETs observe deployment drain.

## Persistence and verification

`auth_mcp_clients`, `auth_mcp_codes`, `auth_mcp_grants` and `auth_mcp_refresh`
are additive tables in the primary SQLite store. The existing `auth_api_tokens`
row owns each grant and its revocation. Only hashes of codes/access/refresh
credentials persist. Consumed refresh hashes remain until grant expiry or
revocation so replay can revoke the current generation. The existing auth sweep
prunes expired protocol state. No new secret-encryption key or product store is
required. Existing API tokens retain their current behavior.

Wire tests exercise consent, client/resource/PKCE binding, replay, rotation,
expiry, live roles and revocation. The process-level auth test follows upstream
login back to consent; the auth release smoke exchanges OAuth credentials and
calls a real MCP reader on the compiled server. `npm run viz:smoke` also submits
the real consent form in Chrome and exchanges its code, verifying browser Origin
behavior. No test starts a paid run.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591),
[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009),
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
