"""Independent package regression harness for the inspected published repair.

Usage: python check-repair.py ORIGINAL_CHECKOUT REPAIRED_CHECKOUT
Read the delivered Python before running this harness: it executes verify_all.py
only in disposable copies of tracked files. No model-authored shell is replayed.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

original, repaired = (Path(arg).resolve() for arg in sys.argv[1:])
STREAMS = {'packing', 'schedule', 'routing', 'quality'}

def tracked(root):
    return subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().rstrip('\0').split('\0')

def snapshot(root, names):
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}

old_files, new_files = tracked(original), tracked(repaired)
old_streams = [name for name in old_files if name.split('/')[0] in STREAMS]
new_streams = [name for name in new_files if name.split('/')[0] in STREAMS]
assert old_streams == new_streams
assert snapshot(original, old_streams) == snapshot(repaired, new_streams), 'Analysis bytes changed'
assert (original / 'dossier.md').read_bytes() == (repaired / 'dossier.md').read_bytes(), 'Dossier changed'
before = snapshot(repaired, new_files)
receipts = {}
failures = []
cases = ('clean', 'runtime_exclusions', 'internal_reference', 'missing_file', 'altered_file', 'wrong_hash',
         'omitted_entry', 'duplicate_entry', 'escaping_path', 'unexpected_file')
for case in cases:
    with tempfile.TemporaryDirectory(prefix='atoma-package-regression-') as temp:
        root = Path(temp)
        for name in new_files:
            target = root / name
            assert target.resolve().is_relative_to(root.resolve())
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((repaired / name).read_bytes())
        manifest_path = root / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        entries = manifest['files']
        entry = next(item for item in entries if item['path'] == 'README.md')
        if case == 'runtime_exclusions':
            for name in ('.git/config', '.atoma/cache', '.atoma-probes.json',
                         'node_modules/example/index.js', 'quality/__pycache__/example.pyc'):
                excluded = root / name
                excluded.parent.mkdir(parents=True, exist_ok=True)
                excluded.write_text('local runtime state', encoding='utf-8')
        elif case == 'internal_reference':
            entries.append({'path': '.atoma-probes.json', 'sha256': '0' * 64})
        elif case == 'missing_file':
            (root / 'README.md').unlink()
        elif case == 'altered_file':
            with (root / 'README.md').open('ab') as handle:
                handle.write(b'\nindependent mutation\n')
        elif case == 'wrong_hash':
            entry['sha256'] = '0' * 64
        elif case == 'omitted_entry':
            entries.remove(entry)
        elif case == 'duplicate_entry':
            entries.append(dict(entry))
        elif case == 'escaping_path':
            entries.append({'path': '../outside.txt', 'sha256': '0' * 64})
        elif case == 'unexpected_file':
            (root / 'unexpected.txt').write_text('not inventoried', encoding='utf-8')
        if case not in ('clean', 'runtime_exclusions'):
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        proc = subprocess.run([sys.executable, 'verify_all.py'], cwd=root,
                              capture_output=True, text=True, timeout=60)
        receipts[case] = dict(exit_code=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)
        if (proc.returncode == 0) != (case in ('clean', 'runtime_exclusions')):
            failures.append(case)
        if case not in ('clean', 'runtime_exclusions'):
            if not any(word in (proc.stdout + proc.stderr).lower() for word in ('manifest', 'inventory')):
                failures.append(case + ': missing integrity diagnostic')
assert before == snapshot(repaired, new_files), 'Published checkout changed'
print(json.dumps(dict(analysis_files_unchanged=len(old_streams), dossier_unchanged=True, originals_preserved=True,
                     failures=failures, cases=receipts), indent=2))
sys.exit(1 if failures else 0)
