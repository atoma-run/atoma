# Atoma Compute implementation state — 2026-10-18

The owner requests the whole customer-compute plan EXCEPT Electron. It is NOT
complete and there is no usable customer-device project execution target yet.

Work is isolated on `codex/atoma-compute`, in the managed worktree
`/Users/mgtf/.codex/worktrees/atoma-compute/atoma`. Do not deploy this as a
finished feature. The main/shared checkout has unrelated ongoing work.

Implemented: async workspace capability integrated into the runner's live
control operations; local adapter and private process RPC; standalone compiled
workspace service/image; remote sequential checkpoint sealing after process
drain, bounded private export, chunk receiver, validation and atomic owner-bound
attachment with expiring transfer reservations. Default execution remains hosted.

Remaining dependencies and capacity protocol are recorded in
`records/designs/atoma-compute-2026-10-18.md` and
`records/experiments/atoma-compute-capacity-protocol-2026-10-18.md`.
Preparation, bound-source seed/copy, deepening and streamed checkpoint restore
now cross the private service boundary. The runner awaits asynchronous restore
before launching tools. A backend factory seam supports a mocked-model run
whose host workspace path is unusable. Typed source provisioning and filtered artifact export now cross the private
RPC. Receiving-host staging verifies bytes before exposing the final directory.
Authenticated device admission, project continuation binding and persistent
coordinator finalization still need integration. The private device domain now
stores pairing proofs, grants, generation-fenced sessions and one-run assignments;
a local lease guard preserves unconfirmed engine failures. HTTP/browser pairing,
production WSS mounting, audit/rate limits and engine/coordinator wiring remain, along with remote tool transport,
retrieval/previews, customer-proof trust policy and the Electron app remain.

Docker Desktop/Linux ARM64 is available. The workspace service was built from
packaged dist and tested under the isolated `atoma-workspace:compute-development`
tag; snapshot spool uses a separate control volume never given to tools.
No macOS signing identity was installed. Windows/Mac x64 acceptance and signed
distribution are unverified. No resource reduction has been measured.

Workspace/device/WSS verification: `release:check:static` passed; full tests
with the isolated images passed 7,531 tests (10 skipped),
including 36 worker isolation tests and the separate workspace container smoke.

The private device domain and lease guard add 23 behavioral tests. Review and
remaining trust/integration assumptions: `records/reviews/atoma-compute-device-control-2026-10-18.md`.

The private WSS gateway and outbound client now connect the existing workspace
RPC to the device domain and local lease. TLS integration tests cover actual
checkpoint bytes, authentication, cut connections, stale/mismatched responses,
revocation, timeout and failed teardown. They are not mounted in production;
assignment negotiation, public rate limits/audit and engine wiring remain pending.

Final WSS revision: 20 real TLS integration tests pass; release static checks and
all 516 test files pass (2 skipped). The workspace image bundle hash matches the
final compiled bundle. Direct-TLS adapter remains unmounted in production.

Current integration revision (uncommitted until verification): immutable hosted/
customer-device project and run targets, owner CAS assignment settings and
per-device admission reasons. Remote queued runs do not consume hosted admission
and cannot fall back to the hosted driver. Full remote coordinator dispatch is
still pending. WSS now carries concurrent tools plus an explicit assignment
acknowledgement after local allocation; connection loss joins allocation before
engine teardown. Customer observations are stamped in trace/attestation and do
not credit/promote shared positive trust or learn recipes/prompts.

DesktopCompute now launches pinned workspace/worker images in named Linux volumes
with no host binds. The private service survives worker drain to seal/export.
Real ARM64 Docker + TLS tests cover assignment, writes, engine-confirmed drain,
checkpoint bytes and disconnect teardown. A measured Docker auto-remove race
was corrected by bounded engine-absence polling, never a timeout-as-stop claim.
There is no Electron app, public pairing API or enabled remote coordinator yet.

WSS reconnect now includes the prior execution identity and requires a fresh
launcher reconciliation callback plus an exact acknowledged stop report. Failed
engine reconciliation retains the indeterminate assignment. Deepening's explicit
workspace restart requires confirmed tool drain and reactivates a new attempt.

