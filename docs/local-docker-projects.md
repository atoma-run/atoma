# Local Docker project installation

Docker Desktop is the supported local runtime for projects that need the
customer's computer, including interactive website verification. An independent
Atoma desktop agent is not part of this feature.

A completed delivery can include `atoma.local.json`. Its Files section then
shows a three-step guide: install/open Docker Desktop, download/extract the
project package, and open its Start launcher. Application and optional website
verification links remain explicit user actions. No localhost probing, pairing,
cloud-to-local control or automatic data synchronization is implied.

## Delivery contract

`src/contracts/localDocker.ts` owns the schema. Example:

```json
{
  "version": 1,
  "runtime": "docker-compose",
  "composeFile": "compose.yaml",
  "appUrl": "http://127.0.0.1:3300/",
  "verificationUrl": "http://127.0.0.1:6081/vnc.html?autoconnect=1",
  "files": ["compose.yaml", "Dockerfile", "app.js"]
}
```

Declare every required source file, including Docker ignore files and lockfiles.
The allowlist must exclude credentials, browser profiles, caches and local state.
Only saved, hash-checked artifacts from the same delivered run are read through
the existing organisation-authorized workspace API. Missing files, invalid
paths, partial deliveries and packages over 64 MiB are refused. A Dockerfile
alone does not imply an installation-ready application.

The Compose file must be at the root and self-contained: no developer-specific
absolute mounts, external source directories, Docker socket, `container_name`,
external volumes or secrets expected from the author's shell. Bind published
ports to `127.0.0.1`. Include a healthcheck for services that must be ready before
the app opens. The installer does not audit or rewrite model-authored Compose
semantics: review and testing of the delivered application still apply.

Persist state through `${ATOMA_LOCAL_DATA_DIR}` or project-scoped named volumes.
The launchers supply `ATOMA_LOCAL_UID` and `ATOMA_LOCAL_GID` for applications
that need host-owned writable bind mounts. The stable data directory is
`~/.atoma/apps/<projectId>` on macOS and `%LOCALAPPDATA%/Atoma/apps/<projectId>`
on Windows. Compose's project name is stable per project, independent of the
ZIP's extraction location or run. Port collisions remain visible Docker errors;
projects needing simultaneous operation must declare distinct ports.

The ZIP places source files under `app/`, with generated Start/Stop launchers
and `START-HERE.txt` at its root. Nothing executes on download. Start checks
Docker and Compose, builds/starts with `--wait`, then opens the declared app URL.
Stop uses `compose stop`, never deletes volumes. Updates retain the project data
folder; schema compatibility remains the application's responsibility. Runtime
state must never be written into a future source package.

## Verification

`tests/local-docker.test.ts` exercises archive contents, refusal cases and the
POSIX launcher in a separate process with a fake Docker executable. Existing
workspace service tests cover org scope, changed bytes and symlink refusal.
`npm run viz:shot -- --auth --select-first --local-docker-probe` exercises the
real canvas download control. Windows launchers require native Windows testing
before claiming verified Windows execution. Each application still needs a
real Docker first-start, stop/restart and persistence check on its target OS.
