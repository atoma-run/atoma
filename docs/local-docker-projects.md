# Local Docker project installation

Docker Desktop is the supported local runtime for projects that need the
customer's computer, including interactive website verification. An independent
Atoma desktop agent is not part of this feature.

A completed delivery can include `atoma.local.json`. The project's Application
section presents its delivery-authored explanation, then guides the customer
through Docker Desktop, downloading/starting the app, and its first use.
Returning customers can skip setup. Ordinary hosted applications keep their
direct preview. Files remains the source explorer. Application and optional website
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
  "files": ["compose.yaml", "Dockerfile", "app.js"],
  "onboarding": {
    "whyLocal": "The application reads folders you select on this computer.",
    "runsOnComputer": "A file organiser and its local web interface.",
    "dataAndConnections": "Files stay in the selected folders. The first installation downloads software from the internet.",
    "firstSteps": ["Open Folders.", "Choose a folder to organise."]
  }
}
```

The run authors `onboarding` in the requested application's language once, with
that delivery. Its explanations must match the delivered code: why local execution
is needed, what runs, where data lives and which connections or accounts are used,
and 1–5 concrete first actions. Atoma supplies the generic setup steps. Existing
writer and validator prompts share this guidance, including fallback executors;
there is no extra model call at opening time or separate semantic validator.
The four fields are bounded plain text (600 characters per explanation, 240 per
first step). The UI renders them as text, never HTML or executable actions. They
also travel in START-HERE.txt. Older version-1 deliveries may omit onboarding and
get an explicit generic fallback. No old artifact is rewritten or re-approved.

Setup progress records only the customer's navigation through the guide; clicking
Continue does not establish that Docker is installed or that the app is reachable.
Download failures can be retried; invalid descriptors direct the customer to the
project conversation. Website verification remains manual in the app's own local
browser session. Atoma does not solve or bypass challenges.

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
real canvas Application setup, source-only download, first steps and returning-user path. Windows launchers require native Windows testing
before claiming verified Windows execution. Each application still needs a
real Docker first-start, stop/restart and persistence check on its target OS.
