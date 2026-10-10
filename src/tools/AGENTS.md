# Tools — AGENTS.md

`src/tools/` owns element declarations, the registry, the sandbox, builtins,
the worker protocol and the execution backends — the only code L1 reaches.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.
Element invocation names are immutable wire contracts.

Neighbours:

- [`src/atoms`](../atoms/AGENTS.md) — capability buckets and ground-truth policy
- [`src/contracts`](../contracts/AGENTS.md) — manifest merge identity
- [`src/run`](../run/AGENTS.md) — backend selection

## Elements, sandbox and isolation

- L1 is the only tier with tools. `src/tools/` owns declarations, registry,
  sandbox, builtins, worker protocol, and execution backends.
- `ToolSandbox` is the filesystem/process boundary. Resolve paths through it;
  do not compare raw user spellings for protected files.
- Default builtins and the closed tool vocabulary must stay in lockstep. Tests
  compare names/order; executor scope is the ultimate permission gate.
- `record_probe` writes the manifest from machine-observed results. Models choose
  what to probe; they do not transcribe the record.
- Worker and in-process backends share contracts from `src/contracts/`; never
  fork protocol shapes.
- Container execution uses `network none` unless explicit egress is selected.
  Proxied egress requires Docker Engine 28+: its per-run internal bridge uses
  isolated IPv4 and IPv6 gateway modes, because plain `--internal` can still
  reach host services through the bridge address. Fail closed on older engines.
- The worker receives an allowlisted environment, not a spread parent env.
  Credentials and control-plane store paths never cross the boundary.
- THE HOST CREATES THE MOUNT SOURCE before the engine is asked for it. A
  bind-mount source that does not exist is created by the DAEMON, as root; the
  worker then runs as the host user and finds `/workspace` unwritable, and the
  L1 agent — told nothing — improvises in `/tmp`, so the deliverable never
  lands where delivery, publication and the preview look for it. Measured on
  the first real containerised project run (2026-09-02). The local sandbox
  creates its own root; in container mode that sandbox lives INSIDE the worker
  and cannot create the host directory it is mounted from, and the operator
  path never saw this because its workspace persists across runs while a
  project run gets a fresh path every time. `tests/container-executor-lifecycle`
  asserts the property at the seam: the source is a directory at spawn time.
- Network allowlists compare parsed hostnames; lookalikes and IP literals fail.
  Default egress includes package registries and the shared public resource
  hosts in `contracts/webResources.ts`. Chromium receives the worker proxy
  explicitly; its loopback bypass keeps local application probes direct.
- Document retrieval shares one Haystack process per run. A search timeout
  kills that process; subsequent searches in the same run return `unavailable`.
  The 10-second deadline bounds work but does not restart the retrieval service.
- Cleanup is mandatory on success, failure, timeout, signal, and hard-exit paths.
  Network teardown races need bounded retry.
- `ToolSandbox.drain()` is the stronger local contract before workspace
  replacement: await cleanup, kill surviving owned children/groups and confirm
  their exit; a surviving process prevents replacement.
- `ContainerToolExecutor.drain()` permanently closes its transport, removes
  every worker it started through the launcher-issued ownership handle and
  requires a successful engine query proving absence. CLI exit alone is not
  worker exit. The backend drains workers before stopping its egress sidecar.
- Docker image packaging is verified statically against the worker import graph
  and dynamically by booting the real image.
- `start_static_server` and `start_node_server` use OS-selected ports and explicit
  readiness markers, and register `{ port → kind, pid, entry }` in the tool
  set's ONE `servedOrigins` registry, which `fetch_url` and `validate_html`
  read. Do not kill arbitrary process groups; only safe integer PGIDs greater
  than 1 may reach group syscalls.
- At most `MAX_LIVE_NODE_SERVERS` (4) node servers per tool set run at once;
  a fifth start stops the oldest still running through `ToolSandbox.stopChild`
  (group SIGTERM, a short grace, then `drain()`'s SIGKILL and exit
  confirmation, bounded), and marks it `stoppedByHost` only once its exit is
  confirmed, so a probe of its port says so. A SIGTERM sent is not a stop: a
  server that handles it kept answering (code review 2026-10-09, 1.8). Run 96d5c845 (2026-10-04) held 53, 812 MB, and swapped
  the production host until nothing on it answered.
- A loopback URL with NO port is refused PRE-FLIGHT by both probe tools
  (`unservedLoopbackProbeRefusal`, prefix `PROBE_URL_REFUSAL_PREFIX` from
  [src/contracts](../contracts/AGENTS.md)): the server tools never bind the
  protocol default, so `http://localhost/` is a request-shape error, and the
  refusal names the registered origins. An EXPLICIT unregistered port is NOT
  refused — a `run_shell`-started server is invisible to the registry — but a
  refused connection there gets the registered origins appended to its error.
  Measured 2026-09-21 (run `d3098d25`): a final review probing the bare origin
  read the refusal as a dead service and replayed executions into the 1800 s
  deadline.