Verification of this integration: release:check:static passed; the full suite with
rebuilt isolated worker/workspace images passed 7,548 tests (10 skipped), 517 files
passed (2 skipped). An additional targeted run of all 27 TLS tests passed after
extending the real-container case to the actual mocked-model runner: unusable host
workspace, remote write, shutdown/drain, verified artifact receipt and checkpoint.
Fresh-worker CI now includes both desktop/runtime and TLS integration suites.
Workspace bundle SHA-256: 9155e25a1356c351814f38cadec032959a84357d5e26e80844055ec5aad60bc8.

Latest scope: the user requests all remaining work EXCEPT Electron. Do not keep
Electron as an outstanding deliverable. The rest is not complete.

New increment: opt-in server HTTP pairing + WSS mounting with strict deployment
version/digest policy, exact proxy TLS trust, rate caps and deployment freeze;
one-use session/org-bound browser consent and secret-free audit; private
host-child compute bridge consumed by build-app; runner source provisioning after
scope validation; one-use dynamically bound sources in the private service; exact
saved-manifest transfers and a real-container regression for read-only copies.
Browser consent compiled/TLS/keyboard/responsive smoke is in viz:smoke. Production
activation is NOT performed. The coordinator still refuses remote dispatch.

The initial full suite of this increment exposed runTask arity and the explicit
server-catalog bundle allowlist; both were corrected and targeted regressions
passed. Container acceptance must use ATOMA_TEST_ACCEPTANCE_IMAGE with the
isolated rebuilt image; the shared :latest image is stale and must not be replaced.
Final verification/commit details follow below once complete.

Headless lifecycle increment: ComputeInventory holds an OS-released SQLite mutex
and a separate atomic/fsynced bounded JSON operational journal (no product data
or credentials). ComputeMachine connects it to Docker and WSS reconciliation;
real-process tests cover exclusion/SIGKILL persistence, and real TLS+Docker tests
cover reconnect without replay. DesktopCompute accepts locally recorded allocation
UUIDs and an export-only recovery mode; real Docker verifies retained bytes,
read-only reference mounts, and that duplicate/foreign instances cannot remove
the existing control container. A distributable CLI/OS credential vault, remote
coordinator/finalization, retrieval, previews, project UI and measurements remain.

Final source verification for this increment: release:check:static passed;
full tests with isolated acceptance/worker/workspace images passed 7,568 tests,
10 skipped, 521 files passed and 2 skipped. The final workspace bundle and image
both hash to a55a462621135a3d595632ac038198578eef76078eede0194e8eda82f5e8d271.
Compiled Compute browser consent passes TLS, keyboard and responsive checks.
The full viz:smoke also passed (MCP consent, Compute consent, WebGPU and WebGL
application journeys). Final gateway review rejects unsupported upgrade paths
when it is the only upgrade consumer; its focused TLS regression passed afterward.


## Continuation after owner correction (2026-10-18, work in progress)

The owner explicitly objected to stopping at milestones: finish ALL remaining
non-Electron scope. Do not end another turn asking whether to continue. No
subagents (current developer restriction). Current isolated checkout remains
`/Users/mgtf/.codex/worktrees/atoma-compute/atoma`, branch `codex/atoma-compute`.
HEAD still e0ccd118; the following changes are uncommitted and must be preserved.

Implemented this continuation:
- Actual coordinator/customer dispatcher, host process bridge, abort orchestration
  on WSS loss; remote queued runs use ordinary org/model/orchestration leases.
- Product-store finalization journal, bounded durable driver result, streamed
  byte-verified delivery. Running remote rows survive server boot; no terminal
  event or read-copy cleanup while pending. Explicit authenticated requester-only
  POST `/api/compute/runs/:id/finalize` recovers transfer in a fresh generation.
- Export-only recovery assignment identifies an older same-run local allocation;
  local inventory preserves generation aliases, denies cross-run reuse. Engine
  stop reports are persisted independently of timeout; explicit reconciliation
  can fail an interrupted run only after exact confirmed stop, enabling normal
  checkpoint eligibility. No commands or model calls are replayed.
