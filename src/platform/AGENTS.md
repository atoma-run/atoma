# Platform — AGENTS.md

`src/platform/` owns the control-plane audit journal — the one source of
notifications — and the platform run limits a platform admin may re-state.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
This file is the whole platform-events and platform-settings contract.

Neighbours:

- [`src/contracts`](../contracts/AGENTS.md) — the closed kind vocabulary and
  the settings catalog
- [`src/viz`](../viz/AGENTS.md) — the routes and push delivery
- [`src/projects`](../projects/AGENTS.md) — an emitting domain, and a limit reader
- [`src/run`](../run/AGENTS.md) — the other limit reader
- [`src/github`](../github/AGENTS.md) — an emitting domain
- [`src/auth`](../auth/AGENTS.md) — where the platform-admin flag comes from

## Contract

- PLATFORM EVENTS are the control-plane audit journal (`platform_events`,
  gated deployments only) and the ONE source of notifications. Emitters
  journal a fact; `PUSH_ROUTES` decides who hears about it. Nothing may
  call the notifier directly — that is what keeps every push attributable.
  - `src/contracts/platformEvents.ts` owns the closed kind vocabulary.
    Severity is derived from the kind in one exhaustive
    `Record<PlatformEventKind, …>`, so one kind can never be journaled at
    two severities, and `PUSH_ROUTES` is exhaustive too: a new kind does
    not compile until its severity AND its audience are stated. `null`
    means journal-only, which is the answer for most kinds — a short push
    list is a credible one.
  - `PlatformEventLog.append` is FAIL-OPEN like the ledger, but louder:
    each distinct failure reason warns once on one compacted line, with
    the reason set bounded. Every untrusted string entering a `summary`
    goes through `eventLabel` — the log drops what it cannot store, so an
    unbounded display name would silently lose the audit row.
  - `summary` is operator-facing English; `detail` is the machine-readable
    payload push copy renders from. Never a token (not even hashed), never
    a credential, never model-authored prose.
  - Domain modules (`src/projects/`, `src/github/`) take an injected
    `PlatformEventSink`, never a store: the dependency arrow points from
    the server at the domain, and an absent sink means "no journal".
  - The operator CLI writes its rows from its own process — audited,
    notifying nobody — so operator power changing hands survives in the
    journal with no server running.
  - Readers TOLERATE foreign rows: an unknown kind or a torn `detail`
    renders raw rather than blinding the page around it. Retention cuts by
    age (`ATOMA_EVENTS_RETENTION_DAYS`, 90d) AND by a 50k row cap, swept
    from the viz server's existing 5-minute timer — and by the sentinel CLI on
    the same cadence, since that watch writes rows on ungated checkouts where
    the server's timer does not exist. Any resident writer sweeps, or it is a
    writer with no retention.
  - `platform_events` carries no uniqueness over (kind, run_id, dedupeKey), so
    de-duplication by read-back is a cross-tick guarantee only. Exclusivity
    between watchers is a LEASE, not a constraint — see
    [src/sentinel](../sentinel/AGENTS.md).
  - `/api/admin/events` and `/api/admin/ledger` are platform-admin only,
    beside the registry and skill surfaces. They are two SEPARATE reads:
    `lifecycle_events` keeps its counter-checking semantics and its own
    `ledger check` consumer, and the two tables are never joined.
  - Design record and the five settled decisions:
    [platform events](../../docs/platform-events-design.md).

## Cross-organisation reads

`recordCrossOrgRead` is the strict exception to fail-open append: a missing
receipt must commit before foreign payload is returned. The one-hour receipt
is per principal and target org across HTTP/MCP, never a permission cache.
Polling hits read the journal; misses recheck and insert under an immediate
transaction. Publish only after commit, through the existing notification
router to org owners. Domains receive `CrossOrgReadSink`, not the store.
Design, polling basis and deferred tests: [W11](../../docs/cross-org-read-audit.md).
## Platform settings — the run limits an admin may re-state

- PLATFORM SETTINGS are a CLOSED CATALOG of bounded numeric run limits
  (`platform_settings`), owned by `src/contracts/platformSettings.ts`. The
  catalog IS the schema: `platformSettingOverridesSchema` and the update shape
  are derived from it, so an unknown key is a 400 and every value is bounded
  on both ends before it is stored. Never accept a free-form
  `Record<string, number>` — a settings table nobody can validate is a table
  whose rows outlive the call sites that read them.
- EVERY `fallback` IS THE CONSTANT THAT SHIPPED, verbatim, and
  `tests/platform-settings.test.ts` pins each one against the module that
  owns it. An instance with no rows must behave exactly like one built before
  the feature; a settings surface whose mere existence moved a limit would
  make the change invisible in the deployments least able to explain it.
- TWO KINDS, and the difference is the whole precedence rule. A `default`
  replaces the code fallback only when NOTHING asks — a CLI flag or the
  entry's env var still wins. A `ceiling` BINDS: a request above it is
  REFUSED (never clamped) at the launch sites that already refuse an
  out-of-range budget, and enforced mid-run where there is no request to
  refuse. `0` means "no ceiling" only for entries declaring
  `zeroMeansUnlimited`, and `ceilingOf` is the one reader of that rule.