- `validate_html` treats smoke input as a JS expression, bounds every supplied
  duration, and ignores Chrome's own favicon 404. Browser console errors remain
  evidence but not every one is a mechanical failure: a same-origin fetch/xhr
  ANSWERED 4xx is a warning, since a page that must show the server's refusal
  could never validate (run 1d42ac2a: 29 calls, 40 minutes); the smoke judges
  it. A 5xx, another origin and a failed subresource stay errors. A node server that
  exits after boot is recorded on its origin and named by every later probe of
  it; the favicon filter never drops a broken connection (run 1d42ac2a).
- Do not relax `detectBrittleComputedStyleLiteral` (the rgb()/rgba()-literal
  pre-flight refusal). Measured across six batches on 2026-08-21 (15 firings
  over seven web runs): every refusal was followed by in-run compliance at
  ~one model turn each, every run delivered, and the expensive streak blamed
  on it (batch 5, seven calls on one unreachable check) was an AWAITED
  before/after comparison on a background-color transition that never
  progressed in the headless page — removing the transition made the
  identical check pass with a 100ms wait — plus an over-specified aggregate:
  shapes the guard neither causes nor could catch. The allowed routes (source-toggled class/inline
  marker; captured before/after comparison) are strictly more robust, and a
  conditional relaxation would need colour-space resolution against the page
  source for marginal gain.
- Tool results are truncated before returning to the model, with the relevant
  head/tail retained. Budget-exhausted finalization keeps tools declared so the
  provider transcript remains valid.
- Shared smoke guidance lives in one constant. Do not duplicate or specialize
  it around one widget vocabulary. The guidance and the `validate_html`
  pre-flight guards are ONE contract: `SMOKE_ASYNC_TRANSITION_EXAMPLE` is
  exported so `tests/smoke-guidance.test.ts` can feed it to the real guards.
  Never teach a smoke shape the tool refuses.
- The erased-intermediate-state refusal hands out TWO shapes since
  2026-09-15, rendered from ONE contract constant (`SMOKE_TWO_CALL_SHAPE`,
  [src/contracts](../contracts/AGENTS.md)) because atoms and tools may not
  import each other: real interactions up to the milestone under a read-only
  smoke, then one change plus the reset under a read-only smoke — the only
  taught shape that also covers a declared `dom-interaction` obligation — and
  the self-driving IIFE, which passes every guard and executes NO interaction,
  so both texts say it covers nothing. The covering shape comes first.
  `tests/smoke-two-call-coverage.test.ts` feeds both calls to the guards and
  through the attestation seam to `checkProofCoverage`. Why, and the measured
  cost of teaching the self-driving shape alone:
  [incident](../../docs/incidents/verification-replay-2026-09-15.md).
- A SYNCHRONOUS `getComputedStyle`
  read on a TRANSITIONED property returns the pre-transition value (verified
  in Chrome, 2026-08-21): assert the class/inline marker the source toggles,
  or make the smoke async and await past the declared duration — the tool
  awaits the returned promise.
- That await is BOUNDED to one repaint or transition. It is not a way to wait
  for real time: a smoke still running at `CDP_PROTOCOL_TIMEOUT_MS` is killed
  and returns NOTHING, and `diagnoseSmokeEvaluationError` replaces Puppeteer's
  `protocolTimeout` advice (addressed to the harness author, not the caller)
  with the remedy the `holdMs` description already gives — drive
  `window.__test.advance(ms)`. Measured 2026-08-21: teaching the await without
  the bound made a countdown task await 33s and 35s inside two smokes, both
  killed after burning ~45s each, and the run failed on its whole budget.

## Generated artefact conventions

- HTTP servers normally bind `process.env.PORT`, accept port 0, and emit
  `LISTENING_ON_PORT=<N>` once ready. A task-defined CLI may instead receive
  literal `args` and emit a complete JSON `{"port":N}` line. Preserve that
  interface; no shell interprets argv. Nonempty argv withholds code-only
  standing proof because options may change behavior. `start_node_server` passes a CONCRETE
  free port, never 0: `Number(process.env.PORT) || 3000` — what "default
  3000" compiles to — reads 0 as unset, bound 3000, and collided with itself
  on the next start (EADDRINUSE in three of four runs on 2026-09-24; run
  811782c2 rewrote its delivered default to get past the tool).

## Probe manifest writes

