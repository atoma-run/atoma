#!/usr/bin/env bash
# Run from a verified deployed release. Never fetch/run an unreviewed installer.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 2; }
release="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
config=/home/atoma/config/mender.env
checkout=/home/atoma/mender
[[ ! -L "$config" && ! -L "$checkout" ]] || { echo 'Refusing symlinked config or checkout.' >&2; exit 2; }
[[ -f "$release/REVISION" ]] || { echo 'Use the installer in /home/atoma/current after deployment.' >&2; exit 2; }
revision="$(cat "$release/REVISION")"
[[ $revision =~ ^[0-9a-f]{40}$ ]] || exit 2
for command in git gh docker node npm python3 flock; do
  command -v "$command" >/dev/null || { echo "Install prerequisite: $command" >&2; exit 2; }
done
# Collect interactive input before pausing admission or stopping the service.
if [[ ! -f "$config" ]]; then
  read -r -s -p 'GitHub publisher PAT (Contents + Pull requests write on atoma-run/atoma): ' publisher
  printf '\n'
  [[ $publisher =~ ^[A-Za-z0-9_]+$ ]] || { echo 'Invalid token format.' >&2; exit 2; }
fi
# Share the activator's lock: installation must not overlap a release switch
# or another installer, including while it is waiting for the run slot.
exec 9>/home/atoma/.deployment.lock
flock -n 9 || { echo 'Another deployment or mender installation is active.' >&2; exit 2; }
exec 8>/home/atoma/.mender-refresh.lock
flock -n 8 || { echo 'A mender refresh is active; retry after it finishes.' >&2; exit 2; }
service_home="$(getent passwd atoma | cut -d: -f6)"
guard_dir=''
guard_pid=''
restart_app=0
cleanup() {
  local status=$?
  trap - EXIT
  # Restart before releasing admission, even when the build failed. Preserve
  # the original failure, but report a recovery failure after an otherwise
  # successful installation.
  if (( restart_app )); then systemctl start atoma.service || status=1; fi
  if [[ -n "$guard_dir" ]]; then touch "$guard_dir/release"; fi
  if [[ -n "$guard_pid" ]]; then wait "$guard_pid" || status=1; fi
  if [[ -n "$guard_dir" ]]; then rm -rf -- "$guard_dir"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# The existing deployment guard closes admission, waits for current work and
# holds the run lease throughout installation. A read-only preflight followed
# by systemctl stop leaves a window for a new run (including an MCP client).
guard_dir="$(mktemp -d /home/atoma/.mender-install-guard.XXXXXX)"
chown atoma:atoma "$guard_dir"
runuser -u atoma -- env HOME="$service_home" bash -c '
  set -Eeuo pipefail
  set -a; source /home/atoma/config/atoma.env; set +a
  [[ ${ATOMA_DEPLOY_LOCK_PATH:-} == /* ]] || { echo "Configure an absolute ATOMA_DEPLOY_LOCK_PATH first." >&2; exit 2; }
  cd /home/atoma/current
  exec node dist/cli/deploy-preflight.js --hold --parent-pid "$1" \
    --ready-file "$2/ready" --release-file "$2/release" \
    --admission-marker "$ATOMA_DEPLOY_LOCK_PATH" --wait-ms 5400000
' bash "$$" "$guard_dir" &
guard_pid=$!
until [[ -f "$guard_dir/ready" ]]; do
  if ! kill -0 "$guard_pid" 2>/dev/null; then
    wait "$guard_pid" || true
    echo 'Maintenance guard failed; installation refused.' >&2
    exit 1
  fi
  sleep 0.1
done
kill -0 "$guard_pid"
if systemctl cat atoma-mender.service >/dev/null 2>&1; then
  systemctl stop atoma-mender.service
fi
restart_app=1
systemctl stop atoma.service

if [[ ! -f "$config" ]]; then
  install -o root -g atoma -m 640 "$release/deploy/mender.env.example" "$config"
  printf 'GH_TOKEN=%s\n' "$publisher" >> "$config"
  unset publisher
fi
# Copy ONLY shared path settings, never product/provider secrets. Resolve HOME
# and the default lease from the account exactly as systemd does.
env HOME="$service_home" bash -c '
  set -a
  source /home/atoma/config/atoma.env
  printf "HOME=%s\nATOMA_MCP_RUN_LOCK=%s\nATOMA_RUNS_DIR=%s\nATOMA_SUPERVISOR_DIR=%s\nATOMA_DB_PATH=%s\n" \
    "$HOME" "${ATOMA_MCP_RUN_LOCK:-$HOME/.atoma/mcp-run-lock.db}" \
    "${ATOMA_RUNS_DIR:-/home/atoma/current/runs}" \
    "${ATOMA_SUPERVISOR_DIR:?Persist ATOMA_SUPERVISOR_DIR first}" \
    "${ATOMA_DB_PATH:-/home/atoma/current/atoma.db}"
' >> "$config"
install -d -o atoma -g atoma -m 700 "$checkout" /home/atoma/state/codex/mender
if [[ ! -f /home/atoma/state/codex/mender/auth.json ]]; then
  [[ -f /home/atoma/.codex-mender-ci/auth.json ]] || { echo 'Create the dedicated mender ChatGPT login first.' >&2; exit 2; }
  install -o atoma -g atoma -m 600 /home/atoma/.codex-mender-ci/auth.json /home/atoma/state/codex/mender/auth.json
fi
runuser -u atoma -- env MENDER_REVISION="$revision" bash -c '
  set -Eeuo pipefail
  set -a
  source /home/atoma/config/mender.env
  set +a
  MENDER_REMOTE=https://github.com/atoma-run/atoma.git
  if [[ ! -d /home/atoma/mender/.git ]]; then
    git clone "$MENDER_REMOTE" /home/atoma/mender
  fi
  cd /home/atoma/mender
  origin="$(git remote get-url origin)"
  # The repository moved from mgtf/atoma (2026-10-08): a clone made before
  # follows the move, any other origin is still refused.
  if [[ $origin == https://github.com/mgtf/atoma || $origin == https://github.com/mgtf/atoma.git ]]; then
    git remote set-url origin "$MENDER_REMOTE"
    origin="$MENDER_REMOTE"
  fi
  [[ $origin == "$MENDER_REMOTE" ]] || { echo "mender checkout has another origin" >&2; exit 2; }
  [[ -z $(git status --porcelain) ]] || { echo "Mender checkout is dirty; preserve and inspect it." >&2; exit 2; }
  git fetch origin main
  git checkout --detach "$MENDER_REVISION"
  git config user.name "Atoma Mender"
  git config user.email "atoma-mender@users.noreply.github.com"
  HUSKY=0 npm ci
  npx tsc -p tsconfig.json
  docker build -f docker/mender.Dockerfile -t atoma-mender:local .
  CODEX_HOME="$ATOMA_MENDER_CODEX_HOME" "$ATOMA_MENDER_CMD_CODEX" login status
  node dist/cli/mender.js --help >/dev/null
'
# Keep a root-only backup of the old environment; remove the retired dispatcher.
cp -a --no-clobber /home/atoma/config/atoma.env /home/atoma/config/atoma.env.before-local-mender
chmod 600 /home/atoma/config/atoma.env.before-local-mender
chown root:root /home/atoma/config/atoma.env.before-local-mender
python3 - <<'PY'
from pathlib import Path
p = Path('/home/atoma/config/atoma.env')
lines = p.read_text().splitlines(keepends=True)
p.write_text(''.join(line for line in lines if not line.lstrip().removeprefix('export ').startswith('ATOMA_MENDER_DISPATCH_')))
PY
install -o root -g root -m 644 "$release/deploy/atoma-mender.service" /etc/systemd/system/atoma-mender.service
systemctl daemon-reload
systemctl start atoma.service
restart_app=0
systemctl enable --now atoma-mender.service
echo 'Mender installed. Inspect: sudo journalctl -u atoma-mender -f'
