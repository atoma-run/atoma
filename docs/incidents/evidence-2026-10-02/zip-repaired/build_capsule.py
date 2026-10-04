#!/usr/bin/env python3
"""Build the deterministic museum capsule and its manifest."""

import hashlib
import json
import zipfile
from pathlib import Path

FILES = (
    ("README.txt", "Museum capsule v1\n".encode("utf-8")),
    ("data/café.txt", "Café — été\n".encode("utf-8")),
    ("data/empty.bin", b""),
)


def build_archive(path):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.comment = b""
        for name, payload in FILES:
            info = zipfile.ZipInfo(filename=name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.create_version = 20
            info.extract_version = 20
            info.flag_bits = 0x800
            info.external_attr = 0o100644 << 16
            info.extra = b""
            info.comment = b""
            archive.writestr(info, payload)


def build_manifest(path):
    manifest = {
        "entries": [
            {
                "name": name,
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            for name, payload in FILES
        ]
    }
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def main():
    root = Path(__file__).resolve().parent
    build_archive(root / "capsule.zip")
    build_manifest(root / "manifest.json")


if __name__ == "__main__":
    main()
