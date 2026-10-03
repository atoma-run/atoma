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

code = record("fixed-code")
body = code["metadata"]["result"]["output"]
assert dict(re.findall(r"(?m)^\| ([01]{3}) \| ([01]{7}) \|$", body)) == words
rows = re.findall(r"(?m)^\| ([01]{3}) \| ([01]{7}) \| (\d+) \|$", body)
assert len(rows) == 24
for received, offset in zip(("1111100", "1110100", "0111010"), (0, 8, 16)):
    for data, word, distance in rows[offset:offset+8]:
        assert word == words[data]
        assert int(distance) == sum(a != b for a, b in zip(received, word))

history = record("fixed-history")
answer = history["metadata"]["result"]["output"]
assert "{011}" in answer and "distance 0" in answer
assert "positions 1, 2, 3, and 7" in answer and "distance is 4" in answer
planning = [e for e in history["events"] if e.get("role") == "plan"]
assert planning and all("previousRunResults" in e["userContent"] for e in planning)
assert all("2ff3b86f-66b2-4b7b-be0a-d5b81bac81e1" in e["userContent"] for e in planning)
assert all("ce1c7dbe-eafa-41a4-ada4-5c3ffd9e1b10" in e["userContent"] for e in planning)
assert all("c7fce1a1-2a46-4661-b366-6181bd3da760" not in e["userContent"] for e in planning)
print(json.dumps({"fixed-code": {"codewords": 8, "distances": 24, "numeric_mismatches": 0,
      "manual_completeness_review": "FAIL: requested Hamming-distance definition omitted"},
      "fixed-history": {"answer": "correct", "both_seed_ancestors_present": True,
      "comparison_output_excluded": True}}, indent=2))
