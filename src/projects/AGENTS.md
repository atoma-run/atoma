# Projects — AGENTS.md

`src/projects/` owns organisation-scoped projects, run corpora, artifacts, publication and [private conversation continuity](../../docs/integrated-assistant.md) and [structured Haystack code retrieval](../../docs/code-retrieval.md).

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:
- [`src/auth`](../auth/AGENTS.md) — the identities projects belong to
- [`src/github`](../github/AGENTS.md) — where publication lands
- [`src/platform`](../platform/AGENTS.md) — the journal this domain emits into

## Independent run executors

With `ATOMA_EXECUTOR_SOCKET`, the web coordinator delegates admission and
publication to a private generation host. It never drives or reconciles runs.
The executor owns the existing coordinator/runner, durable lease, finalization,
naming and deferred learning; no second task table or orchestration loop exists.
Cancellation is a request in the primary store, polled by the owning executor.
Boot recovery preserves runs/publications with live lease owners across generations.
A draining generation dispatches no queued work and exits only after explicit
retirement and its own work completes. The active socket is resolved on every
command (no HTTP keep-alive pool across a symlink switch). Compatibility changes
are owned by `src/contracts/executorVersion.ts`; see
[deployment](../../docs/automatic-deployment.md).

## Customer compute control

`computeDevices.ts` is the private customer-compute control domain, sharing the
product database. Pairing requires browser identity plus proof of the app's
secret; only hashes persist. Every operation rechecks membership and explicit
project grants. Connection and execution generations are separate. Disconnect,
revocation or expiry never prove workload exit or release its slot. A fresh
connection requires an exact launcher stop report before admission. A negotiated
transport reattachment instead retains the same live session and in-memory
command state: credential, machine, lease, execution and authority are rechecked
before replacing the socket; sequence acknowledgements fence retransmission.
It never allocates or renews the lease, and a newer attachment fences old sockets. Membership downgrade
and project archival fence assignments in the same database transaction, so
restoring access cannot resurrect old work. The opt-in `computeGateway`/`computeConnection` adapter requires verified TLS
provenance, bounded frames and one outstanding workspace command. Browser
pairing requires current identity, one-use consent, exact origin and app-secret
proof. Every dispatch, result and heartbeat rechecks authority. `computeDispatch`
bridges the existing host child to that connection. Terminal channel loss aborts host orchestration;
no command is executed twice. Its product-store journal preserves incomplete delivery
across server restart. Finalization (automatic or explicit) binds a fresh
export-only generation to the recorded local allocation; only verified received
bytes become delivered. A typed `export-refused` reply (the device's publication
inventory refused the finished tree) is terminal on dispatch and on retry alike:
the row fails exactly as a hosted refusal does, same message, stats kept from the
persisted `.compute-result`, slot released through the normal close. Run
40c20c5d sat `running` instead, its cause discarded. Only a refusal the same
tree reproduces (`artifactRefusalCodeSchema`) is terminal: a race or an I/O
failure (inventoried as `changed`) stays an operation failure and pends.
Every cause a dispatch leaves pending is logged, including an absent device.
A device sends these shapes to a server that knows them only if the server
deploys first: rollout order in [src/launcher](../launcher/AGENTS.md).
A persisted launcher stop report, never a deadline, permits closing an interrupted
run and consulting its normal checkpoint eligibility. The selected executor
reconciles confirmed interrupted stops during its control poll, including after a
generation change (`startSelfExecutorControlPoll` with no executor socket). It also
finishes pending finalization transfers by itself (2026-10-25), running the explicit
retry's path for the requester, one attempt per run, once only the transfer is left
and the device is connected and accepting work with no execution holding its slot. A
paused device is never attempted (assign would refuse); resuming on the same
connection retries at once. Failures back off 30 s doubling to ten minutes whatever
the connection: an attempt that reached the device closes its socket and the app
reconnects a second later. Only a failure before assign lets a new connection re-arm
sooner, under a floor that grows too. A lost membership or archived project is
logged once, not retried while it lasts. A run cancelled before an attempt or while
waiting for the slot is never exported: it closes as cancelled once its stop is
confirmed; readers drop its waiting state, the button refuses with typed
`cancelling`. The export runs no tool or model. Public readers never reconcile.

Results WAITING on a computer (2026-10-25) are host facts: a running Compute row whose journal says
`finalizing` with no driver (`computeResultsWaiting`); `computerReady` picks a neutral sentence. Readers:
stage `awaiting-results`, run `resultsWaiting`, project `runningRunsAwaitResults`, Settings rows, a busy
`reason` (`-stalled` when ready). One claimed notice once `RESULTS_WAITING_NOTICE_MS` passed since the first
driver stop. "Get the results" answers `ComputeResultsNotYet` only for what passes by itself; access, project
and executor refusals keep their type. Journal `interrupted` (or `finalizing` once cancelled) reads stage
`stopping`, never `finalizing` (run a4dcf853, 2026-10-26); with no dispatcher, `computeProgress` reads the journal, never `stopped`.

Legacy project targets remain hosted and run receipts are immutable. On gated
hosts, only a current platform admin may start hosted work; other members must
pair and explicitly select a granted device. The coordinator rechecks this before
admission and dispatch, including continuations and after asynchronous preparation. Continuations inherit the source receipt, even if the project changed.
Only an owner/admin may change a target, with a compare-and-set and explicit
device project grant. Device admission explains unavailable capacity without
acquiring a hosted slot; remote receipts must never launch on the hosted driver.
The WSS bind acknowledgement follows local allocation; loss during allocation
is indeterminate and cannot free the persisted assignment. Tools use a separate
bounded concurrent channel; their acknowledged drain leaves workspace RPC alive.

