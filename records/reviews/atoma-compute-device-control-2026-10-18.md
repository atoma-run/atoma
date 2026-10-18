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
