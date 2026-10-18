"""Build-time only: download the reviewed model lock, verify bytes, retain licenses."""
import hashlib
import json
from pathlib import Path
import shutil
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "docker/compute-models.lock.json").read_text())
OUT = ROOT / "dist/compute-model-downloads"
for model in LOCK["models"]:
    destination = OUT / model["kind"]
    destination.mkdir(parents=True, exist_ok=True)
    for entry in model["files"]:
        target = destination / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size == entry["size"]:
            with target.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() == entry["sha256"]:
                    continue
        url = f'https://huggingface.co/{model["repository"]}/resolve/{model["revision"]}/{entry["path"]}'
        temporary = target.with_name(target.name + ".partial")
        for attempt in range(3):
            try:
                digest = hashlib.sha256()
                total = 0
                with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > entry["size"]:
                            raise ValueError("Model download exceeds pinned size")
                        digest.update(chunk)
                        output.write(chunk)
                if total != entry["size"] or digest.hexdigest() != entry["sha256"]:
                    raise ValueError("Model download differs from reviewed lock")
                temporary.replace(target)
                break
            except Exception:
                temporary.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        print(f'Verified {model["kind"]}/{entry["path"]}', flush=True)
    shutil.copyfile(ROOT / f'docker/model-licenses/{model["kind"]}-LICENSE', destination / "LICENSE")
    (destination / "atoma-provenance.json").write_text(json.dumps({
        "repository": model["repository"], "revision": model["revision"],
        "license": model["license"], "weightsModified": False,
    }, indent=2) + "\n")
