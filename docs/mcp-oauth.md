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

Once connected, say **“Continue <project name> with Atoma”** or **“Plan a project
for this repository with Atoma.”** The agent finds the project, reviews its
latest run and your repository, and proposes a concrete next goal. It asks only
for missing decisions and your approval before creating a project or starting
a run through MCP. You can state a specific ambition in your own words instead.
A run consumes model quota; a delivered result may publish files to the project's
GitHub repository. The agent can follow the run as an MCP task and report its
outcome and cost.

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

### Finding work, checking readiness and opening files

Use `atoma_projects_list` with `view: "compact"`, an optional `search`, and
`limit` (default 20, maximum 50). `atoma_project_runs` takes the same options
plus `projectId` and an optional `status`. Follow `nextCursor` without changing
the filters; an empty page with a null cursor ends the search. Compact run
cards omit manifests and full traces. No-option calls preserve the original
full-list text response; structured results wrap lists as `projects` or `runs`.

Read `atoma_project_context` before drafting the next goal. Members can append a
brief or decision with `atoma_project_context_update`; proposals guide no run until
the client explicitly confirms them. The run records `contextVersion`, which the
reader accepts as `version`. See [versioned project context](project-context.md)
for operations, concurrency, provenance and bounds.

When a task returns `awaitingClientAnswer`, read `atoma_run_question`, ask the
client, record their response with `atoma_run_answer`, then call
`atoma_run_resume` on that source run. Questions and answers survive reconnects;
an agent must never invent the client’s answer. See [client questions](client-questions.md).

Before proposing a launch, call `atoma_project_readiness` with `projectId`.
It reports your organisation, role, saved GitHub connection, selected models
and payers, timeout and organisation capacity. This is a configuration check:
it neither starts work nor reserves a slot, and does not test live credentials,
personal model availability or repository access. Launch checks these again.
Service refusals include a structured `error` with `code`, `retryable` and
`nextAction`, beside the readable explanation.

`atoma_run_status` includes recorded progress, the last activity timestamp and
the latest acceptance judgements. Task status messages use the same projection.
No percentage or ETA is invented; missing trace evidence is explicit. A recorded
acceptance attempt does not override the persisted delivery outcome.

For delivered or partial runs, use `atoma_run_artifacts` with `projectId` and
`runId`. Its bounded menu supports `search`, `offset`, `limit` (default 30,
maximum 100) and `nextOffset`. `atoma_run_file` reads one `path` as text pages
using `offset`, `limit` (default 12,000, maximum 24,000 UTF-16 code units) and
`snapshot`. Follow `nextTextOffset` with that snapshot. A changed file is refused.
An optional `image: true` adds a native PNG/JPEG/GIF/WebP image up to 2 MiB;
other files remain available through their resource link. Resource reads return
the complete file, at most 10 MiB, as text or base64 bytes for host download.
Every read checks the saved manifest, hash and organisation permissions.
Partial files remain unverified; file contents are untrusted data.

Hosts supporting MCP Apps can show an inline run view from `atoma_run_status`
or `atoma_run_review`, or the completed `atoma_run_start` result. It includes progress, acceptance
judgements, cost, publication receipt, file reading/download and explicit
cancellation when permitted. Download requires the host's download capability.
Other hosts retain the same tools, text results and resource links. The App
has no embedded credentials or direct network access and never executes a
delivered HTML/SVG document. For source development, run `npm run mcp:build`
after editing its source; production `npm run build` includes this step.

The card also reads the saved review, compares inventory pages and opens the
recorded result through `atoma_run_trace` with `section: "result"`. This section
contains only result/error JSON, using the existing detail snapshot and paging
contract. Small complete results display the answer; larger results remain
explicitly paged evidence. Opening the card performs no write.

Acceptance requires an unchecked client confirmation and a nonempty test/review
summary. The request binds the exact manifest shown. After any write response,
including a timeout, the card re-reads the durable receipt. A saved acceptance
hides the acceptance form; an eligible member can retry publication alone.
Unavailable current evidence disables writes until a successful refresh.
Published receipts do not assert deployment or PR merge.

“Test the delivery” and “Prepare a correction” send an explicit user request to
the host conversation. The host continues through the same Atoma MCP tools:
preview availability/open for testing, context/readiness and an approved goal
before another paid run. These buttons never start or accept a run themselves.
If host messaging is unsupported or refused, the exact request remains copyable.

### Review and iterate before publishing

