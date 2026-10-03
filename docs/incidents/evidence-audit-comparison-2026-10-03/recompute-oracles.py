"""Quota-free reference calculations for the preregistered diagnostic cases."""
from itertools import combinations
import json


def division(b_values):
    a_values = (8, 5, 4, 1)
    rows = []
    for own in combinations(range(4), 2):
        other = tuple(i for i in range(4) if i not in own)
        a = sum(a_values[i] for i in own)
        b = sum(b_values[i] for i in other)
        rows.append(dict(A=''.join('abcd'[i] for i in own), uA=a, uB=b,
                         total=a+b, product=a*b,
                         envyFree=a >= sum(a_values)-a and b >= sum(b_values)-b))
    for row in rows:
        row['pareto'] = not any(
            candidate['uA'] >= row['uA'] and candidate['uB'] >= row['uB']
            and (candidate['uA'] > row['uA'] or candidate['uB'] > row['uB'])
            for candidate in rows)
    return rows


base = division((2, 6, 3, 9))
delta = division((2, 6, 3, 0))
assert [r['A'] for r in base if r['pareto']] == ['ab', 'ac']
assert [r['A'] for r in delta if r['pareto']] == ['ab', 'ac', 'ad']
assert [r['A'] for r in delta if r['total'] == max(x['total'] for x in delta)] == ['ac', 'ad']
assert [r['A'] for r in delta if r['product'] == max(x['product'] for x in delta)] == ['ad']
print(json.dumps({'base': base, 'delta': delta,
                  'standardizedRates': {'X': (81/90 + 2/10)/2,
                                        'Y': (19/20 + 64/80)/2}}, indent=2))
