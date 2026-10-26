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
  do not compare raw user spellings for protected files. Containment walks
  links as the kernel does (2026-10-13, two escapes found by adversarial
  review, both proven by a `write_file` landing outside): libc's realpath,
  never Node's JS one, which resolves a link's content as text (`up ->
  inner/..` read as the workspace); and a DANGLING link is followed to its
  raw, unnormalized target instead of reading as a not-yet-created path.
  Every platform, Windows included: both sides of the check use the one
  `kernelRealpath` (or its asynchronous sibling `kernelRealpathAsync`), so a
  platform quirk can refuse, never admit. `openContained` opens without
  following the last component and proves the descriptor lies inside before
  anything is read: exactly on Linux (`/proc/self/fd`), narrowed elsewhere.
  `ToolSandbox.realPath` exposes where a write lands; a file identity check
  compares that (and the inode), never spellings.
- Default builtins and the closed tool vocabulary must stay in lockstep. Tests
  compare names/order; executor scope is the ultimate permission gate.
- The probe manifest has THREE recorders and no hand: `record_probe` for a
  command, `fetch_url record:true` for a request, `validate_html` for a PASSING
  browser check (2026-10-11). Models choose what to probe; they do not
  transcribe the record, and `write_file`/`edit_file` refuse the file.
- Worker and in-process backends share contracts from `src/contracts/`; never
  fork protocol shapes.
- Container execution uses `network none` unless explicit egress is selected.
  Proxied egress requires Docker Engine 28+: its per-run internal bridge uses
  isolated IPv4 and IPv6 gateway modes, because plain `--internal` can still
  reach host services through the bridge address. Fail closed on older engines.
- The worker receives an allowlisted environment, not a spread parent env.
- Project commands never inherit `NODE_ENV`: the worker image runs with
  `production`, and an inherited value made `npm ci` skip devDependencies
  (Attica run 50019ee0, 2026-10-16). A tool needing a mode passes it as an extra.
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
- Network allowlists compare parsed hostnames; lookalikes and IP literals fail
  in the default restricted mode. The operator may set `ATOMA_EGRESS_ALLOWLIST=*`
  to allow all public Internet destinations and TCP ports (owner decision
  2026-10-13). Wildcard mode resolves once, rejects any non-public address, and
  connects to the checked IP; private, loopback and link-local networks stay
  isolated. The run cannot widen this host-owned policy.
  Default egress includes package registries and the shared public resource
  hosts in `contracts/webResources.ts`. Chromium receives the worker proxy
  explicitly; its loopback bypass keeps local application probes direct.
- Document retrieval shares one Haystack process per run. A search timeout
  kills that process; subsequent searches in the same run return `unavailable`.
  The 10-second deadline bounds work but does not restart the retrieval service.
  It is armed only once the service's optional `ready()` resolves: the runner
  prepares Haystack beside the run (2026-10-15), and a search that arrives
  first waits, bounded by the run's signal and deadline, instead of answering
  `unavailable` while the corpus is still building. A rejected `ready()` is
  `unavailable`; an invalid request is refused before any wait.
- `list_mcp_tools` and `call_mcp_tool` (`mcpConnectors.ts`) are host elements
  like search: intercepted around either backend, never in the worker, with
  STATIC declarations because atom types persist them in the shared registry.
  They refuse before reaching a server (unknown, unavailable, denied, tool
  switched off), bound time and result size, and drop media bytes. The
  service, its sessions and its credentials belong to
  [src/connectors](../connectors/AGENTS.md).
