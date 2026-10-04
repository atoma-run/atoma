#!/usr/bin/env python3
"""Independently verify the museum capsule and its manifest."""

import hashlib
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

EXPECTED = (
    ("README.txt", b"Museum capsule v1\n"),
    ("data/café.txt", "Café — été\n".encode("utf-8")),
    ("data/empty.bin", b""),
)
LOCAL_HEADER = struct.Struct("<IHHHHHIIIHH")
LOCAL_SIGNATURE = 0x04034B50
EXPECTED_DOS_TIME = 0
EXPECTED_DOS_DATE = 0x21
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


def fail(message):
    raise ValueError(message)


def expected_flags(name):
    return 0x800 if any(ord(character) > 127 for character in name) else 0


def check_local_header(raw, info, name, payload):
    offset = info.header_offset
    if offset < 0 or offset + LOCAL_HEADER.size > len(raw):
        fail("truncated local header")
    fields = LOCAL_HEADER.unpack_from(raw, offset)
    signature, version, flags, compression, mod_time, mod_date, crc, csize, usize, name_len, extra_len = fields
    if signature != LOCAL_SIGNATURE:
        fail("wrong local header signature")
    end = offset + LOCAL_HEADER.size + name_len + extra_len
    if end > len(raw):
        fail("truncated local header fields")
    name_bytes = raw[offset + LOCAL_HEADER.size:offset + LOCAL_HEADER.size + name_len]
    extra = raw[offset + LOCAL_HEADER.size + name_len:end]
    if name_bytes != name.encode("utf-8") or name_bytes != info.orig_filename.encode("utf-8"):
        fail("wrong local filename")
    if extra or info.extra:
        fail("local or central extra fields are not empty")
    if version != 20 or flags != expected_flags(name) or compression != zipfile.ZIP_STORED:
        fail("wrong local metadata")
    if mod_time != EXPECTED_DOS_TIME or mod_date != EXPECTED_DOS_DATE:
        fail("wrong local timestamp")
    if crc != info.CRC or csize != info.compress_size or usize != info.file_size:
        fail("local sizes or CRC disagree with central directory")
    data_end = end + csize
    if data_end > len(raw):
        fail("truncated local payload")
    if csize != len(payload) or usize != len(payload):
        fail("local data size is wrong")


def verify_archive(path):
    try:
        raw = path.read_bytes()
        with zipfile.ZipFile(path, "r") as archive:
            if archive.comment != b"":
                fail("archive comment is not empty")
            infos = archive.infolist()
            if len(infos) != len(EXPECTED):
                fail("wrong entry count")
            for index, ((name, expected_payload), info) in enumerate(zip(EXPECTED, infos)):
                if info.filename != name or info.is_dir() or info.filename.endswith("/"):
                    fail(f"entry {index} has wrong name or type")
                if info.compress_type != zipfile.ZIP_STORED or info.date_time != (1980, 1, 1, 0, 0, 0):
                    fail("wrong central compression or timestamp")
                if info.create_system != 3 or info.create_version != 20 or info.extract_version != 20:
                    fail("wrong central creator or version")
                if info.external_attr >> 16 != 0o100644:
                    fail("wrong external attributes")
                if info.extra != b"" or info.comment != b"" or info.flag_bits != expected_flags(name):
                    fail("wrong central flags, extra fields, or comment")
                if info.file_size != len(expected_payload) or info.compress_size != len(expected_payload):
                    fail("wrong central sizes")
                check_local_header(raw, info, name, expected_payload)
                payload = archive.read(info)
                if payload != expected_payload:
                    fail("payload mismatch")
                if info.CRC != zipfile.crc32(expected_payload) & 0xFFFFFFFF:
                    fail("CRC mismatch")
    except (OSError, zipfile.BadZipFile, KeyError, RuntimeError, ValueError, EOFError, UnicodeError, IndexError, struct.error) as exc:
        fail(f"malformed ZIP: {exc}")


def verify_manifest(path):
    try:
        with path.open("r", encoding="utf-8") as stream:
            manifest = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"malformed manifest: {exc}")
    if not isinstance(manifest, dict) or set(manifest) != {"entries"} or not isinstance(manifest["entries"], list):
        fail("manifest has wrong shape")
    entries = manifest["entries"]
    if len(entries) != len(EXPECTED):
        fail("manifest has wrong entry count")
    for index, ((name, payload), row) in enumerate(zip(EXPECTED, entries)):
        if not isinstance(row, dict) or set(row) != {"name", "size", "sha256"}:
            fail(f"manifest row {index} has wrong shape")
        if not isinstance(row["name"], str) or not isinstance(row["size"], int) or isinstance(row["size"], bool):
            fail(f"manifest row {index} has wrong name or size type")
        if not isinstance(row["sha256"], str) or SHA256_RE.fullmatch(row["sha256"]) is None:
            fail(f"manifest row {index} has wrong digest type")
        expected = {"name": name, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        if row != expected:
            fail(f"manifest row {index} mismatch")


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
