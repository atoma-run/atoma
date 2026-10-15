"""Check the model-authored manifest against the published Git file set.

Read-only: never execute a command supplied by the deliverable.
This experiment is expected to exit 1 because its manifest names an internal
sidecar which is intentionally not a published deliverable.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
tracked = set(subprocess.check_output(
    ['git', '-C', str(root), 'ls-files', '-z']).decode('utf-8').rstrip('\0').split('\0'))
entries = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['files']
listed = [entry['path'] for entry in entries]
missing = []
mismatches = []
matched = 0
for entry in entries:
    path = (root / entry['path']).resolve()
    assert path.is_relative_to(root), 'Manifest path escapes package'
    if not path.is_file():
        missing.append(entry['path'])
    elif hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
        mismatches.append(entry['path'])
    else:
        matched += 1
unlisted = sorted(tracked - {'manifest.json'} - set(listed))
duplicates = sorted(path for path in set(listed) if listed.count(path) > 1)
receipt = dict(published_files=len(tracked), manifest_entries=len(entries),
    matching_hashes=matched, missing_files=missing, hash_mismatches=mismatches,
    unlisted_files=unlisted, duplicate_entries=duplicates)
print(json.dumps(receipt, indent=2))
sys.exit(1 if missing or mismatches or unlisted or duplicates else 0)