- `run_shell` and `record_probe` take a per-call `timeoutMs` (2026-10-15):
  both default to 120 s (`SHELL_TIMEOUT_MS`, `PROBE_TIMEOUT_MS`), at most
  five minutes, an out-of-range value REFUSED before anything runs, never
  clamped. A timeout still SIGKILLs the whole process group, and its error
  names the argument. Until then every command died at 30 s: three Attica runs
  lost fifteen paced suites at 28–30 s and split them to fit, and the acceptor
  refused the missing combined evidence. `run_shell` kept a 30 s default until
  2026-10-26: run 51c4e71d's two 33 s browser suites died at it and were
  re-run with the argument, a round trip every healthy suite paid; a hung
  command now holds a molecule 120 s, inside the same host bound. A container call crosses a host-side
  bound too (`workerCallTimeoutMs`, `src/contracts/commandTimeouts.ts`): the
  command's own limit plus 15 s, 120 s for every other tool. It was a flat
  120 s, which cut run 90ad4303's 120 s probe at the instant it would have been
  recorded and capped every longer limit. The Codex app-server loop pauses its
  silence clock while a host tool runs; the Claude CLI clock does not, so an
  `llm.callTimeoutMs` ceiling under five minutes can end a call a long
  command is still holding.
- Concurrent browser checks share the in-flight Chromium launch. A call whose page creation fails closes its already-created context.
- `validate_html`'s browser is a CACHE (`SharedToolBrowser`, `toolBrowser.ts`,
  one per tool set): every call holds it for its whole duration; it closes
  after `TOOL_BROWSER_IDLE_MS` (30 s) with no call holding it, and at once
  when `run_shell`/`record_probe` starts a project command, then relaunches
  lazily. One tree is ~113 threads in the worker image and relaunches in
  150–250 ms (measured 2026-10-25). Run 40c20c5d kept one open 21 minutes on
  a Compute worker whose task bound the project's own browser suites then
  could not fit under (46 EAGAIN or launch failures). Each launch keeps
  `trackChild` and an `onCleanup` hook, disposed when the browser closes.
- So the cache holds no state a check sees: EVERY `validate_html` call, not
  only a host replay, opens a browser context of its own and closes it on
  every exit path. Storage, cookies, IndexedDB, service workers and the HTTP
  cache never pass from one call to the next, whatever the idle timer did;
  a reload inside one call keeps them (`{ type: 'reload' }`, the one taught
  persistence proof). The host replays recorded checks in fresh contexts,
  and the two-call shape assumes call 2 opens at the initial state
  (`SMOKE_TWO_CALL_SHAPE`). A fresh context keeps the launch's proxy
  (verified 2026-10-25 with a loopback proxy).