- Separate residual host memory reserve `ATOMA_COMPUTE_HOST_MEMORY_RESERVE_MB`,
  defaults to existing hosted reserve (no optimistic reduction); queue skips
  unavailable devices and independently considers memory admission.
- Headless CLI `compute`/`compute:dev`: pair, doctor, pull pinned images, start,
  status, forget. Node24 + native macOS/Windows; requires Docker Desktop/WSL2.
  macOS Keychain via security stdin; Windows DPAPI CurrentUser ciphertext.
  Native macOS secure-store roundtrip tested. CLI is currently one connection
  per start; requires start again after disconnection. No Electron code.
- Desktop proxied registry egress reuses existing sidecar and policy, defaults on
  in CLI config, --no-network during pair disables. Machine reconciliation owns
  proxy/networks too; direct outbound TCP and host control access denied.

New files staged explicitly: src/projects/computeDispatch.ts,
src/launcher/computeCredential.ts, src/cli/compute.ts,
tests/compute-cli.test.ts, tests/compute-credential.test.ts. Existing modified
files not yet all staged. No unrelated checkout edits.

Validation this continuation (not yet full release):
- `/tmp/compute-dispatch-docker.log`: 140 tests across connection/devices/inventory/
  coordinator; includes real Docker export-only recovery on fresh WSS generation.
- `/tmp/compute-egress-tests.log`: 5 real Docker desktop tests, including registry
  access, denied host service, denied direct TCP bypass, network cleanup.
- `/tmp/compute-client-tests.log`: 5 tests including actual macOS Keychain roundtrip
  (`ATOMA_TEST_SYSTEM_KEYCHAIN=1` explicit opt-in only); mocked CLI pairing.
- `/tmp/compute-client-types.log`: typecheck both tsconfigs passed before latest
  tiny CPU/docs edit. Targeted lint passed earlier; rerun all changed files.
- Native diagnoseClient tested separately; session 58189 result may need polling.

Important pending: full release/build/browser checks for current changes;
shared runtime resource budget/disk enforcement; CLI live controls; actual remote
Haystack and previews; project/device choice/status UI; multiarch distribution,
real 1/5/10 preregistered benchmark and external hardware acceptance. Existing
host retrieval still executes server-side; do not claim full offload yet.

## Retrieval and preview continuation (2026-10-18, still uncommitted)

Supersedes the pending implementation list above, not the final validation status:
- Remote Haystack is wired through the private host bridge and an independent WSS
  channel. Selected source bytes are archived without host extraction; client
  extraction/indexing/search runs in a private network-none image/volume. Host
  revalidates corpus scope and every returned reference. Bounded local embedding
  SQLite cache (256 MiB); no product database on client. Actual Docker BM25/PDF
  test passes; real hybrid model provisioning/acceptance remains.
- CLI now requires workspace/worker/retrieval/preview immutable images, advertises
  service capabilities, reconnects only after confirmed local teardown, reconciles
  before the new generation, and never resumes interrupted work automatically.
- Project target/grant/status UI and device controls are implemented. Pending
  finalization UI, actionable query failures and final browser smoke remain.
- Remote preview controller/manager/gateway stream, separate local copy, fixed
  container-local port relay through docker exec (no published port), stop/lease
  cleanup implemented. Static Docker preview test passes; WSS preview revocation
  and concurrent workspace test passes. Additional terminal/Node/gateway and
  restart tests remain. Idle relay slots now release on timeout.
- Workspace classify-preview operation shares hosted classification. Dispatcher
  stores its remote observation in product DB after verifying the returned entry
  exists in received artifacts, preserving custom Node entries excluded with the
  internal probe manifest. Coordinator passes it to descriptor recording.
- Resource envelope now 5 CPUs/6 GiB RAM/4 GiB disk including retrieval/preview
  proxies. Resource status includes both egress proxies. Dynamic disk enforcement,
  retention, transfer progress and last server-confirmed checkpoint remain.

