# Automatic deployment after GitHub CI

This guide describes the production auto-deployment path: a compiled Atoma web/API process and independent versioned run executors
on an existing Linux host, with Docker Engine available to its
in-process launcher and a reverse proxy in front. The separate
[packaged Linux stack](packaged-stack.md) provides the web/launcher/Caddy
container topology; it has its own provisioning and acceptance guide.

Production auto-deployment is armed: `ATOMA_DEPLOY_ENABLED=true`. Each
successful CI run triggered by a push to `main` deploys that exact revision,
subject to the runtime drain/preflight gate below. A push to `main` is a
production action. A newly configured fork still needs the host, credentials
and repository configuration described here before it can deploy.

## What happens

1. The `static` CI job builds and verifies one commit — the build half of
   `release:check`, beside the test suite; the required `core` check passes
   only when both did — then archives the runtime files under
   `atoma-<full-sha>/` with a revision receipt and SHA-256 file.
2. Only a successful `CI` workflow caused by a push to `main` may enter the
   `production` GitHub environment. Pull requests can never reach its secrets.
3. The deployment job downloads the artifact from that exact CI run, verifies
   its digest, and streams it over SSH with strict host-key checking.
4. The root-owned activator verifies the execution compatibility number of
   both releases and the running executor. Compatible releases coexist: no
   deployment announcement, global run lease or admission freeze is taken.
   The first transition from a legacy web-owned coordinator, a rollback to
   one, or a changed compatibility number uses the full drain described below.
5. It prepares the new release and its revision-specific worker image. Each
   executor is an independent `atoma-executor@<sha>.service`, running from
   `/home/atoma/releases/<sha>` with that revision's worker image. Updating or
   stopping `atoma.service` never stops an executor's process group.
6. After the candidate executor passes its health check, the activator
   atomically switches the private admission socket and `/home/atoma/current`,
   then starts the new web/API/MCP process. New runs use the selected executor;
   runs already admitted retain their original code, image, lease, finalizer
   and accounting. Queued requests retain their existing durable run rows.
7. Until the web health check succeeds, the previous executor stays available
   for rollback even if idle. After success it stops admitting work and exits
   when its runs, finalization, naming and pending host work finish. Release
   retention protects running processes and their immutable directories.
8. Activation failure restores the previous release, admission socket, worker
   tag and web service. A candidate that already admitted work drains rather
   than being killed. The optional mender refresh runs as a separate systemd
   job after activation and holds no product run lease.

The web can briefly disconnect while its process restarts. Project task/run
identity and cancellation survive through the existing product store, so clients
reconnect and read the same run; they never need to start it again. Ephemeral
preview grants still fail closed on web restart and members reopen the preview.
Atoma Compute device connections go directly from nginx to the independent
executor gateway, so a web restart does not disconnect executing devices.
If TCP reconnects after admission moved, the selected gateway authenticates the
existing session and relays its resume to the original live executor over its
host-private Unix gateway. That draining executor permits the reattachment,
without admitting a new session or renewing the lease. This requires both
generations to include resume routing; older generations must drain first.

### Compatibility and exceptional maintenance

`src/contracts/executorVersion.ts` owns `EXECUTOR_COMPATIBILITY`. Increment it
before shipping an incompatible shared-store migration, lease, executor RPC or
commons-writer contract. During ordinary coexistence, schema changes must be
additive and readable by both generations; never remove or reinterpret a field
an old executor can still use. Rollback obeys the same compatibility check.

The legacy/incompatible path closes new admissions with the existing deployment
pending row, lets running work finish, then takes the global lease and freezes
writes for activation. `ATOMA_DEPLOY_WAIT_SECONDS` defaults to 5400. A deadline or
unverifiable surviving work refuses with exit 75. This maintenance path remains
necessary for incompatible writers, rather than being imposed on every release.
A stale executor socket is not evidence of a live writer. If its health cannot be
read, maintenance checks the receipt's process birth identity using the existing
lease policy. A proven gone owner is skipped with its receipt preserved; a live,
unreadable or malformed identity still waits or refuses at the deadline. Skipping
a gone owner never stops a service from that stale receipt.

