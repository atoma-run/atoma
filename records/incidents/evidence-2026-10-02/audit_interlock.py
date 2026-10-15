"""Exhaustive oracle for the exact four-bit interlock used in the live run."""
from collections import deque
import json


def successors(state, corrected):
    a, b, pa, pb = state
    if b == 0:
        yield 'authorizeA', (a, b, 1, pb)
    if a == 0:
        yield 'authorizeB', (a, b, pa, 1)
    if pa == 1 and (not corrected or b == 0):
        yield 'openA', (1, b, 0, pb)
    if pb == 1 and (not corrected or a == 0):
        yield 'openB', (a, 1, pa, 0)
    if a == 1:
        yield 'closeA', (0, b, pa, pb)
    if b == 1:
        yield 'closeB', (a, 0, pa, pb)


def explore(corrected):
    initial = (0, 0, 0, 0)
    paths = {initial: []}
    pending = deque([initial])
    while pending:
        state = pending.popleft()
        for action, target in successors(state, corrected):
            if target not in paths:
                paths[target] = paths[state] + [(action, target)]
                pending.append(target)
    bad = [state for state in paths if state[:2] == (1, 1)]
    shortest = min((paths[state] for state in bad), key=len, default=None)
    return {'reachable_count': len(paths),
            'reachable_states': [''.join(map(str, state)) for state in sorted(paths)],
            'shortest_safety_violation': shortest,
            'permission_witnesses': {
                ''.join(map(str, state)): paths[state]
                for state in [(1, 1, 0, 1), (1, 1, 1, 0)] if state in paths}}


original, corrected = explore(False), explore(True)
assert original['reachable_count'] == 15
assert '1111' not in original['reachable_states']
assert len(original['shortest_safety_violation']) == 4
assert corrected['reachable_count'] == 12
assert corrected['shortest_safety_violation'] is None
assert ('authorizeA', (0, 0, 1, 0)) in list(successors((0, 0, 1, 0), True))
print(json.dumps({'original': original, 'corrected': corrected,
                  'unfair_liveness_lasso': '0000 --authorizeA--> 0010 --authorizeA--> 0010 forever'}, indent=2))
