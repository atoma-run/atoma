# Atoma Compute — implementation record

Owner-approved direction, 2026-10-18: move workspaces, tools, Chromium,
builds/tests, Haystack and ephemeral previews to the customer's personal
computer. Atoma retains orchestration, model credentials, budgets, shared
knowledge, traces, durable checkpoint bytes and delivered artefacts.

The product target is a graphical Electron application for macOS (ARM64/x64)
and Windows x64 with Docker Desktop/WSL2. Connections originate from the
client over WSS. Disconnects require explicit client-side recovery, never an
automatic hosted fallback. Remote observations cannot directly earn shared
trust without independent platform-controlled verification.

## Implemented foundation

- Async private workspace interface used by the runner, dispatch and root
  acceptance, retaining synchronous library/test compatibility.
- Routing and delivery evidence, read-run identity capture and comparisons,
  inherited-check filesystem reads/writes, read-only photograph/restore.
- Versioned bounded RPC with strict shared schemas; a separate process adapter
  and a standalone service bundle/image. No element exposes control commands.
- Streamed checkpoint receiver with one-file memory bound, ordered chunks,
  path/mode/link/digest checks, incomplete snapshot isolation, expiring pins
  against pruning, and owner-bound atomic attachment to a checkpoint.
- Stable private execution-host export and sequential checkpoint integration,
  including process drain before sealing and remote digest verification on release.
- Execution-host preparation, seeding from launcher-bound sources, read-run
  copying and deepening, using the hosted implementation's existing algorithms.
- Streaming restoration from the product store through the private RPC. The
  local and streamed paths share one restoration writer; the runner awaits it
  before starting tools. Source SQL queries release their cursors before waits.
- A trusted backend factory seam, with a mocked-model runner test whose host
  workspace path is a regular sentinel file while the execution host builds
  into its own directory. This does not implement a network tool transport.
- Source provisioning through typed seed/reference selectors, resolving only
  launcher-bound destinations and refusing replacement or imports after prepare.
- Artifact export from a private filtered snapshot, with publication-policy
  parity and independent receiving-host hash/mode/inventory validation. A
  partial or invalid transfer never exposes the final directory. The real-runner
  test exports after tool shutdown while its workspace service remains alive.

- Private device control domain in the product database: secret-bound one-use
  pairing, explicit project grants, credential revocation, connection/execution
  fencing, one-run device admission and exact-generation stop reconciliation.
- Local one-generation lease guard: dispatch-time renewal, sleep/clock-rewind
  checks and engine-confirmed cleanup semantics. Not yet wired to a desktop
  engine or network session. The [adversarial review](../reviews/atoma-compute-device-control-2026-10-18.md)
  records the accepted mechanisms and their remaining integration assumptions.

This is groundwork, NOT a usable customer-device execution target. The default
runner still uses the local workspace implementation. There is no desktop app,
remote device admission, customer WSS endpoint, or claim of resource savings.

## Remaining integration, in dependency order

1. Bind source/artifact transfers to authenticated device admission and the
   project coordinator. Keep finalization pending until all bytes are verified,
   and retain confirmed process-stop evidence. Bind project continuation identity to a
   device generation; operator checkpoint tests currently exercise the same
   execution-host path across process restarts. A new project continuation's
   source validation still needs its device binding.
2. Bind authenticated chunk streams to the checkpoint receiver; admission must
   cap concurrent transfers and total reserved bytes. Reconcile abandoned
   uploads and reuse existing recovery-effect and spend barriers.
3. Expose the device control domain through authenticated, rate-limited browser
   pairing and generation-fenced WSS sessions, with journaled authorization
   changes. Wire the lease guard to the client launcher and engine reconciliation.
   Persist the selected execution target in the project and run receipt;
   preserve hosted defaults and separate device/server admission.
4. Move Haystack extraction/indexing/inference and its disposable cache;
   route previews through the existing authorization/origin gateway to a
   locally isolated copy. Keep GitHub and connector credentials on Atoma.
5. Build the graphical application, diagnostic/resource controls, installers
   and signing/release workflow. Validate all supported OS/CPU targets.
