#!/usr/bin/env bash
# Root-owned production activator invoked by GitHub Actions over SSH.
#
# The deploy key may stream one CI-built archive and its digest. It cannot
# choose a command, service, release root or health target: those live in the
# root-owned configuration below. Runtime state and secrets stay outside every
# release directory.
set -Eeuo pipefail

CONFIG_PATH="${ATOMA_DEPLOY_CONFIG:-/etc/atoma/deploy.env}"
if [[ "${EUID}" -ne 0 ]]; then
  echo "host-deploy must run as root" >&2
  exit 2
fi
if [[ ! -f "${CONFIG_PATH}" || -L "${CONFIG_PATH}" ]]; then
  echo "deployment config must be a regular non-symlink file: ${CONFIG_PATH}" >&2
  exit 2
fi

# shellcheck source=/dev/null
set -a
source "${CONFIG_PATH}"
set +a

REVISION="${1:-}"
EXPECTED_DIGEST="${2:-}"
DEPLOY_ROOT="${ATOMA_DEPLOY_ROOT:-/home/atoma}"
REQUIRED_MOUNT="${ATOMA_DEPLOY_REQUIRED_MOUNT:-/home/atoma}"
SERVICE_NAME="${ATOMA_DEPLOY_SERVICE:-atoma.service}"
SERVICE_USER="${ATOMA_DEPLOY_USER:-atoma}"
APP_ENV="${ATOMA_DEPLOY_APP_ENV:-/home/atoma/config/atoma.env}"
HEALTH_URL="${ATOMA_DEPLOY_HEALTH_URL:-http://127.0.0.1:4111/}"
# How long a deployment WAITS for work already running (a run, a mend, an
# analysis, a preview) while nothing new may start. The default outlasts one
# project run at its default budget — 60 min, plus the preparation (10), the
# watchdog (1) and the hard reap (3) — so a run no longer makes a deployment
# fail at its deadline. 0 restores the old behaviour: refuse at once.
WAIT_SECONDS="${ATOMA_DEPLOY_WAIT_SECONDS:-5400}"
# The mender runs from its OWN clone, not from the CI artefact (worktrees,
# devDependencies, gh). These name that installation so the activator can
# move it to the deployed revision; an absent checkout or env means "no mender
# on this host" and the phase is skipped, never failed.
MENDER_SERVICE="${ATOMA_DEPLOY_MENDER_SERVICE:-atoma-mender.service}"
MENDER_CHECKOUT="${ATOMA_DEPLOY_MENDER_CHECKOUT:-/home/atoma/mender}"
MENDER_ENV="${ATOMA_DEPLOY_MENDER_ENV:-/home/atoma/config/mender.env}"
MENDER_REMOTE="https://github.com/atoma-run/atoma.git"

fail() {
  echo "deployment failed: $*" >&2
  exit 1
}

# Busy work refused the deployment: nothing is broken, and running it again
# later is the remedy. EX_TEMPFAIL, like the drain guard's own exit.
refuse() {
  echo "deployment refused: $*" >&2
  exit 75
}