Images built locally (ARM64 only): atoma-retrieval:compute-verification,
atoma-preview:compute-verification, atoma-workspace:compute-development,
atoma-worker:compute-verification. Rebuild workspace/preview bundles after the
latest classification change before testing compiled container paths again.
Latest focused logs: /tmp/compute-retrieval-docker.log (5 passed),
/tmp/compute-preview-tests.log (22 passed, actual Docker),
/tmp/compute-classification-tests.log (77 passed, 1 opt-in skipped),
/tmp/compute-wss-preview-tests.log (118 passed, 3 opt-in skipped).
Typecheck passed before latest small changes; final release still NOT passed:
last full run had one Docker bind failure under suite load, focused rerun passed.
No capacity measurements or distributed images yet; no Windows/Mac Intel hardware
validation. No Electron, production runs, paid calls or deployment performed.

## Final non-Electron integration (2026-10-18, verification in progress)

Supersedes pending implementation items above:
- Actual offline Docker hybrid embeddings/reranking + PDF extraction passed using
  local BGE and MiniLM weights. No paid calls. Optional weights staged only in
  ignored dist/compute-models and excluded from ordinary release archives.
- Pending-finalization requester UI, actionable load failures, live controls,
  dynamic disk guard, transfer bandwidth/progress and persisted server checkpoint
  confirmations are implemented. Reconnect refreshes advertised resources.
- Actual Docker static, custom-entry Node and terminal previews pass; remote
  gateway terminal origin/grant parity is tested. Static bundle import closure
  was narrowed to the artifact contract to exclude control/model modules.
- Native Linux amd64/arm64 build/test/publish workflow added, called explicitly
  by the release workflow after source publication; manual dispatch validates
  only. This avoids GITHUB_TOKEN event suppression. Not yet published/run.
- Design record rewritten to current scope, docs/compute.md documents actual
  behavior and limitations. No Electron, no ceiling increase, no resource-saving
  claim. Capacity protocol is preregistered; faithful fleet/hardware acceptance
  and capacity measurement are not established by one ARM64 developer machine.

Latest verification: release:check:static passed in /tmp/compute-release-static-final.log.
All five isolated images rebuilt from current dist, including hybrid derived image
(/tmp/compute-images-final.log). Full suite currently session 5970, maxWorkers=2,
all explicit Docker image envs, log /tmp/compute-full-final.log. Earlier full suite
had an obsolete image-closure expectation (fixed and strengthened) and a browser
400ms async-page race (passes isolated; no production behavior weakened).
Browser smoke must run after full suite. Update review with final results, commit
all own changes in this isolated checkout, push codex/atoma-compute, update PR25
using gh api and /tmp/atoma-compute-headless-pr-body.md. Never push main here.

Final local checks passed: release static; full suite 7,611 passed / 10 skipped
(528 files passed / 1 skipped), including fresh Docker hybrid retrieval and all
preview modes; full viz:smoke passed. Desktop/mobile screenshots inspected.
No active Compute-labelled containers remain. Frozen capacity corpus and exact
hashes now accompany the preregistration (60 batches / 320 runs); no capacity
measurements claimed. README and .env.example link/document opt-in activation.

## Image publication requested (2026-10-18)

Owner explicitly authorized publishing Docker images and deferred native Mac/
Windows acceptance until the client application tests. Image-only publication
uses a `compute-images-*` tag, builds/tests native Linux amd64 and arm64, pushes
four GHCR images and preserves digest receipts as Actions artifacts. It does not
merge the feature branch, create an application release or deploy production.

Publication completed: `compute-images-20261018-2`, revision b0e263be,
Actions run 39123606814. Four public GHCR packages, each linux/amd64 + arm64;
90 tests passed and one hybrid-weight test skipped per architecture. Anonymous
manifest/config hashes, architecture and revision checked for all eight images.
Receipts/checksums: records/releases/compute-images-2026-10-18/.
Owner approved temporary organization public-package permission; restored to
disabled after making the four packages public. Native desktop acceptance and
capacity measurements remain deferred/unexecuted. Base retrieval is BM25.

## Multilingual images published (2026-10-18)