6. Execute the pre-registered capacity experiment before raising admission.

## Local evidence

Source/artifact transfer tests cover launcher-bound reference rejection,
preparation/deepening after removing the server source, client-side reference
identity checks, filtered private exports, false hashes, unlisted files,
interrupted delivery, empty text delivery and transfer after tool shutdown.
The container smoke provisions a private source through RPC and exports final
artifacts from the packaged service. Device authentication and persistent
finalization recovery are not established by these private-channel tests.


The container smoke drives the packaged service in one container and modifies
its Linux volume from another. The service restores the original file and
neither workload receives a Docker socket or host-directory mount. Its image
uses an isolated development tag; the existing worker image is not replaced.
The checkpoint spool has its own control volume, absent from the tool
container. CI's fresh-worker job builds the service image and runs this smoke.

The process-boundary tests exercise real supervision restoration, inherited
browser replay, read-run identity comparisons, and sequential checkpoint sealing
with an unavailable host path. Killing the service mid-transfer leaves no
resumable boundary; a lost restoration acknowledgement is not replayed.
Additional tests resume the real runner after SIGKILL through the workspace
process, retain accounted spend and avoid crediting completed phases twice.
Imports leave the old target intact until validation and clean their private
directory on a controlled disconnect. Docker archives a child of its volume,
while the tool container sees only that child's subpath.

Release verification after the device/lease domain additions: the static half
(`release:check:static`) passed, including types, lint, documentation, audit,
build and compiled release smokes. The complete test half passed 7,511 tests
in 515 files; 10 tests were skipped. The workspace image was rebuilt from packaged output under its isolated tag;
its service bundle hash matches the final build exactly. The unchanged worker
uses the previously verified isolated image. The run included all 36 worker container-isolation
tests and the workspace container smoke, with `ATOMA_TEST_ACCEPTANCE_IMAGE`
and `ATOMA_TEST_WORKSPACE_IMAGE` explicitly selecting those images. This
supersedes the first foundation check's failures against a stale local image.

The current development machine has Docker Desktop/Linux ARM64. No valid
macOS code-signing identity was available when inspected. Windows and Mac x64
acceptance and signed distribution are not established by local ARM64 tests.

## Private WSS workspace transport