The coordinator selects a host-configured retrieval override by the immutable
run target's device UUID; legacy devices keep their existing fallback. The
schema and bounded reader live in [contracts](../contracts/AGENTS.md#haystack-runtime-configuration).

## Deployment preference

`deploymentDestination` is `none` (default), `atoma` or `external` (no
provider): admin-only, org-scoped, journaled, CAS on an expected value, never
deploying or stopping anything; preview, acceptance, publication and deployment
stay separate. Hosting ([docs](../../docs/project-hosting.md), `hostingService`)
runs accepted, published, hash-verified copies at the `hostingSubdomain` label;
a rename leaves a permanent redirect, never reused ([rules](../../docs/project-hosting.md#dns-and-https)). `update`
(owner, 2026-10-25) is one explicit admin request under Stop's lock and CAS:
candidate created unstarted, then every `holdsApplicationData` row stopped and
the candidate reserved, visitors held (`swapping`); failure offers `restore`. `status().history` (2026-10-26) tells the conversation each row's outcome from row facts only (`readyAt`, `replacedRunId`; `hostingHistory`).
Health (2026-10-26): `HOSTING_HEALTH.failures` consecutive failed checks, or a
gone container, fail a ready row; one slow answer journals nothing. A GRANTED
visitor of an offline project gets 503, anyone else the unknown-address 404.

## The organisation's MCP servers

A project enables some of its organisation's MCP servers (admin-only, journaled
`project.mcp_servers_changed`). At launch the coordinator asks `mcpConnectorsFor`
during preparation and writes `ATOMA_MCP_CONNECTORS` (access headers only, never
a refresh token); a resolver failure starts the run without servers. Contract:
[src/connectors](../connectors/AGENTS.md).

## Run network

Project runs enable isolated, proxied egress by default. `ATOMA_EGRESS=0` disables
it; `ATOMA_EGRESS_ALLOWLIST` replaces the host list. Both are host-only settings.

## Scoping and storage
- Projects, installations and publications belong to one organisation. Gated
  `/api/runs` reads its project traces at `orgs/<orgId>/projects/<projectId>/runs/<runId>/`
  under `ATOMA_PROJECTS_ROOT` (default `~/.atoma`), never operator `./runs`.
- `context.ts` versions project briefs and decisions in the product DB. Updates
  require CAS and idempotency; only explicit client-confirmed guidance reaches
  models. Admission pins the revision; retries/resumes/reruns preserve it.
  History never becomes platform skills or trust. See the full bounded storage,
  transport and provenance contract in [project context](../../docs/project-context.md). `requestedVia` (`requested_via_json`, 2026-10-26) is a run's door, stamped by its caller, never read from the request: first writer wins, immutable, unparseable reads as unknown. Attribution only.
- A run's USER-APPROVED acceptance list is captured in `project_run_acceptance`
  in the reservation transaction, digested by `src/run/acceptanceSpec.ts` and
  immutable by trigger; `getRunAcceptanceSpec` re-digests on read and throws
  on a mismatch. The digest joins the idempotency comparison: same key and
  goal with another list is a conflict. The coordinator hands the child the
  STORED spec in `ATOMA_ACCEPTANCE_SPEC`, never the request's.

## Tier selectors and credentials
- Every tier of a project run resolves to one full selector,
  `<api|sub|own>:<vendor>:<model>` ([src/contracts](../contracts/AGENTS.md)
  `modelSelector.ts`), by walking a rerun's run level > account pin >
  organisation default > host `ATOMA_MODEL_L*`. ALL THREE TIERS MUST RESOLVE: there is no base transport,
  no `ATOMA_LLM` and no built-in default since 2026-09-07; a tier no level
  can honour refuses the run and names the two ways out (a Settings choice
  whose vendor key the organisation saved, or a host pin beside its
  credential).
- An `api:` selector is honoured when its vendor's credential is available to
  THIS run: the organisation's OWN key first, else the host's. One answer PER
  VENDOR, because a vendor's credential is one environment variable and every
  tier on that vendor shares it. A BYO-only deployment carrying no platform
  key at all is therefore a supported shape, and an org key WINS over a host one.
- `ANTHROPIC_AUTH_TOKEN` is REFUSED, not ignored, when an `api:anthropic`
  tier takes the host credential. No tenant can supply one (the org key store
  is keyed by vendor, and anthropic's credential variable is
  `ANTHROPIC_API_KEY`), and a bearer is refreshed from a login profile the
  run child cannot read — a frozen env snapshot would expire mid-run.
  Operator LOCAL runs keep it ([src/run](../run/AGENTS.md)).
- An `api:ollama` selector is honoured only where the HOST declared its
  endpoint: `OLLAMA_BASE_URL` is forwarded on every run (self-hosted selects
  no payer), and without it the pin falls through like a keyless vendor —
  presuming localhost is exactly what detonates. The endpoint is the
  operator's infrastructure: an org picks ollama models, never an ollama
  destination (a tenant URL would be SSRF from the platform's own process).
- For ordinary tiers, only their RESOLVED vendors' credentials cross into the
  child, and a BYO key crosses WITHOUT the host's gateway variables
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, …): a tenant's key belongs to its
  own issuer, the host's gateway applies to the host's own credential only.
- Shared tissue authorship captures the HOST's `ATOMA_MODEL_L3` and credential
  before customer overrides; [contract](../../docs/decisions/tissue-routing-2026-10-02.md) owns authority, the envelope and subprocess isolation.
- Decision's `TYPESAFE_API_KEY` and `ATOMA_JEV=1` cross into EVERY organisation's runs;
  host `ATOMA_JEV=0` forwards only that switch, so logs explain the refusal.
  Decision receives task, catalog, plan and result text as a third party, as the service
  terms state ([owner decision](../../docs/decisions/jev-decisions-2026-09-28.md)).
- `api:openai` is OpenAI's API with function tools, admissible on every tier
  from the org's or the host's `OPENAI_API_KEY`. `sub:openai`/`own:openai`
  are the Codex CLI on a ChatGPT login; L1 actions pass through Atoma's
  host-side tool loop and ToolSandbox.

## Subscription selectors
- A `sub:` selector spends the HOST's own login session (Claude Code for
  anthropic, Codex for openai) and cannot honour a supplied credential — for a
  tenant that would be one account billing another. It is ADMISSIBLE BY CHAIN
  LEVEL, not merely by value: the ACCOUNT level only. An org default is
  inherited by every member by construction, and the host env is the third
  candidate for every tier; a `sub:` at either level would be a payer-bearing
  default nobody chose, and is refused whatever the requester's flag. The
  former whole-deployment regime (`ATOMA_LLM=claude-cli`) no longer exists.
- Authority is re-asked PER RUN and is never handed in: through the
  fail-closed `resolveSubscriptionGrant`, EITHER the platform-admin flag OR a
  host-subscription delegation for this principal in THIS organisation
  ([src/auth](../auth/AGENTS.md)), plus `ATOMA_HOST_SUBSCRIPTION_ORG` naming
  the ONE organisation where the operator's own login may be spent, plus a
  match against this run's org. Both resolvers fail closed, and the run is
  never told which one answered. A stored pin is data; permission is not
  storable. `platformAdmins` is passed
  to the coordinator as a QUESTION, never as an answer — absent resolver,
  `false`, or a throwing resolver all mean refusal — deliberately the opposite
  of `tierModelsFor`, which is fail-open: a preferences lookup must not block
  a run, an authority lookup must never be read as permission to spend.
- FALL-THROUGH IS PERMITTED WITHIN A PAYER; REFUSAL IS REQUIRED ACROSS PAYERS.
  A vendor you may not use THROWS, a credential nobody brought CONTINUES. A
  revoked authority is the first kind: falling through would change the payer
  from a subscription to a billed credential with no event anywhere, which is
  what finding 2.2 closed.
- A run is MIXED by design: `sub:` tiers spend the login, `api:` tiers keep
  their own credential, and the three-row `payers` ledger
  ([src/contracts](../contracts/AGENTS.md) `runPayers.ts`) names each. The
  ledger is what fires `onSubscriptionTransport`, journaled by the caller as
  `run.host_subscription` (severity `security`, never pushed) — the
  coordinator emits no audit row itself, so there is one delivery path, as
  with `onRunFinished`. A run touching a subscription forwards no
  `ANTHROPIC_BASE_URL`, and `ATOMA_SUBSCRIPTION_TIERS` names exactly the
  authorised tiers for the child's own gate
  (`assertTransportHonoursCredentials`, [src/run](../run/AGENTS.md)).
- The selector travels into the child AS STORED — it is the routing identity —
  and the child refuses any `sub:`/`own:` tier its parent did not list. The
  stored value is data; the two authority checks are what make it a transport.
- Design and the owner's decisions:
  [records/designs/subscription-per-tier-design-2026-08-28.md](../../records/designs/subscription-per-tier-design-2026-08-28.md)
  (its `host-subscription:` / `claude-cli:` spellings predate the selector
  grammar of 2026-09-07).

## Per-tier personal subscriptions
- `own:openai:<model>` and `own:anthropic:<alias>` are ACCOUNT-only selectors
  on any tier, resolved at launch from the requester's exact private generation
  (payer `principal-subscription`): Codex gets `CODEX_HOME`/`CODEX_SQLITE_HOME`,
  Claude Code gets `CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR` (beta,
  2026-10-08). A run never mixes the host's and the requester's login of one vendor.
- Missing, revoked, wrong-chain-level and mixed host/personal Codex profiles
  THROW. None may fall through to a host login, organisation key or lower
  preference level. Disconnect is refused while that principal has an active
  run, so credential deletion cannot race an already captured generation.

- The door does NOT change what a project run may learn or execute. That is
  stated once, under "What a tenant run may learn" below.

## Readers outside this subsystem

- Public run `durationS` is persisted project elapsed time (`endedAt` minus
  `startedAt`), including host finalization, not the narrower trace duration.
  A missing endpoint or reversed interval remains unknown (`null`).
- `listLiveRunTraces()` is the ONE read that exposes which project runs are
  executing, shared by the platform-admin live listing and the sentinel
  ([src/sentinel](../sentinel/AGENTS.md)). It has to: each project run writes
  into its own `runs/<runId>/traces` directory, so there is no shared index to
  poll and `status = 'running'` is the only fact. Cross-org by construction,
  like `listAllRunTraces`, because its caller is platform-wide.
- `listRunsRequestedBy()` is the MCP's task listing ([src/mcp](../mcp/AGENTS.md)):
  one principal's runs in its own organisation, live or ended since a cut-off,
  keyed on who STARTED the run, never on who may read it (a platform admin too).
- `listShowcaseRuns()` is the public showcase's ONE read
  ([src/viz](../viz/AGENTS.md#public-showcase)): delivered, not a rerun, in a
  `listed` or NULL (pre-2026-10-06) project, REQUESTED BY THE PLATFORM ADMIN WHO
  FOUNDED (first member) AND STILL OWNS THE RUN'S ORGANISATION, never a client
  one they joined, even as owner (owner decision 2026-10-09); read per query.
  `hidden` (the creation default since 2026-10-10, opt-in `listed`; later
  `setProjectShowcase`/MCP `atoma_project_showcase`, journaled, caller's
  organisation only, 409 unless such a one) keeps the runs off; other values hide too. Projects of `showcaseOrganisations()` (same pairs)
  alone carry `showcase` and `showcaseShown` (a run in this read, page served).
- `ProjectService.listProjects()` orders the public project cards by their
  newest run, or by creation before a first run. `projects.updated_at` also
  changes for repository and showcase administration, so it cannot describe
  the activity shown on those cards. Break ties by creation and project id.
- `suiteDisputes.ts` is the suite-dispute report (2026-10-17), the one body
  behind the platform MCP tool `atoma_suite_disputes` and `projects disputes`.
  Cross-org by construction, it opens only runs whose stats count a dispute or
  have none, then the later runs of the projects that counted one, and reads
  their `id`, `provenance`, `suiteDisputes` and `result` members through
  `withTraceDocument`, one trace per event-loop turn. It journals nothing (its
  MCP door does) and writes nothing; units, clusters and outcomes are defined
  in its header ([pre-registration](../../benchmark/suite-dispute-2026-10-17/PREREGISTRATION.md)).
- Such a reader must not WRITE here. A `running` row that outlived its process
  is repaired by `reconcileInterrupted` at the next boot, never by the
  observer that noticed it. `hasProjectTables` exists so a reader can ask
  whether this store has a control plane without `ProjectStore.open`'s DDL
  creating one.

## Run titles

- Every run that ENDS is named once (`runTitle.ts`): one line, by the HOST's
  `api:` tier-1 model on the host's credential, after the terminal transition,
  off the lease. Platform-paid: `stats` stay the run's spend, the cost is the
  title's receipt, kept under a NULL title when a paid call named nothing (never
  re-paid). A `sub:`/`own:` tier 1 names nothing: a tenant's goal must not cross
  a machine login. The trigger makes it immutable. A GitHub access interruption
  before model work is excluded, backfill included: it must spend no quota.
- It is model text: display copy beside the goal, never in a journal `detail`.

## Repository visibility

- It is chosen ONCE, at project creation, and it is IRREVERSIBLE: no update
  schema, no `UPDATE projects` touching the column, no PATCH route, and the
  HTTP transport has no PATCH method. Flipping it at GitHub instead breaks the
  project permanently — `ensureRepository` refuses a repository whose
  visibility disagrees with the row ("never a convergence") and
  `REPOSITORY_TRANSITIONS.ready` is empty, so the row can never be reconciled.
  The create form says so; anything that offers to change it later is lying.
- `DEFAULT_REPOSITORY_VISIBILITY` in [src/contracts](../contracts/projects.ts)
  is the ONE definition, read by the schema default and by the create form, and
  it is `private`. The reasons are recorded beside it, including the one that
  decides it: nothing in this pipeline reviews what gets published — the file
  set is the finished workspace inventory, the filter is filenames only, publication
  follows client acceptance — so a
  public default hands an unreviewed set to the internet whenever nobody looks.
- A new empty repository is created at PUBLICATION, not at project creation, so a
  project sits at `repository_status = 'pending'` until its first delivered
  run. Everything about the target is therefore validated late: create-project
  checks only that the installation row is active and belongs to the viewer's
  organisation.
- A failed repository creation is recorded ON THE PROJECT ROW (`failed` plus
  `repository_error`), not only on the publication. It used to stay `creating`
  with a NULL error, indistinguishable from a publish in flight sitting above a
  green delivered run. `failed → creating` is allowed, so it stays retryable.
- Every transition here is a compare-and-set, so the publisher reads the
  repository status FRESH from the store rather than from the caller's
  `Project` snapshot — a retry's snapshot is as old as the attempt that failed.
- A `ready` repository is not re-derived: its receipt on the row IS its
  identity. Calling GitHub again would fail the terminal `ready` CAS, which is
  what made a retry-after-failed-commit impossible.
- ONE PROJECT PER REPOSITORY, per organisation, and the comparison FOLDS CASE
  because GitHub does. `acme/Site` and `acme/site` are one repository there and
  were two rows here, so the collision that creation-time refusal exists to
  catch came back at the second project's first publish as a permanent
  `GitHubDivergenceError`, after the run and the spend. The unique index is on
  `lower(owner)`/`lower(name)` under its own name; the COLUMNS keep the
  spelling the tenant typed, because that spelling is what `ensureRepository`
  asks GitHub to create. A store already holding such a pair cannot take that
  index — and needs it most — so it keeps the binary one, is told which pair to
  resolve, and still OPENS.
- Creating a project is ONE `BEGIN IMMEDIATE` transaction: both identity checks
  and the INSERT. Two processes write this file (the route and the CLI), and
  outside a transaction the loser of that race met the index instead of the
  typed conflict, so the caller got a driver's UNIQUE prose naming an index
  rather than a 409 naming the holder.
- HTTP 422 from repository creation is NOT proof the name is taken — an
  account can also refuse to create a repository of that visibility, and
  `GitHubApiError` carries no body to tell them apart. Say what is known.

## What a tenant run may learn

- Approved learning runs after the source run's lease is released. Dispatch
  rechecks membership and the original selectors/payer; it never saves keys or
  permission to spend. `ProjectRun.learning` reports its separate costs/status.
  Active learning also holds the requesting principal's profile-change guard.
  [Recovery and accounting](../../docs/decisions/approved-learning-2026-10-11.md).

- SKILL LEARNING IS ON (`ATOMA_SKILL_LEARN=1`, `ATOMA_EVENT_SKILLS=1`). It is
  the point of the platform: a tenant's runs get cheaper as their project
  grows. It was off, and two delivered runs measured the cost of that —
  $0.59 spent, `learnedSkills: 0`, nothing carried forward.
- `ATOMA_SKILLS_DIR` points at the host's ONE catalog, and `ATOMA_DB_PATH` at
  the host's ONE registry: a tenant run reads and earns exactly what every
  other run does ([platform trust record](../../docs/decisions/platform-trust-2026-09-15.md)).
  New run receipts persist the selected skills path, and launch authority
  (`assertProjectRunAuthority`) compares workspace, runs and skills paths to
  that receipt before any writable handle — it gates the launch, never the
  rows. Legacy receipts retain their recorded layout. The coordinator folds
  old partitions with backups before admitting new work
  ([skill storage contract](../skills/AGENTS.md)).
- PROMOTION, DETERMINISTIC DISPATCH and the PREFILTER CACHE follow the same
  defaults as any run on the host (a run is a run,
  [platform trust record](../../docs/decisions/platform-trust-2026-09-15.md)): promotion
  is on unless the host env turns it off, dispatch is on unless it says
  `ATOMA_SKILL_DIRECT=0`, and the cache is the platform's. The coordinator
  pins none of them and sends no veto flag; the one thing a tenant launch
  insists on is `--container`. A host that wants a lifecycle stage off says
  so in its own environment, for every run alike.
- A measurement that depends on PROMOTION or deterministic dispatch therefore
  still cannot be run as a project run. Learning, now, can.
- A FAILED run records what it cost. The outcome vocabulary is
  `delivered | failed | error | cancelled`, and the failure path used to
  enumerate two of the three non-delivered values, so the ordinary
  `outcome: 'failed'` had its stats dropped — measured on a real tenant run:
  $1.10 over 41 calls, persisted as `stats_json = NULL`. `delivered` is the
  only outcome that cannot ride a failure; the store refuses the remaining
  contradictions itself.

## Delivery, and the evidence it is decided from

- Declared text deliveries retain their answer in the trace and may have an empty
  inventory; they never preview or publish, even with input files. Empty partials
  remain partial; ordinary empty file deliveries still fail. Legacy hashes stay.
  [Contract and evidence](../../records/incidents/text-delivery-2026-10-02.md).
  `previousResultsFor` carries text from at most three actual seed hops as bounded untrusted context, oldest first, preserving status and marking truncation/unavailability. Comparisons use their origin's seed; fresh imports inherit none. No new store or publication decision. [Review](../../docs/decisions/text-review-and-history-2026-10-03.md).

- New delivery manifests inventory every publishable regular file in the
  finished workspace, including files child work added after the root plan.
  `source: workspace` distinguishes them from legacy plan-only manifests;
  existing hashes and rows are never rewritten. The root plan declaration is
  retained as run evidence, not used as the publication file allowlist.
- Inventory uses the existing path jail, size/count limits and exclusions.
  Internal records, VCS, dependencies, workflows and secret-like paths are
  excluded before traversal; other symlinks and special files refuse delivery,
  except entries that hold no bytes: sockets, FIFOs, and links whose target
  exists nowhere and names no existing workspace path, here or under the
  workers' `/workspace` mount (Chromium's `Singleton*` links that run 40c20c5d's
  own tests left at its root; the profile files beside them hold bytes and
  are inventoried like any other). They are never followed, published or
  seeded (`byteLessWorkspaceEntry`: the next run's checkpoint refuses them);
  they stay out of the manifest and its hash and are listed, bounded, once in
  the run log (by the export that wrote the copy, for Compute runs). A link
  that resolves still refuses, and one that starts resolving refuses at
  revalidation. Inventory, device export, revalidation and seeds share it.
  `WORKSPACE_LIMITS` is shared with import and sync: 100,000 files, 10 MiB
  per file, 512 MiB total. Text and file deliveries use the same inventory.
  Publication loads bytes lazily and sends only changed files for existing
  repositories; commit messages show a bounded path excerpt, never reject a
  delivery because its complete file list would exceed GitHub's message bound.
  Revalidation of a workspace manifest compares the complete inventory again,
  so added files cannot silently miss publication after delivery.
- Delivery status and its manifest commit in one SQLite transaction. A failure
  rolls both back; previews and publication run only after that transaction.
- The viz workspace reader exposes only a terminal run's manifest paths, under
  project/org read authority. Reuse the artifact jail and hash validation for
  file bytes; no directory traversal, live worker reads or host paths in replies.
  The legacy JSON text reader stops at 256 KiB. File preview bytes stop at
  10 MiB and are returned as attachments with no-store and nosniff.

- DELIVERY IS DECIDED FROM SIX DEPTH-1 TRACE MEMBERS, never from the whole
  document. `verifiedTrace` reads `id`, `endedAt`, `cancelled` and `degraded` as
  values and `result`/`error` as shapes, through
  [`readTraceTopLevelFields`](../contracts/AGENTS.md). Its three refusal
  messages are unchanged; what changed is that a trace is no longer refused for
  being large. Delivered run `2857a579` wrote 781_071 bytes, passed every
  semantic check, and was recorded `failed` by a 524_288-byte cap — which also
  made the NEXT run of that project seed from an older workspace, silently
  skipping the work, because `previousDeliveredWorkspace` reads only rows whose
  status is `delivered`.
- First publication checkpoints its root seed in the private
  `project_publications.seed_commit_sha` column before uploading the rest.
  It is scoped to the same org/publication and survives failed retries and
  restarts; it is never inferred from a ready repository or an observed head.
  The exact retry authority lives in [src/github](../github/AGENTS.md).
- `MAX_CONTROL_JSON_BYTES` now governs `declared-artifacts.json` ALONE, and the
  difference between the two files is the whole point: a declared manifest is
  small by contract and its CONTENT is model-chosen, so a size bound plus a
  whole-document parse fits it; a trace is a control-plane-owned path whose
  SIZE grows with the work. Bounding them the same way is what caused the
  erasure. Do not reunify them.
- Host-side finalization failures retain the runner's measured spend. The
  project stats outcome becomes failed/cancelled to match its persisted status;
  the original runner outcome remains in the trace. No delivered stats are
  attached to a failed row, and no paid work disappears from the accounting.
- PUBLICATION IS A SEQUENCE, one row per run, and only a client-accepted delivery reaches
  the repository. Exactly one commit used to be possible per project, because
  `repository_status = 'ready'` is terminal and routed every later run into the
  first publication's empty-branch refusal. `ready` means the repository EXISTS
  and never that it is current; the authority to commit onto an existing branch
  is `lastPublishedCommitForProject` — this project's own last published commit
  — passed to the client as `expectedHead`
  ([src/github](../github/AGENTS.md)).
- `base_sha` on a publication row is an OBSERVATION, never a pointer anything
  decides from: the head found before publication (the captured run base for
  imported projects). NULL means
  it created the branch, and `commit_sha = base_sha` means the attempt added no
  commit because the branch already held the manifest. There is deliberately NO
  last-published column on the projects row: "is the branch where we left it"
  is answerable only by GitHub, and a stored head is a cache of state GitHub
  owns — a stale one is how a wrong divergence verdict gets manufactured.
- Publication retries take the run lease. A queued/running run or newer accepted lineage run refuses
  an older publication (`PublicationSupersededError`); PR mode is independent. An older run published
  after a later one synced is Atoma's write: it advances that run's base, never a conflict (review 1.3).
- STALENESS IS A QUERY, NOT A COLUMN. How far behind a repository is = delivered
  runs of the project newer than the last published one, which `projects list`
  prints. A project can sit at `ready` over a repository several runs old.
- A publication failure NEVER changes a delivered run's status. The run was
  delivered, the cost is real, `previousDeliveredWorkspace` seeds from
  `delivered` rows, and a `failed` row may not carry `delivered` stats — marking
  it failed would rebuild the measured cost erasure and silently stop seeding.
  The operator surface is `publication.failed` plus the publication status
  beside the run, and `projects run` now exits non-zero when a publisher is
  configured and the publication did not reach `published`.

## The run budget

- ONE place decides how long a project run may take: `projectRunTimeoutMs`,
  which reads an explicit argument, then `ATOMA_PROJECT_TIMEOUT_MS`, then the
  eight-hour default, and REFUSES anything malformed or outside 60s..28800s
  rather than falling back — a run that quietly gets the default when the
  operator asked for 40 minutes is the same defect wearing a different hat.
- `ATOMA_BUILD_TIMEOUT_MS` is the CHILD's variable and is inert on the host:
  `spawnRun` writes it from this value AFTER spreading the caller's
  environment, so an exported one is overwritten. That is why "raise the
  timeout", which run `949ecd5d`'s post-mortem advised after dying at 900s on
  68 tool calls and $0.96, was unreachable advice until the lever existed.
- The DEFAULT and maximum are eight hours (owner, 2026-10-23). The default
  was raised from 30 to 60 minutes on 2026-09-22 after two production
  runs died at exactly that wall clock having spent $2.83 and $3.50. It is the
  smaller half of that answer: a bigger budget only moves the cliff, and what
  stops the loss is that reaching the deadline now LANDS
  ([src/atoms](../atoms/AGENTS.md)) and records `partial`.
- THE PREPARATION IS NOT BILLED TO THE RUN. The repository import and the
  corpus build happen before the child is spawned and have their own ceiling,
  `PROJECT_RUN_PREPARATION_TIMEOUT_MS`; the tenant's clock starts when the child
  does. `deadlineAt` used to be stamped above that work and the child got the
  remainder, which is the arithmetic behind `run aborted after 1787s budget` on
  a 1800s setting. Moving it off the budget must not make it unbounded.
- A platform admin may re-state the default and only NARROW the ceiling, per run: [src/platform](../platform/AGENTS.md).

## A landed run: `partial`

- `partial` is TERMINAL and is not a failure: the run reached its budget with
  phases already accepted and reported those, or a phase failed its typed
  checks and its dependents were never started (`blockedPhases`) and the
  run's one extra root pass could not run them (src/run, G1); a follow-up the
  clock cut adds its planned phases as unfinished. It reaches the store through the
  same `completeProjectRun` transaction as a delivery — same trace bar, same
  workspace manifest, same atomicity — and differs on exactly three points.
  It may carry an error string, because the phases it never ran are worth
  naming and no other field says so; its files remain downloadable, but it is
  never offered as an executable preview; and it NEVER publishes.
- Publication stays `delivered`-only, by the operator's decision of 2026-09-22.
  The customer's repository is the one surface where an incomplete artefact set
  would be indistinguishable from a finished one once it landed.
- For projects without an imported repository, `previousSeedRun` (formerly
  `previousDeliveredRun`) takes a landed run too, and
  that is the half that actually recovers the spend: the next run continues
  from the phases that did complete instead of rebuilding them. Retention and
  the retrieval source follow it, so a landed seed is held like any other.
- The status CHECK on `project_runs` was widened by a TABLE REBUILD
  (`migrateProjectRunsForPartial`), because SQLite cannot relax a CHECK by
  `ALTER TABLE` and a store created before that date would refuse every landed
  run. The copy is driven by the OLD table's column list so the additive
  migrations below it are not silently dropped.

## Client acceptance before publication (owner decision 2026-10-08)

Delivery makes the result available for testing, never publishes automatically.
`project_delivery_acceptance` binds the manifest hash, member, time and review
in the product store; immutable, it survives errors/restarts. `atoma_run_accept`
and HTTP record it, then publish files. Text-only results need no publication.
Model acceptance is not client consent. All publication paths, including CLI retries, meet the store's
`assertPublicationAccepted` gate before remote writes. Previously published
receipts stay historical facts without invented client acceptance.
Newer unaccepted candidates do not supersede older accepted versions; accepted
or published ones do. GitHub divergence, byte, lease and scope checks remain.

## Publication read receipts

- The persisted `git` receipt records the actual branch, base branch, default
  branch, publication kind and direct/PR mode returned by the publisher. Legacy
  rows stay null; never infer their destination from today's project branch.
- Public run readers (HTTP, MCP and task results) expose this receipt with the
  repository, commit, parent, PR URL, error and timestamps. `remoteState` is
  `not-checked`: these reads do not query GitHub. A PR's `mergeStatus` stays
  `unknown`; publication never establishes a later merge or current branch head.

## What a published commit says

- The commit message is a PRODUCT SURFACE: permanent, in the tenant's own
  repository, and public if they chose a public one. It is rendered once, by
  `publicationCommitMessage`, and its shape is a decision rather than a format.
- SUBJECT: the goal through `eventLabel`, cut at a word boundary. BODY: the
  provenance, the paths this commit actually writes, and the goal in full. TRAILERS:
  `Atoma-Project` and `Atoma-Run`, so a machine can read them.
- The body labels workspace inventories as delivered files and legacy
  manifests as declared files. Publication still merges onto the parent's
  tree: additions and updates are supported; deletion remains unimplemented
  and must never be inferred from a legacy manifest's absent paths.
- The goal is quoted INDENTED, and that is a guard, not a style. Git trailers
  are unindented `Key: value` lines at the end, and a goal is up to 4 000
  characters of tenant text that permits newlines — so a goal shaped like a
  trailer would forge one. `git interpret-trailers --parse` is the authority
  that it does not, and a test uses it.
- OMITTED ON PURPOSE: the parent and created-versus-extended, because those are
  first-class git fields and naming them in prose would both duplicate the
  commit's own metadata and be decided BEFORE the head is read; cost and call
  counts, because they come from the run log, a channel a tenant's goal can
  write into ([src/cli](../cli/AGENTS.md)) — a git history must not carry a
  number the tenant can influence, and the journal already has it; and the trace
  id, which means nothing outside this instance.

## Starting from GitHub

- Missing installation repository access is stored as typed `githubAccess`
  on the run, never inferred from error prose. A refused preparation keeps its
  failed audit row; the UI presents authorization required. Continue verifies
  GitHub again, then reuses the saved goal, criteria and depth with a stable
  retry key, records its successor and permits only the original requester.
  Delivered work retries publication alone. Normal admission and publication
  gates still apply; no new GitHub grant is made by either resume path.

- `repositoryTarget.source` explicitly distinguishes work on an existing
  repository (one PR per changed delivered run) from a fork (direct commits).
  Creation reads the source identity and visibility; the first fork run creates
  the real GitHub fork. Imported runs snapshot the current default branch before
  model work instead of seeding the previous delivered workspace. Merge a PR
  before starting work that depends on it. Forks advance their own branch.
- The captured `repositoryBase` is the PR parent; fork publication plans against
  the live fork head, preserving concurrent edits. `followUpstream` is fork-only,
  off by default, admin-settable and journaled. Merge failure never refuses a run.
- Projects Atoma created reconcile the prior workspace with GitHub before model
  work. `project_run_repository_sync` stores an immutable per-run BASE outside
  strict legacy JSON columns. `planRepositorySync` owns the one per-path rule at
  start and publication; client changes win. An explicit seed's verified bytes and mode matching the live head may advance the publication base even without a ledger receipt; unavailable/changed seed evidence grants no authority. Prior workspaces stay untouched.
  Published runs owe only tombstones; other runs owe their difference from BASE.
  Hard-linked seeds replace by unlink/create and pass the delivery inventory.
  Unavailable sync fails open; unresolved debt refuses publication. See
  [design and measurements](../../docs/decisions/repository-sync-2026-10-07.md).
- Materialised seeds retain landing/text history but invalidate standing HTTP
  evidence across their boundary. Comparison reruns reuse the recorded seed
  directory, including reruns of reruns; an expired directory refuses comparison.
- Push observations notify once per project between runs; they never start work.
  Source choice is immutable; imported visibility is inherited.

## Retention and admission

Finished run bytes are eligible after 90 days; current active-project seeds
and unfinished publications hold them. Offline maintenance preserves run
metadata, payers and lifecycle_events; expiry never changes delivery status. Complete Compute initial-state captures share the byte lifecycle; pending validation holds source/reference runs, and expiry invalidates captures containing expired read-run copies.
Per-org admission defaults to one (zero suspends), with a configurable project-run ceiling (10 by default)
on the host. Waiting rows hold no lease, survive restart, and can be cancelled. Dispatch rechecks membership, models and limits; its lease reserves the organisation before preparation, through
cleanup and publication; excess global demand persists as queued runs and resumes FIFO. Recheck inside reservation after idempotency; an
identical live request (goal, items, depth) re-attaches, any key; refusals name it.
Operator commands and offline prerequisites: [W9/W10](../../docs/project-maintenance.md).
The coordinator can additionally queue on Linux `MemAvailable` with
`ATOMA_RUN_MEMORY_RESERVE_MB` (unset/0 disables it). The first run remains
admissible; recent admissions reserve growth headroom for seven minutes.
Recheck after asynchronous preparation, immediately before starting the run;
exclude that run's already-acquired lease, since its base reserve counts it once.
Operational ramp-up: [maintenance](../../docs/project-maintenance.md#memory-aware-admission-and-store-pressure).

## A landed run, from the tenant's side

- `partial` is a run that produced real work and did not deliver it, for either
  of two reasons that compose: the deadline left phases unrun, or root delivery
  acceptance refused the result. `landedRunDetail` reports BOTH — reporting only
  the phases drops the half a customer needs, which is that the work was judged
  and found wanting rather than merely cut short.
- It NEVER publishes (three gates, all keyed on the row status) and is NEVER
  offered as a preview. The second is a deliberate refusal rather than an
  inheritance from the delivered case: the preview runtime EXECUTES the
  workspace and serves it, so previewing a refused deliverable would hand the
  customer, running, the artefact the judge called unproven.
- It DOES seed the next run (`previousSeedRun`), and that is the half that
  recovers the spend. WHY it did not deliver travels with the bytes, as
  `PREVIOUS_LANDING_ENV` in the child's environment and `Task.inputs
  .previousRunLanding` at the other end — never argv (`parseRunnerArgs`
  discards an undeclared flag with a warning, argv is the E2BIG surface the
  goal already fills, and it is world-readable in `ps`), and never on a
  repository-backed project, where `seedFrom` is replaced by a fresh repo-HEAD
  snapshot and the refused workspace never reaches the child.
- Use typed `stats.landingReasons`, never the row's error string. The tenant's
  goal is echoed into the log, so a forged early banner must not win.
  `parseRunStatsEpilogue` keeps the LAST valid object; `landedRunDetail` falls
  back to the banner only to say THAT a run landed, never why.
- `verifiedTrace` separates INTEGRITY from PUBLISHABILITY. A failed or
  cancelled trace is never recordable; `degraded` refuses only a run that would
  publish. A refusal reached after a deepening is degraded by construction
  (`viaFallback`), so checking it on the landed path coerced the run straight
  back to `failed` — the feature would have been inert on one of its two
  production shapes while appearing to work.

Explicit `baseRunId` selects a retained delivered/partial non-comparison workspace;
request identity is immutable and launch rechecks bytes. Its BASE/corpus follow it,
without GitHub refresh. Default seeding stays. `acceptedReferenceRunId` exposes the
newest accepted run by creation order; retention holds it and active iteration bases.
Selection never grants publication. Review cases: [checkpoint contract](../../docs/decisions/run-checkpoints-2026-10-08.md).

`readRunIds` (one to three, stored sorted, immutable, in both identity comparisons) names runs
whose saved files a run may READ: each what a `baseRunId` must be, 64 MiB and 10,000 files
together (refused before any hashing, never trimmed), bytes re-read at admission and at launch.
The launch index (`<runRoot>/read-runs.json`, 0600, named by `ATOMA_READ_RUNS`) carries their
manifests. A rerun reads its origin's, refused once one expired; a continuation its source's,
from stored manifests. ONE predicate, `projectRunContinuable` (paused, or recoverable), decides
both: retention holds them while a reader is queued, running or continuable (on the plan's
read-only handle), and a reader that ends and cannot be continued has its own `.atoma-runs`
removed once its manifest and preview are built, and from its checkpoint snapshot
(`forgetReadRunCopies`); a continuation's end also releases the run it consumed, and boot
releases runs a restart failed with theirs. A removal logs, never throws. Never a seed, never delivered:
[decision](../../docs/decisions/read-runs-2026-10-17.md). `iterationEligible` is the ONE rule a base or
read run meets (`iterationBase` refuses by it); readiness offers `selectableRuns`, at most 8 eligible runs
among the newest 40, and a conversation proposal names only runs `checkReadRuns` (`readRuns`) admits: when
it is saved, and again before its approval is claimed.

## Comparison reruns
- File comparisons are a separate read: `compareRuns` shares workspace
  authority, retention and path filtering, then compares saved manifests.
  Pagination snapshots bind both run identities, both manifest hashes and
  search. Counts cover all files; search filters changed-file pages only.
  Legacy declared inventories are explicitly incomplete; missing membership
  never proves a repository deletion. Byte integrity remains the file reader's job.

- `{rerunOf, models}` reruns a delivered or partial run on other models with
  ITS goal, ITS acceptance list (a drafted one is recovered from its trace and
  carried as `drafted`) and the seed IT started from (`seed_json`, recorded for
  every run; a legacy row through its retrieval receipt). Run-level models
  REFUSE rather than fall through; the stored row is read by spelling only
  (`storedRunTierModelsSchema`), the catalogue asked at the door and at launch.
  An unrecoverable drafted list is refused; an origin judged without one reruns
  without one. A rerun never seeds (`previousSeedRun`) and never publishes.
  Imported projects are refused. [Contract](../../docs/decisions/comparison-reruns-2026-09-25.md).

## Pausing and continuing validated work

Deep non-comparison runs enable root phase checkpoints. Pause is a durable request
observed after a complete approved sequential phase; it never interrupts a tool.
The runner drains its backend before making the boundary resumable. Paused runs
remain `partial`: no preview or publication before fresh final acceptance.
Only the original requester, still an active member, can pause or resume through
the same-origin service routes. `resumeOf` is immutable and part of request
identity. Admission, queue dispatch and payer authorization are unchanged.
A continuation gets a new run, trace and sealed workspace copy (Compute paths belong to its execution host, not the control plane). It retains the
original repository sync BASE, goal, criteria, plan and cumulative budget; it
never refreshes GitHub HEAD and calls that a continuation. No proof is inherited.
Readers expose phase state and blocking client questions. Retention holds a paused boundary
or a source needed by queued/running continuations. A failed pre-launch attempt
can retry while the source is still ready. Failed interrupted runs may recover
from a sealed snapshot when the journal permits it; blocked reasons are projected
to the requester. Their retrieval corpus stays the recorded starting corpus.
See [checkpoints](../../docs/decisions/run-checkpoints-2026-10-08.md) and [client questions](../../docs/client-questions.md).

## Host latency receipts

The existing coordinator/driver records preparation, process, process finalization,
customer-compute handoff, host finalization and detached naming in an optional
host-owned timing sidecar beside the trace. Transfer failures record elapsed time
without claiming completion; failed timing writes never affect admission, leases,
acceptance, publication or the immutable child trace.

## Intentional choices and rejected shortcuts

- Launch passes a bounded `repositoryPreparation` receipt from persisted host
  preparation to the runner. Snapshot import, synchronization, selected versions,
  comparisons and resumes remain distinct; unknown outcomes never become success.
  Compute progress is a read-only projection of the dispatch journal and exact
  stop acknowledgement. `stop-confirmation-pending` never releases the slot.
- Automatic Compute finalization (2026-10-25) lives in the executor's control
  poll, not in the gateway's connect callback: a connection arrives before its
  launcher reports the old stop, so that attempt would meet a held slot, and the
  poll owns selection, demotion and restart. Refused: a retry timer blind to
  connections (an export per tick against an absent device), resetting the
  count on each new connection (every attempt's close makes one: an export
  every 6 s), and a durable counter (the journal is the state).

- The project learning reader shares one org-authorized body across HTTP/MCP, including deferred-worker ledger provenance. Read-only, bounded and explicit about coverage: [contract](../../docs/decisions/prompt-consolidation-2026-10-12.md).

- Hosted update on acceptance, client-sequenced Stop then Deploy or put-back,
  stateful blue-green: refused ([why](../../docs/project-hosting.md#updating-an-application)).
  So are a one-probe health verdict and a 503 for strangers (it names live addresses).
- Reading egress settings, or an ollama destination, from a tenant prompt:
  refused; both come from the HOST snapshot ([tier selectors](#tier-selectors-and-credentials)).
- A `sub:` selector as a deployment-wide or organisation-wide default:
  refused whatever the requester's flag: a payer-bearing default nobody chose.
- Storing the authority to spend a subscription: refused, and this is the
  sharpest line here. A stored pin is DATA; permission is not storable.
  Authority is re-asked per run through `resolveSubscriptionGrant`, both
  resolvers fail closed, and the run is never told which one answered.
  `platformAdmins` reaches the coordinator as a QUESTION — absent, `false` or
  throwing all mean refusal — deliberately the opposite of `tierModelsFor`,
  which is fail-open: a preferences lookup must not block a run, and an
  authority lookup must never be read as permission to spend.
- Falling through to a host login when a personal Codex profile is missing,
  revoked or mixed: refused, it THROWS. Fall-through is permitted WITHIN a
  payer and forbidden ACROSS payers.
- Byte-less inventory entries (2026-10-25): excluding Chromium's `Singleton*`
  names or profile directories was refused (a vocabulary-frozen detector),
  so was omitting every symlink (a link that resolves is part of what the
  application reads), and so was judging a link absolute `/workspace/...` by
  this host alone (the device's service sees `/workspace/current`). Recording
  omissions in the manifest was refused too: copies never hold them, so every
  transfer revalidation would disagree with its own manifest. Accepted
  trade-off: a link naming no workspace path is `stat`-ed on the host doing
  the inventory (the control plane for hosted runs), so success against
  refusal tells a member whether that host path exists: one bit per paid
  run, never a byte or a name. Not stat-ing it means omitting every such
  link, one the application reads included, or refusing them all, run
  40c20c5d's `/tmp` links included.
- "Results waiting" from the trace's `endedAt`, row age or error text; telling
  again per reconnect; a clock reset by every driver stop (failing automatic
  attempts would postpone the notice forever): refused. Claim first, then journal.
- Letting a reader repair a `running` row it noticed: refused. That is
  `reconcileInterrupted`'s job at the next boot. `hasProjectTables` exists
  precisely so a reader can ask about the control plane without triggering
  `ProjectStore.open`'s DDL.
- Offering to change a repository's visibility later: refused, and anything
  in a UI that offers it is lying. `ensureRepository` refuses a repository
  whose visibility disagrees with the row ("never a convergence") and
  `REPOSITORY_TRANSITIONS.ready` is empty.
- A public repository default: refused. The published set is the finished
  workspace inventory, the filter is filenames only, publication follows explicit
  client acceptance, and the manifest never crosses the API — so a public default
  would hand an unreviewed set to the internet whenever nobody looks.
- Creating the repository at project creation: deliberately not done. It is
  created at PUBLICATION, so a project with no delivered run leaves no empty
  repository behind.
- A rerun seeded from the project's latest run, redrafting its list, or
  publishing on delivery: refused — each compares two different requests.
- Reading another run through a mount, a link, a new element or a whole
  workspace copy: refused ([read runs](../../docs/decisions/read-runs-2026-10-17.md)).
  Only its saved manifest is copied, with its modes, and checked at acceptance.
- Resolving the request-key conflict outside a transaction: refused. Two
  processes write this file, and the loser of that race met the index instead
  of the typed conflict, handing the caller a driver's UNIQUE prose naming an
  index.
