# Compute identity and lease domain — adversarial review

Scope: private product-store methods and a client-side lease guard. These are
not exposed through HTTP/WSS and do not yet launch customer workloads.

The review examined accepted mechanisms, including restoration of permissions,
not just malformed inputs. No model calls or production state were used.

- A pairing code alone must not mint a credential. Redemption needs the app's
  high-entropy secret, prior authenticated organization confirmation and an
  unexpired row. Consumption and credential insertion share one immediate
  transaction. Raw codes, secrets and device credentials are not stored.
- Rechecking current membership alone was insufficient: a downgrade followed
  by an upgrade could resurrect the old socket. Transactional membership
  triggers now permanently revoke the owner's device and invalidate pending
  approved pairings. They also fence work requested by another downgraded
  member on a shared device. Project archival and grant withdrawal likewise
  leave existing assignments indeterminate even after access returns.
- A second connection supersedes the first but cannot adopt its active work.
  A delayed disconnect from the first cannot disconnect the second. A session
  expiry retains the assignment and blocks admission until a fresh authenticated
  launcher reports the exact run and execution generation stopped. An observed
  expiry is fenced outside the failed renewal transaction; rollback and a later
  wall-clock rewind cannot restore that session.
- Stop reports are launcher reports, not independent platform proof. They never
  earn shared trust. Integration must confirm engine removal before sending them;
  lost engine connectivity must not be converted to a successful report.
- A received heartbeat cannot grant a fresh full interval: that would extend
  authority by transport latency. The guard uses its own request dispatch time,
  rejects reordered/replayed acknowledgements and closes permanently on expiry.
  Wall time catches ordinary sleep; monotonic time prevents clock rewind from
  extending the lease. A resumed process checks expiry before another operation.
- A failed cleanup stays unconfirmed. The guard does not release resources or
  restart work automatically; boot/reconnect reconciliation must handle it.
- Device admission is per device and checks the aggregate resource request,
  explicit project grant, version/image allowlists and an existing scoped run.
  An indeterminate device does not occupy another device's slot. Organization,
  model and orchestration admission remain the coordinator's responsibility.

Behavioral tests cover these paths against the actual auth/project schemas,
including cross-organization grants, credential/session confusion, explicit
revocation, requester downgrade, duplicate connection, expiry, stale stop reports,
sleep, clock rollback, delayed cleanup confirmation and engine failure.

Before exposure: add authenticated/rate-limited browser and device endpoints,
the audit journal, WSS request identity and dispatch fencing, persistent run-target
receipts, local engine integration, orphan reconciliation and independent trust
validation. The internal `ComputeActor` is supplied by a trusted authenticated
adapter; accepting it from request JSON would violate this design.

## WSS transport follow-up

The explicit TLS gateway and outbound client now exercise workspace control on
real encrypted sockets. They remain unmounted in production. This is a private
transport foundation, not a customer-device admission path.

Reviewed accepted mechanisms:
- A gateway accepts direct TLS only, never a forwarded-proto claim, and refuses
  browser Origin headers. WS compression is disabled; frames are capped at 1 MiB,
  authentication at 4 KiB/5 seconds, and the gateway at 32 live connections.
  Public deployment still requires IP/identity rate limits and audit wiring.
- The app verifies certificates and hostnames, follows no redirects, and sends
  credentials only in the encrypted hello. No credentials enter diagnostic errors.
- Each request and accepted reply rechecks the product store's current authority.
  Connection and execution generations are independent. The watchdog and each
  heartbeat recheck the dispatched workload, so grant withdrawal cannot renew it.
- One outstanding workspace command prevents privileged import/guard races.
  Timeout, malformed response, disconnect or mismatched identity terminates the
  channel, rejects pending effects as indeterminate, and retains the device slot.
  No automatic reconnect, retry or stop acknowledgement is implemented.
- The client binds one launcher-selected execution and handler; repeated request
  ids, overlapping requests and other generations fail closed. The local lease
  must be active before execution and before returning a result. Work already
  dispatched can finish after disconnection; its result is discarded and only the
  launcher teardown callback can establish local stop. A failed callback stays
  unconfirmed.

Limits: the client binding is currently a trusted injection seam, not the final
assignment negotiation or engine boot reconciler. It does not launch Docker,
carry tools/previews, release a device slot, or enable remote runs in the runner.
The network frame cap is intentionally lower than private process RPC; an
oversized bounded workspace inventory fails rather than allocating arbitrarily.
TLS termination through a reverse proxy is not enabled by this adapter.

A failed SQLite disconnect write cannot prevent socket teardown or turn an
unknown operation into success: the persisted lease remains bounded, and the
slot is not released. The final transport suite tests this with query-only SQLite.

## Execution receipts, tools and desktop profile

The project target is copied into the run reservation transaction. A continuation
inherits its source receipt, and SQLite refuses later receipt changes. Target
changes require current organisation authority, explicit project grant and CAS.
Remote queued receipts neither take a hosted lease nor block another organisation's
hosted run. The coordinator deliberately refuses remote dispatch until its remote
lifecycle/finalization integration exists; no automatic hosted fallback is present.