User requested embedded hybrid models and support for all 13 Atoma locales.
Tag compute-images-20261018-3 at a5b7bde7 published all four images on amd64/arm64,
including E5-small multilingual + mMARCO MiniLMv2 weights (pinned upstream commits
and SHA-256 in docker/compute-models.lock.json). Native image workflow
39124781261 succeeded: 91 tests per architecture, no skips, including 26 actual
hybrid searches per architecture (13 locales, same-language and English corpus).
This is a small compatibility smoke, not a relevance benchmark. Prefixes are
query/passage; documentPrefix now travels hosted/remote and keys cache isolation.
Receipts in records/releases/compute-multilingual-2026-10-18 include ready-to-use
haystackConfig. All eight manifest/config digests and anonymous access verified.
No main merge/deployment or native desktop acceptance performed.
Full CI for a5b7bde7 also passed (39124777321): 7,570/51 general tests,
88 fresh-worker tests, 3 mender-isolation tests, static release checks.

## Production activation and existing CLI (2026-10-18)

Owner chose the existing headless client and atoma.run UI; Electron is again
out of scope. No Electron dependencies or code were created. Main 00b3779f
passed CI 39131749011 and deployed successfully in 39132264503. Server current
symlink and active systemd service verified. Compute enabled in the existing
production environment file, with a preserved pre-activation backup, version
0.4.0, both published worker reference digests and receipt haystackConfig.
Admission ceilings unchanged. Worker allowlisting must use the digest in
`reference`, NOT receipt `contentDigest` (which is the image configuration ID).
CLI advertises the reference digest. Documentation corrected accordingly (1d41249e on the feature branch; runtime main remains 00b3779f).

Mac ARM64 images are being pulled; worker/workspace/preview done, retrieval
pending. Pairing browser confirmation prepared for Mac de Matthieu / Matthieu
Foillard's organisation; user approval pending. No project grant or paid run
started. Host disk has about 6.4 GiB left; monitor before workloads.
Post-deploy MCP health returned Authentication required (pre-deploy call worked);
production browser session and pairing endpoint work. Do not equate that
connector session error with a production service outage.

Pairing confirmed by the owner and completed successfully in production. Native
credential stored by the CLI; no secret copied into documentation or logs.
Convenience launcher: ~/.atoma/compute/start.command, pinned Node and isolated
checkout. Removed only reproducible dist/compute-model-downloads and
dist/compute-models staging to recover about 1.1 GiB; no volumes removed.

All four published ARM64 images downloaded. CLI doctor passed against actual
Docker Desktop 29.1.5, 14 CPUs, 18,832,355,328 bytes RAM, and exact published
retrieval runtime SHA. Docker Linux disk reports 404 GB free, but native Mac
host has only about 4.6 GiB free after installation; do not confuse these.
Client started successfully with WSS production handshake, PTY session 82145.
No project authorised. Native Terminal UI access was rejected by computer-use
policy; launch file remains available for the owner to use independently.

## Customer onboarding and hosted execution policy (2026-10-18)

Owner requires ordinary customers to associate a computer; hosted project runs
are platform-admin only. Implementation adds onboarding to the welcome/project
conversation, `/compute/setup` with a pinned compiled archive and native commands,
and session-scoped device status. Explicit per-project grant/selection remains.
The coordinator enforces current platform authority at admission, queued dispatch,
after asynchronous preparation and before invoking the hosted driver. Continuations
retain their source target. Legacy hosted rows remain readable but ordinary members
cannot launch them. Device settings hide/refuse hosted selection for non-admins.
Ungated local operator behavior and permanent application hosting are unchanged.

Compiled client release compute-client-20261018-1 published from exact CI artifact
00b3779f; checksum/public assets verified, packaged CLI import closure tested on Mac.
No Electron. Review: records/reviews/compute-onboarding-2026-10-18.md.
Release verification passed: 7,608 tests, 25 opt-in skips, with the fresh Compute
acceptance image (the unrelated atoma-worker:latest is stale). TLS setup browser
smoke passed at 1366/375 px; full GPU smoke passed, including ordinary-owner
onboarding and absence of the hosted choice. Production deployment pending.
