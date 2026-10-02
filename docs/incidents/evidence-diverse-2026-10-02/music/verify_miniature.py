#!/usr/bin/env python3
"""Independently verify miniature.mid and score.csv using only the standard library."""
import csv
import struct
import sys

TPQ = 480
TOTAL = 15360
TEMPO_US = 500000
MELODY_CHANNEL = 0
BASS_CHANNEL = 1
EXPECTED_BASS_CLASSES = [0, 5, 7, 0, 9, 5, 7, 0]
CSV_HEADER = ["voice", "start_tick", "duration_ticks", "pitch", "velocity"]

def read_vlq(data, pos):
    value = 0
    for _ in range(4):
        if pos >= len(data):
            raise ValueError("truncated variable-length quantity")
        byte = data[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7f)
        if not byte & 0x80:
            return value, pos
    raise ValueError("overlong variable-length quantity")

def parse_midi(path):
    raw = open(path, "rb").read()
    if raw[:4] != b"MThd" or len(raw) < 14:
        raise AssertionError("invalid MIDI header")
    header_len, fmt, tracks, division = struct.unpack(">IHHH", raw[4:14])
    assert header_len == 6 and fmt == 1 and tracks == 3
    assert division == TPQ
    pos = 14
    parsed = []
    for track_index in range(tracks):
        assert raw[pos:pos + 4] == b"MTrk"
        length = struct.unpack(">I", raw[pos + 4:pos + 8])[0]
        data = raw[pos + 8:pos + 8 + length]
        assert len(data) == length
        pos += 8 + length
        tick = 0
        cursor = 0
        running = None
        active = {}
        notes = []
        tempo = []
        signature = []
        eot_tick = None
        while cursor < len(data):
            delta, cursor = read_vlq(data, cursor)
            tick += delta
            first = data[cursor]
            if first < 0x80:
                assert running is not None
                status = running
            else:
                status = first
                cursor += 1
                if status < 0xf0:
                    running = status
            if status == 0xff:
                kind = data[cursor]
                cursor += 1
                size, cursor = read_vlq(data, cursor)
                payload = data[cursor:cursor + size]
                assert len(payload) == size
                cursor += size
                if kind == 0x51:
                    tempo.append((tick, payload))
                elif kind == 0x58:
                    signature.append((tick, payload))
                elif kind == 0x2f:
                    assert size == 0
                    eot_tick = tick
                    assert cursor == len(data)
            elif status in (0xf0, 0xf7):
                size, cursor = read_vlq(data, cursor)
                cursor += size
            else:
                event_type = status & 0xf0
                needed = 1 if event_type == 0xc0 or event_type == 0xd0 else 2
                values = data[cursor:cursor + needed]
                assert len(values) == needed
                cursor += needed
                if event_type in (0x80, 0x90):
                    pitch = values[0]
                    velocity = values[1]
                    key = (status & 0x0f, pitch)
                    if event_type == 0x90 and velocity:
                        assert key not in active
                        active[key] = (tick, velocity)
                    else:
                        assert key in active
                        start, on_velocity = active.pop(key)
                        notes.append({"channel": key[0], "start_tick": start, "duration_ticks": tick - start, "pitch": pitch, "velocity": on_velocity})
        assert not active
        assert eot_tick == TOTAL
        parsed.append((notes, tempo, signature, eot_tick))
    assert pos == len(raw)
    return parsed

def load_score(path):
    with open(path, newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert list(rows[0].keys()) == CSV_HEADER if rows else False
    result = []
    for row in rows:
        assert row["voice"] in ("melody", "bass")
        result.append({"voice": row["voice"], "start_tick": int(row["start_tick"]), "duration_ticks": int(row["duration_ticks"]), "pitch": int(row["pitch"]), "velocity": int(row["velocity"])})
    return result

def main():
    tracks = parse_midi("miniature.mid")
    assert tracks[0][1] == [(0, TEMPO_US.to_bytes(3, "big"))]
    assert tracks[0][2] == [(0, b"\x04\x02\x18\x08")]
    melody = [n for n in tracks[1][0] if n["channel"] == MELODY_CHANNEL]
    bass = [n for n in tracks[2][0] if n["channel"] == BASS_CHANNEL]
    assert len(melody) == 32 and len(bass) == 8
    assert {n["channel"] for n in melody}.isdisjoint({n["channel"] for n in bass})
    assert all(n["duration_ticks"] == TPQ for n in melody)
    assert all(n["duration_ticks"] == 4 * TPQ for n in bass)
    assert all(60 <= n["pitch"] <= 79 and n["pitch"] % 12 in {0, 2, 4, 5, 7, 9, 11} for n in melody)
    assert all(abs(b["pitch"] - a["pitch"]) <= 7 for a, b in zip(melody, melody[1:]))
    assert melody[-1]["pitch"] == 72
    assert all(36 <= n["pitch"] <= 55 for n in bass)
    assert [n["pitch"] % 12 for n in bass] == EXPECTED_BASS_CLASSES
    assert [n["start_tick"] for n in melody] == [i * TPQ for i in range(32)]
    assert [n["start_tick"] for n in bass] == [i * 4 * TPQ for i in range(8)]
    score = load_score("score.csv")
    expected = [{"voice": "melody" if n["channel"] == MELODY_CHANNEL else "bass", "start_tick": n["start_tick"], "duration_ticks": n["duration_ticks"], "pitch": n["pitch"], "velocity": n["velocity"]} for track in tracks[1:] for n in track[0]]
    assert score == expected
    print("OK: MIDI and CSV satisfy all miniature constraints")

if __name__ == "__main__":
    try:
        main()
    except (AssertionError, ValueError, OSError, struct.error) as exc:
        print("FAIL:", exc)
        sys.exit(1)