- `resolvePlatformLimits` READS NO ENVIRONMENT. `spec.env` is metadata a
  reader displays; folding it in would create a second parser for
  `ATOMA_PROJECT_TIMEOUT_MS` and the two call timeouts beside the owners that
  already refuse a malformed value. Adding an entry whose value the resolver
  reads from env is the drift this split exists to prevent.
- READS FAIL OPEN, WRITES FAIL LOUD. `limits()` and `platformLimitsFor` fall
  back to the shipped constants — a run must never fail to launch because the
  table is absent — and a foreign or out-of-range row is DROPPED on read, on
  the journal's unknown-kind precedent. `set()` validates the WHOLE batch
  before writing any of it and throws: an admin told nothing would believe a
  limit is in force that is not.
- CLEARING REMOVES THE ROW, never writes the default back. The row's absence
  is what lets a later change to a shipped default reach this instance, and
  what makes "using the default" and "an admin chose this number" two
  distinguishable facts in the form.
- THE COORDINATOR AND THE RUNNER READ THE LIMITS FRESH, PER RUN. The viz
  server outlives every save, so `ProjectRunCoordinator` takes
  `platformLimits` as a FUNCTION — the dependency arrow points from the server
  at the domain, exactly as it does for the event sink — and resolves it once
  more at construction only to fail fast on a malformed environment. The
  runner re-checks the wall-clock ceiling itself: `spawnRun` writes
  `ATOMA_BUILD_TIMEOUT_MS` from whatever budget its caller chose, and an
  operator's own `npm run run:build` has no coordinator in front of it.
- THE TOKEN AND SPEND CEILINGS ABORT, THEY DO NOT THROW.
  `src/core/runBudget.ts` decorates the METRICS RECORDER — the one seam that
  already sees successful calls and the partial usage of failed ones — reuses
  the single cost formula, fires `onExceeded` exactly ONCE, and the runner
  aborts the run's own controller. A recorder that threw would surface a
  budget decision as a transport error from whichever call crossed the line.
  A budget abort is reported as a CEILING, never as a timeout: the run had
  wall clock left, and the failure path tests the typed reason, not the
  message text.
- A TOOL-ITERATION CEILING ONLY EVER LOWERS. A request that named no budget
  is bounded by `min(ceiling, DEFAULT_MAX_TOOL_ITERATIONS)` — a limit that
  raised a 24-iteration default to 50 would increase spend, which is not a
  limit. The default is `0` (disabled) because the tiers ask for 40 when a
  validator is attached.
- `/api/admin/settings` is platform-admin only, GET and PUT, same-origin on
  the write, beside the events and ledger reads. It answers with the CATALOG,
  the STATED rows, the EFFECTIVE limits and the current ENV value of every
  entry naming a variable — without that last field the form would show a
  default the deployment has already overridden, the omission
  `operatorDefaults` fixed on the org-models screen. The response is the
  whole snapshot on every write, so a clamp or a refusal cannot be papered
  over by an optimistic client update.
- EVERY CHANGE IS JOURNALED as `platform.settings_updated` at SECURITY
  severity, naming the keys that ACTUALLY moved with their before/after
  values, and the summary is bounded before it is emitted — the journal is
  fail-open, so an oversized row would silently lose the audit trail for the
  largest change. Journal-only, never pushed: the admin holding the form is
  the one who moved the limit, and every other admin reads the new value in
  that same screen.
- `npm run settings` is the operator path, and it needs no server, gate or
  session, for the same reason `auth grant-admin` does: a deployment whose
  ceiling is what broke the browser must still be recoverable. Its rows carry
  `updated_by = NULL` and journal with `actorType: 'cli'` — audited,
  notifying nobody. Never invent a principal id for it.
- The row labels in the admin form are NOT translated. They name constants of
  this codebase and the source paths those are read at; the contract's English
  `summary` is rendered as sent, on the same reasoning the audit journal
  renders a server summary raw. Only the form's own chrome is a catalog key.

## Intentional choices and rejected shortcuts

- Calling the notifier directly, from the domain that knows it wants a push:
  refused. Every push must be attributable to a journalled fact, so an emitter
  journals and `PUSH_ROUTES` decides the audience. A direct call is a push no
  audit row explains.
- `PUSH_ROUTES` with a default audience, or a non-exhaustive severity map:
  refused. Both are exhaustive `Record<PlatformEventKind, …>` so a new kind
  does NOT COMPILE until someone states its severity and who hears it. A
  default would make "everyone" the answer nobody chose.
- Handing domain modules the store instead of a `PlatformEventSink`: refused.
  The dependency arrow points from the server at the domain, and an absent
  sink must mean "no journal" rather than "no server".
- A SQL uniqueness constraint over (kind, run_id, dedupeKey) to deduplicate:
  refused. De-duplication by read-back is a cross-tick guarantee only, and
  exclusivity between watchers is a LEASE ([src/sentinel](../sentinel/AGENTS.md)).
  A constraint would look like exclusivity without providing it.
- Joining `platform_events` with `lifecycle_events` for one admin read:
  refused. `lifecycle_events` keeps its counter-checking semantics and its own
  `ledger check` consumer; two tables, two reads.
- Fail-open on a cross-organisation read receipt: refused, and it is the one
  strict exception to the fail-open append above. A missing receipt must
  COMMIT before foreign payload is returned, because a journal that loses the
  row is a read that never happened.
