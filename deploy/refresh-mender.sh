#!/usr/bin/env bash
# Root-owned, independent mender refresh. It never holds the product run lease.
set -Eeuo pipefail
[[ $EUID == 0 ]] || exit 2
CONFIG_PATH="${ATOMA_DEPLOY_CONFIG:-/etc/atoma/deploy.env}"
[[ -f "$CONFIG_PATH" && ! -L "$CONFIG_PATH" ]] || exit 2
set -a; source "$CONFIG_PATH"; set +a
DEPLOY_ROOT="${ATOMA_DEPLOY_ROOT:-/home/atoma}"
SERVICE_USER="${ATOMA_DEPLOY_USER:-atoma}"
MENDER_SERVICE="${ATOMA_DEPLOY_MENDER_SERVICE:-atoma-mender.service}"
MENDER_CHECKOUT="${ATOMA_DEPLOY_MENDER_CHECKOUT:-/home/atoma/mender}"
MENDER_ENV="${ATOMA_DEPLOY_MENDER_ENV:-/home/atoma/config/mender.env}"
MENDER_REMOTE="https://github.com/atoma-run/atoma.git"
fail() { echo "$*" >&2; exit 1; }
[[ "$DEPLOY_ROOT" == /* && "$DEPLOY_ROOT" != / && "$MENDER_SERVICE" =~ ^[A-Za-z0-9_.@-]+$ ]] || exit 2
# Serialize refreshes, then resolve current: a queued job follows the latest
# deployed revision, never an obsolete release captured by the SSH session.
exec 9>"${DEPLOY_ROOT}/.mender-refresh.lock"
flock 9
TARGET_RELEASE="$(realpath -e "${DEPLOY_ROOT}/current")"
[[ "$TARGET_RELEASE" == "${DEPLOY_ROOT}/releases/"* ]] || exit 2
REVISION="$(basename "$TARGET_RELEASE")"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ && "$(<"$TARGET_RELEASE/REVISION")" == "$REVISION" ]] || exit 2
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
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
    origin="$(git remote get-url origin)"
    # The repository moved from mgtf/atoma (2026-10-08): a clone made before
    # follows the move, any other origin is still refused.
    if [[ $origin == https://github.com/mgtf/atoma || $origin == https://github.com/mgtf/atoma.git ]]; then
      git remote set-url origin "$MENDER_REMOTE"
      origin="$MENDER_REMOTE"
    fi
    [[ $origin == "$MENDER_REMOTE" ]] || { echo "mender checkout has another origin" >&2; exit 2; }
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
