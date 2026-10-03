"""Exhaustive, quota-free references; no model-authored code is executed."""
import itertools
import json

words = {}
for a, b, c in itertools.product((0, 1), repeat=3):
    words[f'{a}{b}{c}'] = f'{a}{b}{c}{a ^ b}{b ^ c}{a ^ c}{a ^ b ^ c}'


def distance(left, right):
    return sum(a != b for a, b in zip(left, right))


decoding = {}
for received in ('1111100', '1110100', '0111010'):
    distances = {data: distance(received, code) for data, code in words.items()}
    decoding[received] = dict(distances=distances, nearest=[
        data for data, value in distances.items() if value == min(distances.values())])
assert decoding['1110100']['nearest'] == ['101', '110', '111']
assert [data for data, code in words.items()
        if code[3] == '1' and distance('1110100', code) <= 2] == ['101']

solutions = [(0, b, c, d, d+2)
             for b in range(2, 5) for c in range(3, 6) for d in range(0, 6)
             if 2 <= d-b <= 3 and 1 <= d-c <= 2]
assert len(solutions) == 5
assert not [s for s in solutions if s[-1] <= 5]
assert min(s[-1] for s in solutions) == 6
print(json.dumps(dict(words=words, decoding=decoding, solutions=solutions,
                     intervals=[(min(s[i] for s in solutions), max(s[i] for s in solutions))
                                for i in range(5)]), indent=2))
