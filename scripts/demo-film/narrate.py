"""Synthesise the demo film's narration, one WAV per line.

    python scripts/demo-film/narrate.py <out-dir>

Reads narration.json beside this file and speaks every line with edge-tts
(Microsoft's neural voices; only the narration text leaves the machine), at
the voice's natural rate. Breathing is added, not slowness: each sentence is
synthesised on its own, trimmed of the engine's silence, and the sentences of
a line are joined by `sentencePause` seconds. The pause BETWEEN lines is the
compositor's (`linePause`). Writes <out-dir>/voice.json with every line's
duration; a line whose settings and text are unchanged is not spoken again.
ffmpeg comes from $FFMPEG or PATH.
"""

import array
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import wave

import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
RATE = 24000
THRESHOLD = 300  # 16-bit amplitude under which the engine's padding counts as silence
MARGIN = int(0.03 * RATE)


def read_pcm(path):
    with wave.open(path) as handle:
        samples = array.array("h")
        samples.frombytes(handle.readframes(handle.getnframes()))
        return samples


def trimmed(samples):
    loud = [i for i in range(len(samples)) if abs(samples[i]) > THRESHOLD]
    if not loud:
        return samples
    return samples[max(0, loud[0] - MARGIN):min(len(samples), loud[-1] + MARGIN)]


async def speak(text, voice, rate, stem):
    mp3, wav = stem + ".mp3", stem + ".wav"
    await edge_tts.Communicate(text, voice, rate=rate).save(mp3)
    subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", mp3, "-ac", "1", "-ar", str(RATE), wav], check=True)
    os.remove(mp3)
    samples = trimmed(read_pcm(wav))
    os.remove(wav)
    return samples


async def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(HERE, "narration.json"), encoding="utf-8") as handle:
        script = json.load(handle)
    pause = array.array("h", [0]) * int(script["sentencePause"] * RATE)
    edge = array.array("h", [0]) * int(0.05 * RATE)
    index_path = os.path.join(out_dir, "voice.json")
    previous = {}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as handle:
            previous = json.load(handle)
    index = {}
    for line_id, line in script["lines"].items():
        settings = f"{script['voice']}|{script['rate']}|{script['sentencePause']}|{line['say']}"
        key = hashlib.sha256(settings.encode()).hexdigest()[:16]
        path = os.path.join(out_dir, f"{line_id}.wav")
        if previous.get(line_id, {}).get("key") != key or not os.path.exists(path):
            sentences = [part for part in re.split(r"(?<=[.!?])\s+", line["say"].strip()) if part]
            joined = array.array("h", edge)
            for number, sentence in enumerate(sentences):
                if number:
                    joined.extend(pause)
                joined.extend(await speak(sentence, script["voice"], script["rate"], os.path.join(out_dir, f"{line_id}-{number}")))
            joined.extend(edge)
            with wave.open(path, "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(RATE)
                handle.writeframes(joined.tobytes())
            print(f"spoke {line_id} ({len(sentences)} sentences)")
        with wave.open(path) as handle:
            seconds = handle.getnframes() / handle.getframerate()
        index[line_id] = {"key": key, "seconds": round(seconds, 3), "file": f"{line_id}.wav"}
    with open(index_path, "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=2)
    total = sum(entry["seconds"] for entry in index.values())
    print(f"{len(index)} lines, {total:.1f} s of speech")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "screenshots/demo-film/voice"))
