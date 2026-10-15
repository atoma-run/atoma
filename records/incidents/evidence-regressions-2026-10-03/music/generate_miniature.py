#!/usr/bin/env python3
"""Generate an original eight-bar, two-voice MIDI miniature and matching CSV."""
import csv
import struct

TPQ = 480
TOTAL = 15360
TEMPO_US = 500000
MELODY = [60, 62, 64, 65, 67, 65, 64, 62,
          64, 65, 67, 69, 71, 69, 67, 65,
          67, 69, 71, 72, 74, 72, 71, 69,
          67, 65, 64, 62, 60, 67, 69, 72]
BASS = [48, 53, 55, 48, 45, 53, 55, 48]
VELOCITY = 88
BASS_VELOCITY = 70

def vlq(value):
    if value == 0:
        return b"\x00"
    out = bytearray()
    while value:
        out.append(value & 0x7f)
        value >>= 7
    out.reverse()
    for i in range(len(out) - 1):
        out[i] |= 0x80
    return bytes(out)

def meta_track():
    data = bytearray()
    data += vlq(0) + b"\xff\x51\x03" + TEMPO_US.to_bytes(3, "big")
    data += vlq(0) + b"\xff\x58\x04\x04\x02\x18\x08"
    data += vlq(TOTAL) + b"\xff\x2f\x00"
    return bytes(data)

def note_track(notes, channel, duration):
    data = bytearray()
    current_tick = 0
    for pitch, start in notes:
        data += vlq(start - current_tick) + bytes((0x90 | channel, pitch, VELOCITY if channel == 0 else BASS_VELOCITY))
        current_tick = start
        data += vlq(duration) + bytes((0x80 | channel, pitch, 0))
        current_tick += duration
    data += vlq(TOTAL - current_tick) + b"\xff\x2f\x00"
    return bytes(data)

def track_chunk(data):
    return b"MTrk" + struct.pack(">I", len(data)) + data

def main():
    melody_notes = [(pitch, i * TPQ) for i, pitch in enumerate(MELODY)]
    bass_notes = [(pitch, i * 4 * TPQ) for i, pitch in enumerate(BASS)]
    with open("miniature.mid", "wb") as midi:
        midi.write(b"MThd" + struct.pack(">IHHH", 6, 1, 3, TPQ))
        midi.write(track_chunk(meta_track()))
        midi.write(track_chunk(note_track(melody_notes, 0, TPQ)))
        midi.write(track_chunk(note_track(bass_notes, 1, 4 * TPQ)))
    with open("score.csv", "w", newline="") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["voice", "start_tick", "duration_ticks", "pitch", "velocity"])
        for pitch, start in melody_notes:
            writer.writerow(["melody", start, TPQ, pitch, VELOCITY])
        for pitch, start in bass_notes:
            writer.writerow(["bass", start, 4 * TPQ, pitch, BASS_VELOCITY])

if __name__ == "__main__":
    main()