### Enable independent executors on an existing host

After deploying and verifying a release containing the executor:

```bash
sudo install -o root -g root -m 0755 /home/atoma/current/deploy/host-deploy.sh /usr/local/sbin/atoma-deploy
sudo install -o root -g root -m 0644 /home/atoma/current/scripts/prune-deploy-releases.mjs /usr/local/sbin/atoma-prune-releases.mjs
sudo /home/atoma/current/deploy/install-executor-proxy.sh
```

The proxy installer validates nginx and reloads it without closing existing
connections. Its upstream falls back to the legacy web gateway until the first
executor is active. For another nginx site layout, include
`deploy/compute-executor-location.nginx.conf` inside the HTTPS server and install
`deploy/compute-executor.nginx.conf` at HTTP scope. The public compute socket
exposes only the authenticated device protocol; the execution RPC socket stays
in a separate service-owned `0700` directory and is never a workload mount.

Rerun the deployment job for that verified revision. This first activation still
drains legacy work, installs the independent executor unit and web drop-in, and
switches admission. Subsequent compatible deployments use the coexistence path.
A same-revision redeploy never reinstalls an executing generation's dependencies
or rebuilds its worker image in place.

Runtime stores, traces, skills, workspaces and secrets never enter a release
directory. The supported host layout puts every application byte on the
dedicated filesystem mounted at `/home/atoma`; only the root trust anchors
(systemd unit, deployment config, sudoers rule and forced-command executables)
stay in their standard system directories.
The host activator verifies `/home/atoma` with `findmnt` before creating an
incoming directory, and refuses the deployment if the disk is absent.

## One-time host bootstrap

The commands below assume the names from the checked-in templates. Review them
before running them on the host. Mount the dedicated disk at `/home/atoma`
first and make that mount persistent by UUID in `/etc/fstab`. Formatting a
device destroys its existing contents: identify and verify the exact device
with `lsblk --fs` and `findmnt` before running any partitioning or filesystem
command. The required state before continuing is:

```bash
findmnt --mountpoint /home/atoma
sudo install -d -o root -g root -m 0755 /home/atoma
```

Use one root-owned mount with explicit ownership below it. The service and
deployment users get separate homes on the same disk; the release root and
Docker data remain root-owned.

```bash
sudo useradd --system --create-home --home-dir /home/atoma/state --shell /usr/sbin/nologin atoma
sudo useradd --system --create-home --home-dir /home/atoma/deploy-user --shell /bin/bash atoma-deploy
sudo install -d -o root -g root -m 0755 /home/atoma /home/atoma/releases /etc/atoma
sudo install -d -o root -g atoma -m 0750 /home/atoma/config
sudo install -d -o atoma -g atoma -m 0750 /home/atoma/state /home/atoma/state/runs /home/atoma/state/skills /home/atoma/state/projects /home/atoma/state/workspaces
sudo install -d -o atoma -g atoma -m 0700 /home/atoma/state/account-profiles
sudo install -d -o root -g root -m 0711 /home/atoma/docker
sudo usermod -aG docker atoma

sudo install -o root -g root -m 0755 deploy/host-deploy.sh /usr/local/sbin/atoma-deploy
sudo install -o root -g root -m 0644 scripts/prune-deploy-releases.mjs /usr/local/sbin/atoma-prune-releases.mjs
sudo install -o root -g root -m 0755 deploy/ssh-command.sh /usr/local/sbin/atoma-deploy-ssh
sudo install -o root -g root -m 0644 deploy/atoma.service /etc/systemd/system/atoma.service
sudo install -o root -g root -m 0600 deploy/deploy.env.example /etc/atoma/deploy.env
```

`atoma` joining the Docker group is host-root-equivalent. That is an explicit
cost of the launcher still being in-process; it is not the final containerised
launcher boundary.

On a fresh Docker installation, put its image, layer, container and volume
store on the dedicated disk by merging this property into
`/etc/docker/daemon.json` (do not overwrite unrelated existing properties):

```json
{
  "data-root": "/home/atoma/docker"
}
```

Restart Docker and prove which directory it actually uses before building an
Atoma worker. Changing `data-root` on a host that already contains Docker data
requires a separately planned migration; otherwise the existing images and
volumes become invisible under the new root.

