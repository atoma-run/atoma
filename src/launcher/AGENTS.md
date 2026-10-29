# Launcher — AGENTS.md

`src/launcher/` owns engine access: it is the one component allowed to create,
inspect and remove containers and networks.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/contracts`](../contracts/AGENTS.md) — the typed launcher contract
- [`src/tools`](../tools/AGENTS.md) — the egress sidecar that composes it
- [`src/preview`](../preview/AGENTS.md) — the next caller
- [`src/cli`](../cli/AGENTS.md) — doctor's engine checks

Design of record:
[`records/designs/deployment-docker-launcher-2026-08-28.md`](../../records/designs/deployment-docker-launcher-2026-08-28.md) §2.

## The two invariants

1. **The atoma web container never mounts the Docker socket**, in any mode,
   including development.
2. **Exactly one component holds engine access**, under its own OS identity.

Mounting `docker.sock` into the web-facing container hands host-root to the
process that also holds session cookies, the authenticated API and the product
store — the exact inversion of the discipline that already forbids the worker
that socket.

## The contract is narrow on purpose

A caller names a PROFILE and supplies identity plus the few values that
profile takes. It may never supply a command line, an image, a mount path, an
environment map, a network name or any other engine option: those are derived
here. A launcher that accepted them would be a remote shell wearing a typed
interface, and invariant 2 would buy nothing.

`checkpointWorkerAbsent` accepts only a host-issued worker UUID and returns a
read-only absence proof. A live launch/cleanup or an engine error never establishes
absence; it neither claims nor removes another connection's worker.

There is deliberately no `exec`, no raw `inspect`, and no option passthrough.
Each would reopen the invariant, so each is a change to this file's contract
rather than an addition to a backend.

The kind vocabularies are CLOSED and hold exactly what a backend implements. A
member with no implementation is a promise the type system makes and the
runtime breaks.

## It must stay swappable

Kubernetes is deferred, not rejected, and this interface is the insurance
policy: a Kubernetes backend implements the same operations over Job/Pod under
RBAC without any caller changing. That is the concrete meaning of "Kubernetes
is a swap", and it is why nothing in the contract names Docker.

Two consequences worth stating:

- **Readiness is a log line.** These units sit on internal networks the control
  plane cannot reach, so there is nothing to connect to from here. Every
  backend can read a unit's output; a port probe would not survive the swap.
- **`armHardExitCleanup` may be a no-op.** A backend whose objects are already
  owned by something that cascades — `ownerReferences` — needs no synchronous
  fallback. That difference is exactly what the swap should absorb.

The local composition seam is `createContainerLauncher`: it returns only
`ContainerLauncher`, and egress and viz consumers use that return type.
Shared-deadline network removal and launcher-selected preview copy ownership
are contract operations; neither requires the concrete backend type.

## Local and separate service modes

`computeClient.ts` connects an explicitly bound private workspace handler over
outbound WSS. It verifies TLS, serializes commands and refuses repeated ids or
another execution generation; it does not launch Docker. `computeChannel.ts`
retains one logical channel across brief network changes, within the unchanged
lease. It replaces stale TCP after two missing five-second heartbeat replies,
reauthenticates, and deduplicates sequenced messages before application dispatch.
Queues are bounded to 128 frames / 8 MiB; overflow fails closed. A new process,
expired lease or explicit stop cannot resume this in-memory channel. Legacy peers
use the original transport. Reattachment never renews the lease.
Checkpoint open/digest operation failures return an explicit refusal without closing the live channel: automatic continuation can be disabled while the run proceeds. Snapshot restrictions remain unchanged. An `artifact-open` the publication inventory refuses answers `export-refused` with its typed code and bounded message, also keeping the channel: the server ends the run with that reason. Lease expiry, malformed replies and failures of other workspace operations still fail closed.
Those reply shapes (`export-refused`, an export's `omitted` list) are not
negotiated, so rollout order is the gate: server first (a push to `main`),
then the workspace image adopted in `computeImages.ts` together with the
desktop app that pins it; a CLI-paired client receives its own pinned
archive (`COMPUTE_CLIENT_ARCHIVE`, src/viz) beside the current images, so
adopting the new workspace image also bumps that archive, or an older CLI
client rejects the new replies and its run pends. Against an older server they parse as
`invalid-frame` and the run pends, as that server already left such a tree;
the export of a tree holding byte-less entries cannot succeed there. A
handshake flag was declined: `ready` cannot carry one (an older app refuses
an unknown field) and `hello.services` neither (an older server refuses an
unknown service), so gating would need server-first anyway and would turn
one pending run into a device that cannot connect.
`ComputeLease` guards this channel, but engine teardown remains caller-injected. Authenticated heartbeat acknowledgements renew from dispatch
time, never receipt time. Monotonic and wall deadlines jointly detect expiry and
sleep; every operation must call `assertActive`. Expiry starts cleanup once. Both ends log bounded transport causes and pending
request metadata through `computeDiagnostics`; frame bodies, arbitrary exception
messages and remote close text are excluded. The launcher retains two private
1 MiB connection logs under its state root for desktop and CLI diagnosis.
Only engine-confirmed cleanup may resolve its callback; failure stays unconfirmed.
The headless CLI keeps credentials in macOS Keychain or Windows DPAPI
CurrentUser, never plaintext config, argv or environment. Pairing, image pulling
and Docker resource changes are explicit; diagnostic probes do not alter Docker
settings. A closed guard cannot be revived by a late response or reused after reconnect.
Before a new session, transient DNS/socket failures retry with a one-second
backoff capped at thirty seconds, only after engine-confirmed teardown. The
inventory owner stays locked and each retry reconciles and rechecks capacity.
TLS, identity, protocol and unconfirmed-cleanup failures remain terminal; no
command or interrupted run is replayed by this reconnect loop.

Explicit desktop preparation refreshes all four pins from the bundled verified
`computeImages.ts` release before pulling. It requires local inventory ownership
and confirmed teardown of earlier workloads. Opening, diagnostics and headless
`pull` retain the configured pins; pairing, budgets and credentials survive upgrades.
Worker fixes are not deployed to Compute by a server release: the installed
immutable worker must contain the fix too. Publish and test the affected image,
adopt its verified digest, prepare the idle device and check the configured
image before a live regression run. Server trace provenance alone does not
identify the code executing `record_probe` on a customer device.

`DesktopCompute` owns the desktop-only profile: immutable image identities,
Linux named volumes, no host binds, non-root read-only containers, capped CPU,
RAM/swap and processes, and network none by default. The headless client
explicitly selects the existing per-run isolated egress proxy for package
registries; `--no-network` disables it. Engine-confirmed boot reconciliation
also removes that machine’s proxy and both networks. Tools receive only `current/`; the
private control service alone mounts the snapshot spool. A drained worker cannot
restart until explicit next-attempt activation. Close confirms engine absence
and preserves the workspace and snapshot volumes; it removes the allocation's
retrieval corpus (recovery refuses retrieval, previews never mount it), never
the shared embeddings cache. Boot reconciliation also reclaims this machine's
allocation corpora after confirming all its containers absent. Boot reconciliation requires the app's single-instance
lock. This profile is not equivalent to gVisor. WSS assignment allocation is
joined before teardown, preventing a late allocation from escaping a lost lease.

`ComputeMachine` holds `ComputeInventory` ownership before any engine access.
The empty SQLite mutex is OS-released; the separate bounded fsynced JSON journal
contains only operational allocation identities, never product data or credentials.
Restart marks unfinished allocations unconfirmed. Engine reconciliation precedes
WSS stop acknowledgement; an unknown allocation cannot prove another installation
stopped. Recorded volumes may reopen for export only, with no tools or resume.
Per-instance labels protect an existing control container from duplicate cleanup.
Workspace and snapshot volumes have no retention yet (2026-10-26: 203 volumes,
5.56 GB on one Mac). An age and count pass was built and withdrawn on review:
the device cannot tell which runs still await finalization, and disposing one
makes its later export-only recovery close the connection on every attempt, so
the run never settles. It waits for the server to tell the device which runs it
still needs.

`connectContainerLauncher` selects the local backend when no
`ATOMA_LAUNCHER_SOCKET` is configured, otherwise the separate Linux service.
The configured socket must work; never fall back to Docker on the caller.
Setup and limitations: [launcher service](../../docs/launcher-service.md).

The socket is private, versioned and bounded. Only the service chooses images,
runtime, workspace location and identity. Callers verify the reported profile;
handles cannot name another owner or arbitrary engine object. Naming has one
shared derivation. Arm/disarm calls are awaited so registration precedes work.
Each connection holds its owners; disconnect cleanup follows any in-flight
operation and never reaps another connection's objects. Unknown outcomes are
not replayed. Global reconciliation refuses while a connection owns work and excludes new claims until it finishes.

W1–W3 supply the service, transport and volumes, not deployed acceptance.
The shared workspace projection remains a W7 packaging requirement. Local mode
remains in-process and does not satisfy the deployment boundary.

## Worker lifecycle and transport

Every worker container runs with `--init` (`workerRunArgs`): an orphan a command
leaves is reaped by that init, and the worker can tell orphans from its own
children ([src/tools](../tools/AGENTS.md), escaped process groups). Without it
the worker was PID 1 and each orphan became its unreaped zombie.

Every worker, hosted and Compute, carries ONE task bound, `WORKER_PIDS_LIMIT`
(2048). Linux `pids.max` counts threads, and one headless Chromium tree is
~113. Compute's 256 was hit 9,822 times in run 40c20c5d (2026-10-25): the
worker, validate_html's browser and four servers held 150 while the run only
read files, so the project's browser suites, npm and node failed with EAGAIN.
2048 is twice what a run legitimately starts at once — Playwright's default
of one Chromium per two `os.cpus()` (which ignores `--cpus`: seven on a
14-CPU Docker Desktop VM), the tool browser, four servers, an install — and
stays a fork-bomb bound whose kernel cost is charged to the same `--memory`
cap. Hosted workers had no bound at all; they take the same one.
`tests/worker-thread-headroom.test.ts` launches four Chromium trees in the
real Compute profile, and the former 256 as its failing control; both Docker
CI jobs that build the worker run it. The bound is in the desktop app's
launcher, so it reaches a device with a desktop release.

MEMORY, not tasks, is the next wall. Measured 2026-10-25 on a Mac (Docker
Desktop, 14 CPUs, worker image of 2026-10-21, Chromium 155) with
`ATOMA_SIZE_WORKER=1` (`ATOMA_SIZE_WORKER_TREES` sets the count): each tree a
node process on a 1,500-row page, beside a resident tool browser, at the
smallest Compute tools budget (2 GiB, no swap). 7+1 trees: 985–998 tasks,
`memory.peak` 1,596–1,618 MiB (1,425 anonymous), no OOM kill; 8+1:
1,107–1,123 tasks, 1,784–1,838 MiB, none; 9+1: 1,246 tasks, 1,976 MiB, none;
10+1: 1,345 tasks, the 2 GiB cap, 6 `oom_kill`s, 6 of 11 browsers failed.
So ~190 MiB a tree: ten workers fail on memory with 700 tasks free, and
eight leave 210–260 MiB for the worker and the run's servers. No default
changed: no run has hit it yet, and only the 6 GiB minimum budget leaves the
tools worker 2 GiB (`computeWorkloadBudget`; the recommended budget gave it
5 here).
Other containers keep smaller bounds on purpose, running no test runner: a
hosted browser app (`hosting.ts`, 256) holds one host-fixed Chromium beside
its server under gVisor, and a desktop preview (`desktopPreview.ts`, 128)
serves the delivered app from an image with no browser.

`ContainerToolExecutor` is a compatibility facade. Local stdio attach lives
in `localWorker.ts`; the service mode uses `RemoteWorkerExecutor` and the
closed `WorkerLauncher` contract. The launcher chooses image, uid, workspace
mapping and egress topology. No caller path or engine argument crosses RPC.

The launcher creates two private Unix endpoints per worker. The worker
CONNECTS to its endpoint, mounted as ONE read-only socket file; the caller
connects to the separately issued endpoint. The launcher relays their NDJSON
protocol with stream backpressure. Neither the control socket nor any sibling
endpoint is mounted in the worker. A worker-writable socket directory would
allow replacing an endpoint with a host-side symlink: do not use that shape.
Tool requests remain concurrent and id-matched on the data channel, independent
of serialized lifecycle RPC. Shared wire types live in `contracts/workerProtocol.ts`.

The socket root is bounded: `<socketRoot>/<uuid>/w.sock` must fit `sun_path`
(104 bytes on macOS/BSD, 108 on Linux), so a root over 56 bytes cannot hold a
worker. `LauncherWorkers` refuses it at CONSTRUCTION and names the arithmetic,
because bound late the protocol answers a coded `operation-failed` with no
message and a root a few bytes too long reads as an engine fault (2026-09-22).

One connection owns each worker and one worker owns each configured workspace.
A lost data channel is terminal. Removal must be confirmed by the engine before
network teardown or reuse; failed removal retains the workspace claim. Startup
cleanup waits for the outstanding create, and control disconnect retries it.
The worker label is `dev.atoma.owner=worker`, separate from preview and egress.
The explicit orphan sweep includes it, and the exit backstop removes workers
before the network registry runs. Boot recovery and stale socket sweeping are
launcher-owned.

Service workspaces are named volumes. The local driver binds a launcher-owned
projection beneath one dedicated root; callers never choose driver options.
The projection preserves host-side delivery, preview classification and backups
without mounting product stores into workloads. `hostPath` describes that view;
only the issued volume identity is used for a workload mount. Projects derive
their path from stable ids through `projectWorkspaceRelative`; operator aliases
remain service configuration and must fall beneath the same root.

`WorkspaceVolumes` journals intent BEFORE creation in machine-local operational
state. It never opens the product store. A separate SQLite exclusive transaction
fences service processes while the JSON journal is atomically committed and
fsynced; OS process death releases the lock. A failed journal write poisons the
manager until restart. A volume that predates its creation intent is never
adopted or removed. Failed removal retains its lease and prevents reuse.

Heartbeats renew a ten-minute lease, capped at 24 hours from workspace creation.
Expired leases cannot be resurrected. Socket expiry joins the in-flight operation
before reverse teardown; failed disconnect cleanup retries every 30 seconds.
Boot recovery runs under the process lock, before accepting clients: workers,
owner networks, volumes, then stale UUID socket directories. Engine absence
must be confirmed. Run bytes survive volume teardown for retention/backup (W9);
only ephemeral preview projections are removed. Never broaden that deletion to
run data. Shared root paths and local-driver backing must be mounted consistently
on the engine host, launcher and control plane; W7 packages that topology.
## The flags are the isolation

Every flag in a profile was verified against a real container before it was
written down, and `tests/egress-sidecar-lifecycle.test.ts` asserts the exact
command sequence rather than trusting a comment. Three facts sit behind the
egress profile and none may be relaxed:

- `--network none` blocks the control plane and the internet; the DEFAULT
  bridge REACHES the control plane; only `--internal` WITH
  `gateway_mode_ipv4/ipv6=isolated` blocks both while still being a LAN a proxy
  can bridge. Plain `--internal` is not enough — its bridge gateway can reach
  host services.
- Docker Engine 28+ is required for those gateway modes, and an older engine
  FAILS CLOSED. `isIsolatedGatewayUnsupported` exists so the caller can say so
  rather than silently serving a weaker network.
- One network per owner, never shared. Reproduced: two containers on one
  `--internal` network read each other's HTTP servers, so a shared network
  hands one tenant's workspace to the next.

## Two families, one namespace each

`dev.atoma.owner` is `egress` or `preview`, and every object carries it. The
families must not share a namespace: a sweep collecting orphaned previews must
never remove a live run's egress network. A reconciler therefore queries once
per family, and `listUnits` reads a unit's kind from its name prefix.

Object names are deterministic from the owner id and are **wire contracts
between containers**, not cosmetics: the relay resolves its upstream by the app
unit's name, and the run reaches its proxy by the proxy's. Renaming one is a
change to what two containers agree on.

Sweeps and per-owner teardown remove **containers before networks**. A network
with an endpoint still attached refuses removal, so the reverse order spends
the entire bounded retry budget losing to a container nobody removed. Within a
preview, the relay goes before the app: it is what holds the network open and
what a member is still connected to.

## The preview profiles

- **`preview-app`** runs the delivered application: pinned image by digest,
  `--runtime=runsc`, non-root, read-only root filesystem, `--cap-drop ALL`,
  `no-new-privileges`, memory equal to memory-swap (otherwise the cap is
  escapable by swapping), bounded CPU/pids/nofile, two bounded tmpfs (`/tmp`
  and `/data`, both dying with the container, which is what makes a restart
  begin again from the immutable copy), rotated logs, and a fixed set of
  environment variables — never a spread of the parent environment, whose
  variables are credentials and store paths. One mount: the launcher-issued
  workspace. The app command is exactly `node <entry>`.
  The explicit `mode: terminal` variant instead runs the fixed
  `/opt/atoma-terminal/server.mjs`; it accepts no entry or egress. It mounts
  `/workspace` read-only, copies into a 512 MiB `/data` tmpfs, and caps memory
  and swap at 1 GiB. This tmpfs permits executable CLI files; root stays
  read-only and capabilities stay dropped. Shell input never crosses launcher
  RPC: only the terminal inside this isolate receives it.
- **`preview-ingress`** runs the relay. Its upstream is resolved HERE from the
  app unit of the same owner, which is what makes it impossible to point
  anywhere else. It publishes on **loopback only**, on an OS-assigned port the
  launcher reads back — a caller that could choose a host port could collide
  with another preview's, or with anything else on the machine.
- `runsc` is the default and production requires it. Whether a dev runtime is
  admissible is the CALLER's decision, made when it constructs the launcher;
  an unset runtime here would be a bug, not a permission.

A mount string is a wire value for the engine, and the engine speaks POSIX, so
a host path is converted rather than passed through — a developer host with
backslash separators would otherwise hand Docker one unreadable component.

Three of these were MEASURED against a real container rather than reasoned
about, and each was wrong before it was measured:

- **The relay needs a PUBLISHABLE leg.** Docker publishes no port at all for a
  container whose only network is `--internal` — `docker port` answers "No
  public port published" — so a relay attached to the isolate's network alone
  listens where nothing can reach it. It is created on the publishable network
  and the internal one is connected after, which is also why the design says
  it is the one component on both.
- **The container must be able to READ the mount.** The copy is written by the
  control-plane process, so a container running as anyone else dies with
  MODULE_NOT_FOUND on its own entry file. `hostContainerUser()` — the helper
  the worker backend already used for exactly this — is the default; as root
  there is no uid to match, so the copy is chowned to the fixed non-root
  identity instead of being widened to world-readable.
- **The command must not be the image's.** `--entrypoint node` is passed
  explicitly, because an image ENTRYPOINT would otherwise wrap the one start
  command the profile is allowed to run.

The optional `preview-egress-proxy` belongs to the preview family and is
removed with its generation. The app receives only a derived proxy address
and loopback bypass; it remains on the internal network. The Docker backend
reads the proxy IPv4 endpoint on that exact internal network before starting
the app, so gVisor does not depend on Docker embedded DNS. A missing endpoint
refuses startup; the uplink address is never used.

## Workspaces: the launcher issues, the caller fills

`createWorkspace` hands back a location; the preview subsystem writes the
filtered copy into it. That split keeps "no mount paths from callers" true
while the copy's CONTENT and its filtering policy stay with the subsystem that
understands the deliverable. The directory is recreated empty every time: one
left by a crashed predecessor would be mounted into the next generation, which
is how a preview would serve bytes the run that owns it never produced.

The service uses a named volume with a shared projection; the legacy local
backend retains its direct directory. The optional `hostPath` is a copy/view
capability, not the engine identity. Mount construction resolves the issued
volume inside the launcher rather than accepting a handle's path back.
## Ordering belongs to the caller

`purgeOwner`, `createNetwork`, `startUnit` and `removeNetwork` are primitives.
WHICH objects are cleaned, created, connected and torn down, and in WHAT
sequence, is the caller's contract with its own domain — the egress sidecar
keeps that order, and it is unchanged from before the extraction. A launcher
that decided the order would make every caller's teardown its business, and
the asymmetry between the failure path and the stop path (internal-then-uplink
versus uplink-then-internal) would have been quietly normalised away.

`removeNetworkBefore` exists for the same reason: several removals in one
teardown must share ONE deadline, not each get a fresh budget.

- **Read-run copies are the one second worker mount**: `.atoma-runs`
  read-only over itself, only when the spec asks (`readOnlyRunCopies`). The
  source passes `verifiedRunCopiesSource` (a real directory whose realpath is
  the workspace's plus that name) right before every `docker run`, because
  Docker follows a symlinked bind source; the engine gets that realpath.
  `--mount` only, `volume-subpath` in service mode (Engine 26+, fails closed).

## Intentional choices and rejected shortcuts

- **`-v` for the read-run mount.** A missing source is created by the daemon
  as root, where `--mount` refuses. Also rejected: copies stored outside the
  workspace and mounted over it (host readers, the sandbox's link refusal,
  sealing and retention would all move).

- **Compute retention driven by free disk, or by age and count alone.** Refused:
  the first deletes the evidence a full disk is documented to protect; the
  second (built and withdrawn 2026-10-26) deletes a run still awaiting its
  transfer, whose recovery then fails forever. Retention needs the server's list
  of runs it still needs from the device.
- **A launcher that returns a pipe.** It would make the interface unswappable
  for the one operation that matters most, and it is what keeps the worker's
  transport behind an explicit socket protocol.
- **Auto-arming the hard-exit registry inside `createNetwork`.** Tracking is
  armed BEFORE creation on purpose: if stale-object removal raced the engine's
  endpoint teardown, `create` itself can fail while the old objects are still
  durable and still need the fallback.
- **Recovering an owner id from an object name.** Names carry a hash, so they
  cannot be reversed. A reconciler only needs to remove the object; a caller
  that needs the original owner holds it already. The one exception is
  `reapDeadRunEgress` (in-process egress, 2026-10-15, when production ran out
  of Docker address pools): it never reverses a name. It forms the candidate
  owner `run-<pid>` from the label, keeps it only when the label's hash proves
  it, and reaps it only when that pid no longer exists. Egress networks carry
  their creator's pid namespace (`dev.atoma.pidns`) and only a sweeper in that
  namespace judges them; unlabelled legacy ones only on Linux.
- **A second copy of the naming rule.** `networkName` and `unitName` are on the
  contract so a failure path with no handle can still name what it must
  remove, instead of rebuilding the rule at the call site.

## Persistent application hosting

`hosting.ts` owns the closed prepare/create/start/inspect/list/stop profile for deployments.
Objects carry their full identity as labels; `listHosting` reads them back so the web's
boot recovery stops, with `stopHosting`, deployments no running row names.
`createHosting` makes a deployment's networks and containers unstarted, labelled with a
digest of its launch and images; `startHosting` starts only objects made for its own
digest, else creates them first, so an update's outage is starts and readiness alone. A
web newer than its launcher meets `invalid-request` and falls back to that full start.
Stop gives the application (the only data writer) ten seconds, the stateless relay and
proxy none: as PID 1 they ignore SIGTERM, which cost ten seconds each per update.
Its `dev.atoma.owner=hosting` objects are excluded from ephemeral sweeps and
survive control-socket disconnect and platform restart. `hostingMain` offers
only those operations for installations still using the legacy run launcher.
Images are immutable digests (including engine content IDs); gVisor is required.
Only UUID identities, a validated relative Node entry and an optional browser
capability cross RPC. The browser image, persistent profile, private desktop and
public-only egress proxy are fixed by the host. CDP/VNC never publish ports. Source is
read-only; per-project `/data` survives every stop. No deletion API exists.
See [project hosting](../../docs/project-hosting.md) for supported limitations.
A deployment moves `current` but never restarts `atoma-hosting-launcher`, so
`hostingMain` watches its own release path (`releaseWatch.ts`) and exits 75 for
systemd's `Restart=on-failure` once the release changed and no connection is
open: started minutes before address pinning, it created a pinless deployment
nine days later (2026-10-25). The web retries its hosting start, and an
unreachable launcher never marks an application unavailable.

## Desktop companion

`desktopApp/` packages Electron around `computeApplication.ts`, the same lifecycle
used by the CLI. Only its utility process imports the engine-owning launcher.
The bundled renderer is sandboxed, isolated, has no Node or network access, and
uses the closed `contracts/computeDesktop.ts` IPC. Main validates the sender frame
and opens only fixed destinations or a validated one-use Atoma pairing URL.
Closing hides the window; quitting/updates wait for confirmed workload teardown.
Unsigned previews never install updates. Stable publication requires platform
signatures and macOS notarization; images stay pinned in `computeImages.ts`.