- A close is bounded (`stopBrowser`): `Browser.close()` never rejects and
  can wait the protocol timeout then an unbounded exit, so it is raced
  against `TOOL_BROWSER_CLOSE_GRACE_MS` (1.5 s), then the tree is stopped by
  `sandbox.stopChild` and its exit confirmed (about 7 s at worst on
  `run_shell`'s path). A release and a relaunch wait
  for any close in flight, so a command never starts beside a dying tree.
- A tracked group leader exiting also kills its remaining owned group immediately; dead servers must not leave descendants consuming the run budget until final cleanup.
- Every finished `run_shell`/`record_probe` command also kills ESCAPED process groups (`reapEscapedProcessGroups`): orphans reparented to the container's init whose group no live process of the worker shares. A browser a test launched in its own group survived its runner's timeout, and seven such leaks exhausted run 9e134e49's 256-task Compute worker. Only inside a worker started with `--init`: on a host, ppid 1 is the machine's orphans.
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
  readiness markers. The static server binds the IPv4 loopback only
  (2026-10-23): an unbound `http.server` reverse-resolves the host name,
  5 s per boot on a macOS developer machine, and served the workspace on
  every interface. Both register `{ port → kind, pid, entry }` in the tool
  set's ONE `servedOrigins` registry, which `fetch_url` and `validate_html`
  read. Do not kill arbitrary process groups; only safe integer PGIDs greater
  than 1 may reach group syscalls.
- At most `MAX_LIVE_NODE_SERVERS` (4) node servers per tool set run at once;
  a fifth start stops the oldest still running through `ToolSandbox.stopChild`
  (group SIGTERM, a short grace, then `drain()`'s SIGKILL and exit
  confirmation, bounded), and marks it `stoppedByHost` only once its exit is
  confirmed, so a probe of its port says so. A SIGTERM sent is not a stop: a
  server that handles it kept answering (code review 2026-10-09, 1.8). Run 96d5c845 (2026-10-04) held 53, 812 MB, and swapped
  the production host until nothing on it answered. The cap stays 4 after
  run 40c20c5d (2026-10-25, four servers at 7–11 threads each, ~40 of 256):
  the cap is per tool set and parallel branches share it, servers live
  across phases on purpose (later probes and the final review reach them),
  and the thread shortage was the worker's bound, fixed in
  [src/launcher](../launcher/AGENTS.md).
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
- A path that holds no file is an ANSWER, not a failed tool (2026-10-13,
  reversing 2026-10-06's retained ENOENT): `read_file` returns
  `{exists:false, nearest}` for an absent path and `{kind:'dir', entries}` for
  a directory; `list_files` returns `{exists:false, entries:[]}`. Measured on
  153 production runs: 15 of 3,345 reads failed, all in opening bursts of
  parallel reads (an output the plan named read as an input, a guessed or
  mis-prefixed name, a directory), none retried. Neither answer is file
  content: `pathHeldNoFile` ([src/contracts](../contracts/AGENTS.md)) keeps
  it out of attestation, the attempt digest and every host reader, which
  still sees a missing claim as missing. Other errors still throw.
- Tool results are truncated before returning to the model, with the relevant
  head/tail retained. Budget-exhausted finalization keeps tools declared so the
  provider transcript remains valid.
  Oversized `fetch_url` responses retain their complete decoded body in a
  sandbox-resolved `.atoma-http/` file, with `bodyFile` before the truncated
  payload. Recover it through `read_file` offset/limit or local parsing, never
  by repeating the request. File pages use UTF-16 offsets and remain partial
  evidence; they cannot supersede a complete-file read.
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
  [incident](../../records/incidents/verification-replay-2026-09-15.md).
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

## Parent-owned test execution

- `atoma-verify` is a fixed `run_shell` utility, not another element. It runs
  Atoma's pinned Vitest with project config/scripts disabled on a disposable
  copy. Canonical suites stay on the host. The container remains the OS
  isolation boundary; Node permissions are defence in depth. No tests, skips,
  focused tests, missing reports and timeouts cannot pass; a run that did not
  finish reports a typed `cause`, never prose a reader classifies. The snapshot
  is digested twice: `workspaceDigest` over every record, `subjectDigest`
  without root `.atoma*` entries and any `node_modules` (host artefacts,
  installs, caches), so a probe record or a Vite cache is not another
  implementation for the suite-dispute count ([src/atoms](../atoms/AGENTS.md)).
- The copy is asynchronous: one worker serves every lane, and the synchronous
  copy froze all of them for its duration (review 2026-10-16). Snapshots share
  at most three libuv slots per process, leaving pool threads to siblings.
  Every entry is opened through `openContained`; entries, depth and bytes are
  bounded. A link is never followed and never pointed at the live tree (Node
  permissions check the requested path, not the resolved one): an internal one
  is recreated inside the copy, an escaping one refuses, unless its target is
  a socket or a FIFO, which, like one in the tree, is skipped and counted as
  the publication inventory omits it (2026-10-26: Chromium's `SingletonSocket`
  link, left by run 51c4e71d's own browser tests, refused every copy of that
  run and rejected both branches twice). A file is consistent
  on its own, not with its siblings. Read-run copies (`.atoma-runs`, up to
  64 MiB of another run) are never copied, beside `.git`, `.atoma-scratch` and
  `.atoma-skeleton`. ONE deadline covers the copy and the run;
  cleanup, the deadline and a shutdown during the copy stop it before a spawn.
  The child gets at most `PARENT_TEST_TIMEOUT_MS` and reports what it had
  (`windowMs`): a timeout in less is the host's, never the code's (second
  review 2026-10-16). Paths the host writes in the copy are removed whole
  first, directories included; `details` is one valid JSON array, bounded.
- Permission bits are the child's to change, never a host fault (third review
  2026-10-16): an entry the owner cannot read refuses the copy as
  `snapshot-unreadable`; after the run the owner takes back the copy root, the
  suite file and the report before reading them (the suite compared by size
  first), and restores its access to every directory before removing a copy.
  A report with no failing assertion that is still red says why: skipped tests,
  or each unhandled error the coordinator names on an `atoma-unhandled:` line
  (child text, like a failure message). A runner killed after its report is a
  `timeout`. The copy is reachable by any process of the worker's uid (a
  `start_node_server` server, a sibling's `run_shell`): a recorded limit in the
  [protocol](../../docs/decisions/parent-owned-tests-2026-10-16.md).
- No project code runs in the coordinator, which holds `--allow-addons` and
  writes the report: an inline PostCSS config, a stylesheet stub decided on the
  RESOLVED id (an alias or a package `main` hides the extension) that keeps a
  missing file red, `config: false`. tsconfig `paths` are read by Vite's native
  resolver, which Node permissions do not confine; the suite's own bare imports
  resolve as the modules it imports do, then through root `tsconfig*.json` as
  data, inside the copy only. The LLM-facing capability text has one home,
  `PARENT_TEST_PLANNING`. The runner entrypoint, the setup file and their
  Vite/rolldown pins belong in image-closure tests. See the
  [protocol](../../docs/decisions/parent-owned-tests-2026-10-16.md) and the
  [C-runner record](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#group-c-runner--asynchronous-snapshot-no-project-code-in-the-coordinator).
- `parentTestSetup.ts` is the assertion-integrity guard (G2, 2026-10-16): a
  setup file, loaded before the suite, that locks Vitest's objects and checks
  the built-ins of `src/contracts/assertionIntegrity.ts` and the values around
  every matcher. Its tag is `assertions-tampered`, a rejection; two nonces ride
  the coordinator's stdin, and a run whose guard never reported ready is a
  `runner-error`, never a pass. It narrows forging, it does not close it: the
  residual list lives once, in the
  [protocol](../../docs/decisions/parent-owned-tests-2026-10-16.md). The guard
  and its contract load without their compiled source maps, which name `src/`
  files the thread cannot read: mapped through them, a failing assertion left
  its test `pending` on the packaged runner. The coordinator exits when the
  runner's stdin pipe ends; copies carry the runner's pid, and a later
  verification removes a dead owner's copy once it is 10 minutes old.
  [G2 record](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#follow-up-matcher-forging-leftover-copies-suite-aliases).
- A path outside the runner's readable set is ABSENT for the code under test
  (run 760fef4c, 2026-10-17: `existsSync('/usr/bin/chromium')` threw
  `ERR_ACCESS_DENIED`, a code no file API documents, the module never loaded
  and its suites read "failed 0/0"). The setup file converts a READ refusal of
  the path the caller named, decided by Node's own `process.permission.has`,
  into Node's ENOENT: thrown, called back after the call returns, or rejected;
  `existsSync`/`exists` answer false, `throwIfNoEntry: false` undefined, streams
  follow `fs.open`. Nothing becomes readable; writes (also those that read
  first: open for writing, truncate, `rm` with `force`) and the directories
  above the readable set keep Node's refusal. It is installed inside the guarded
  setup (a fault there is `runner-error`), and its ESM re-sync holds every
  `node:process` binding, or `import { exit }` became Vitest's catchable stub.
  A traversal test aimed outside the copy proves nothing: `PARENT_TEST_RUNNER_SCOPE`
  tells planners, and the residuals are in the
  [protocol](../../docs/decisions/parent-owned-tests-2026-10-16.md).

## Generated artefact conventions

- `run_shell` supplies the deterministic `atoma-scaffold` utility directly
  (not a PATH executable or a new element). It writes the versioned application
  skeleton into an empty sandbox directory and never installs packages or
  overwrites existing work; `.atoma-*` host entries (read-run copies, the
  probe record) do not make a directory non-empty. Existing apps use a
  separate reference directory.
  `applicationSkeleton.ts` and its pinned lockfile ship in `dist/tools`;
  `application:skeleton:smoke` exercises fresh installs and compiled apps in
  the release checks, and `npm run check` beside a broken read-run copy under
  `.atoma-runs/node_modules`, with v2's lint ignore, v1's and Vitest's default
  include (the same copy at `.atoma-runs/<runId>` must fail). The three kinds
  run concurrently in separate sandboxes (86 s one after the other on the
  static CI job, 2026-10-24); keep every npm call in it asynchronous.
  Contract: [application skeleton](../../docs/decisions/application-skeleton-2026-10-16.md).

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

- `fetch_url record:true` persists `serverKind` and `entry` only from its
  verified `servedBy` observation: a live process holding the requested port,
  no redirect. A static HTTP response must not classify browser `app.js` as
  a Node server. Foreign or stale origins remain unstamped.
- `write_file` and `edit_file` REFUSE `.atoma-probes.json`
  (`manifestHandWriteRefusal`), naming the recorder of each shape, under any
  name that lands on it — a symlink, a directory link, a hard link
  (2026-10-13). Until
  2026-10-11 the web canonical asked the molecule to write_file the manifest
  itself; measured on the 140 project runs since 2026-10-05: 1,198 edit_file
  calls, 171 failures, 43 of them this refusal — the only category that
  repeats in streaks (15, 9 and 7 calls in one run), because the molecule had
  written prose labels where a smoke belongs, then tried to repair them, and
  the old message pointed at `record_probe`, a tool web molecules do not hold
  ([measurement](../../records/incidents/edit-file-failures-2026-10-11.md)).
- A declaration names no OTHER tool affirmatively (2026-10-26): it travels to
  every molecule holding its tool, with or without the one it would name.
  `record_probe` told the file scribe, which holds no `fetch_url`, to "use
  start_node_server followed by fetch_url"; its refusal messages, read only
  after a refused call, still name the request tools.
- `validate_html` records a PASSING check bound to its document
  (`appendWebProbe`, replay identity `webEntryIdentity`): the interactions as
  sent, the viewport and waitMs only when the caller gave them (a defaulted
  value is another identity), `expected` as the encoded smoke result up to
  4,000 characters (beyond, the verdict alone, marked `expectedTruncated`).
  A record is a CHECK: real input, or a smoke that reads the page; a literal
  verdict would fill the forty identities a later run replays. A host replay,
  a failing, refused or smoke-less call records nothing, and a page that could
  not be bound to a workspace file (a server returning generated HTML) gets a
  warning, not a record. The 2026-08-21 incident (a hand-authored document with a raw newline reaching
  disk) is closed by the refusal itself.

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
- `write_file`, `edit_file` and `atoma-scaffold` refuse a path that lands under
  `.atoma-runs/` (`readRunCopies.ts`: links followed, the name read case-blind),
  the copies of other runs' saved files ([read runs](../../docs/decisions/read-runs-2026-10-17.md)):
  a restore copies FROM a copy. A shell is stopped by the kernel: the worker
  mounts `.atoma-runs` read-only (`readOnlyRunCopies`, src/launcher).
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
  ([docs/decisions/inherited-checks-replay-2026-10-01.md](../../docs/decisions/inherited-checks-replay-2026-10-01.md)).
  Each call opens a fresh browser context whose proxy is dead for everything
  but the page's own origin, which covers what request interception never
  sees (a WebSocket handshake, a service worker's own fetches, a popup); a
  page-level stub of those APIs was tried, escaped by a popup, and broke
  feature detection. The stuck and oscillation tracker is neither read nor
  written, and the result carries `smokeOk`, `smokeThrew` and the response's
  `httpStatus`.

## Intentional choices and rejected shortcuts

- Auto-recording every `run_shell` command into the manifest, so a molecule
  without `record_probe` gets entries: refused (the shell contract: the record
  would drown in scratch commands). Its commands are host receipts instead.

- `read_file` with the internal `observationOnly` flag withholds its `markSeen`
  side effect: supervisor inspection must not authorize a child's blind overwrite.
  Ordinary reads still authorize writes; observation never revokes an existing read.

- File text is preserved after one JSON decoding; source escapes are bytes,
  not transport errors. `edit_file` never unescapes its replacement. A mismatched
  old span can be recovered only when one decoded span exists and the raw old
  and new arguments prove one uniform literal identifier rename; the tool
  applies that rename to the file's actual bytes. Otherwise it only diagnoses.
  Whitespace candidates carry actual
  offset-matched bytes, including multiple possible regions, and apply no
  edit. Missing `new_string` is invalid; an explicit empty string deletes.
  The resolver's repeated edits and adversarial cases are recorded in
  [the 2026-10-05 incident](../../records/incidents/dependency-resolver-2026-10-05.md);
  the bounded recovery and its exclusions are in
  [the 2026-10-06 follow-up](../../records/incidents/edit-file-token-recovery-2026-10-06.md).
  A serialized read result whose path and content equal the current file gets
  a specific wrapper diagnostic, never automatic unwrapping. Missing or
  aliased edit arguments get the required names; no alias is executed.

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
  [`records/designs/decided-not-built-2026-08-23.md`](../../records/designs/decided-not-built-2026-08-23.md).
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
- The integrity guard's rejected shortcuts (G2, 2026-10-16): Node's
  `--frozen-intrinsics` (the measured runner crashed under it); a check only
  after the run (a self-restoring `Object.is` passes it, F6d); freezing the
  built-ins themselves (fake timers, spies and polyfills write them); naming
  the caller of `expect.extend` from its stack; a tally of assertion failures
  (`expect.poll` and `vi.waitFor` retry failing assertions by design);
  removing copies by age alone (a live run's copy is old too); watching the
  global `Date` binding or `JSON` (fake timers and `vi.spyOn` replace them);
  a nonce in argv or env (`ps` and `/proc/<pid>/cmdline` show both).
- Paths outside the runner's readable set (2026-10-17): widening
  `--allow-fs-read` (loses the defence that keeps the live workspace out);
  answering EACCES as the system would (`throwIfNoEntry: false` and
  ENOENT-only handlers still throw); deciding from the error's `resource`
  (callback `realpath` of a file inside the copy then read as absent); a Vite
  alias or loader hook for `node:fs` (misses `require` and externalized
  dependencies); wrapping `statSync`/`accessSync` alone (callbacks, promises
  and streams would answer otherwise: one concept, two definitions).
- The idle tool browser (2026-10-25): a browser per call (each smoke would
  pay a launch, and parallel branches would each hold a tree); a run-long
  browser (run 40c20c5d); a persistent `userDataDir` so storage outlives a
  relaunch (it would keep one call's storage reaching the next, which no
  host replay reproduces and the two-call shape contradicts, and leave a
  profile directory to clean); yielding only to commands that LOOK like browser
  tests (a vocabulary-frozen detector: any runner, script or `npm test` may
  launch Chromium); stopping servers judged unused (no use signal covers a
  `run_shell` client, and a later phase's probe needs them).
- Moving smoke guidance closer to the call site is NOT the untried variable.
  The erased-intermediate-state rule already sits in the `smoke` PARAMETER
  description and the model still violated it six times across two batches.