Make Docker require the mount too, so a boot with the disk absent cannot put a
second, hidden Docker store on the VPS root filesystem:

```bash
sudo install -d -o root -g root -m 0755 /etc/systemd/system/docker.service.d
sudoedit /etc/systemd/system/docker.service.d/atoma-disk.conf
```

```ini
# /etc/systemd/system/docker.service.d/atoma-disk.conf
[Unit]
RequiresMountsFor=/home/atoma
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
sudo docker info --format '{{.DockerRootDir}}'
```

Create `/home/atoma/config/atoma.env` as a root-owned file readable by the
`atoma` group. In addition to provider/auth/preview settings, use absolute
durable paths:

```dotenv
ATOMA_DB_PATH=/home/atoma/state/atoma.db
ATOMA_LEDGER_DB=/home/atoma/state/atoma.db
ATOMA_RUNS_DIR=/home/atoma/state/runs
ATOMA_SKILLS_DIR=/home/atoma/state/skills
ATOMA_PROJECTS_ROOT=/home/atoma/state/projects
ATOMA_ACCOUNT_PROFILES_ROOT=/home/atoma/state/account-profiles
ATOMA_BUILD_WORKSPACE=/home/atoma/state/workspaces/build
ATOMA_MCP_RUN_LOCK=/home/atoma/state/mcp-run-lock.db
ATOMA_DEPLOY_LOCK_PATH=/home/atoma/state/deploy.lock
# The analyst resident in the viz server and the mender service must resolve
# the SAME verdict directory. `supervisorDirPath` otherwise defaults to the
# cwd-relative `./supervisor`, which under systemd is a release symlink
# swapped on every deploy. `install-mender.sh` already hard-requires this
# variable; the web service needs it for the same reason.
ATOMA_SUPERVISOR_DIR=/home/atoma/state/supervisor
# Which backup tiers this host does NOT have. `~/.atoma/archive` holds
# pre/post-benchmark store archives and a server runs no benchmarks, so the
# tier is a shape fact here rather than a loss. Every tier left out of this
# list is mandatory: missing, the snapshot reports it as a loss and
# `restore-drill.py` fails. Never add `skills`, `runs`, `projects` or
# `supervisor` here to quiet a red drill — that is the drill working.
ATOMA_BACKUP_OPTIONAL_TIERS=archive
```

### Decision for every organisation

Add the host's TypeSafe credential to the same private `atoma.env` file:

```dotenv
TYPESAFE_API_KEY=<key>
# ATOMA_JEV=0   # global off switch; otherwise enabled when the key is present
```

