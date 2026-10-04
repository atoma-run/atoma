"""Independent audit of the published museum capsule; use only owned copies."""
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
expected = [
    ('README.txt', b'Museum capsule v1\n'),
    ('data/caf\u00e9.txt', 'Caf\u00e9 \u2014 \u00e9t\u00e9\n'.encode('utf-8')),
    ('data/empty.bin', b''),
]
archive = (root / 'capsule.zip').read_bytes()
manifest = (root / 'manifest.json').read_bytes()
with zipfile.ZipFile(io.BytesIO(archive)) as z:
    assert z.namelist() == [name for name, _ in expected]
    assert z.comment == b''
    for entry, (name, content) in zip(z.infolist(), expected):
        assert z.read(entry) == content
        assert entry.compress_type == zipfile.ZIP_STORED
        assert entry.date_time == (1980, 1, 1, 0, 0, 0)
        assert entry.create_system == 3
        assert entry.external_attr >> 16 == 0o100644
        assert entry.extra == entry.comment == b''
        assert entry.file_size == len(content)
        offset = entry.header_offset
        local = struct.unpack_from('<IHHHHHIIIHH', archive, offset)
        assert local[0] == 0x04034B50
        assert local[3:6] == (0, 0, 33)
        assert local[-1] == 0
        assert local[6] == entry.CRC
        assert local[7:9] == (len(content), len(content))
    assert z.testzip() is None
expected_manifest = {'entries': [
    {'name': name, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    for name, content in expected
]}
assert json.loads(manifest) == expected_manifest
assert all(type(row['size']) is int for row in json.loads(manifest)['entries'])

fresh_builds = []
for timestamp in (1, 2000000000):
    with tempfile.TemporaryDirectory(prefix='build-', dir=root) as folder:
        p = Path(folder)
        builder = p / 'build_capsule.py'
        builder.write_bytes((root / 'build_capsule.py').read_bytes())
        os.utime(builder, (timestamp, timestamp))
        subprocess.run([sys.executable, str(builder)], cwd=p, check=True, timeout=15)
        built_zip = (p / 'capsule.zip').read_bytes()
        built_manifest = (p / 'manifest.json').read_bytes()
        assert built_zip == archive and built_manifest == manifest
        fresh_builds.append(hashlib.sha256(built_zip).hexdigest())

results = []
def check(label, zip_bytes, manifest_bytes, should_pass):
    with tempfile.TemporaryDirectory(prefix='case-', dir=root) as folder:
        p = Path(folder)
        (p / 'verify_capsule.py').write_bytes((root / 'verify_capsule.py').read_bytes())
        (p / 'capsule.zip').write_bytes(zip_bytes)
        (p / 'manifest.json').write_bytes(manifest_bytes)
        r = subprocess.run([sys.executable, str(p / 'verify_capsule.py')], cwd=p,
                           capture_output=True, text=True, timeout=15)
        results.append({'case': label, 'expected_pass': should_pass, 'exit_code': r.returncode,
                        'matched': (r.returncode == 0) == should_pass,
                        'output': (r.stdout + r.stderr)[:1000]})

check('valid', archive, manifest, True)
damaged = bytearray(archive)
payload_start = 30 + struct.unpack_from('<H', damaged, 26)[0] + struct.unpack_from('<H', damaged, 28)[0]
damaged[payload_start] ^= 1
check('stored_payload_crc_mismatch', damaged, manifest, False)
bad = json.loads(manifest)
bad['entries'][-1]['size'] = False
check('boolean_instead_of_integer_size', archive, json.dumps(bad).encode(), False)
bad = json.loads(manifest)
bad['entries'][0]['sha256'] = '0' * 64
check('wrong_manifest_digest', archive, json.dumps(bad).encode(), False)
local_time = bytearray(archive)
struct.pack_into('<H', local_time, 10, 1)
check('local_header_timestamp_differs', local_time, manifest, False)
check('malformed_zip', b'not a zip', manifest, False)
for label, entries in [('extra_entry', expected + [('extra.txt', b'x')]),
                       ('missing_entry', expected[:-1]),
                       ('duplicate_entry', expected + [expected[0]])]:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for name, payload in entries:
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            z.writestr(info, payload)
    check(label, stream.getvalue(), manifest, False)
report = {'artifact_valid': True, 'archive_sha256': hashlib.sha256(archive).hexdigest(),
          'fresh_builds_sha256': fresh_builds,
          'expected_manifest': expected_manifest, 'verifier_cases': results}
(root / 'independent-audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