valid_absolute_path() {
  local value="$1"
  [[ "${value}" == /* && "${value}" != "/" && "${value}" != *$'\n'* ]] || return 1
  [[ "/${value#/}/" != *"/../"* && "/${value#/}/" != *"/./"* ]]
}

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail "revision must be a full Git commit SHA"
[[ "${EXPECTED_DIGEST}" =~ ^[0-9a-f]{64}$ ]] || fail "archive digest must be SHA-256"
valid_absolute_path "${DEPLOY_ROOT}" || fail "ATOMA_DEPLOY_ROOT must be a narrow absolute path"
valid_absolute_path "${REQUIRED_MOUNT}" || fail "ATOMA_DEPLOY_REQUIRED_MOUNT must be a narrow absolute path"
[[ "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+$ ]] || fail "invalid systemd service name"
[[ "${MENDER_SERVICE}" =~ ^[A-Za-z0-9_.@-]+$ ]] || fail "invalid mender service name"
valid_absolute_path "${MENDER_CHECKOUT}" || fail "ATOMA_DEPLOY_MENDER_CHECKOUT must be a narrow absolute path"
valid_absolute_path "${MENDER_ENV}" || fail "ATOMA_DEPLOY_MENDER_ENV must be a narrow absolute path"
[[ "${SERVICE_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail "invalid service user"
[[ "${HEALTH_URL}" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/ ]] ||
  fail "ATOMA_DEPLOY_HEALTH_URL must be a loopback HTTP URL"
[[ "${WAIT_SECONDS}" =~ ^(0|[1-9][0-9]{0,4})$ ]] && (( WAIT_SECONDS <= 14400 )) ||
  fail "ATOMA_DEPLOY_WAIT_SECONDS must be an integer between 0 and 14400"
[[ -f "${APP_ENV}" && ! -L "${APP_ENV}" ]] || fail "application environment is missing or symlinked: ${APP_ENV}"
id "${SERVICE_USER}" >/dev/null 2>&1 || fail "service user does not exist: ${SERVICE_USER}"

for command in node npm docker curl systemctl systemd-run python3 runuser tar sha256sum realpath getent flock findmnt soffice timeout; do
  command -v "${command}" >/dev/null 2>&1 || fail "required command is missing: ${command}"
done

findmnt --mountpoint "${REQUIRED_MOUNT}" >/dev/null 2>&1 ||
  fail "required deployment filesystem is not mounted: ${REQUIRED_MOUNT}"
REQUIRED_MOUNT="$(realpath -e "${REQUIRED_MOUNT}")"
[[ "${DEPLOY_ROOT}" == "${REQUIRED_MOUNT}" || "${DEPLOY_ROOT}" == "${REQUIRED_MOUNT}/"* ]] ||
  fail "ATOMA_DEPLOY_ROOT must stay on ${REQUIRED_MOUNT}"

install -d -m 0755 "${DEPLOY_ROOT}" "${DEPLOY_ROOT}/releases"
DEPLOY_ROOT="$(realpath -e "${DEPLOY_ROOT}")"
[[ "${DEPLOY_ROOT}" != "/" ]] || fail "resolved deployment root cannot be /"
RELEASES="${DEPLOY_ROOT}/releases"
CURRENT="${DEPLOY_ROOT}/current"
EXECUTOR_ROOT="${DEPLOY_ROOT}/executors"
ACTIVE_EXECUTOR="${EXECUTOR_ROOT}/active.sock"
OWN_EXECUTOR="${EXECUTOR_ROOT}/${REVISION}.sock"
COMPUTE_ROOT="${DEPLOY_ROOT}/compute"
OLD_EXECUTOR=""
ROLLING=0
TARGET_EXECUTOR=0
EXECUTOR_STARTED=0
SERVICE_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
[[ -n "${SERVICE_HOME}" && -d "${SERVICE_HOME}" ]] || fail "service user has no home directory"

# GitHub serialises its own jobs, but the host is the final authority: a
# manual invocation or a second delivery path must not overlap this one. In
# particular, a losing deploy must never remove the admission marker owned by
# the winner. The descriptor holds this lock until the process exits.
exec 9>"${DEPLOY_ROOT}/.deployment.lock"
flock -n 9 || fail "another deployment is already active"

WORK_DIR="$(mktemp -d "${DEPLOY_ROOT}/.incoming-${REVISION}.XXXXXX")"
EXECUTOR_DROPIN="/etc/systemd/system/${SERVICE_NAME}.d/executor.conf"
if [[ -f "${EXECUTOR_DROPIN}" ]]; then
  cp -a "${EXECUTOR_DROPIN}" "${WORK_DIR}/previous-executor.conf"
fi
BUNDLE="${WORK_DIR}/atoma-${REVISION}.tar.gz"
ARCHIVE_ROOT="atoma-${REVISION}"
TARGET_RELEASE="${RELEASES}/${REVISION}"
MARKER_PATH=""
GUARD_PID=""
GUARD_DIR=""
GUARD_RELEASE_FILE=""
ACTIVATION_STARTED=0
WORKER_LATEST_CHANGED=0
WORKER_ROLLBACK_TAG=""

restore_previous_generation() {
  [[ -n "${OLD_RELEASE:-}" ]] || return 0
  echo "deployment activation failed; restoring ${OLD_REVISION}" >&2
  systemctl stop "${SERVICE_NAME}" || true
  if [[ "${ROLLING}" -eq 0 && "${EXECUTOR_STARTED}" -eq 1 ]]; then
    # The global guard prevented every admission in an incompatible/initial
    # activation. Stop this idle candidate before old writers start again.
    systemctl stop "atoma-executor@${REVISION}.service" || true
  fi
  if [[ -f "${WORK_DIR}/previous-executor.conf" ]]; then
    cp -a "${WORK_DIR}/previous-executor.conf" "${EXECUTOR_DROPIN}"
  else
    rm -f -- "${EXECUTOR_DROPIN}"
  fi
  systemctl daemon-reload
  if [[ -n "${OLD_EXECUTOR}" ]]; then
    rm -f -- "${EXECUTOR_ROOT}/.rollback.sock"
    ln -s "${OLD_EXECUTOR}" "${EXECUTOR_ROOT}/.rollback.sock"
    mv -Tf "${EXECUTOR_ROOT}/.rollback.sock" "${ACTIVE_EXECUTOR}"
    ln -sfn "${COMPUTE_ROOT}/$(basename "${OLD_EXECUTOR}")" "${COMPUTE_ROOT}/.rollback.sock"
    mv -Tf "${COMPUTE_ROOT}/.rollback.sock" "${COMPUTE_ROOT}/active.sock"
    rm -f -- "${OLD_EXECUTOR}.retire"
    systemctl start "atoma-executor@$(basename "${OLD_EXECUTOR}" .sock).service" || true
  elif [[ "${TARGET_EXECUTOR}" -eq 1 ]]; then
    rm -f -- "${ACTIVE_EXECUTOR}"
    rm -f -- "${COMPUTE_ROOT}/active.sock"
  fi
  # Never kill a candidate that may already have admitted a run. It drains
  # independently after the old admission pointer is restored.
  if [[ "${TARGET_EXECUTOR}" -eq 1 && "${OWN_EXECUTOR}" != "${OLD_EXECUTOR}" ]]; then
    touch "${OWN_EXECUTOR}.retire"
  fi
  local rollback_link="${DEPLOY_ROOT}/.rollback-${OLD_REVISION}"
  rm -f -- "${rollback_link}"
  ln -s "${OLD_RELEASE}" "${rollback_link}"
  mv -Tf "${rollback_link}" "${CURRENT}"
  if [[ "${WORKER_LATEST_CHANGED}" -eq 1 ]]; then
    if [[ -n "${WORKER_ROLLBACK_TAG}" ]] &&
      docker image inspect "${WORKER_ROLLBACK_TAG}" >/dev/null 2>&1; then
      docker tag "${WORKER_ROLLBACK_TAG}" atoma-worker:latest
    else
      # Remove only the mutable tag; the revision tag remains available for
      # diagnosis and a retry.
      docker image rm atoma-worker:latest >/dev/null 2>&1 || true
    fi
  fi
  systemctl start "${SERVICE_NAME}" || true
}

cleanup() {
  local status=$?
  # A second signal must not cut the cleanup short: mid-restoration it would
  # leave the service stopped, and before the marker is removed it would
  # leave every write refused.
  trap '' HUP INT TERM
  set +e
  if [[ "${status}" -ne 0 && "${ACTIVATION_STARTED}" -eq 1 ]]; then
    restore_previous_generation
  fi
  if [[ -n "${GUARD_RELEASE_FILE}" ]]; then
    touch "${GUARD_RELEASE_FILE}"
  fi
  if [[ -n "${GUARD_PID}" ]]; then
    wait "${GUARD_PID}" >/dev/null 2>&1
  fi
  if [[ -n "${MARKER_PATH}" ]]; then
    rm -f -- "${MARKER_PATH}"
  fi
  if [[ -n "${GUARD_DIR}" ]]; then
    case "${GUARD_DIR}" in
      "${DEPLOY_ROOT}"/.deploy-guard-*) rm -rf -- "${GUARD_DIR}" ;;
    esac
  fi
  case "${WORK_DIR}" in
    "${DEPLOY_ROOT}"/.incoming-*) rm -rf -- "${WORK_DIR}" ;;
  esac
  exit "${status}"
}
trap cleanup EXIT
# A dropped SSH channel sends SIGHUP to the forced command. Route termination
# signals through a normal exit so the EXIT cleanup restores the previous
# generation whenever activation has already stopped the service.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# A write to a channel that died (the relayed drain progress, a log line)
# must fail as EPIPE, not kill the shell: a builtin killed by SIGPIPE skips
# the EXIT trap, and with it the restoration of the previous generation.
trap '' PIPE

# The archive is streamed over the authenticated SSH channel. It never sits
# in a deploy-user-writable inbox that another local process could replace.
cat >"${BUNDLE}"
ACTUAL_DIGEST="$(sha256sum "${BUNDLE}" | awk '{print $1}')"
[[ "${ACTUAL_DIGEST}" == "${EXPECTED_DIGEST}" ]] || fail "archive digest mismatch"

while IFS= read -r entry; do
  [[ "${entry}" == "${ARCHIVE_ROOT}" || "${entry}" == "${ARCHIVE_ROOT}/"* ]] ||
    fail "archive entry escapes its revision root: ${entry}"
  [[ "${entry}" != /* && "/${entry}/" != *"/../"* ]] ||
    fail "unsafe archive entry: ${entry}"
done < <(tar -tzf "${BUNDLE}")

if [[ -e "${TARGET_RELEASE}" ]]; then
  [[ -f "${TARGET_RELEASE}/REVISION" ]] || fail "existing release has no revision receipt"
  [[ "$(<"${TARGET_RELEASE}/REVISION")" == "${REVISION}" ]] || fail "existing release receipt disagrees"
else
  STAGE="${WORK_DIR}/stage"
  install -d -m 0755 "${STAGE}"
  tar -xzf "${BUNDLE}" -C "${STAGE}" --no-same-owner --no-same-permissions
  [[ "$(<"${STAGE}/${ARCHIVE_ROOT}/REVISION")" == "${REVISION}" ]] || fail "archive revision receipt disagrees"
  [[ -f "${STAGE}/${ARCHIVE_ROOT}/dist/viz/server.js" ]] || fail "compiled viz server is missing"
  [[ -f "${STAGE}/${ARCHIVE_ROOT}/dist/cli/deploy-preflight.js" ]] || fail "compiled deployment preflight is missing"
  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${STAGE}/${ARCHIVE_ROOT}"
  mv "${STAGE}/${ARCHIVE_ROOT}" "${TARGET_RELEASE}"
fi

run_as_service() {
  local cwd="$1"
  shift
  runuser -u "${SERVICE_USER}" -- env HOME="${SERVICE_HOME}" bash -c \
    'cd "$1" && shift && exec "$@"' bash "${cwd}" "$@"
}

run_as_service_with_app_env() {
  local cwd="$1"
  shift
  runuser -u "${SERVICE_USER}" -- env HOME="${SERVICE_HOME}" bash -c \
    'set -a; source "$1"; set +a; cd "$2"; shift 2; exec "$@"' \
    bash "${APP_ENV}" "${cwd}" "$@"
}

# Existing installations have the dependencies needed by the drain command.
# A first installation has no running Atoma process and therefore no admission
# race to close.
OLD_RELEASE=""
OLD_REVISION=""
if [[ -L "${CURRENT}" ]]; then
  OLD_RELEASE="$(realpath -e "${CURRENT}")"
  [[ "${OLD_RELEASE}" == "${RELEASES}/"* ]] || fail "current release escapes ${RELEASES}"
  OLD_REVISION="$(basename "${OLD_RELEASE}")"
elif [[ -e "${CURRENT}" ]]; then
  fail "current must be a symlink"
fi

executor_protocol() {
  local release="$1"
  [[ -f "${release}/dist/contracts/executorVersion.js" ]] || return 1
  run_as_service "${release}" node --input-type=module -e \
    'import { pathToFileURL } from "node:url"; console.log((await import(pathToFileURL(process.argv[1]))).EXECUTOR_COMPATIBILITY)' \
    "${release}/dist/contracts/executorVersion.js"
}
if [[ -f "${TARGET_RELEASE}/dist/cli/executor.js" ]]; then
  TARGET_EXECUTOR=1
  configured_socket="$(run_as_service_with_app_env "${TARGET_RELEASE}" bash -c 'printf %s "${ATOMA_EXECUTOR_SOCKET:-}"')"
  [[ -z "${configured_socket}" || "${configured_socket}" == "${ACTIVE_EXECUTOR}" ]] || fail "application environment points to a different executor socket"
fi
if [[ -L "${ACTIVE_EXECUTOR}" ]]; then
  OLD_EXECUTOR="$(readlink "${ACTIVE_EXECUTOR}")"
  [[ "${OLD_EXECUTOR}" == "${EXECUTOR_ROOT}/"*.sock && "$(basename "${OLD_EXECUTOR}" .sock)" =~ ^[0-9a-f]{40}$ ]] || fail "invalid active executor"
fi
if [[ "${TARGET_EXECUTOR}" -eq 1 && -n "${OLD_RELEASE}" && -n "${OLD_EXECUTOR}" ]]; then
  old_protocol="$(executor_protocol "${OLD_RELEASE}" || true)"
  new_protocol="$(executor_protocol "${TARGET_RELEASE}" || true)"
  if [[ "${old_protocol}" =~ ^[1-9][0-9]*$ && "${new_protocol}" == "${old_protocol}" ]] &&
      run_as_service "${OLD_RELEASE}" timeout 5 node dist/cli/executor.js --health "${OLD_EXECUTOR}" >/dev/null 2>&1; then
    ROLLING=1
    echo "activation: compatible executors; existing runs keep their release and admissions remain open"
  fi
fi

# The guard runs from the OLD release, so what it can do is that release's:
# the first deployment after waiting was introduced still refuses busy work.
# Captured rather than piped into `grep -q`, whose early exit would kill the
# writer and turn a match into a pipefail.
guard_waits() {
  local usage
  # Bounded: a release that hangs on `--help` must not hold the host lock.
  usage="$(timeout 30 runuser -u "${SERVICE_USER}" -- env HOME="${SERVICE_HOME}" \
    node "${OLD_RELEASE}/dist/cli/deploy-preflight.js" --help 2>/dev/null || true)"
  [[ "${usage}" == *"--wait-ms"* ]]
}

# In wait mode the guard, not root, writes the freeze marker.
marker_dir_writable_by_service() {
  runuser -u "${SERVICE_USER}" -- test -w "$(dirname "${MARKER_PATH}")"
}

GUARD_LINES_SHOWN=0
relay_guard_progress() {
  local lines
  lines="$(wc -l <"${GUARD_DIR}/stdout" 2>/dev/null || echo 0)"
  if (( lines > GUARD_LINES_SHOWN )); then
    sed -n "$((GUARD_LINES_SHOWN + 1)),${lines}p" "${GUARD_DIR}/stdout"
    GUARD_LINES_SHOWN="${lines}"
  fi
}

guard_exited() {
  relay_guard_progress
  local guard_status=0
  wait "${GUARD_PID}" || guard_status=$?
  [[ "${guard_status}" -eq 75 ]] && refuse "runtime drain refused: $(<"${GUARD_LOG}")"
  fail "runtime drain failed (exit ${guard_status}): $(<"${GUARD_LOG}")"
}

if [[ -n "${OLD_RELEASE}" && "${ROLLING}" -eq 0 ]]; then
  EXECUTOR_DRAIN_DEADLINE=$((SECONDS + WAIT_SECONDS))
  MARKER_PATH="$(run_as_service_with_app_env "${OLD_RELEASE}" bash -c 'printf %s "${ATOMA_DEPLOY_LOCK_PATH:-}"')"
  valid_absolute_path "${MARKER_PATH}" || fail "ATOMA_DEPLOY_LOCK_PATH must be configured as an absolute path"
  # Created when absent, for the service user who reads it — and never
  # re-moded when present: an existing state directory keeps its own mode.
  [[ -d "$(dirname "${MARKER_PATH}")" ]] ||
    install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "$(dirname "${MARKER_PATH}")"
  GUARD_WAIT_ARGS=()
  if (( WAIT_SECONDS > 0 )) && guard_waits; then
    if marker_dir_writable_by_service; then
      GUARD_WAIT_ARGS=(--wait-ms "$((WAIT_SECONDS * 1000))")
    else
      echo "drain: ${SERVICE_USER} cannot write $(dirname "${MARKER_PATH}"); refusing busy work at once, as before"
    fi
  fi
  if (( ${#GUARD_WAIT_ARGS[@]} > 0 )); then
    # WAIT MODE: the guard announces the deployment so nothing new starts,
    # lets running work finish, and writes the write-freeze marker itself
    # once the slot is clear. Freezing every write for the whole wait would
    # have refused logins and settings for as long as a run lasts.
    # This activator holds the host lock, so any marker already there was
    # left by a deployment that died; it must not freeze writes for the wait.
    rm -f -- "${MARKER_PATH}"
    echo "drain: waiting up to ${WAIT_SECONDS}s for running work; nothing new may start meanwhile"
  else
    # The running release predates waiting deployments (or waiting is off):
    # freeze writes first and refuse whatever is busy, as before.
    # Match runLock's Linux birth identity, including the boot: an abandoned
    # fallback freeze must expire when this activator dies or the host reboots.
    PARENT_STAT="$(<"/proc/$$/stat")"
    read -r -a PARENT_FIELDS <<< "${PARENT_STAT##*) }"
    PARENT_BOOT="$(</proc/sys/kernel/random/boot_id)"
    [[ -n "${PARENT_BOOT}" && "${PARENT_FIELDS[19]:-}" =~ ^[0-9]+$ ]] || fail "cannot identify deployment parent"
    printf 'guard %s linux:%s:%s\n' "$$" "${PARENT_BOOT}" "${PARENT_FIELDS[19]}" > "${MARKER_PATH}.$$.partial"
    chmod 0644 "${MARKER_PATH}.$$.partial"
    mv -f -- "${MARKER_PATH}.$$.partial" "${MARKER_PATH}"
  fi

  # The service user cannot traverse WORK_DIR: mktemp deliberately creates it
  # as 0700 root. Keep the private guard beneath the root-owned 0755 deploy
  # root so only its explicitly assigned owner can enter it.
  GUARD_DIR="$(mktemp -d "${DEPLOY_ROOT}/.deploy-guard-${REVISION}.XXXXXX")"
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${GUARD_DIR}"
  GUARD_READY_FILE="${GUARD_DIR}/ready"
  GUARD_RELEASE_FILE="${GUARD_DIR}/release"
  GUARD_LOG="${GUARD_DIR}/stderr"
  run_as_service_with_app_env \
    "${OLD_RELEASE}" \
    node "${OLD_RELEASE}/dist/cli/deploy-preflight.js" \
      --hold \
      --parent-pid "$$" \
      --ready-file "${GUARD_READY_FILE}" \
      --release-file "${GUARD_RELEASE_FILE}" \
      --admission-marker "${MARKER_PATH}" \
      "${GUARD_WAIT_ARGS[@]}" \
      >"${GUARD_DIR}/stdout" 2>"${GUARD_LOG}" &
  GUARD_PID=$!
  if (( ${#GUARD_WAIT_ARGS[@]} > 0 )); then
    # The guard refuses at its own deadline; this bound only catches a guard
    # that neither became ready nor exited.
    READY_DEADLINE=$((SECONDS + WAIT_SECONDS + 120))
    until [[ -f "${GUARD_READY_FILE}" ]]; do
      kill -0 "${GUARD_PID}" 2>/dev/null || guard_exited
      (( SECONDS < READY_DEADLINE )) || fail "runtime drain did not become ready within ${WAIT_SECONDS}s"
      relay_guard_progress
      sleep 1
    done
    relay_guard_progress
  else
    for _ in {1..80}; do
      [[ -f "${GUARD_READY_FILE}" ]] && break
      kill -0 "${GUARD_PID}" 2>/dev/null || guard_exited
      sleep 0.25
    done
  fi
  [[ -f "${GUARD_READY_FILE}" ]] || fail "runtime drain did not become ready"
fi

# The new release is PREPARED WHILE THE OLD GENERATION STILL SERVES: it runs
# from its own directory and nothing reads the new one, and the mutable worker
# tag moves only below. So the outage is the stop, the switch and the start —
# it used to include the install, the smoke and the image build, about 30 s
# per deployment (2026-09-27) — and a preparation that fails leaves the old
# generation running, untouched. A redeploy of the running revision is the
# exception: its dependencies are the running ones, so it stops first.
prepare_release() {
  run_as_service "${TARGET_RELEASE}" npm ci --omit=dev
  run_as_service "${TARGET_RELEASE}" node scripts/release-smoke.mjs
  run_as_service "${TARGET_RELEASE}" docker build \
    -f docker/worker.Dockerfile -t "atoma-worker:${REVISION}" .
}
PREPARED=0
if [[ "${TARGET_RELEASE}" != "${OLD_RELEASE}" ]]; then
  prepare_release
  PREPARED=1
elif [[ "${TARGET_EXECUTOR}" -eq 1 && "${OLD_EXECUTOR}" == "${OWN_EXECUTOR}" ]]; then
  # An immutable generation may still be executing. Reinstalling its modules
  # or rebuilding its image in place would mix code within that run.
  PREPARED=1
fi
ACTIVATION_STARTED=1
if [[ "${ROLLING}" -eq 0 && -n "${OLD_EXECUTOR}" ]]; then
  # A compatibility boundary must stop ALL old writers, not just the web or
  # selected generation. Naming/notifications can outlive the run lease.
  for receipt in "${EXECUTOR_ROOT}"/*.sock.json; do
    [[ -f "${receipt}" ]] || continue
    generation="$(basename "${receipt}" .sock.json)"
    [[ "${generation}" =~ ^[0-9a-f]{40}$ ]] || fail "invalid executor receipt"
    while [[ -f "${receipt}" ]]; do
      idle_status=0
      run_as_service "${OLD_RELEASE}" timeout 5 node dist/cli/executor.js --idle "${EXECUTOR_ROOT}/${generation}.sock" >/dev/null 2>&1 || idle_status=$?
      [[ "${idle_status}" -eq 0 ]] && break
      (( SECONDS < EXECUTOR_DRAIN_DEADLINE )) || refuse "executor ${generation} did not become verifiably idle before maintenance"
      sleep 1
    done
    systemctl stop "atoma-executor@${generation}.service"
  done
fi
systemctl stop "${SERVICE_NAME}"
if [[ "${ROLLING}" -eq 1 ]]; then
  # Those browser grants no longer exist. Reclaim remote previews without
  # waiting for their hard lifetime and without touching executing devices.
  for receipt in "${EXECUTOR_ROOT}"/*.sock.json; do
    [[ -f "${receipt}" ]] || continue
    run_as_service "${OLD_RELEASE}" timeout 5 node dist/cli/executor.js --retire-previews "${receipt%.json}" >/dev/null 2>&1 || true
  done
fi
(( PREPARED )) || prepare_release

if [[ "${TARGET_EXECUTOR}" -eq 1 ]]; then
  # The executor unit is deliberately independent of the web unit. Only a
  # verified release supplies its template; root owns the installed copy.
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${EXECUTOR_ROOT}"
  install -d -m 0755 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${COMPUTE_ROOT}"
  install -o root -g root -m 0644 "${TARGET_RELEASE}/deploy/atoma-executor@.service" /etc/systemd/system/atoma-executor@.service
  install -d -m 0755 "/etc/systemd/system/${SERVICE_NAME}.d"
  # Render only host-owned path/account settings; do not run release code as
  # root. Quoted systemd arguments preserve spaces, literal '$' and '%'.
  python3 - /etc/systemd/system/atoma-executor@.service "${DEPLOY_ROOT}" "${APP_ENV}" "${SERVICE_USER}" "${SERVICE_GROUP}" "${EXECUTOR_DROPIN}" "${REVISION}" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); root, app_env, user, group = sys.argv[2:6]
def quoted(value, command=False):
    value = value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('{instance}', '%i')
    if command: value = value.replace('$', '$$')
    return '"' + value + '"'
generation = root + '/releases/{instance}'
args = ['ATOMA_RUN_EXECUTOR=1', 'ATOMA_EXECUTOR_SOCKET=' + root + '/executors/active.sock',
        'ATOMA_EXECUTOR_OWN_SOCKET=' + root + '/executors/{instance}.sock',
        'ATOMA_EXECUTOR_COMPUTE_SOCKET=' + root + '/compute/{instance}.sock',
        'ATOMA_WORKER_IMAGE=atoma-worker:{instance}', '/usr/bin/node', generation + '/dist/viz/server.js']
values = {'RequiresMountsFor': quoted(root), 'User': user, 'Group': group,
          'WorkingDirectory': quoted(generation), 'EnvironmentFile': quoted(app_env),
          'ExecStart': '/usr/bin/env ' + ' '.join(quoted(v, True) for v in args) + ' --host 127.0.0.1 --port 0'}
p.write_text('\n'.join(k + '=' + values[k] if (k := line.split('=', 1)[0]) in values else line
                       for line in p.read_text().splitlines()) + '\n')
revision = sys.argv[7]
Path(sys.argv[6]).write_text('[Unit]\nWants=atoma-executor@' + revision + '.service\nAfter=atoma-executor@' + revision +
                           '.service\n[Service]\nTimeoutStopSec=90\nEnvironment=' + quoted('ATOMA_EXECUTOR_SOCKET=' + root + '/executors/active.sock') + '\n')
PY
  # Wants/After starts the selected generation again after a host reboot.
  # There is no reverse PartOf/BindsTo: stopping the web cannot stop runs.
  rm -f -- "${OWN_EXECUTOR}.retire"
  systemctl daemon-reload
fi

if [[ -n "${OLD_REVISION}" ]] && docker image inspect atoma-worker:latest >/dev/null 2>&1; then
  WORKER_ROLLBACK_TAG="atoma-worker:rollback-${OLD_REVISION}"
  docker tag atoma-worker:latest "${WORKER_ROLLBACK_TAG}"
fi
docker tag "atoma-worker:${REVISION}" atoma-worker:latest
WORKER_LATEST_CHANGED=1

NEXT_LINK="${DEPLOY_ROOT}/.current-${REVISION}"
ln -s "${TARGET_RELEASE}" "${NEXT_LINK}"
mv -Tf "${NEXT_LINK}" "${CURRENT}"

if [[ "${TARGET_EXECUTOR}" -eq 1 ]]; then
  EXECUTOR_STARTED=1
  systemctl start "atoma-executor@${REVISION}.service"
  executor_ready=0
  for _ in {1..30}; do
    if run_as_service "${TARGET_RELEASE}" timeout 5 node dist/cli/executor.js --health "${OWN_EXECUTOR}" >/dev/null 2>&1; then
      executor_ready=1; break
    fi
    sleep 1
  done
  [[ "${executor_ready}" -eq 1 ]] || fail "new executor failed health verification"
  ln -s "${OWN_EXECUTOR}" "${EXECUTOR_ROOT}/.next.sock"
  mv -Tf "${EXECUTOR_ROOT}/.next.sock" "${ACTIVE_EXECUTOR}"
  ln -s "${COMPUTE_ROOT}/${REVISION}.sock" "${COMPUTE_ROOT}/.next.sock"
  mv -Tf "${COMPUTE_ROOT}/.next.sock" "${COMPUTE_ROOT}/active.sock"
elif [[ -n "${OLD_EXECUTOR}" ]]; then
  # A rollback across the compatibility boundary reached here only after
  # the ordinary full drain. Retire the empty external host, restore legacy wiring.
  rm -f -- "${ACTIVE_EXECUTOR}" "/etc/systemd/system/${SERVICE_NAME}.d/executor.conf"
  rm -f -- "${COMPUTE_ROOT}/active.sock"
  systemctl daemon-reload
fi

systemctl start "${SERVICE_NAME}"
HEALTHY=0
for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 3 "${HEALTH_URL}" >/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done
[[ "${HEALTHY}" -eq 1 ]] || fail "new generation failed health verification"

if [[ -n "${OLD_EXECUTOR}" && "${OLD_EXECUTOR}" != "${OWN_EXECUTOR}" ]]; then
  touch "${OLD_EXECUTOR}.retire"
fi

ACTIVATION_STARTED=0
echo "deployed ${REVISION} to ${SERVICE_NAME}"
# The new generation is healthy: writes and previews resume now, not after
# the retention prune below. A maintenance guard releases its run lease at
# EXIT; the independent mender refresh never holds that lease.
if [[ -n "${MARKER_PATH}" ]]; then
  rm -f -- "${MARKER_PATH}"
fi

# Health has passed; keep the previous generation and five recent releases.
# The deployment lock and drain lease remain held until EXIT. The helper is
# installed root-owned beside this script, never executed from a writable release.
if ! node "$(dirname "${BASH_SOURCE[0]}")/atoma-prune-releases.mjs" \
    "${DEPLOY_ROOT}" "${OLD_RELEASE:-}" --apply; then
  echo "WARNING: release retention failed; application remains deployed. Inspect disk usage." >&2
fi

# ── The mender follows the deployed revision ────────────────────────────────
# Until 2026-09-07 nothing moved the mender's clone: it stayed on whatever
# revision install-mender.sh last pinned, while mender.env could already
# describe the new one. This phase runs AFTER the application is healthy and
# AFTER the rollback section closed: a mender that cannot be refreshed is
# reported and left STOPPED on its previous checkout, never a reason to
# restore the previous application generation. The separate refresh job
# performs its own graceful mender stop before changing that checkout.
# The app is healthy and admits runs. Refreshing the optional mender is a
# separate systemd job; its graceful stop/build never blocks this deployment
# and never holds the global run lease while user work is executing.
install -o root -g root -m 0755 "${TARGET_RELEASE}/deploy/refresh-mender.sh" /usr/local/sbin/atoma-refresh-mender
if [[ -d "${MENDER_CHECKOUT}/.git" && -f "${MENDER_ENV}" ]]; then
  systemd-run --quiet --collect --unit="atoma-mender-refresh-${REVISION}" \
    --setenv="ATOMA_DEPLOY_CONFIG=${CONFIG_PATH}" /usr/local/sbin/atoma-refresh-mender ||
    echo "WARNING: mender refresh could not be scheduled; application remains deployed" >&2
fi
