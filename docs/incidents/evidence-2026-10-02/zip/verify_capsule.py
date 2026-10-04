#!/usr/bin/env python3
"""Independently verify the museum capsule and its manifest."""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

EXPECTED = (
    ("README.txt", b"Museum capsule v1\n"),
    ("data/café.txt", "Café — été\n".encode("utf-8")),
    ("data/empty.bin", b""),
)


def fail(message):
    raise ValueError(message)


def verify_archive(path):
    try:
        with zipfile.ZipFile(path, "r") as archive:
            if archive.comment != b"":
                fail("archive comment is not empty")
            infos = archive.infolist()
            if len(infos) != len(EXPECTED):
                fail("wrong entry count")
            for index, ((expected_name, expected_payload), info) in enumerate(
                zip(EXPECTED, infos)
            ):
                if info.filename != expected_name:
                    fail(f"entry {index} has wrong name")
                if info.is_dir() or info.filename.endswith("/"):
                    fail("directory entry is not allowed")
                if info.compress_type != zipfile.ZIP_STORED:
                    fail("entry is compressed")
                if info.date_time != (1980, 1, 1, 0, 0, 0):
                    fail("wrong timestamp")
                if info.create_system != 3:
                    fail("wrong creator system")
                if info.create_version != 20 or info.extract_version != 20:
                    fail("wrong ZIP version fields")
                if info.external_attr >> 16 != 0o100644:
                    fail("wrong external attributes")
                if info.extra != b"" or info.comment != b"":
                    fail("entry extra fields or comment are not empty")
                expected_flags = 0x800 if any(ord(character) > 127 for character in expected_name) else 0
                if info.flag_bits != expected_flags:
                    fail("wrong filename flags")
                if info.file_size != len(expected_payload):
                    fail("wrong uncompressed size")
                if info.compress_size != len(expected_payload):
                    fail("wrong stored size")
                payload = archive.read(info)
                if payload != expected_payload:
                    fail("payload mismatch")
                if info.CRC != zipfile.crc32(expected_payload) & 0xFFFFFFFF:
                    fail("CRC mismatch")
    except (
        OSError,
        zipfile.BadZipFile,
        KeyError,
        RuntimeError,
        ValueError,
        EOFError,
        UnicodeError,
        IndexError,
    ) as exc:
        fail(f"malformed ZIP: {exc}")


def verify_manifest(path):
    try:
        with path.open("r", encoding="utf-8") as stream:
            manifest = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"malformed manifest: {exc}")
    expected_rows = [
        {"name": name, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        for name, payload in EXPECTED
    ]
    if manifest != {"entries": expected_rows}:
        fail("manifest mismatch")


def main():
    root = Path(__file__).resolve().parent
    try:
        verify_archive(root / "capsule.zip")
        verify_manifest(root / "manifest.json")
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    print("OK: capsule.zip and manifest.json verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
