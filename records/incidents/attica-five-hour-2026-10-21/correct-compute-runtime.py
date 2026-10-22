"""Add a guarded device runtime override; preserve the legacy default. Dry-run by default."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import stat
import tempfile

LEGACY_KEY = "ATOMA_COMPUTE_HAYSTACK_CONFIG"
KEY = "ATOMA_COMPUTE_HAYSTACK_CONFIG_BY_DEVICE"
DEVICE = "9bafcb10-327f-477d-ac4a-82ec1fade218"
WORKER = "sha256:7f2cda61d07c145dbf1beaf804153b1047b0ce6e2d41037d48fcf3a92710dc7e"
OLD = "7a8803e1a36e2ccbe9a02e9b0c984de0a6d9fa168e522f24b6c9bfb018840c38"
NEW = "eaf4e66093d9f7f34b1faa0b340e19fd6107331c5151d578392ff6fb9ab3d422"
MODELS = {
    "embeddingRevision": "8481cae14ea3d37144274e82b407060d198aceaa31141955aa3794bcff0002be",
    "rerankerRevision": "b4ef9bdd2c8d5e81541448743fe6392d378b7fc7b4f8d83db5ed9c34486b650d",
}


def environment_value(lines, key, required=True):
    matches = [line for line in lines
               if re.match(r"\s*(?:export\s+)?" + key + r"\s*=", line)]
    if len(matches) > 1 or (required and not matches):
        raise ValueError("Expected exactly one active setting: " + key)
    if not matches:
        return None
    raw = matches[0].split("=", 1)[1].strip()
    if raw[:1] in ("'", '"'):
        if raw[-1:] != raw[:1]:
            raise ValueError("Unmatched environment quote")
        raw = raw[1:-1]
    return raw


def proposed_bytes(original):
    lines = original.decode("utf-8").splitlines(keepends=True)
    config = json.loads(environment_value(lines, LEGACY_KEY))
    settings = config.get("settings", {})
    if config.get("runtimeSha256") != OLD:
        raise ValueError("Legacy runtime changed; refusing this incident repair")
    if settings.get("mode") != "hybrid-rerank" or any(settings.get(k) != v for k, v in MODELS.items()):
        raise ValueError("Model identity changed; refusing this incident repair")
    admitted = environment_value(lines, "ATOMA_COMPUTE_IMAGE_DIGESTS")
    if WORKER not in [value.strip() for value in admitted.split(",")]:
        raise ValueError("The observed worker image is no longer admitted")
    selected = {**config, "runtimeSha256": NEW}
    expected = {DEVICE: selected}
    existing = environment_value(lines, KEY, required=False)
    if existing is not None:
        if json.loads(existing) == expected:
            return original
        raise ValueError("An existing device map needs a separately reviewed merge")
    encoded = json.dumps(expected, separators=(",", ":"), ensure_ascii=True)
    if "'" in encoded:
        raise ValueError("Configuration cannot be safely single-quoted")
    newline = b"\r\n" if b"\r\n" in original else b"\n"
    separator = b"" if original.endswith(b"\n") else newline
    # Preserve the full legacy file, including every other client's setting.
    return original + separator + (KEY + "='" + encoded + "'").encode("utf-8") + newline


def repair(target, apply=False):
    before = target.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("Environment target must be a regular file")
    original = target.read_bytes()
    proposed = proposed_bytes(original)
    if proposed == original:
        return {"changed": False, "deviceId": DEVICE, "runtimeSha256": NEW, "legacyRuntimeUnchanged": OLD}
    if not apply:
        return {"dryRun": True, "setting": KEY, "deviceId": DEVICE, "overrideRuntime": NEW, "legacyRuntimeUnchanged": OLD}
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = target.with_name(target.name + ".attica-runtime-" + stamp + ".bak")
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor, temporary_name = tempfile.mkstemp(prefix=".attica-runtime-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(before.st_mode))
            os.fchown(stream.fileno(), before.st_uid, before.st_gid)
            stream.write(proposed)
            stream.flush()
            os.fsync(stream.fileno())
        current = target.lstat()
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_uid", "st_gid")
        if any(getattr(current, k) != getattr(before, k) for k in fields) or target.read_bytes() != original:
            raise ValueError("Environment changed concurrently; refusing replacement")
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        if target.read_bytes() != proposed:
            raise ValueError("Replacement verification failed")
        return {"changed": True, "setting": KEY, "deviceId": DEVICE, "runtimeSha256": NEW, "legacyRuntimeUnchanged": OLD, "privateBackup": str(backup)}
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    arguments = parser.parse_args()
    if arguments.apply and os.geteuid() != 0:
        raise SystemExit("Applying requires the root configuration owner")
    print(json.dumps(repair(Path("/home/atoma/config/atoma.env"), arguments.apply)))