Implemented an explicit direct-TLS gateway and outbound client using the existing
workspace RPC and device store. Each dispatch/result and workload heartbeat checks
current authority. One outstanding command, bounded frames and terminal timeout
prevent automatic replay of unknown effects. A real WSS test exports a checkpoint
through the existing runtime. The app-side lease invokes teardown on connection
loss; failures remain unconfirmed. The adapter is not mounted in production and
has no engine launch or tool/preview channel yet. Review:
[device control](../reviews/atoma-compute-device-control-2026-10-18.md#wss-transport-follow-up).

WSS verification: `release:check:static` passed and the full test half passed
7,531 tests (10 skipped), across 516 passing files (2 skipped). Twenty new TLS
tests include byte-exact checkpoint transfer and a failed SQLite disconnect write.
The separate workspace image still matches the compiled bundle byte for byte.

## Target receipts and desktop execution integration

Projects now persist an execution preference; every new run freezes that target,
and continuation receipts retain their source target. The private admin setter
checks explicit grants and uses compare-and-set. Device admission exposes bounded
waiting reasons. The existing coordinator skips remote receipts and never falls
back to hosted compute; its actual remote dispatch remains to be connected.

The WSS protocol now separates concurrent tool calls from serialized workspace
operations. A host-issued assignment is acknowledged after local allocation,
and disconnection joins that allocation before engine teardown. Reconnection
names the previous generation; only a confirmed local reconciliation report on
the fresh session releases it. A command with an unknown effect is not replayed.

`DesktopCompute` launches immutable images in private Linux named volumes with
the desktop isolation profile, keeping snapshot control separate from tools.
An explicit restart follows confirmed tool drain. Real Docker Desktop ARM64 tests
cover the profile and the full TLS assignment → file write → drain → checkpoint
transfer → disconnect sequence. These are runtime integration tests, not a usable
Electron distribution or production coordinator acceptance.

Remote evidence is recorded as customer-device provenance throughout trace and
attestation contexts. Positive shared trust, recipe credit/learning/promotion and
prompt learning require independent hosted validation. The comparison protocol
remains preregistered but unexecuted; no resource reduction is claimed.

Integration verification: release static checks passed; the full suite passed
7,548 tests (10 skipped), with 517 passing files (2 skipped), using rebuilt
isolated images. The subsequent 27-test TLS run also exercised the real runner
with simulated models, an unusable host workspace path, remote Docker tools,
and a verified final artifact received on the host. Fresh-worker CI runs these
new container/TLS cases. This proves the runner seam, not coordinator/UI delivery.

## Browser pairing and orchestration bridge increment

Scope update from the owner: complete the remaining compute work **excluding
Electron**. Desktop installers and Electron views are no longer part of this
implementation request; a usable non-Electron client and backend remain required.

The server now has opt-in HTTPS pairing and WSS admission. Enable only for
integration work with `ATOMA_COMPUTE_ENABLED=1`, an explicit comma-separated
`ATOMA_COMPUTE_APP_VERSIONS` list and `ATOMA_COMPUTE_IMAGE_DIGESTS` (sha256 content
identities). Authenticated project hosting is required. Reverse-proxy TLS is
accepted only from the deployment's existing exact trusted-proxy addresses.
The default remains disabled. This is **not** an enabled run dispatch path:
customer-device runs still wait in the coordinator.

Native POST pairing requests reject browser cookies/origins. Browser consent
shows the account and organisation, escapes the application-supplied name,
requires an exact origin and binds a one-use consent token to the displayed
session. Redemption still requires the application's independent secret.
Requests, pending pairings, consent tokens and WSS peers have bounded admission.
Device lists, revocations, explicit project grants and CAS target settings are
org-authorized; access changes enter the existing audit journal. No token,
secret or pairing code is journaled. The compiled consent page is verified in
Chromium at desktop/mobile/landscape sizes, including native keyboard form
submission over TLS. Its catalog and shared action icons have a standalone
server bundle, checked after Vite has removed the client output directory.

The host child can use a one-use, bounded private Unix-socket bridge carrying
workspace and tool channels. `build-app` consumes and removes the bridge
capability before starting the existing runner. Host-only source provisioning
runs after corpus/project authority checks. Seed transfer and exact saved
read-run manifests cross the bridge; host paths are replaced with inert labels,
and the workspace service derives destinations in its private source volume.
Referenced identities are captured on that destination filesystem. Binding is
one-use and forbidden after preparation. A real Docker regression proves the
reference copy is mounted read-only, including when `ensureReadRuns` correctly
returns null (meaning no legacy-layout error).

Still required before customer use: coordinator dispatch and durable pending
finalization/reconciliation; headless client packaging, OS credential storage and
shared resource/disk budgeting; remote Haystack and previews; project machine controls/status; distributable
multiarchitecture runtime images and the preregistered capacity measurements.
Neither this increment nor passing tests establishes the 50% resource target.

The headless `ComputeMachine` lifecycle now holds a local single-owner inventory
before touching Docker. Its OS-released SQLite mutex is separate from its
fsynced operational JSON journal, following the existing launcher-volume pattern;
there is no product data or credential in either file. Allocations are recorded
before engine effects, survive a killed process, and become unconfirmed on
restart. A second owner is excluded across actual processes. Only successful
engine reconciliation permits a stop receipt on the new WSS session. Unknown
allocations cannot acknowledge a former installation's stop.

A recorded allocation can reopen its volumes in export-only recovery mode.
Preparation, restoration, tools and next-attempt activation are refused there;
a real Docker test transfers retained bytes after reopening. Volume labels and
per-instance control labels prevent an unsuccessful duplicate launcher from
removing an existing instance. This is a library lifecycle, not yet a distributed
CLI with OS credential storage, and the server's durable finalization/recovery
workflow still needs to consume it.
