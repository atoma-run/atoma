# Atoma Compute desktop

Atoma Compute is a companion for macOS (Apple Silicon and Intel) and Windows x64.
It runs the existing Compute client in a separate process, with Node embedded.
Docker Desktop remains an explicit prerequisite; use its WSL2 backend on Windows.

Connect your account in the application and confirm the organisation in your
browser. Choose **Prepare and connect** to download the pinned components, check
Docker and connect. In Atoma project settings, explicitly allow and select this
computer. The application never grants itself project access.

An existing terminal-client pairing is reused. Run only one client on a computer:
stop the terminal client before connecting the desktop application.

The four views show connection, diagnostics, activity and resources. Closing the
window keeps it running in the menu bar/system tray. Quitting stops local work;
it waits for engine confirmation and refuses to claim success when Docker cannot
confirm teardown. A disconnected run requires explicit recovery in Atoma.

## Build and distribution

Use the pinned Node version and `npm ci`, then:

```sh
npm run compute:desktop:build
npm run compute:desktop
npm run compute:desktop:package
```

The application bundle is `dist/compute-desktop`; installers are written under
`dist/compute-installers`. Node is embedded, and product databases, local
credentials and workspaces are not included. No Electron native-module rebuild
is needed: the local inventory uses embedded Node's SQLite implementation.

The **Compute desktop** workflow builds and tests macOS arm64, macOS x64 and
Windows x64. An unsigned workflow run produces downloadable test artifacts,
not a stable public release. Native Docker/run acceptance remains separate from
the application smoke and requires Docker Desktop on the target machine.

Stable builds require Developer ID signing/notarization on macOS and a Windows
code-signing certificate. Configure `ATOMA_MAC_CSC_LINK`,
`ATOMA_MAC_CSC_PASSWORD`, `ATOMA_WINDOWS_CSC_LINK`,
`ATOMA_WINDOWS_CSC_PASSWORD`, `ATOMA_APPLE_API_KEY`, `ATOMA_APPLE_API_KEY_ID`
and `ATOMA_APPLE_API_ISSUER` as CI secrets. The Apple API key secret contains the private `.p8` key; the workflow provisions
it as a private temporary file for notarization and removes it afterward.
Never commit certificates, passwords or API keys.

Run the workflow with `signed` and `publish` enabled to publish the signed stable
channel. Each architecture has its own update manifest. Updates are requested
explicitly from Resources, require confirmation, and install only after work
has stopped. Unsigned test builds link to the release page instead.

```sh
node scripts/compute-desktop-smoke.mjs
```

This smoke drives the real Electron sandbox and IPC with an isolated fake runtime;
it never pairs an account or starts a paid project run.

## Guided setup

`/compute/setup` opens the app-download view by default; `mode=manual` retains
the verified terminal installation instructions. Browser hints suggest a system,
with explicit overrides. A Mac browser does not reliably identify the physical
chip: users select Apple Silicon or Intel using About This Mac.

The utility process checks the native OS, Docker Desktop and Windows WSL2.
The app can download and open the fixed official Docker installer after verifying
its publisher, or start an installed Docker application. The installer retains
license acceptance and OS authorization. On Windows, a separate explicit action
opens the elevated WSL installation/update prompt; disabled firmware virtualization
requires the manufacturer's instructions. Preparation waits for Docker readiness
before image pulls. Pending preparation survives reopening; Cancel clears it.
It does not resume a run or replay an indeterminate command.

Preview installers are separate from the signed stable feed and carry an explicit
notice about platform installation blocks. The native release workflow can publish
an immutable preview after all three platform jobs pass. Real Docker installation,
WSL reboot and license flows still require manual platform acceptance testing.
