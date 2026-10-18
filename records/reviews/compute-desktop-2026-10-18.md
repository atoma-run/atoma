# Compute desktop boundary review — 2026-10-18

Scope: Electron companion over the existing Compute application lifecycle. This
review is a local adversarial review, not an independent security certification.

## Boundaries reviewed

- Renderer compromise: the local page has Node disabled, sandbox and context
  isolation enabled, no network CSP, no navigation/popups/permissions, and a
  closed validated command vocabulary. IPC checks the exact main frame and
  file URL. Browser links and pairing origin are fixed. No generic shell,
  filesystem, Docker, URL or port method is exposed.
- Credential disclosure: pairing redemption and OS credential storage stay in
  the utility process. Only a bounded state projection crosses IPC. The desktop
  reuses the CLI's inventory lock, credentials and reconciliation protocol.
- Interrupted shutdown: losing WSS changes the displayed connection immediately,
  while engine cleanup continues. Cleanup errors become an unconfirmed stop.
  Quit and update installation wait for confirmation; timeout is not proof.
  A runtime crash requires an explicit Connect and successful reconciliation
  before quit can claim work has stopped. No old command is replayed.
- Distribution: desktop code and assets are bundled separately from the server.
  Initial packaging unexpectedly collected root production dependencies; an
  explicit node_modules exclusion plus an exact eight-file afterPack assertion
  closes this boundary. Images come from the shared immutable digest catalog.
- Updates: signed builds alone use the stable feed, with separate architecture
  manifests. Download and installation are explicit. Unsigned builds cannot
  publish that channel or use automatic update installation.

## Defects caught during verification

- Electron fuses invalidate the downloaded executable signature: unsigned Mac
  previews need ad-hoc signing, rather than no signing, to launch.
- Native smoke screenshot paths must use the OS temporary directory on Windows.
- Desktop imports of the existing translation catalog need explicit entrypoints
  in the client-bundle boundary check; the actual closure is still tested.
- Drain must suppress automatic reconnect, which otherwise accepts fresh work.
- A crashed utility process must be restartable, while retaining the unknown
  workload state until the existing engine reconciliation succeeds.

## Evidence and remaining limits

Focused lifecycle/desktop/WSS tests: 42 passed, 4 skipped. Real Electron smoke
passed with sandbox isolation, rejected unknown commands, fake pairing and
preparation, background close, runtime crash/reconnect and confirmed quit.
The real packaged Mac ARM application opened and read the existing pairing;
it did not start a paid run. The application uses the existing Atoma icon.

No Apple Developer or Windows signing certificates are configured. Native
installer CI and full release verification are recorded separately after they
complete. A GUI smoke with a fake runtime does not prove Docker/WSL2 execution
on Windows or Docker execution on Intel macOS. No such claim is made here.

The release static half passed (types, lint, docs, dependency audit, builds and
compiled smokes). The complete test half reported 7,617 passing tests and one
failure in the existing MCP listen-stream quota test (200 versus 429); that
file passed all 18 tests when rerun alone. Container isolation passed against
the published immutable ARM worker image, including packaged Vitest acceptance.
The final Mac ARM DMG/ZIP were built, package contents asserted, DMG checksum
verified, and the actual packaged application opened successfully. Clean CI
remains the deployment gate; the first full local invocation is not recorded
as an all-green run.

The first native CI matrix exposed two environment-specific failures: an empty
CSC_LINK was interpreted as the working directory by electron-builder, and the
Intel macOS runner's virtual GPU could not initialize EGL for screenshots.
Unsigned package steps now remove signing environment variables entirely; the
CI-only smoke selects software rendering while retaining the sandbox and all
behavioral assertions. The same smoke passed locally with that CI setting.
Windows passed the application tests and native smoke before packaging.

## Final validation

- Translated revision: `61ea0fc90bd0b404cd9351770eaa69ebfa6f2541`.
- [Native matrix](https://github.com/atoma-run/atoma/actions/runs/39144467070):
  Mac ARM64, Mac x64 and Windows x64 all passed and uploaded installers with
  checksums. Intel software-rendered CI smoke passed without removing assertions.
- [Complete CI](https://github.com/atoma-run/atoma/actions/runs/39144466517):
  passed, including 7,594 unit/integration tests (51 deliberately skipped),
  release static checks and separate fresh-worker/container isolation jobs.
- CodeQL passed. [Production deployment](https://github.com/atoma-run/atoma/actions/runs/39145364994)
  successfully activated the exact translated revision.
- All 2,364 English keys have translations in the 12 target catalogs.

The native matrix validates application behavior and packaging, not a real
paid run or Docker Desktop/WSL2 execution on every target OS. The public stable
installer channel remains unpublished until signing credentials exist.
