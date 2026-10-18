# Atoma Compute desktop

Atoma Compute is a companion for macOS (Apple Silicon and Intel) and Windows x64.
It runs the existing Compute client in a separate process, with Node embedded.
Docker Desktop remains an explicit prerequisite; use its WSL2 backend on Windows.

Connect your account in the application and confirm the organisation in your
browser. Choose **Prepare and connect** to download the pinned components, check
Docker and connect. In Atoma project settings, explicitly allow and select this
computer. The application never grants itself project access.

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
