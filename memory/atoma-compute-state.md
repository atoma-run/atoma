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