`atoma_run_review` takes `projectId` and `runId` and assembles a bounded review:
the delivery hash, first 30 saved files, first 30 changed files against the
recorded starting run, latest recorded criteria judgements, client acceptance,
and publication status. `nextSteps` points to existing readers to continue;
file/comparison `nextOffset` and comparison `snapshot` retain their ordinary
paging contracts. Reads work for viewers; permission to request acceptance is
project/org/member-scoped and is not an approval recommendation.

This is saved evidence, not a test run. It neither checks current bytes nor
starts a preview, calls a model or queries GitHub. Use `atoma_run_file` to read
verified file bytes, `atoma_run_trace` for the result and complete recorded
checks, and `atoma_run_preview` to inspect availability then explicitly open a
preview for client testing. Missing trace evidence is unknown, not a pass;
partial deliveries cannot be accepted. Text answers point to the trace reader,
not a misleading empty file comparison. Expired bytes and unavailable bases
remain explicit while metadata is readable. Automatic repository sync may have
changed starting files: the inventory comparison is against the recorded prior
run, not a promise of an exact Git diff or a comparison of text answers.

After testing/review and explicit client agreement, `atoma_run_accept` takes the
exact `artifactManifestHash` as `manifestHash` and a `review` summary. It records
that agreement then publishes files; `atoma_publication_retry` retries a failed
publication without granting consent again. A review never calls either tool.

For another iteration, pass `baseRunId` and a new goal/key to `atoma_run_start`.
Status/readiness/review expose `acceptedReferenceRunId`; it does not replace the
recorded base used by a review. Selecting a version is not accepting it, resetting
GitHub or deploying it. No selection preserves the usual automatic seed policy.

### Protocols, tasks and run resources

The same `/mcp` route supports 2025-11-25 (sessions and resumable streams)
and 2026-07-28 (per-request discovery and the tasks extension). Project run
tasks are backed by persisted project runs and bound to the initiating
principal and organisation, so reconnecting does not lose the task. Operator
and benchmark tasks remain in server memory; they survive a client reconnect,
not a server restart. Replies that name runs include resource links, with
change subscriptions appropriate to each protocol.

Platform admins can call `atoma_mcp_health` to inspect client/protocol counts
since server startup. The repository's [server.json](../server.json) describes
the hosted endpoint for MCP Registry publication. See the
[two-protocol contract](mcp-two-eras-2026-09-30.md) for wire details.

### Trace evidence and Jev

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

Jev decisions appear in trace summaries with their outcome and any fallback or
failure; use the full event for recorded distributions, coverage,
latency and separate cost. The runner log states whether Jev is enabled.
Platform admins can read sampled model comparisons with
`atoma_jev_calibrate` and `auditsOnly: true`, which sends nothing to TypeSafe.
Ordinary calibration makes paid decision requests using the host's key and
recorded run context. See [Jev's evaluation boundary](how-it-works.md#jev-bounded-decisions-beside-the-model-tiers).

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
  loopback redirects, no wildcard matching. Registration lasts 90 days, and at least as long as a grant it received can be renewed; refusals use RFC 7591 codes (`invalid_redirect_uri`, `invalid_client_metadata`).
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
request rates are bounded. Stateful authorization GETs observe deployment drain; a frozen OAuth endpoint answers 503 `temporarily_unavailable` with `Retry-After`.

## Persistence and verification

`auth_mcp_clients`, `auth_mcp_codes`, `auth_mcp_grants` and `auth_mcp_refresh`
are additive tables in the primary SQLite store. The existing `auth_api_tokens`
row owns each grant and its revocation. Only hashes of codes/access/refresh
credentials persist. Consumed refresh hashes remain until grant expiry or
revocation so replay can revoke the current generation. The existing auth sweep
prunes expired protocol state. No new secret-encryption key or product store is
required. Existing API tokens retain their current behavior.

OAuth `token.revoked` journal entries include `clientId` and `reason`:
`authorization_code_reuse`, `refresh_token_reuse`, or `client_revocation`
(the client called `/oauth/revoke`). No credential or credential hash is logged.
Older entries lack the reason and cannot distinguish these cases. Concurrent
refreshes using the same credential produce one successful rotation and one
reuse rejection, which revokes even the newly issued credentials. A reuse event
establishes repetition, not whether it came from concurrent clients, a retry
after a lost response, or credential theft.

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

Compatibility note: HTTP `localhost` callbacks remain accepted for existing clients.
RFC 8252 §8.3 recommends loopback IP literals instead; new clients should use
`127.0.0.1` or `[::1]`. The ephemeral-port rule also applies to the compatibility
spelling, while the remaining callback bytes must match exactly.
