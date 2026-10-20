#!/usr/bin/env bash
# One-time nginx wiring from an already verified release. Reload preserves
# existing WSS connections; before the first cutover the upstream falls back
# to the legacy web gateway.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 2; }
release="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
site="${1:-/etc/nginx/sites-available/atoma.run}"
[[ -f "$release/REVISION" && "$(<"$release/REVISION")" =~ ^[0-9a-f]{40}$ ]] || { echo 'Use a verified deployed release.' >&2; exit 2; }
[[ -f "$site" && ! -L "$site" && "$site" == /etc/nginx/* ]] || exit 2
upstream=/etc/nginx/conf.d/atoma-compute-executor.conf
location=/etc/nginx/snippets/atoma-compute-executor.conf
for file in "$upstream" "$location"; do [[ ! -L "$file" ]] || exit 2; done
backup="$(mktemp -d)"
cp -a "$site" "$backup/site"
for key in upstream location; do
  file="${!key}"
  if [[ -e "$file" ]]; then cp -a "$file" "$backup/$key"; fi
done
committed=0
cleanup() {
  local status=$?
  if (( ! committed )); then
    cp -a "$backup/site" "$site"
    for key in upstream location; do
      file="${!key}"
      if [[ -f "$backup/$key" ]]; then cp -a "$backup/$key" "$file"; else rm -f -- "$file"; fi
    done
  fi
  rm -rf -- "$backup"
  exit "$status"
}
trap cleanup EXIT
install -o root -g root -m 0644 "$release/deploy/compute-executor.nginx.conf" "$upstream"
install -o root -g root -m 0644 "$release/deploy/compute-executor-location.nginx.conf" "$location"
python3 - "$site" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); text = p.read_text()
include = '    include /etc/nginx/snippets/atoma-compute-executor.conf;'
if include not in text:
    if 'server_name atoma.run;' not in text or '    location / {' not in text:
        raise SystemExit('Unrecognized site layout; add the documented include inside the HTTPS server manually.')
    text = text.replace('    location / {', include + '\n\n    location / {', 1)
    p.write_text(text)
PY
nginx -t
systemctl reload nginx
committed=1
echo 'Compute connections now reach independent executor generations; legacy fallback remains available.'
