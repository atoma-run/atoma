"""Offline checks of archived deliveries; never a product acceptance gate."""
import itertools
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent
words = {f"{a}{b}{c}": f"{a}{b}{c}{a ^ b}{b ^ c}{a ^ c}{a ^ b ^ c}"
         for a, b, c in itertools.product((0, 1), repeat=3)}

def record(name):
    return json.loads((root / f"{name}.json").read_text(encoding="utf-8"))

for name in ("fixed-code", "coverage-code"):
    body = record(name)["metadata"]["result"]["output"]
    assert dict(re.findall(r"(?m)^\| ([01]{3}) \| ([01]{7}) \|$", body)) == words
    rows = re.findall(r"(?m)^\| ([01]{3}) \| ([01]{7}) \| (\d+) \|$", body)
    assert len(rows) == 24
    for received, offset in zip(("1111100", "1110100", "0111010"), (0, 8, 16)):
        for data, word, distance in rows[offset:offset+8]:
            assert word == words[data]
            assert int(distance) == sum(a != b for a, b in zip(received, word))
    if name == "coverage-code":
        assert "Hamming distance is the number of differing coordinates" in body
        assert "only a nearest-neighbor guess, not a guaranteed correction" in body

history = record("fixed-history")
answer = history["metadata"]["result"]["output"]
assert "{011}" in answer and "distance 0" in answer
assert "positions 1, 2, 3, and 7" in answer and "distance is 4" in answer
planning = [e for e in history["events"] if e.get("role") == "plan"]
assert planning and all("previousRunResults" in e["userContent"] for e in planning)
assert all("2ff3b86f-66b2-4b7b-be0a-d5b81bac81e1" in e["userContent"] for e in planning)
assert all("ce1c7dbe-eafa-41a4-ada4-5c3ffd9e1b10" in e["userContent"] for e in planning)
assert all("c7fce1a1-2a46-4661-b366-6181bd3da760" not in e["userContent"] for e in planning)
timing = record("fixed-time")["metadata"]["result"]["output"]
expected = [(0, b, c, d, d+2) for b in range(2, 5) for c in range(3, 6)
            for d in range(0, 6) if 2 <= d-b <= 3 and 1 <= d-c <= 2]
assert [tuple(t) for t in timing["enumeration"]["feasible_tuples"]] == expected
for index, event in enumerate("ABCDE"):
    assert timing["tight_intervals"][event] == f"[{min(t[index] for t in expected)},{max(t[index] for t in expected)}]"
for key, value in (("minimum_E", 6), ("maximum_E", 7)):
    witness = timing["extremal_witnesses"][key]
    assert witness["value"] == value and tuple(witness["witness"]) in expected
    assert witness["witness"][-1] == value
follow = record("time-follow")["metadata"]["result"]["output"]
assert "infeasible with E<=5" in follow and "E=D+2>=6" in follow
assert "(0,2,3,4,6)" in follow and "replacement deadline: E<=6" in follow
museum = record("museum")["metadata"]["result"]["output"]
label, audio = museum.split("\n\nAudio script\n")
assert label.startswith("Object label\n")
counts = [len(label.removeprefix("Object label\n").split()), len(audio.split())]
assert counts == [60, 111]
assert "If you wish" in audio and "imagination, not evidence" in audio
revision = record("museum-follow")["metadata"]["result"]["output"]
assert revision.startswith("Object label\n")
assert len(revision.removeprefix("Object label\n").split()) == 59
assert "1981" in revision and "1978" not in revision and "Audio script" not in revision
for fact in ("palm-sized wooden bird", "one wing missing", "school cupboard", "maker is unknown", "paint colour is unknown"):
    assert fact in revision
print(json.dumps({"fixed-code": {"codewords": 8, "distances": 24, "numeric_mismatches": 0,
      "manual_completeness_review": "FAIL: requested Hamming-distance definition omitted"},
      "coverage-code": {"codewords": 8, "distances": 24, "numeric_mismatches": 0,
      "definition_and_guarantee_qualification_present": True},
      "fixed-time": {"all_five_tuples": True, "tight_intervals": True, "extreme_witnesses": True},
      "time-follow": {"infeasibility_proof": True, "minimal_deadline": 6},
      "museum": {"section_word_counts": counts, "manual_source_and_tone_review": "pass"},
      "museum-follow": {"word_count": 59, "corrected_year": 1981, "old_year_and_audio_absent": True},
      "fixed-history": {"answer": "correct", "both_seed_ancestors_present": True,
      "comparison_output_excluded": True}}, indent=2))
