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

This is groundwork, NOT a usable customer-device execution target. The default
runner still uses the local workspace implementation. There is no desktop app,
remote device admission, customer WSS endpoint, or claim of resource savings.

## Remaining integration, in dependency order

1. Provision the bound seed/read-run sources over authenticated transfers and
   implement final artifact export. Bind project continuation identity to a
   device generation; operator checkpoint tests currently exercise the same
   execution-host path across process restarts. A new project continuation's
   source validation still needs its device binding.
2. Bind authenticated chunk streams to the checkpoint receiver; admission must
   cap concurrent transfers and total reserved bytes. Reconcile abandoned
   uploads and reuse existing recovery-effect and spend barriers.
3. Add device identity, browser pairing, revocation, project permissions,
   generation-fenced WSS sessions and a client launcher with local leases.
   Persist the selected execution target in the project and run receipt;
   preserve hosted defaults and separate device/server admission.
4. Move Haystack extraction/indexing/inference and its disposable cache;
   route previews through the existing authorization/origin gateway to a
   locally isolated copy. Keep GitHub and connector credentials on Atoma.
5. Build the graphical application, diagnostic/resource controls, installers
   and signing/release workflow. Validate all supported OS/CPU targets.
6. Execute the pre-registered capacity experiment before raising admission.

## Local evidence

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

Release verification after lifecycle/restoration integration: the static half
(`release:check:static`) passed, including types, lint, documentation, audit,
build and compiled release smokes. The complete test half passed 7,476 tests
in 512 files; 10 tests were skipped. Both images were rebuilt from packaged
output under isolated tags. The run included all 36 worker container-isolation
tests and the workspace container smoke, with `ATOMA_TEST_ACCEPTANCE_IMAGE`
and `ATOMA_TEST_WORKSPACE_IMAGE` explicitly selecting those images. This
supersedes the first foundation check's failures against a stale local image.

The current development machine has Docker Desktop/Linux ARM64. No valid
macOS code-signing identity was available when inspected. Windows and Mac x64
acceptance and signed distribution are not established by local ARM64 tests.
