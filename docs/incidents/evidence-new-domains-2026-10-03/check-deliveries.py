"""Check numeric claims in these two archived deliveries, not a product gate."""
import itertools
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent
words = {}
for a, b, c in itertools.product((0, 1), repeat=3):
    words[f"{a}{b}{c}"] = f"{a}{b}{c}{a ^ b}{b ^ c}{a ^ c}{a ^ b ^ c}"


def distance(a, b):
    return sum(x != y for x, y in zip(a, b))


observations = {}
for name in ("code", "code-terra"):
    record = json.loads((root / f"{name}.json").read_text(encoding="utf-8"))
    body = record["metadata"]["result"]["output"]
    actual_words = dict(re.findall(r"(?m)^([01]{3})(?:&| → )([01]{7})", body))
    assert actual_words == words, (name, actual_words)
    mismatches = []
    for i, received in enumerate(("1111100", "1110100", "0111010"), 1):
        if name == "code":
            pattern = rf"R_{i}={received}: \(([0-9,]+)\)"
        else:
            pattern = rf"R{i} = {received}:\n([0-9, .]+)"
        match = re.search(pattern, body)
        assert match, (name, pattern)
        actual = list(map(int, re.findall(r"\d+", match.group(1))))
        assert len(actual) == 8
        for data, value in zip(words, actual):
            expected = distance(received, words[data])
            if value != expected:
                mismatches.append(dict(received=received, data=data,
                                       expected=expected, actual=value))
    observations[name] = dict(codewords=8, distances=24, mismatches=mismatches)
assert observations["code"]["mismatches"] == [
    dict(received="0111010", data="100", expected=4, actual=6)]
assert observations["code-terra"]["mismatches"] == []
print(json.dumps(observations, indent=2))
