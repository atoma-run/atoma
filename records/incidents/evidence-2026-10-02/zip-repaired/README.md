# Museum capsule

This repository contains a reproducible ZIP capsule and its JSON manifest. The capsule has exactly three stored files in a fixed order:

1. `README.txt` — `Museum capsule v1\n`
2. `data/café.txt` — `Café — été\n`
3. `data/empty.bin` — empty

`manifest.json` has this shape:

```json
{"entries":[{"name":"string","size":0,"sha256":"lowercase hexadecimal SHA-256"}]}
```

The rows are in ZIP entry order. `size` is the UTF-8 byte count and `sha256` is the digest of the exact entry bytes.

## Regenerate

```sh
python3 build_capsule.py
```

This writes `capsule.zip` and `manifest.json` deterministically.

## Verify

```sh
python3 verify_capsule.py
```

Verification uses only the Python standard library and does not rebuild the protected artifacts. The verifier retains the fixed capsule contract: exactly three stored files in the stated order, with their exact bytes, names, metadata, timestamps, permissions, CRCs, empty comments and extras, and matching manifest digests. It also rejects missing, duplicate, or extra entries.

Manifest validation checks the complete JSON shape and field types explicitly; in particular, sizes must be integers and must not be Boolean values. Each local-file header is parsed with bounds checks and checked against the fixed contract and its central-directory record, including names, flags, stored compression, DOS timestamp, sizes, CRC, and empty extras.

## Negative tests on isolated copies

Each command below uses `tempfile.TemporaryDirectory` to copy the verifier and protected inputs into an isolated directory, asserts a nonzero verifier exit, and removes all temporary material automatically, including after an assertion failure. The repository files are not modified.

Boolean manifest size rejection:

```sh
python3 - <<'PY'
import json, pathlib, shutil, subprocess, sys, tempfile
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d)
    for name in ("verify_capsule.py", "capsule.zip", "manifest.json"):
        shutil.copy2(name, root / name)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["entries"][2]["size"] = False
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    result = subprocess.run([sys.executable, "verify_capsule.py"], cwd=root, capture_output=True, text=True)
    assert result.returncode != 0, result.stdout
PY
```

Altered first local-header DOS modification time rejection:

```sh
python3 - <<'PY'
import pathlib, shutil, subprocess, sys, tempfile
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d)
    for name in ("verify_capsule.py", "capsule.zip", "manifest.json"):
        shutil.copy2(name, root / name)
    raw = bytearray((root / "capsule.zip").read_bytes())
    raw[10:12] = (1).to_bytes(2, "little")
    (root / "capsule.zip").write_bytes(raw)
    result = subprocess.run([sys.executable, "verify_capsule.py"], cwd=root, capture_output=True, text=True)
    assert result.returncode != 0, result.stdout
PY
```

Stored-payload corruption rejection:

```sh
python3 - <<'PY'
import pathlib, shutil, subprocess, sys, tempfile
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d)
    for name in ("verify_capsule.py", "capsule.zip", "manifest.json"):
        shutil.copy2(name, root / name)
    raw = bytearray((root / "capsule.zip").read_bytes())
    needle = b"Museum capsule v1\n"
    position = raw.index(needle)
    raw[position] ^= 1
    (root / "capsule.zip").write_bytes(raw)
    result = subprocess.run([sys.executable, "verify_capsule.py"], cwd=root, capture_output=True, text=True)
    assert result.returncode != 0, result.stdout
PY
```
