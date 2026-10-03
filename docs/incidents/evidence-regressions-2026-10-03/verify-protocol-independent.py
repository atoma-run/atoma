"""Compare published graphs with the independently preregistered oracle."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
oracle = json.loads((root / 'preregistration.json').read_text())['protocolOracle']
actual = json.loads((root / 'protocol/results.json').read_text())
report = {}
for name in ('correct', 'buggy'):
    expected = oracle[name]
    observed = actual[name]
    states = [tuple(s) for s in observed['states']]
    wanted = [tuple(s) for s in expected['states']]
    assert len(states) == len(set(states))
    assert set(states) == set(wanted)
    edges = set()
    for edge in observed['edges']:
        actor = int(edge['label'][1])
        source, target = states[edge['from']], states[edge['to']]
        assert edge['label'] == f'p{actor}:pc{source[actor]}->pc{target[actor]}'
        edges.add((source, target, actor))
    wanted_edges = {(wanted[e['from']], wanted[e['to']], e['process']) for e in expected['edges']}
    assert len(edges) == len(observed['edges'])
    assert edges == wanted_edges
    deadlocks = {s for s in states if not any(e[0] == s for e in edges)}
    assert deadlocks == {tuple(s) for s in observed['checks']['deadlocks']}
    assert observed['counts'] == {'states': len(states), 'edges': len(edges)}
    assert not any(s[0] == s[1] == 3 for s in states)
    report[name] = {'states': len(states), 'edges': len(edges), 'deadlocks': len(deadlocks)}
    if name == 'buggy':
        trace = observed['buggy_deadlock_trace']
        path = [tuple(s) for s in trace['states']]
        assert path[0] == wanted[0] and path[-1] in deadlocks
        assert len(trace['transitions']) == len(path) - 1 == 4
        for a, label, b in zip(path, trace['transitions'], path[1:]):
            assert (a, b, int(label[1])) in wanted_edges
        reached = {wanted[0]}
        frontier = reached.copy()
        for _ in range(4):
            assert not frontier & deadlocks
            frontier = {b for a, b, _ in wanted_edges if a in frontier} - reached
            reached |= frontier
        assert frontier & deadlocks
        report[name]['shortest_deadlock_steps'] = 4
report['sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in (root / 'protocol').iterdir() if p.is_file()}
print(json.dumps(report, sort_keys=True))