Adversarial cases exercised: a caller changes project target after reservation;
an administrator selects another organisation's device; a viewer changes target;
resources or image version do not match; tool names try to reach private workspace
operations; commands arrive before assignment acknowledgement; the connection dies
while allocation is pending; reconnect tries to reuse a generation; reconciliation
fails in the engine. Allocation is joined before teardown. Only an exact stop report
on the new authenticated session releases the old assignment, not reconnect or time.
That report is still customer-origin evidence, not independent proof for shared trust.

Customer provenance follows nested contexts and tool attestations. Positive type
and recipe credit, recipe learning/promotion and prompt learning are withheld for
remote executions; results can still be accepted for the owning project's delivery.
Negative failure paths are unchanged. This is not a blanket isolation of every
catalogue mutation, nor an independent hosted validation service.

Real Docker Desktop ARM64 tests exercise pinned content images, named Linux volumes,
non-root read-only root filesystems, network none and no bind mounts. Tools receive
only the current workspace subpath. The private control service survives tool drain
and exports bytes over TLS; disconnect removes containers before reporting local
stop. A real concurrent test exposed Docker's automatic removal race: `rm -f` can
lose to an in-progress `--rm`. Bounded polling now succeeds only on an actual empty
engine query; a still-present container or engine failure remains unconfirmed.

Remaining release blockers include remote coordinator dispatch/finalization,
authenticated browser pairing and endpoint integration, audit/rate limiting,
resource sharing/disk bounds, persistent local recovery inventory, remote retrieval
and preview relay, Electron screens/secure credentials, signed multi-platform images
and installers, and the preregistered capacity measurements. No admission increase
or production activation is authorized by these tests.

## Completed integration review, 2026-10-18

This section supersedes the remaining-implementation list above. The coordinator,
browser pairing, WSS endpoint, audit/rate limiting, headless secure credentials,
local recovery inventory, resource/disk guards, remote retrieval, preview relay
and project settings are now implemented. Electron and signed application
installers are explicitly excluded by the owner.

Additional failure boundaries checked during integration:

- Finalization never replays an uncertain command. The host persists its result
  before transfer; a fresh recovery generation only exports the retained copy.
- A published checkpoint remains valid if its client notification is lost. The
  client displays only the confirmation it actually received and persisted.
- Preview stream slots release on idle expiry. Terminal origin/grant checks run
  before either hosted or remote forwarding, and arbitrary local ports are not
  expressible in the remote contract.
- Shared static byte policy initially imported the broad project contract, which
  pulled model catalogue modules into the preview bundle. The minimal artifact
  contract replaces that import; closure tests enforce the absence of control
  modules while retaining one implementation of the filesystem jail.
- Model content pins use POSIX relative paths on every OS. A nested-file test
  fixes the cross-platform identity rather than accepting different Windows pins.
- Reconnection refreshes resource diagnostics. A disk probe that completes after
  a new connection cannot close that newer generation. Failed Docker cleanup
  remains unconfirmed, including during low-disk shutdown.
- Model staging is excluded from ordinary release archives. The derived retrieval
  image is an explicit separate packaging operation, never a silent download.

No test here establishes customer hardware as trustworthy for the global catalogue.
Remote observations remain tainted; project delivery and independent shared-trust
promotion are separate decisions. No capacity claim or admission uplift is made.

The image workflow is called explicitly by the release workflow after source
publication. It does not rely on a `release.published` event emitted by
`GITHUB_TOKEN`, which would not trigger another workflow. Manual dispatch remains
validation-only. Native image publication itself is still unexecuted locally.

## Final local verification

On macOS Apple Silicon / Docker Desktop Linux ARM64, with Node 24.20.0:

- `npm run release:check:static`: passed, including documentation, both TypeScript
  configurations, lint, audit (zero vulnerabilities), build and compiled smokes.
- Full `npm test -- --maxWorkers=2`: 7,611 passed, 10 skipped; 528 passing files
  and one wholly skipped file. All explicit worker/workspace/retrieval/hybrid/
  preview test-image variables selected freshly rebuilt isolated images.
- The full run includes 36 worker-isolation tests, 38 WSS connection/lifecycle
  tests, actual BM25 and hybrid model execution, and all three Docker preview
  modes. The gVisor-only preview suite remains skipped on Docker Desktop.
- `npm run viz:smoke`: passed, including compiled TLS pairing, keyboard consent,
  project grant/target selection, disconnected status, checkpoint recovery,
  responsive project surfaces and WebGPU/WebGL paths. Desktop/mobile Compute
  screenshots were visually inspected.
- Workflow YAML syntax and staged/unstaged whitespace checks passed. No active
  Compute-labelled Docker workload remained after the suite.

The first full attempt exposed an obsolete preview COPY expectation and the
existing fixed-delay asynchronous page smoke under load. The closure assertion
was updated and strengthened; the browser assertion passed in isolation and in
the complete two-worker run without relaxing its condition or timeout. These
results do not represent a capacity benchmark, native Windows/Mac Intel testing,
published image acceptance, or production activation.