- `write_file` REFUSES an unparseable `.atoma-probes.json`
  (`probeManifestWriteRefusal`) before touching disk. The verbatim
  pass-through exists so the model can REPAIR a broken manifest, and only the
  INCOMING document is checked, so repair still works — but a repair that does
  not itself parse is corruption, and no writer may leave a record no reader
  can read back. Measured 2026-08-21: a hand-authored 10857-byte document with
  a raw newline inside a string reached disk, the ground-truth probe reported
  MALFORMED, the validator rejected, and the run paid an extra execute cycle
  to repair our own write. `edit_file` refuses manifest edits and points at
  this path, so the two halves must hold the same standard.

## Browser observation

- `validate_html` lays the page out at the caller's `viewport` (default
  800x600, Puppeteer's own) and ALWAYS reports the size it used. A malformed
  size is refused, never clamped: a page silently laid out at another width is
  the false proof the parameter exists to end. Until 2026-09-25 there was no
  parameter, so a task demanding 320/375/768px proof could not be met, and a
  smoke labelled "320px" read `innerWidth` 800 (runs `2fac992c`, `0e89e0ce`).
  The size rides the ATTESTED observation too (`viewport=WxH` in the line a
  validator reads), and keys the smoke stuck/oscillation detector, whose
  refusals report it: a width sweep is several layouts, not one flaky smoke.
- An `upload` interaction attaches a WORKSPACE file to an `<input type="file">`
  (`ElementHandle.uploadFile`, whose CDP call fires input and change). A
  click on a file input opens a chooser a headless page cannot answer, so
  the README's own "upload a CSV" could never be observed, and run 74fe5cec
  spent its whole budget trying (2026-09-26). The file goes through
  `sandbox.resolve` and `lstat`: never a path or a symlink outside the jail,
  because its bytes reach the page and the trace.
- `write_file` refuses to overwrite an existing, non-empty file that nothing
  in this run has read or written (`.atoma*` paths and the merged probe
  manifest excepted): work from before the run — a seeded deliverable, a
  repository — is read before it is replaced. Runs 902b2c21 and f33379a4
  (2026-09-27) each opened by writing a home page over the configurator the
  task asked them to keep. The memory is per sandbox, so every phase of a run
  shares it, and a fresh backend after a deepening starts over.
- A `select` interaction chooses a `<select>` option by value or label, or
  sets a range, date, month, week, time, datetime-local, colour or number
  input, then fires input and change. A headless page opens no dropdown: a
  click on an `<option>` has no bounding box, arrow keys on a closed select
  change nothing, and no interaction could move a slider, so runs 556c9e54
  and 068cfe14 (2026-09-27) proved filters by assigning `.value` from the
  smoke, which executes no interaction. It refuses what a person could not
  choose (not rendered, disabled, no such option) and warns where a slider's
  bounds moved the value. Keyboard interactions focus their `selector` first:
  a keypress meant for a slider went to the checkbox clicked before it.
- A `reload` interaction reloads the page in place (storage, cookies and
  origin kept, document and memory gone), and `type` without a selector types
  where focus is, with no click — the keyboard-only form, logged "at focus on
  <element>" and refused when nothing has focus or focus is on a control that
  takes no text (a space would press a button: run 7f80148d typed eight
  passages onto buttons, Clear history among them). No key reloads a headless
  page: `F5` and `r` under a held Control or Meta are refused as interaction
  errors (`reloadKeyRefusal`, [src/contracts](../contracts/AGENTS.md)) and
  never executed. Run 779d854c (2026-10-10) delivered "survives a reload" on
  a keypress F5 whose smoke read the unreloaded page, and the typing studio
  was refused twice because neither a reload nor Tab-reached typing could be
  shown. A reload alone establishes no DOM interaction.
- `validate_html` reports `requestedInteractions`, `ignoredInteractions` and
  the served `document` digest alongside `interactionLog`. The counts are the
  CALLER's fact and the log is the runtime's; a result that carries only one
  side cannot distinguish an executed click from a discarded one.
- `smokeDrivesOwnState()` still discards external interactions — the filter
  preserves one coherent state-transition path and is deliberately unchanged.
  What changed is that its effect is now reported as a number instead of only a
  warning string, so a consumer can act on it.
