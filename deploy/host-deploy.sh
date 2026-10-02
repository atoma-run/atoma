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
MENDER_REMOTE="https://github.com/mgtf/atoma.git"

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

for command in node npm docker curl systemctl runuser tar sha256sum realpath getent flock findmnt soffice timeout; do
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

if [[ -n "${OLD_RELEASE}" ]]; then
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
fi
ACTIVATION_STARTED=1
systemctl stop "${SERVICE_NAME}"
(( PREPARED )) || prepare_release

if [[ -n "${OLD_REVISION}" ]] && docker image inspect atoma-worker:latest >/dev/null 2>&1; then
  WORKER_ROLLBACK_TAG="atoma-worker:rollback-${OLD_REVISION}"
  docker tag atoma-worker:latest "${WORKER_ROLLBACK_TAG}"
fi
docker tag "atoma-worker:${REVISION}" atoma-worker:latest
WORKER_LATEST_CHANGED=1

NEXT_LINK="${DEPLOY_ROOT}/.current-${REVISION}"
ln -s "${TARGET_RELEASE}" "${NEXT_LINK}"
mv -Tf "${NEXT_LINK}" "${CURRENT}"

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

ACTIVATION_STARTED=0
echo "deployed ${REVISION} to ${SERVICE_NAME}"
# The new generation is healthy: writes and previews resume now, not after
# the retention prune and the mender refresh below. The guard keeps the run
# lease until EXIT, so no run starts beside the mender's rebuild.
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
# restore the previous application generation. No mend is in flight here —
# the drain guard still holds the machine run lease until this script exits.
refresh_mender() {
  if [[ ! -d "${MENDER_CHECKOUT}/.git" || ! -f "${MENDER_ENV}" || -L "${MENDER_ENV}" ]]; then
    echo "mender: not installed on this host (${MENDER_CHECKOUT}, ${MENDER_ENV}); skipping"
    return 0
  fi
  for command in git gh; do
    command -v "${command}" >/dev/null 2>&1 || fail "mender refresh needs ${command}"
  done
  [[ -f "${TARGET_RELEASE}/deploy/atoma-mender.service" ]] || fail "release ships no mender unit"
  systemctl stop "${MENDER_SERVICE}" || true
  # The rebuild was about 90 s of every deployment, the run lease held
  # throughout (2026-09-27): a full `npm ci` (43 s) and `tsc` (39 s) on this
  # 4 GB host. Dependencies change only with the lockfile or the runtime, so
  # an identical pair skips the reinstall; and the release was compiled by CI
  # from this same revision and lockfile and verified by digest before this
  # activation, so its `dist` is what `tsc` would write here.
  if ! runuser -u "${SERVICE_USER}" -- env HOME="${SERVICE_HOME}" MENDER_REVISION="${REVISION}" \
      MENDER_REMOTE="${MENDER_REMOTE}" MENDER_RELEASE_DIST="${TARGET_RELEASE}/dist" bash -c '
    set -Eeuo pipefail
    set -a; source "$1"; set +a
    cd "$2"
    [[ $(git remote get-url origin) == "$MENDER_REMOTE" ]] || { echo "mender checkout has another origin" >&2; exit 2; }
    [[ -z $(git status --porcelain) ]] || { echo "mender checkout is dirty; preserve and inspect it" >&2; exit 2; }
    git fetch --quiet origin main
    git checkout --quiet --detach "$MENDER_REVISION"
    stamp="$(sha256sum package-lock.json | cut -d" " -f1) $(node --version)"
    if [[ "$(cat node_modules/.atoma-install-stamp 2>/dev/null || true)" != "$stamp" ]]; then
      HUSKY=0 npm ci
      printf "%s\n" "$stamp" > node_modules/.atoma-install-stamp
    fi
    rm -rf dist
    cp -a "$MENDER_RELEASE_DIST" dist
    docker build -f docker/mender.Dockerfile -t atoma-mender:local .
    node dist/cli/mender.js --help >/dev/null
  ' bash "${MENDER_ENV}" "${MENDER_CHECKOUT}"; then
    fail "mender refresh failed; ${MENDER_SERVICE} is stopped on its previous checkout — inspect ${MENDER_CHECKOUT} or rerun deploy/install-mender.sh (the application itself is deployed)"
  fi
  install -o root -g root -m 0644 "${TARGET_RELEASE}/deploy/atoma-mender.service" \
    "/etc/systemd/system/${MENDER_SERVICE}"
  systemctl daemon-reload
  systemctl start "${MENDER_SERVICE}"
  echo "mender: ${MENDER_SERVICE} refreshed to ${REVISION}"
}
refresh_mender
