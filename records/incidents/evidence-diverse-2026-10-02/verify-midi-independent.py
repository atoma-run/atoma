"""Independent audit of the published experiment, not the run's verifier."""
import csv
import json
import struct
import sys
from pathlib import Path

root = Path(sys.argv[1])
raw = (root / 'miniature.mid').read_bytes()
assert raw[:4] == b'MThd'
header_size = int.from_bytes(raw[4:8], 'big')
fmt, track_count, division = struct.unpack('>HHH', raw[8:14])
assert header_size == 6 and fmt in (0, 1) and division == 480
pos = 8 + header_size
notes, tempos, meters, ends = [], [], [], []

for track in range(track_count):
    assert raw[pos:pos+4] == b'MTrk'
    length = int.from_bytes(raw[pos+4:pos+8], 'big')
    data = raw[pos+8:pos+8+length]
    assert len(data) == length
    pos += 8 + length
    i, tick, running = 0, 0, None
    active = {}
    track_notes = 0
    ended = False

    def vlq():
        global i
        value = 0
        for _ in range(4):
            b = data[i]
            i += 1
            value = (value << 7) | (b & 127)
            if b < 128:
                return value
        raise AssertionError('invalid VLQ')

    while i < len(data):
        tick += vlq()
        status = data[i]
        if status >= 128:
            i += 1
            if status < 240:
                running = status
        else:
            assert running is not None
            status = running
        if status == 255:
            kind = data[i]
            i += 1
            size = vlq()
            payload = data[i:i+size]
            assert len(payload) == size
            i += size
            if kind == 81:
                tempos.append((tick, int.from_bytes(payload, 'big')))
            if kind == 88:
                meters.append((tick, list(payload)))
            if kind == 47:
                assert size == 0 and not active and i == len(data)
                ended = True
                break
        elif status in (240, 247):
            size = vlq()
            i += size
        else:
            assert 128 <= status < 240
            kind, channel = status >> 4, status & 15
            size = 1 if kind in (12, 13) else 2
            args = data[i:i+size]
            assert len(args) == size and all(v < 128 for v in args)
            i += size
            if kind in (8, 9):
                pitch, velocity = args
                key = (channel, pitch)
                if kind == 9 and velocity > 0:
                    assert key not in active
                    active[key] = (tick, velocity)
                else:
                    start, vel = active.pop(key)
                    notes.append((channel, start, tick-start, pitch, vel))
                    track_notes += 1
    assert ended and not active
    if track_notes:
        assert tick == 15360
    ends.append(tick)

assert pos == len(raw) and max(ends) == 15360
assert tempos and all(t == 500000 for _, t in tempos) and tempos[0][0] == 0
assert meters and all(m[:2] == [4, 2] for _, m in meters) and meters[0][0] == 0
melody = sorted(n for n in notes if 60 <= n[3] <= 79)
bass = sorted(n for n in notes if 36 <= n[3] <= 55)
assert len(notes) == 40 and len(melody) == 32 and len(bass) == 8
assert len({n[0] for n in melody}) == len({n[0] for n in bass}) == 1
assert melody[0][0] != bass[0][0]
assert [n[1] for n in melody] == list(range(0, 15360, 480))
assert [n[1] for n in bass] == list(range(0, 15360, 1920))
assert all(n[2] == 480 and n[3] % 12 in (0, 2, 4, 5, 7, 9, 11) for n in melody)
assert all(n[2] == 1920 for n in bass)
assert [n[3] % 12 for n in bass] == [0, 5, 7, 0, 9, 5, 7, 0]
assert melody[-1][3] == 72
assert all(abs(a[3]-b[3]) <= 7 for a, b in zip(melody, melody[1:]))
with (root / 'score.csv').open(newline='', encoding='utf-8') as handle:
    reader = csv.DictReader(handle)
    assert reader.fieldnames == ['voice', 'start_tick', 'duration_ticks', 'pitch', 'velocity']
    rows = list(reader)
for voice, sequence in [('melody', melody), ('bass', bass)]:
    actual = sorted(tuple(int(r[k]) for k in reader.fieldnames[1:]) for r in rows if r['voice'].lower() == voice)
    assert actual == sorted(n[1:] for n in sequence), voice
assert len(rows) == 40
print(json.dumps({'format': fmt, 'tracks': track_count, 'end_ticks': ends,
                  'notes': len(notes), 'melody': 32, 'bass': 8, 'csv_matches': True}))