Every organisation's runs receive this decision service by default, including
new organisations. `ATOMA_JEV_ORGS` is retired and ignored. Decision is separate from
the three tier selectors and uses the host credential, not an organisation's
model key. Its outbound HTTPS request goes from the run host to
`api.typesafe.ai`; enabling worker or preview egress is not required.
Decision context reaches TypeSafe as described in the
[shared-learning terms](platform-commons-terms.md#decisions-taken-by-typesafe).

The service reads this file at startup. Apply changes through the normal
deployment/preflight lifecycle, preserving work in flight. At boot it reports
`jev: deciding in every run` or why Decision is off; each runner log also records
admission, readable through `atoma_run_trace` with `section: "log"`. No key,
`ATOMA_JEV=0`, uncertain answers and unavailable decisions leave the relevant
decision to the run's model. Disabling Decision does not undo trust already earned.

Decision's costs are recorded on `jev` trace events outside LLM totals and LLM
spend ceilings. Sampled model audits (`jev-audit`) do count as LLM calls.
Platform MCP `atoma_jev_calibrate` with `auditsOnly: true` reads existing audit
and cost reports without contacting TypeSafe; other calibration requests send
recorded decision context and incur cost. See [how Decision works](how-it-works.md#decision-bounded-decisions-beside-the-model-tiers).

### Run limits without a redeployment

A platform admin can use Settings → Platform run limits to adjust the project
run timeout default and ceiling, token and LLM spend ceilings, watchdog grace,
Claude/Codex call-timeout ceilings and the tool-iteration ceiling. The same
operations are available through the compiled CLI, against the live product
store, without a running web server:

```bash
npm run settings -- list --db /home/atoma/state/atoma.db
npm run settings -- set run.costMaxUsd 5 --db /home/atoma/state/atoma.db
npm run settings -- unset run.costMaxUsd --db /home/atoma/state/atoma.db
```

The set/unset lines illustrate a spend ceiling and its removal; choose values
for the instance before applying them. Run as the service account with the
host's environment when checking conflicts with exported timeout requests.
Overrides live in `platform_settings` in the primary store, survive releases
and are included in its backup. Each change is journaled and takes effect at
the next run; it does not reconfigure a run already in flight.

A default applies only when the launcher asks for no value. A ceiling binds:
an excessive launch request is refused, and a token or spend ceiling reached
during execution stops further LLM calls while keeping completed phases.
Usage is checked when calls report it, so the call that crosses a ceiling has
already incurred its cost. For subscription transports the dollar figure is
the API-equivalent estimate, not a per-token subscription charge.
`unset` removes the override so future shipped defaults can apply. The form
and CLI show bounds and units; only entries explicitly marked unlimited accept
zero with that meaning. A ceiling conflicting with a timeout exported by the
admin process is refused before saving.

### ChatGPT subscription on all three tiers

After installing and signing in to Codex under the service account (below),
set `ATOMA_HOST_SUBSCRIPTION_ORG` to the operator's active organisation id and
include Codex's executable directory in the service `PATH`. In Settings → LLM
models, choose the **ChatGPT (host subscription)** family for all three personal
account pins. `sub:openai` remains forbidden in organisation defaults and host
model environment variables: the account choice is the authorization to spend.
No API credential is required when all three resolved pins use ChatGPT.

L1's tool loop runs in Atoma: Codex emits a structured action, the host checks
its declared scope and calls the existing sandbox executor, then sends the
observed result back. Codex's native tools stay disabled. Each action is a
separate isolated text completion; latency and subscription consumption should
be measured for the workload rather than assumed equal to native function calls.

### Z.ai L1 with ChatGPT supervisors

For the recommended production split, keep L1 on a credentialled Z.ai
transport and use ChatGPT only on L2/L3. Put the Z.ai key in the root-owned
host file above — not in a GitHub variable or secret. The optional
`ATOMA_HOST_SUBSCRIPTION_ORG` declaration below is needed only if the platform
admin will also use the machine's host Codex profile:

```dotenv
PATH=/home/atoma/state/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ZAI_API_KEY=zai-...
ZAI_BASE_URL=https://api.z.ai/api/anthropic
ATOMA_MODEL_L1=api:zai:glm-4.5-air
ATOMA_MODEL_L2=api:zai:glm-4.5
ATOMA_MODEL_L3=api:zai:glm-4.5
ATOMA_HOST_SUBSCRIPTION_ORG=<organisation-id>
```

All three tiers are required on the host: they are the third level of the
account > organisation > host chain, and a tier no level resolves refuses the
run. The organisation id is shown in the Settings organisation card. Do not
set any tier to `sub:` in this host file: hosted project runs accept a
subscription only from a guarded account choice, resolved again for every run
as either the platform admin's host login or the requesting member's exact
personal profile.

Install Codex under the service account's real home. This binary serves both
the operator-only host profile and each member's isolated personal profile:

```bash
sudo -u atoma env HOME=/home/atoma/state sh -c \
  'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
```

After deploying this version, every `org:owner`, `org:admin` or `org:member`
can open **Settings → Personal subscriptions → Codex**, start the device-code
flow, and authenticate their own ChatGPT subscription in their browser. Atoma
stores the provider-owned credentials only below
`ATOMA_ACCOUNT_PROFILES_ROOT`, in a private profile belonging to that
principal. The database and audit journal contain only a non-secret connection
receipt and provider-name lifecycle events, respectively. A run resolves the
profile of the member who requested it; a missing or disconnected profile
fails explicitly and never falls back to the host. App-server checks and run
children share a crash-safe SQLite lease beside each profile, so a restart or
overlapping process cannot rotate the same `auth.json` concurrently.

Codex is a supervisor transport, so personal ChatGPT choices are offered only
on L2/L3. Keep L1 on Z.ai, Anthropic or another credentialled tool-capable
transport.

The commands below are optional and create the legacy **host subscription**
used only by the platform-admin exception. They are not needed for members'
personal connections:

```bash

sudo -u atoma env \
  HOME=/home/atoma/state \
  PATH=/home/atoma/state/.local/bin:/usr/local/bin:/usr/bin:/bin \
  codex login --device-auth

sudo -u atoma env \
  HOME=/home/atoma/state \
  PATH=/home/atoma/state/.local/bin:/usr/local/bin:/usr/bin:/bin \
  codex login status
```

Open the URL printed by the device-login command in your own browser and enter its
one-time code. Device-code login may first need to be enabled in ChatGPT
security settings. The resulting credentials live under the service account's
Codex home (normally `/home/atoma/state/.codex`); treat them like a password,
never copy them into the repository or GitHub. This follows OpenAI's
[Codex CLI installation](https://learn.chatgpt.com/docs/codex/cli) and
[headless authentication](https://learn.chatgpt.com/docs/auth) guidance.

For the optional host profile, sign in as the platform admin and choose:

- L1: `Z.ai — GLM-4.5 Air` (or inherit the host default);
- L2: `ChatGPT (host subscription) — GPT-5.6-Terra`;
- L3: `ChatGPT (host subscription) — GPT-5.6-Sol`.

Claude CLI remains available as a separate host-subscription family. Since
2026-10-08 the Settings page also offers a personal Claude connection, in
BETA: a member runs `claude setup-token` on a machine where Claude Code is
signed in with their subscription and pastes the long-lived token; the host
keeps it in a private per-account profile and passes it to that member's runs
as `CLAUDE_CODE_OAUTH_TOKEN`. The deployment therefore needs the `claude`
binary on the service account's `PATH` for the connect probe
(`claude auth status --json`) and for the runs. Anthropic requires prior
approval before a third-party product routes `claude.ai` subscription
credentials, and that approval has not been granted: the owner chose to ship
the connection as a beta anyway
([decision](decisions/personal-claude-beta-2026-10-08.md)). See Anthropic's
[Agent SDK authentication boundary](https://code.claude.com/docs/en/agent-sdk#authentication)
and [legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

```bash
sudo chown root:atoma /home/atoma/config/atoma.env
sudo chmod 0640 /home/atoma/config/atoma.env
sudo visudo -f /etc/sudoers.d/atoma-deploy
```

The sudoers file contains one command only:

```sudoers
atoma-deploy ALL=(root) NOPASSWD: /usr/local/sbin/atoma-deploy *
```

Put the public half of a dedicated deployment key in
`/home/atoma/deploy-user/.ssh/authorized_keys`, prefixed with the forced
command and SSH restrictions:

```bash
sudo install -d -o atoma-deploy -g atoma-deploy -m 0700 /home/atoma/deploy-user/.ssh
sudo install -o atoma-deploy -g atoma-deploy -m 0600 /dev/null /home/atoma/deploy-user/.ssh/authorized_keys
sudoedit /home/atoma/deploy-user/.ssh/authorized_keys
```

```text
restrict,command="/usr/local/sbin/atoma-deploy-ssh" ssh-ed25519 AAAA... github-actions-atoma
```

The forced command accepts only `deploy <40-hex-revision> <64-hex-digest>`.
The key cannot request a shell or choose a systemd unit, filesystem root or
health URL.

Finally:

```bash
sudo systemctl daemon-reload
sudo systemctl enable atoma.service
```

Do not start the empty service before its first release has created the
`/home/atoma/current` link.

## Plugging an agent into the instance (MCP)

The instance serves ONE MCP at `https://atoma.run/mcp`. A signed-in principal
mints a bearer token for its active organisation in **Settings → Connect your
AI agent (MCP)** — the panel shows the address, the procedure and the exact
line to paste — (`POST /api/tokens` underneath, or the operator on the host: `npm run auth -- token --principal <id-or-email> --org
<org-id-or-name> --label "<what for>"`), then registers the URL:

```bash
claude mcp add atoma --transport http https://atoma.run/mcp --header "Authorization: Bearer <token>"
```

The tools the agent sees follow the principal's role; a platform admin's token
sees the operator tools as well. Tokens are listed and revoked through
`/api/tokens`, and every mint and revocation is a journal row.

## Self-repair on the VPS

The read-only analyst remains inside Atoma. A separate `atoma-mender.service`
uses its own clone, persistent verdicts and a dedicated ChatGPT profile to
prepare correction PRs. Both reserve the existing machine-global run slot;
Docker limits the executable checks independently of the service's memory cap.
A person merges, and the merge follows the deployment path above.

After application health verification, the activator schedules a separate
root-owned `atoma-mender-refresh-<sha>` systemd job. Refreshes serialize on their
own lock and resolve the current release after acquiring it, so a queued job
cannot pin the clone to an obsolete revision. The job gracefully stops the
mender, fetches/checks out the deployed revision, reinstalls only when the
lockfile or Node version changed, copies the CI-built `dist`, rebuilds the
mender image and restarts its unit. It never reserves the product run slot.
A refresh failure appears in that systemd job and leaves the mender stopped;
it cannot roll back the healthy application. A host without a mender skips it.
`install-mender.sh` remains the first installation and manual recovery path.
Unlike the independent refresh, it also changes the application's environment:
it takes both deployment and mender-refresh locks, closes admission with the
existing `deploy-preflight --hold --wait-ms` guard, and waits for active work
before stopping services. It holds the lease and write-freeze until Atoma is
restarted, including on installation failure. A cancelled wait releases its
announcement without stopping the application.

The activator and pruning helper are root-owned trust anchors. After changing
`deploy/host-deploy.sh` or `scripts/prune-deploy-releases.mjs`, reinstall them from
the verified release. The activator installs the verified executor template and
mender-refresh helper itself.

Release retention runs after activation, under the deployment lock. It keeps
five recent releases, current/previous releases, and every release referenced
by a process, top-level symlink or nested mount. An executor's cwd and command
line protect its release for its entire lifetime. Only obsolete directories
with matching revision receipts are removed; stores and Docker images are
outside this cleanup. An unreadable inventory refuses cleanup with a warning,
without rolling back a healthy application.

Follow [the production supervisor guide](supervisor-codex-production.md) for
installation, GitHub configuration cleanup, and end-to-end verification.

## GitHub configuration

Create an environment named `production`, restricted to the protected `main`
branch. Add these environment variables:

| Variable | Example |
|---|---|
| `ATOMA_DEPLOY_HOST` | `atoma.run` |
| `ATOMA_DEPLOY_PORT` | `22` |
| `ATOMA_DEPLOY_USER` | `atoma-deploy` |
| `ATOMA_DEPLOY_URL` | `https://atoma.run/` |

Add two environment secrets:

- `ATOMA_DEPLOY_SSH_PRIVATE_KEY`: the dedicated private OpenSSH key;
- `ATOMA_DEPLOY_KNOWN_HOSTS`: a reviewed `known_hosts` line for the target
  (including `[host]:port` when the port is not 22).

Only after the host and environment are complete, create the repository-level
variable `ATOMA_DEPLOY_ENABLED=true`. Removing it disables future automatic
deployments without deleting credentials.

## Operational boundaries

- Ordinary compatible deployments do not wait for running user work. The
  legacy/incompatible maintenance path waits rather than cancelling or
  recovering busy work, refuses at its deadline, and keeps the original
  ownership/fingerprint rules. Reinstall the root-owned activator when its
  implementation changes; deploying application code alone cannot update it.
- The workflow's 130-minute limit still covers exceptional maintenance with
  the default 5400-second drain. Raising that drain requires adjusting the
  workflow limit too. An ordinary coexistence deployment uses neither wait.
- The worker image follows the control-plane revision. The preview image does
  not: production preview configuration is pinned to a registry digest by
  contract, so publishing and rotating that digest remains a separate release
  operation.
- Releases are retained under `/home/atoma/releases`; automatic retention
  protects every generation still referenced by a live process.
