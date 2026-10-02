# Eight-Bar C-Major Miniature

## Musical design

This original miniature is an eight-bar, two-voice study in C major. The meter is 4/4, the tempo is 120 BPM, and the pulse resolution is 480 ticks per quarter note. There are 32 quarter-note beats: `32 * 480 = 15360` ticks.

The melody has one quarter note per beat (32 notes). Its contour begins with a rising C-major scale fragment, rises again through the middle register, reaches MIDI 74, then descends and turns upward into the final MIDI 72 (middle C). The pitches are MIDI 60..79 and use only C-major pitch classes; adjacent notes move by no more than seven semitones. The repeated stepwise motion and the final return to C give the line a clear arrival without asserting that these mechanical properties alone make it aesthetically successful.

The bass sustains one whole-bar note per bar (eight notes), creating this harmonic/bar progression:

| Bars | Bass pitch | Harmonic role |
|---|---:|---|
| 1 | C3 (48) | C tonic |
| 2 | F3 (53) | IV / predominant |
| 3 | G3 (55) | V / dominant |
| 4 | C3 (48) | tonic arrival |
| 5 | A2 (45) | vi, a contrasting minor-color region |
| 6 | F3 (53) | IV / predominant |
| 7 | G3 (55) | V / dominant |
| 8 | C3 (48) | final tonic cadence |

Thus the second G-to-C motion supplies the closing cadence, while the final melody note is C4 (MIDI 72). The melody occupies a higher register than the bass (MIDI 60..79 versus MIDI 36..55), and their distinct registers plus sustained-versus-quarter-note rhythms keep the voices separate. Melody velocity is 88; bass velocity is 70.

## MIDI organization and timing

`miniature.mid` is a format-1 Standard MIDI File with division 480 and three tracks:

1. Track 0 is the metadata track. At tick 0 it contains tempo `500000` microseconds per quarter note (120 BPM) and the 4/4 time signature (`04 02 18 08`). Its end-of-track event is at tick 15360.
2. Track 1 is the melody voice on MIDI channel 0 (the first, conventionally displayed as channel 1). It contains 32 note-on/note-off pairs, each 480 ticks long, starting at ticks 0, 480, ... 14880, and ends at tick 15360.
3. Track 2 is the bass voice on MIDI channel 1 (the second, conventionally displayed as channel 2). It contains 8 note-on/note-off pairs, each 1920 ticks long, starting every four beats, and ends at tick 15360.

The two voices therefore use distinct MIDI channels. A 15360-tick track duration is exactly 32 quarter-note beats at 480 ticks per quarter; it is also eight 4/4 bars. The tempo event makes those beats 120 per minute.

## CSV-to-MIDI mapping

`score.csv` has the columns `voice,start_tick,duration_ticks,pitch,velocity`. Each melody row maps to one channel-0 MIDI note with the same start tick, duration, pitch, and velocity; each bass row maps to one channel-1 MIDI note in the same way. Rows are emitted in track order: the 32 melody rows, followed by the 8 bass rows. Melody durations are 480 ticks and bass durations are 1920 ticks, so the CSV is a human-readable transcription of the note events rather than a separate interpretation.

## Generation and verification

`generate_miniature.py` creates both deliverables using only Python's standard library (`csv` and `struct`); no external packages are required. Regenerate them with:

```text
python3 generate_miniature.py
```

`verify_miniature.py` independently parses the binary MIDI using standard-library code, including variable-length quantities, running status, note-on velocity zero, note pairing, metadata, timing, voice constraints, and exact CSV equality. Run it with:

```text
python3 verify_miniature.py
```

The verifier's rule checks establish structural and data agreement; they do not by themselves prove aesthetic quality.

## Deliverable entry points

- Outputs: `miniature.mid` and `score.csv`
- Regenerate: `python3 generate_miniature.py`
- Verify: `python3 verify_miniature.py`
