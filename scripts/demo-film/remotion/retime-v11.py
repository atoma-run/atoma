"""Align every scene to its generated narration and a short breathing interval."""
import json
import math
from pathlib import Path

root = Path(__file__).resolve().parent
voice = json.loads((root / "public/voice-v11/voice.json").read_text())
timing = {}
start = 0
for key, entry in voice.items():
    tail = 1.5 if key == "closing" else 1.05
    frames = math.ceil((entry["seconds"] + 14 / 30 + tail) * 30)
    timing[key] = {"start": start, "frames": frames}
    start += frames
(root / "src/timing-v11.json").write_text(json.dumps(timing, indent=2) + "\n")
print(f"{start} frames, {start / 30:.2f} seconds")
