---
name: deploy-pipeline-state
description: "2026-10-20 independent executor generations for compatible releases; legacy/incompatible drain, root activator bootstrap and verification"
metadata:
  node_type: memory
  type: project
  originSessionId: a287b345-0cde-4c2f-9dc4-24d010fe43ba
  modified: 2026-10-20
---

**Current code contract (2026-10-20, `00d96a50`):** ordinary compatible releases use independent executor generations. Read [the deployment guide](../docs/automatic-deployment.md) and [the design/verification record](../records/designs/independent-run-executors-2026-10-20.md). New admissions follow `/home/atoma/executors/active.sock`; old generations finish their own runs on immutable releases and revision-specific worker images. Cancellation and operator status survive a web restart through the primary store. Compute WSS follows `/home/atoma/compute/active.sock` directly from nginx. The first legacy migration and a changed `EXECUTOR_COMPATIBILITY` still use the full drain; incompatible maintenance verifies every old executor idle and stops all old writers before activation.

**Host state is verified, never inferred from deployed application code:** the root-owned activator must be reinstalled from a verified release, together with the pruning helper, and the one-time `deploy/install-executor-proxy.sh` must install the nginx includes. Then rerun deployment of that verified revision. Check `readlink /home/atoma/executors/active.sock`, `systemctl show atoma-executor@<revision>.service -p MainPID -p ActiveState`, and the selected release's `node dist/cli/executor.js --health <socket>` as the service user. A compatible deploy logs `activation: compatible executors` and does not publish the global pending-deployment marker or take the run lease. A web `Wants`/`After` drop-in restarts the selected executor after reboot; stopping the web does not stop its cgroup. Never restart a running executor to deploy a compatible release. The optional mender refresh is a separate serialized systemd job, outside the product lease.

The dated state below describes the earlier global-drain implementation; the compatibility maintenance path retains its ownership and stale-lease rules.

Since 55e9229 + 000dc15 (2026-09-27) a production deploy WAITS for running work instead of being refused: a `mcp_deployment_pending` row in `/home/atoma/state/mcp-run-lock.db` closes the slot to new takers, `ATOMA_DEPLOY_WAIT_SECONDS` defaults to 1800, deploy.yml job timeout is 75 min. The release is prepared before `systemctl stop` (outage ≈ stop/switch/start), and the mender refresh copies the release's `dist` and skips `npm ci` through `node_modules/.atoma-install-stamp`. The mender watch loop pauses at 3 open same-repo `mender/` PRs.

The root activator `/usr/local/sbin/atoma-deploy` (+ `atoma-prune-releases.mjs`) was reinstalled by the user from `releases/000dc15…` at 18:19 UTC (backups `*.bak-2026-09-27`). Every future `deploy/host-deploy.sh` change needs that manual reinstall; a deploy log without `drain: waiting up to` means an old activator is installed.

Measured: CI 7m29 → 5m30 (worker beside core, LibreOffice during npm ci) → 3m45 with 0d8998d (release:check = `release:check:static && npm test`, run as parallel jobs `static` + `tests`, gated by the required `Hermetic checks (Node 24)` job with `if: always()`). First deploy through the new activator (0d8998d, 19:54 UTC): wait mode active, outage ~3 s, 1m39 total, mender refresh ran npm ci once to create its stamp. Push → prod ≈ 5.5 min (was ~9.5). 0d8998d also ships: dead-owner lease rows with nothing behind are reclaimed by any taker (birth identity, not pid); the mender stop records `interrupted` (finding stays pending), TimeoutStopSec 10min; default wait 5400 s. The user reinstalled `/usr/local/sbin/atoma-deploy` from releases/0d8998d at 20:06 UTC (checksum verified; deploy.env sets no wait, so 5400 s applies).

Direct pushes to `main` from the owner's account (mgtf / mgf@iotanet.net) bypass the repository's pull-request ruleset BY DESIGN, and have for weeks: `git push` then prints "Bypassed rule violations … Changes must be made through a pull request". That is expected — do not flag it or switch to PRs (owner, 2026-09-30).

**Why:** push → prod was ~9.5 min, and deploys were refused whenever the single run slot was busy (two in a row on 2026-09-27).

**How to apply:** a deploy refused with "the run slot is occupied (… pid N)" may be a STALE row: check `ps -p N`. On 2026-09-27 the mender was SIGKILLed at 15:36 (probably OOM on the 4 GB host, reap script killed too) and its `mender:` row blocked deploys and background stages; nothing but a member run start ever recovers such a row. Fix used: confirm no `atoma.role=mender` containers survive, then `sudo -u atoma sqlite3 /home/atoma/state/mcp-run-lock.db "DELETE FROM mcp_run_lease WHERE owner_pid = N AND run_id = '<id>'"`. Never restart the mender by hand on old code (it resumes the backlog); let the deploy's refresh restart it. See [[supervisor-mender-state]].

**Reading deploy runs (2026-10-17):** `gh run list` shows a Deploy production run under main's HEAD when the workflow_run fired, not the commit it deploys. On 2026-10-16 the deploy of green 6270cd45 was listed as red 7a94b880 and misread as a deploy of a red commit. The deployed commit is the job's `REVISION` (= the triggering CI run's head_sha), and since 2026-10-17 the run's name: "Deploy <sha> (CI <conclusion>)". Production cannot roll back by a race: main CI queues one run at a time in push order (cancel-in-progress is false on main), deploys queue the same way, and each deploys only its own green CI run's artifact. tests/deployment-pipeline.test.ts pins both.

**Compatibility maintenance and root-only app config (2026-10-27):** complete
Compute initial-state references require executor compatibility 2. The first
maintenance activation exposed that `atoma.env` is root:root 0640: systemd can
read it, the service user cannot. `run_as_service_with_app_env` must read literal
bytes while privileged, then evaluate assignments only as the service user
through a pipe. Do not loosen the config mode or source it as root. A real
read-only probe confirmed UID 988 receives the required configuration. The
root-owned activator must be installed from the verified CI release when this
helper changes; retry the ordinary deployment after installation.
