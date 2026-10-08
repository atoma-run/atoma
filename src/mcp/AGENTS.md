# MCP — AGENTS.md

`src/mcp/` owns atoma's MCP: ONE surface for everyone, served over HTTP on the
viz server's `/mcp` route, with a tiered catalogue of `atoma_*` tools, the
prompt and completion surface, the operator run launcher, its lease and the
bounded readers.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
The `atoma_*` tools are host control APIs, not L1 elements.

Neighbours:

- [`src/viz`](../viz/AGENTS.md) — the server that mounts `/mcp` and `/api/tokens`
- [`src/auth`](../auth/AGENTS.md) — principals, roles, the platform-admin flag, API tokens
- [`src/projects`](../projects/AGENTS.md) — the tenant runs the member tools drive
- [`src/run`](../run/AGENTS.md) — the launcher the operator run tools spawn
- [`src/registry`](../registry/AGENTS.md), [`src/skills`](../skills/AGENTS.md) — what the platform readers read
## One surface, tiered (decision 2026-09-05)

- ONE MCP, ONE ROUTE, TWO PROTOCOL ERAS. Streamable HTTP on `/mcp`, and
  nothing else. The stdio server is gone: its argument ("no socket the run
  could reach") described a product installed on the operator's machine, and
  the product is a deployed server with organisations, principals and a
  journal ([`docs/mcp-one-surface-2026-09-05.md`](../../docs/mcp-one-surface-2026-09-05.md)).
  Since 2026-09-30 the route answers protocol 2025-11-25 (a session per
  `initialize`) AND 2026-07-28 (no session, a server per request through the
  SDK's `createMcpHandler`); `isLegacyRequest` decides, and a request naming a
  session is 2025. The 2025 era stays whole — sessions, replay, tasks,
  subscriptions, the run log — because the clients in use still speak it
  (`health().clients` counts who speaks what; `atoma_mcp_health` reads it): see
  [`docs/mcp-two-eras-2026-09-30.md`](../../docs/mcp-two-eras-2026-09-30.md).
  Do not add a second transport for a special case; make the case a tier.
- THE CATALOGUE IS ONE TABLE (`tools.ts#MCP_TOOLS`): every tool names its
  MINIMUM TIER and what it NEEDS from the host. `tools/list` for a caller,
  `tools/call`'s re-check, the README's tool count and this file all read
  those rows. A tool is registered on a session only when the caller's tier
  admits it AND the host honours its needs — so the ungated loopback server,
  which has no organisations, shows the operator the operator tools and
  nothing tenant-shaped.
- THE LADDER (`identity.ts`): `viewer` reads an organisation's projects, runs
  and traces, plus the two platform commons the viz shows every signed-in role
  (since 2026-09-15): the one registry (`atoma_registry_list`, `_show`,
  `_history`) and the one skill catalog (`atoma_skills_list`, `_show`) every
  run reads and earns on; below `platform` the payload's `store` and
  `skillsDir` are basenames, never host paths (`commonsForTier`), and a
  runner log is served through `src/projects/hostPaths.ts`, the redaction
  the projects service applies to run and publication errors;
  `member` starts, cancels and publishes its runs; `admin` reads the
  organisation's members, sets its model defaults and keeps a project on or
  off the public showcase; `platform` — the
  platform-admin flag, or the operator on the ungated loopback — everything
  above plus operator runs, skill analytics (`stats`, `review`), the four
  writes, ledger, the operator corpus, friction, the journal, every
  organisation, the Jev calibration (below), and who may spend the host's own
  login (`atoma_subscription_delegates`, the third door onto
  [src/auth](../auth/AGENTS.md)'s one body). A platform admin READS every
  organisation and WRITES only in its active one, exactly as the HTTP routes.
- ONE SESSION, ONE SERVER, ONE CALLER on the 2025 era (`http.ts`); a 2026
  request has no session and is authenticated and served on its own. `initialize` authenticates
  the caller and builds a server holding exactly their tools; every later
  request must present the same caller or the session ends with a 401. Hiding
  a tool is therefore never the only guard: a revoked or demoted token cannot
  ride the session it opened. Sessions are memory-only and idle-swept (a day);
  a restart forgets them, and an AUTHENTICATED caller presenting a forgotten
  id with its matching caller/tier hash reopens it. Legacy UUID-only ids must
  initialize again; another caller cannot resume or destroy
  the owner's session. This keeps deployments from failing a client's next call (2026-09-28: about
  ten deployments that day, each one a failed call). Nothing of the old
  session returns: operator task ids, subscriptions and the replay ring were memory.
  A project run's task id is not session state and answers anywhere.
  An id evicted to keep a caller inside its ceiling stays gone, or the caller
  would cycle its sessions; a DELETE and an unknown shape still answer 404. They are also CEILINGED
  TWICE, because a session holds a whole server and a replay ring worth
  megabytes and the idle sweep is a day away: a caller past
  `MCP_MAX_SESSIONS_PER_CALLER` loses its OWN stalest session, and the host's
  `MCP_MAX_SESSIONS` backstop answers 503. Both are counted in `health()`, so
  a client re-initialising in a loop is visible rather than merely survived.
  A POST body is read before anything is reserved or built (its era is in
  it), and one that has not arrived in `MCP_BODY_TIMEOUT_MS` (30s) is closed;
  an `initialize` then reserves both ceilings before allocation, and a caller
  whose slots are all pending receives 503. The opening has its own 30s
  deadline, cleared the moment the session exists: until 2026-09-30 it stayed
  armed through the reopening request's whole response, and cut the first
  long call after every deployment.
  A call still ANSWERING — a POST, or the GET resuming with `Last-Event-ID`
  the stream of a call whose response is still owed — pins its session
  against the idle sweep AND against `reclaim`, which then answers 503 rather
  than cut it; the standalone GET stream, and a resumed stream whose call was
  already answered, do not pin. A resumed call keeps its original start, so
  past `ATOMA_MCP_MAX_REQUEST_MS` (default 3h) of the CALL, reconnects
  included, its open response is closed — never the session holding other
  calls and tasks.
- UNDER A DEPLOYMENT'S WRITE FREEZE a message is judged by what it DOES
  (`frozen.ts`), since every MCP message is a POST: the opening, pings,
  notifications, listings, reads, a task's status or result and a `tools/call`
  of a tool registered `readOnlyHint: true` are served — on 2026 also
  `server/discover` and `subscriptions/listen`, judged against a server built
  for the caller; anything else, and a body over 1 MiB or not JSON, waits with
  the freeze's 503. Until 2026-09-28
  every MCP POST was refused for the minute of an activation. OAuth routes
  stay frozen: they write identities.
- IDENTITY. Gated: `Authorization: Bearer atoma_…`, an API token a principal
  minted for ONE organisation (`/api/tokens`, or `npm run auth -- token`).
  `AuthStore.resolveApiToken` returns a fresh viewer — role and platform flag
  read NOW — and the row keeps a hash, never the secret. Minting and revoking
  are `token.created` / `token.revoked` journal rows. Ungated: the caller is
  the operator, by possession of the machine, as for the CLI; there is no
  token to present and no organisation to act in.
  The integrated assistant also delegates its live browser session through a
  short-lived server-only bearer (`auth/assistantGrants.ts`); it uses this same
  HTTP route, capped at member in the active org, never a cookie path into MCP.
- HOST IS PINNED, AND ORIGIN BESIDE IT, for both eras by the host itself
  (`admitted`: the SDK's 2026 handler checks neither). `allowedHosts` — the public origin's host (gated) or the
  loopback host:port (ungated) — which is the control that defeats rebinding:
  a page on an attacker domain still sends that domain as Host. `allowedOrigins`
  pins the Origin, checked ONLY when the header is present, so a
  CLI client that sends none is untouched. Say which does what: Origin is
  defence in depth, since nothing here emits CORS headers and MCP's required
  headers are not CORS-safelisted, so a cross-origin page never gets past a
  preflight this server does not answer. Bearer tokens make CSRF moot; there
  is no cookie path into `/mcp`.
- WHAT DID NOT CHANGE: payloads are BOUNDED and honest about trust — traces
  page (`offset`/`limit`, capped), error strings truncate, run output, skill
  bodies, verdicts and trace text are marked UNTRUSTED model data; the
  operator readers never leave their directories (`pathIsInsideDir`, and a
  verdict is opened by run id, never by path); a project run's trace is read
  only through the store's own resolver for a run the caller may see.
- TRACE DETAIL IS OPT-IN: `atoma_run_trace` keeps its summary default; metadata,
  a selected event, result-only data and the project runner log expose complete evidence as JSON
  text pages (12K characters default, 24K maximum). `snapshot` detects changed
  detail between pages; readers concatenate before parsing. All bodies are
  UNTRUSTED. Run provenance is stamped at launch, never inferred from today's
  deployment for old traces. Detail reads use the viz corpus size ceiling.
- PUBLICATION DETAILS come from the shared project run reader: persisted Git
  destination, commit, PR URL, failure and timestamps. Delivery is not publication,
  and a published PR is not a merge. Unknown legacy destinations remain null.
- EVERY RESULT GOES OUT TWICE: the text block every host renders, and
  `structuredContent` for hosts that read typed results (`jsonResult`). A
  reader whose shape is stable declares an `outputSchema` (loose,
  `passthrough`-shaped, so an additive field never fails the host's
  validation); the older readers with polymorphic payloads (`note` on an
  absent store) declare none. Never add an `outputSchema` a payload can miss.
- COMPACT MENUS are opt-in (`view=compact`, search, status, limit, cursor);
  no-option list calls preserve their original array text, with a structured
  envelope added. Cursor fingerprints bind the filters and read scope.
  File tools and resources reuse `ProjectService.workspace`: only the saved
  publishable manifest, with its hash, path jail and byte ceiling. File text
  pages carry a snapshot; images are optional and all content is untrusted.
- RUN PROGRESS projects existing trace events and acceptance judgements,
  cached by file identity and timestamps. Lifecycle rows outrank the trace;
  unavailable evidence is explicit, never a guessed percentage. Readiness
  resolves the launcher's existing configuration without admission or a
  provider request. Structured service errors include the next action.
- MCP APPS is optional metadata on run start/status/review, with `ui://atoma/run.html`
  built by `mcp:build` into `dist/` and included in `build`. The official Apps
  SDK connects through the host; no credential or direct network access is
  embedded. The sandbox renders sanitized Markdown and highlighted source; raw HTML stays
  literal, remote document images are omitted, and SVG is displayed only as an image.
  Hosts without Apps retain the complete text and resource surface. The
  browser smoke is `npm run mcp:smoke`; compiled OAuth smoke checks packaging.
- HOST-PROVIDED NEEDS ARE READ AT CALL TIME. `preview`, `sentinel`,
  `analyst` and `notifications` are functions on `McpToolDeps`, because the
  preview runtime comes up after the bind and the watch's health changes every
  tick. A tool whose dependency is absent answers what the HTTP route answers
  (`503 previews are not available`), never a missing-tool error — except the
  tray, which needs a builder to exist at all and is a `needs` row.

## Operator runs and the lease

- `spawnRun` is the sole sanctioned operator run launcher. Keep compiled and
  source paths and flag ordering aligned; the goal is always the last argument.
- Project runs hold SQLite reservations bounded by `run.concurrentMax` (default 10),
  at most ONE per organisation, including preparation and finalization. Excess global demand is queued; retries
  reattach as before. Operator runs remain exclusive through in-memory state
  and the same lease store (`~/.atoma/mcp-run-lock.db`, machine-global).
  Stale lease recovery must validate PIDs/PGIDs safely. Deployment
  waits for EVERY reservation through `acquireRunLeaseWithoutRecovery` and never
  recovers a row that may still have a run behind it. The one row any taker
  there reclaims is a dead owner's that recorded NO process group — what a
  killed analysis, mend, maintenance or guard leaves — because there is
  nothing to reap; the lease reports it (`reclaimed`). On 2026-09-27 such a
  row, left by a SIGKILLed mender, refused two deployments and every analysis
  for 2 h 10 until a person deleted it.
- A deployment WAITING for the slot is one `mcp_deployment_pending` row in the
  same store (`registerDeploymentPending`). While it lives, both acquirers
  refuse every taker inside their IMMEDIATE transaction — `condition:
  'pending'`, owner `deployment:<pid>` — except the guard presenting its
  token, and `acquireRunLease` refuses BEFORE any recovery, so a start it turns
  away never reaps on its behalf. Whoever already holds the slot is never
  touched. The row lives exactly as long as its guard (same birth-identity
  rule as a lease owner; no identity, no row), is void once the guard is
  gone, and is deleted by the next writer; `peekDeploymentPending` only looks.
- Cancellation is a state, not successful completion. Signal the whole
  validated child group, bound termination, retain trace/status evidence.
  `finishRun` frees the in-memory slot in `finally` even if lease deletion
  fails; hard server backstops bound driver promises that never settle.
- An operator run started through `/mcp` is a child of the viz server; a
  generic server exit signals it (`signalActiveRunOnExit`, SIGTERM only) so it
  closes its trace, and the stale lease lets the next start recover it.
- Stale-lease recovery is VISIBLE: `atoma_operator_run_start` reports what it
  reaped, and `atoma_operator_run_status` with no in-memory match reports the
  cross-process lease row instead of amnesia.

## Runs are tasks (`tasks.ts`)

- `atoma_benchmark_start` is a platform-only task over the existing retrieval
  campaign CLI. It accepts a full immutable registration, never caller-chosen
  dataset/output paths. The host fixes the dataset and archive root; source,
  instruments, worker and global lease checks remain the CLI's. Cancellation
  reaches the same campaign signal. Attempts are visible in the current viz
  without creating product project rows. Operator guide:
  [benchmark MCP integration](../../docs/benchmark-mcp-viz-2026-09-09.md).

- THE START TOOLS ARE MCP TASKS on both eras (`tasks.ts` holds the model,
  `taskWire.ts` each wire; SDK v2 has no task runtime). 2025-11-25: a
  `tools/call` carrying `task` answers `{task}`; `tasks/get` reports
  `working` with a status line, `tasks/result` blocks until the terminal
  result — the status tool's payload —, `tasks/cancel` cancels the run and
  `tasks/list` lists; the capability is `tasks`, and the start tools list
  `execution.taskSupport: 'optional'`. 2026-07-28: a request declaring
  `io.modelcontextprotocol/tasks` on its capabilities gets `{resultType:
  'task'}`; `tasks/get` answers WITH the result inline, `tasks/cancel` and
  `tasks/update` acknowledge, fields are `ttlMs`/`pollIntervalMs`, and since
  `failed` means a JSON-RPC error there, a run that ended — even badly — is
  `completed` with the payload that says how. Since SDK 2.3.0 they are explicit-schema
  handlers (`serveModernTaskMethods`) behind the SDK's own 2026 checks (`Mcp-Name` =
  taskId; a cancel of an ended task is acked, SEP-2663); since the callback the SDK gives a tool
  never sees `params.task`, the task path of `tools/call` wraps the handler
  its `McpServer` installed (`installTaskProtocol`), answering bad arguments
  and a failing start as tool errors, as the SDK's own path does. There is NO "start, then
  poll" contract and NO long-poll: the status tools are plain readers. The
  `waitMs` long-poll and its `notifications/progress` went on 2026-09-07.
- WITHOUT A TASK the start is a synchronous call (`runSynchronously`): the
  terminal result when the run ends, minutes later. A refused start is a task
  that fails at once, never a hung call. A caller that sent a `progressToken`
  hears `notifications/progress` with the run's status line at once and every
  30s (`requestHeartbeat`): it answers an IDLE watchdog (Claude Code, 300s),
  not a FIXED deadline (Codex tool_timeout_sec 300s: Settings sets 10800). 2026
  calls are SSE with keepalives (`responseMode: 'sse'`). A cut call's run goes
  on; a re-sent identical start re-attaches to it (`src/projects`).
- `atoma_run_start.acceptanceCriteria` takes one criterion per ENTRY in the
  console's line grammar (`parseChecklistLines`), not the structured shape: one
  grammar for every human entry point, and a JSON Schema free of transforms.
  An entry that does not parse to exactly one criterion fails the task before
  the service is called.
- A start calls the very start the HTTP routes call (`startRun`,
  `startProjectRunFromInput`), and cancelling calls the cancel tool's body
  (`cancelRun`, `cancelProjectRun`). The operator watcher turns each output
  chunk into the status line (bounded, marked untrusted; the progress line
  carries the chunk count only) and the run's end into the result.
- A PROJECT RUN'S TASK IS THE RUN (`ProjectRunTasks`, 2026-09-30). Its id is
  `project-run:<projectId>:<projectRunId>`, and every task request, on either
  era, reads or cancels the run through `ProjectService`; nothing of it is in
  memory, so it answers in any session, in a session-less 2026 request, after
  a restart. It is BOUND to its authorization
  context: the run's `orgId` and `requestedByPrincipalId` must be the
  caller's viewer's, or the answer is the "not found" of an unknown id — an
  org member who may read the run through `atoma_run_status` still cannot
  follow or cancel another principal's task, and a missing field fails
  closed. The TTL it reports is the coordinator's preparation + run +
  hard-backstop budget plus `TASK_RESULT_GRACE_MS`, and like the SDK's store
  it keeps a task one TTL after the run ENDS, then answers "not found".
  The 2025 `tasks/list` names exactly the tasks a read answers (the spec's
  MUST) — the principal's live runs and those ended within a TTL, read through
  `ProjectService.runsRequestedBy`, at most 50 — then its in-memory ones. A
  run the console started is that principal's task too. Nothing polls it but
  a synchronous start waiting on it. A refusal before a run exists is an
  in-memory task that fails at once. Operator runs die with this process
  (below), so theirs would be a durable id for a dead run: not done.
- CANCELLING: an in-memory task turns `cancelled` at once and reaches its
  run, and its result is the run's status as it then is; a project task is
  `cancelled` once its run is, whichever door cancelled it, with the status
  payload as its result. The 2025 spec wants it
  `cancelled` BEFORE the answer to `tasks/cancel` and for good, while the run
  lands only once its abort is through (or otherwise, if too late): the
  process remembers the cancelled task ids (bounded, after the binding check),
  and a restart forgets them, after which the run's final status speaks.
- OPERATOR AND BENCHMARK TASKS, AND REFUSALS, LIVE IN THIS PROCESS'S MEMORY
  (`MEMORY_TASKS`), bound to their caller (`callerKey`), not to a session: the
  2026 era has none, and a 2025 client that reconnects keeps them. A finished
  one is swept one ttl after it ends; past 1,000 a caller loses its OWN
  oldest finished ones, never another caller's. An operator run that ended
  before its watchers were hooked (a driver settled at once) is read at once,
  or its task would stay `working`. A restart forgets them, never the runs'
  evidence.
- THE 2025 TRANSPORT ANSWERS ON SSE, NEVER PLAIN JSON. `enableJsonResponse` makes
  the SDK drop every notification related to a request (measured 2026-09-07:
  0 of 3 delivered), and the standalone stream is what carries the run log and
  the resource updates. A script reading `/mcp` by hand parses SSE frames
  (`scripts/release-smoke.mjs#readResponseFrame`).
- EVERY 2025 FRAME IS REPLAYABLE (the 2026 era dropped resumability: a cut
  request is re-sent, which is what tasks are for). Each session's transport holds a
  `SessionEventStore` (`eventStore.ts`): a bounded in-memory ring that stamps
  frames with ids so a client cut mid-call reconnects with `Last-Event-ID`
  and receives the frames it missed, the response included. The ring dies
  with the session; a cursor that fell off replays nothing rather than
  something wrong, and the ring counts what it dropped so the host's
  `health()` reports `replayEvictions` — depth lost, not merely never used. EVICTION IS PER STREAM, NOT GLOBALLY FIFO: the standalone stream
  carries one frame per output chunk of a run while a tool call's response is
  a single frame on its own stream, so one queue would let the log evict the
  very response the replay exists to preserve. A frame goes from the LONGEST
  stream, oldest first. The ring is bounded by BOTH a frame count and a byte
  budget, because a log frame carries the child's chunk verbatim and a pipe
  read is up to 64 KiB — the count alone is not a memory bound.
- THE RUN LOG, 2025 only (logging is deprecated in 2026 and has no session
  stream there; the task's status line is the run's voice): the server declares `logging`, and the session that started an
  operator run receives each output chunk as `notifications/message` (`info`,
  logger `atoma.run.<runId>`, `untrusted: true`) and one `notice` when it
  ends. Only runs the session started are followed; the SDK filters by the
  level the client set. Project runs have no chunk source here and log
  nothing; their task's status line follows the store's status.
- The start tools' input schemas live in `tasks.ts` (`OPERATOR_RUN_INPUT`,
  `PROJECT_RUN_INPUT`), one per shape. `McpToolDeps.operatorRunDriver` /
  `operatorRunLease` are `run.ts`'s injectable seam reached through the deps,
  so a wire test drives a start without spawning the runner. Absent in
  production.

## Resources and subscriptions (`resources.ts`)

- Resources are DOORS ONTO THE READERS, never second bodies: `atoma://runs/
  {file}` reads through `runTrace` with its paging and truncation,
  `atoma://operator-runs/{runId}` through `runStatus`, `atoma://projects/
  {projectId}/runs/{runId}` through `ProjectService.projectRunStatus`. A URI
  carries no way to ask for more.
- Registration follows the tools' tiers and needs, per server: the operator
  corpus only at the platform tier on a host with `operatorRuns`, a project
  run only for a principal on a host with organisations. Listings are menus,
  capped at `RESOURCE_LIST_LIMIT`; the trace template completes over
  `completeTraceFile`.
- `resources/subscribe` is per session and dies with it. A finished operator
  run (`onRunFinished`) or a `run.finished`/`run.cancelled` journal row sends
  `resources/updated` to the sessions that subscribed to that URI, and a
  finished operator run also sends `list_changed` (a new trace exists). The
  listeners are unhooked in the server's `onclose`, so nothing is ever written
  to a transport that is gone. The capability is declared BEFORE `connect`
  (`registerCapabilities`), which is when the SDK freezes it. On 2026 a
  client names the URIs it follows on `subscriptions/listen`; the host
  publishes the same events once for the process onto the SDK's bus
  (`publishResourceEvents`), which delivers each to the listeners that named
  its URI. Because that bus is one for everyone, the host narrows each listen
  filter to what the caller's tier registers (`mayFollowResource`; the
  list-changed notice at the platform tier only), and holds a caller to
  `MCP_MAX_LISTENS_PER_CALLER` open streams (429 past it) under the process's
  `MCP_MAX_LISTENS`.

## Operator writes (`writes.ts`)

- Four verbs, platform tier, `needs: ['operator-runs']`: `atoma_skill_reset`,
  `atoma_skill_drop`, `atoma_skill_merge`, `atoma_registry_rollback`. They
  call the SAME store methods the CLI calls (`SkillRegistry.resetCounters/
  drop/merge`, `AtomRegistry.rollback`), so the lifecycle ledger rows are the
  CLI's rows and `ledger check` projects the same counters. Each call runs
  under `withLedgerScope(ledgerScopeOf(actor), …)`: this process serves every
  organisation, so the lifecycle row names the bearer's principal per request
  rather than a process-wide scope (T7).
- THE CLI'S REFUSALS, IN THE CLI'S WORDS: dropping or absorbing a skill with
  recorded successes is refused without `force`; a rollback to the live
  version is a no-op the registry itself reports. A second door must never be
  looser than the first, and must not grow a rule the first lacks.
- ATTRIBUTION is what the MCP adds. The actor is the principal behind the
  bearer (`mcp:<principalId>`) or the loopback operator (`mcp:operator`), and
  it is written into the payload, into `AtomRegistry.rollback`'s `modifiedBy`,
  and — on a gated host — into one journal row per action (`skill.reset`,
  `skill.dropped`, `skill.merged`, `registry.rolled_back`, `actorType:
  principal`, severity warning, never pushed). Rows carry names, ids and
  counters, NEVER a body. On the ungated path there is no journal and the
  payload says `journaled: false`; that matches the CLI, which has no principal
  to name.
- Writes open the store through `openDb` (schema and migrations), exactly as
  the CLI does, and close it before returning. The readers' readonly handles
  are not a write path and must not become one; a reader that needs skill
  trust (`ledgerCheck`) hands its readonly handle to `SkillRegistry`, which
  only checks for the `skill_meta` table there and never creates it.

## Prompts and completions

- The PROMPT surface adds no tool: `atoma_goal` is visible to project members
  and adapts to their project-run path; the local operator gets its operator
  path. Reader prompts complete over the operator store and stay `platform`.
  Goal prompt text QUOTES `GOAL_GUIDANCE` and reader prompts quote their
  exported caveat constants rather than restating either. A prompt must not
  teach a caller to name a builtin element in a goal. Server instructions
  carry the same guidance because clients may never display prompts.
- Argument completions hang off PROMPTS because the protocol has `ref/prompt`
  and `ref/resource` and no `ref/tool`. Every completable argument is
  REQUIRED (the SDK does not unwrap an optional). Completion sources live in
  `readers.ts` and bound their own SCAN, not just the returned slice.
- A completion that needs ANOTHER argument reads it from the completion
  context (`context.arguments`), which is how `atoma_read_skill` completes a
  skill id inside the molecule already typed; with no molecule there is
  nothing to complete against, and the source answers nothing rather than
  every skill on the machine.
- A prompt may NAME a write tool (`atoma_read_skill` names the three skill
  verbs) only to hand the decision back to the person; it must never instruct
  the host to perform the write.

## The Jev calibration (`jevCalibrate.ts`)

- `compilations` measures only caller-supplied recipes (at most 20, repeated
  at most 5 times) through the LIVE compilation prompt and Jev questions.
  Independent expected labels stay local; `null` is unlabelled. It generates
  and executes no script, reads no run corpus, and mutates no skill. It is
  exclusive with trace windows, twins and audits. The same bounded client,
  memory results, cost report and `resultIds` rereading apply; details carry
  request hashes, raw scores and false postponements (owner decision 2026-10-01).
- `atoma_jev_calibrate` (platform, `needs: ['auth', 'projects']`) is the door
  onto `src/atoms/jevCalibration.ts`
  ([decision record](../../docs/jev-decisions-2026-09-28.md)): it reads the
  MODEL's prefilter and validation decisions out of every organisation's runs
  — Jev decides in all of them since 2026-09-30 — asks TypeSafe both question
  designs on them, and reports each against the model's decision. Each
  foreign organisation is journaled once per call as an `mcp.trace`
  cross-organisation read. With Jev off on the host (`ATOMA_JEV=0`, or no
  key) it answers 503, as a host without previews does. Every answer also
  carries the AUDIT sample of the window (`jev-audit` events: the model
  judging a share of Jev's approvals), and `auditsOnly` reads just that — no
  key needed, nothing sent to TypeSafe.
- It is registered `readOnlyHint: true` although it spends cents: it writes
  nothing of Atoma's but the audit row, and a deployment's write freeze has no
  reason to refuse a measurement.
- A call is BOUNDED: `limit` decisions (default 120), a four-minute budget
  after which nothing new is sent, `nextOffset` to page on under a fixed
  `until`, and the progress heartbeat of `tasks.ts` for a host that waits on
  it. Answers stay in process memory, per principal, ten results deep, so
  `resultIds` reads them again under other thresholds for nothing. A restart
  forgets them on purpose: a measurement is read now, and its figures go into
  the decision record through a person.

## Changing the catalogue

- `atoma_run_question` reads a saved blocking choice; `_answer` records only the
  original requester’s explicit response. Then `_resume` uses the existing task
  path. No guessed consent or automatic project-memory update. Details and
  bounds: [client questions](../../docs/client-questions.md).

- `atoma_project_context` reads bounded revisions/history; `_update` is member-only,
  CAS/idempotent, with explicit client confirmation for durable guidance. Both
  use ProjectService, also GET/PUT `/api/projects/:id/context`. The storage and
  pinned-run contract lives in [projects](../projects/AGENTS.md).

- `atoma_run_review` uses the shared `ProjectService.reviewRun` reader, also
  GET `/api/projects/:project/runs/:run/review`. It returns bounded saved evidence
  and links to the existing readers; it runs no test, opens no preview, and
  grants no client approval. Missing/expired evidence remains explicit.

- `atoma_run_start.baseRunId` selects the exact retained project delivery for
  a new goal. Status/readiness expose `acceptedReferenceRunId`; absent selection
  preserves automatic seeding. The shared service refuses comparison/resume
  combinations; identity, queue and byte checks are owned by projects.

- `atoma_run_accept` records the client's explicit test/review acceptance of
  the exact manifest hash, then publishes through the existing project service.
  `atoma_publication_retry` never grants acceptance. Delivery/model validation
  is not client consent, and publication is not deployment.

- `atoma_run_pause` and task-enabled `atoma_run_resume` call the project's
  checkpoint service. Resume takes the SOURCE run id and inherits its durable
  continuation identity; it never invents a client-side second runner.
- `atoma_run_compare` pages the shared `ProjectService.compareRuns` reader,
  also mounted on GET `/api/projects/:project/runs/:run/compare`. It compares
  saved inventory hashes, states legacy coverage, and makes no GitHub,
  live-byte, acceptance or version-adoption claim.

- Adding a tool is adding a row: name, minimum tier, needs, registration.
  With it come a behavioural test in `tests/mcp-http.test.ts` (which tier sees
  it, what it refuses), the release smoke if it is operator-visible, and the
  README sentence `docs:check` derives from the table (the spelled-out count
  in `scripts/repo-facts.mjs` runs to fifty-four; extend the table before the
  catalogue passes it). Removing or renaming one is a compatibility change for
  every registered client and is stated in the changelog.
- `server.json` (repository root) is the MCP Registry entry for the deployed
  `/mcp`: namespace `run.atoma`, proved by the domain, the header optional
  because OAuth signs a client in. It carries `package.json`'s version and
  `tests/mcp-server-json.test.ts` fails when it drifts; publishing it
  (`mcp-publisher login dns --domain atoma.run`, then `publish`) is an
  operator action, never CI.
- `plugins/atoma` is the Claude Code plugin, listed by the repository's
  `.claude-plugin/marketplace.json`: the same `/mcp` URL, a skill and a
  read-only trace reader. It is PACKAGING AND TEXT, never a second surface —
  no logic, no credential, no hook. Its skill QUOTES `GOAL_GUIDANCE`; its
  version, URL, cited names and the reader's read-only viewer tools are held
  by `tests/claude-plugin.test.ts`. Renaming a tool the plugin cites updates
  the plugin in the same change.
- A result that names runs LINKS them (`resource_link`, at most 20, after the
  text block), and only to resources this caller's server registered: a link
  is one it may read or subscribe to. `serverInfo` carries the mark as a data
  URI (`icon.ts`, the favicon's bytes, checked by `mcp-server-json.test.ts`).
- A reader the MCP grows is a reader the CLI or the viz already has, reached
  through a second door: `skillShow` mirrors `skills show`, `ledgerTail`
  `ledger tail`, the tray builder is shared with `/api/notifications`
  (`src/viz/push/tray.ts`). When a new reader has no first door, build the
  shared body first and mount both doors on it — never a loop the route keeps
  and the tool copies.
- `atoma_jev_calibrate` has no CLI door: the key and the admitted
  organisations live in the server's environment on the host, and its body is
  the atoms module plus the store's own trace listing, so a CLI door would be
  a mount on that body, never a copy of it.
- `atoma_doctor` was considered and NOT built (roadmap, 2026-08-21 and
  2026-09-07): doctor probes Docker and the environment and is not a pure
  reader. Exposing a side-effect-free subset needs that subset to exist in
  `src/cli` first.
- The tenant tools call `ProjectService` through its input-based methods
  (`createProjectFromInput`, `startProjectRunFromInput`, `projectRunStatus`);
  the HTTP routes are body readers in front of the same checks. Never
  re-implement a role check in a tool.

## Shared conversations

`atoma_conversation` and `atoma_conversation_update` expose the project-owned
private history to members. The existing create/run tools optionally consume
`conversationApproval`; run starts remain MCP tasks in both eras. See the
[continuity contract](../../docs/integrated-assistant.md). No inference, second
runner, implicit project-memory update or whole-chat export belongs here.

## Intentional choices and rejected shortcuts

- A separate lock file per client bypasses the global capacity and deployment
  drain: refused. All reservations and the pending deployment share one
  immediate transaction boundary. Upgrade/rollback must drain and stop all
  writers: an old binary understands only the former singleton. The migration
  preserves existing ownership, tokens and process fingerprints.
- The waiting deployment as a marker file beside `ATOMA_DEPLOY_LOCK_PATH`:
  rejected. A file cannot be checked atomically with the lease row, every
  process would need that path in its environment, and a file survives the
  guard that wrote it — the flaw the write-freeze marker had until it named
  its writer. The lease store is already what every taker reads under BEGIN
  IMMEDIATE, and a dead owner voids a row by construction.
- The MCP lease `ALTER TABLE` loop is corruption repair, not version
  migration. The lock DB lives in `~/.atoma/` outside the product store, and
  the burn-in pgid guard already documents it as writable by the run itself;
  without the loop a foreign-shaped table makes every start throw a raw
  SQLite error until a human deletes the file.
- Per-session servers rather than one server with enable/disable per call:
  the SDK filters `tools/list` from what is registered, and a tool that is
  not registered cannot be called by name — two properties from one
  mechanism, where toggling would have been two.
- OAuth clients and manually minted API tokens share `resolveApiToken`.
  OAuth discovery, consent, PKCE, expiry and renewal belong to
  [src/auth](../auth/AGENTS.md); the MCP remains the resource server and
  advertises its metadata URL on authentication challenges.
- A `waitMs` long-poll on the status tools, with `notifications/progress`,
  lived two days (2026-09-05 to 2026-09-07) and was removed when the start
  tools became tasks: two ways to follow a run is one too many, and the
  long-poll never delivered its progress line in the JSON transport mode it
  shipped with. Do not re-add a wait parameter to a reader; a host that wants
  to wait drives the task.
- A durable project task as a ROW — a task table beside the lease, or a task
  id column on `project_runs` — was rejected (2026-09-30): it is a second
  record of what the run row already says, and a product store is not added
  for it. The run's own ids make the task id, and the binding check makes a
  guessable id worthless. Binding it to whoever may READ the run was rejected
  too: MCP binds a task to the context that created it, and cancelling is a
  write another member's token must not reach through a task id.
- A bigger ring was the obvious answer to a run log evicting a response, and
  it is the wrong one: the log outgrows any constant, so the ring is fair per
  stream instead and its size stops being the thing that decides correctness.
- Refusing a caller at its own session ceiling, rather than dropping its
  stalest session, was rejected: a client whose sessions leak would lock
  itself out of a working server, and the sessions it lost were its own to
  lose. The host ceiling refuses, because there the cost falls on everyone.
  The one refusal at the caller's ceiling is when EVERY one of its sessions is
  answering a call: dropping one would cut a call in flight, not a leak.
- Serving 2025 clients through the SDK v2 default (`legacy: 'stateless'`)
  was rejected (2026-09-30): a stateless 2025 server has no session, so no
  replay ring, no subscriptions, no run log and no GET stream, for the clients
  that actually connect. The 2025 era keeps its sessionful transport until
  `health().clients` says it is no longer spoken; then it goes, with its text.
- Reserving a session's place before reading a POST body was the old order:
  the era is in the body, and reserving for every session-less POST would
  count a 2026 client's concurrent requests against session ceilings. A body
  still arriving holds a socket, never a place or a server, for 30s at most.
- Keeping stdio "for local development" was considered and dropped
  (2026-09-05): `npm run viz` already serves loopback ungated, so the local
  MCP is the same URL on `127.0.0.1`, and a second transport was code kept
  for a case that does not exist.

`atoma_run_search` (viewer) and GET `/api/projects/:project/runs/:run/search`
share `ProjectService.searchCode`: saved artifacts, host Haystack configuration,
exact citations, optional bounded file relations and explicit corpus coverage.
No live workspace, model API call or durable search store is exposed.