- The `document` binding is established on the FINAL RESPONSE the browser
  loaded, after every redirect, never on the requested URL
  (`bindObservedDocument`, 2026-09-13): the final URL's port must be one this
  tool set's server tools bound whose process HOLDS the listening socket NOW —
  asked of the kernel through `listeningPorts.ts`, `/proc` on Linux and `lsof`
  on darwin, failing closed elsewhere; alive is necessary, not sufficient —
  and the main-frame response bytes must equal the designated workspace file
  read at that instant (`/` → `index.html` is a designation, not a proof). A
  stranger's server, our server that exited or closed its listener while a
  stranger reuses the port, a registered server redirecting to a stranger, a
  Node server returning another file or generated HTML, an unchanged root
  `index.html` while the server serves a different page — all yield NO
  document. Absence is a weaker observation and never a failure, and it
  attests content correspondence at that instant, not the application's
  dependency chain.
- `validate_html`'s HOST REPLAY mode (`hostReplay: true`) replays a check an
  earlier run recorded, for root acceptance
  ([docs/inherited-checks-replay-2026-10-01.md](../../docs/inherited-checks-replay-2026-10-01.md)).
  Each call opens a fresh browser context whose proxy is dead for everything
  but the page's own origin, which covers what request interception never
  sees (a WebSocket handshake, a service worker's own fetches, a popup); a
  page-level stub of those APIs was tried, escaped by a popup, and broke
  feature detection. The stuck and oscillation tracker is neither read nor
  written, and the result carries `smokeOk`, `smokeThrew` and the response's
  `httpStatus`.

## Intentional choices and rejected shortcuts

- File text is preserved after one JSON decoding; source escapes are bytes,
  not transport errors. `edit_file` never unescapes its replacement. A mismatched
  old span can be recovered only when one decoded span exists and the raw old
  and new arguments prove one uniform literal identifier rename; the tool
  applies that rename to the file's actual bytes. Otherwise it only diagnoses.
  Whitespace candidates carry actual
  offset-matched bytes, including multiple possible regions, and apply no
  edit. Missing `new_string` is invalid; an explicit empty string deletes.
  The resolver's repeated edits and adversarial cases are recorded in
  [the 2026-10-05 incident](../../docs/incidents/dependency-resolver-2026-10-05.md);
  the bounded recovery and its exclusions are in
  [the 2026-10-06 follow-up](../../docs/incidents/edit-file-token-recovery-2026-10-06.md).

- `hostReplay` is UNDECLARED, read as an own property only, and stripped
  from every call of a run and from every model-facing executor
  (`modelFacingExecutor`, src/core/attestation.ts): a molecule that passed it
  would escape the stuck tracker built to stop its loops. Do not declare it in
  the schema, and do not read it anywhere but in `validate_html`.

- A SYNCHRONOUS smoke observes only what the page has already committed, so
  the canonical state-driving shape (`SMOKE_CANONICAL_STATE_SHAPE`) is ASYNC
  and keeps its `settle()` awaits. Measured 2026-08-21 twice in one batch: a
  transitioned colour read back stale (`rgb(51, 51, 51)` with the class
  already applied) and a stopwatch display stuck at `"00:00.00"` while
  `elapsed` reached 988ms, because the `setInterval` tick could not run. Both
  runs retried an assertion that could not become true.
- The `validate_html` pre-flight reports EVERY refusal that applies, via
  `preflightSmokeRefusals`. This REVERSES the 2026-08-21 entry that forbade
  batching, and the honest accounting is that the reversal is NOT justified by
  measured savings: across both 2026-08-21 runs and project run `a786358a`
  (2026-08-23), every refused payload still violated exactly ONE guard, so
  batching has saved zero round-trips to date. It changes because three
  sequential early returns made the ORDER of the guards part of the contract,
  and one consequence of that order is a real hole: `interactions` is emptied
  before `detectResetErasedIntermediateEvidence` is consulted, so a
  self-driving smoke can never receive the erased-state refusal. Consulting
  all three keeps the report order-independent. Closing the hole itself would
  change a disposition and is NOT done here — see
  [`docs/archive/designs/decided-not-built-2026-08-23.md`](../../docs/archive/designs/decided-not-built-2026-08-23.md).
- A refused call is still ATTESTED. The pre-flight early return carries
  `requestedInteractions`, `ignoredInteractions` and the discard warning,
  because a refusal reporting none of them is indistinguishable from a call
  that sent no interactions at all — the exact confusion that field pair
  exists to prevent. It carries NO `document` since 2026-09-13: no page was
  loaded, and a binding is established on the loaded response. Its error
  strings start with the contract's `SMOKE_PREFLIGHT_REFUSAL_PREFIX`
  ([src/contracts](../contracts/AGENTS.md)), which is how the L1 validation
  ledger tells a refusal from a failed observation of the page; keep the
  wording behind the prefix free to change, never the prefix.
- Moving smoke guidance closer to the call site is NOT the untried variable.
  The erased-intermediate-state rule already sits in the `smoke` PARAMETER
  description and the model still violated it six times across two batches.
