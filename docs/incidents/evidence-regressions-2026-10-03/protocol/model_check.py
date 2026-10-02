#!/usr/bin/env python3
"""Offline BFS model checker for a two-process Peterson-style protocol."""

import json
import sys
from collections import deque
from pathlib import Path

INITIAL = (0, 0, False, False, 0)
ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results.json"


def state_key(state):
    return [state[0], state[1], state[2], state[3], state[4]]


def state_from_json(value):
    if not isinstance(value, list) or len(value) != 5:
        raise AssertionError("invalid serialized state")
    return (int(value[0]), int(value[1]), bool(value[2]), bool(value[3]), int(value[4]))


def successors(state, buggy):
    """Yield (process label, successor) in deterministic process order."""
    pc0, pc1, flag0, flag1, turn = state
    pcs = (pc0, pc1)
    flags = (flag0, flag1)
    for i in (0, 1):
        j = 1 - i
        pc = pcs[i]
        if pc == 0:
            new_pcs = list(pcs)
            new_flags = list(flags)
            new_pcs[i] = 1
            new_flags[i] = True
            yield (f"p{i}:pc0->pc1", (new_pcs[0], new_pcs[1],
                                      new_flags[0], new_flags[1], turn))
        elif pc == 1:
            new_pcs = list(pcs)
            new_pcs[i] = 2
            yield (f"p{i}:pc1->pc2", (new_pcs[0], new_pcs[1],
                                      flags[0], flags[1], j))
        elif pc == 2:
            enabled = (not flags[j]) if buggy else ((not flags[j]) or turn == i)
            if enabled:
                new_pcs = list(pcs)
                new_pcs[i] = 3
                yield (f"p{i}:pc2->pc3", (new_pcs[0], new_pcs[1],
                                          flags[0], flags[1], turn))
        elif pc == 3:
            new_pcs = list(pcs)
            new_flags = list(flags)
            new_pcs[i] = 0
            new_flags[i] = False
            yield (f"p{i}:pc3->pc0", (new_pcs[0], new_pcs[1],
                                      new_flags[0], new_flags[1], turn))


def explore(buggy):
    states = [INITIAL]
    index = {INITIAL: 0}
    depths = {INITIAL: 0}
    predecessors = {INITIAL: None}
    edges = []
    queue = deque([INITIAL])
    while queue:
        state = queue.popleft()
        source = index[state]
        for label, target in successors(state, buggy):
            if target not in index:
                index[target] = len(states)
                states.append(target)
                depths[target] = depths[state] + 1
                predecessors[target] = (state, label)
                queue.append(target)
            edges.append((source, index[target], label))
    deadlocks = [s for s in states if not list(successors(s, buggy))]
    violations = [s for s in states if s[0] == 3 and s[1] == 3]
    return states, edges, depths, predecessors, deadlocks, violations


def trace_for(state, predecessors):
    states = [state]
    labels = []
    while predecessors[state] is not None:
        previous, label = predecessors[state]
        labels.append(label)
        states.append(previous)
        state = previous
    states.reverse()
    labels.reverse()
    return {"states": [state_key(s) for s in states], "transitions": labels}


def graph_json(buggy):
    states, edges, depths, predecessors, deadlocks, violations = explore(buggy)
    trace = trace_for(deadlocks[0], predecessors) if deadlocks else None
    return {
        "variant": "buggy" if buggy else "correct",
        "initial_state": state_key(INITIAL),
        "states": [state_key(s) for s in states],
        "edges": [{"from": source, "to": target, "label": label}
                  for source, target, label in edges],
        "counts": {"states": len(states), "edges": len(edges)},
        "checks": {
            "mutual_exclusion": not violations,
            "deadlock_free": not deadlocks,
            "mutual_exclusion_violations": [state_key(s) for s in violations],
            "deadlocks": [state_key(s) for s in deadlocks],
        },
        "buggy_deadlock_trace": trace,
    }


def generate():
    payload = {
        "model": {
            "state": ["pc0", "pc1", "flag0", "flag1", "turn"],
            "initial": state_key(INITIAL),
            "variants": {
                "correct": "pc=2 guard: not flag[j] or turn == i",
                "buggy": "pc=2 guard: not flag[j]",
            },
        },
        "correct": graph_json(False),
        "buggy": graph_json(True),
    }
    RESULTS.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n",
                       encoding="utf-8")
    print("generated results.json")


def verify_graph(serialized, buggy):
    expected = graph_json(buggy)
    for key in ("variant", "initial_state", "states", "edges", "counts", "checks",
                "buggy_deadlock_trace"):
        if serialized.get(key) != expected.get(key):
            raise AssertionError(f"{key} does not match independently recomputed graph")
    states, edges, depths, predecessors, deadlocks, violations = explore(buggy)
    if serialized["counts"] != {"states": len(states), "edges": len(edges)}:
        raise AssertionError("serialized counts mismatch")


def replay_trace(trace, buggy, expected_depth):
    if not trace or len(trace["states"]) != len(trace["transitions"]) + 1:
        raise AssertionError("malformed counterexample trace")
    states = [state_from_json(x) for x in trace["states"]]
    if states[0] != INITIAL or len(states) - 1 != expected_depth:
        raise AssertionError("trace is not shortest from the initial state")
    for state, label, target in zip(states, trace["transitions"], states[1:]):
        available = {edge_label: successor for edge_label, successor
                     in successors(state, buggy)}
        if label not in available or available[label] != target:
            raise AssertionError("counterexample transition does not replay")
    if list(successors(states[-1], buggy)):
        raise AssertionError("trace endpoint is not a deadlock")


def self_check():
    payload = json.loads(RESULTS.read_text(encoding="utf-8"))
    verify_graph(payload["correct"], False)
    verify_graph(payload["buggy"], True)
    states, edges, depths, predecessors, deadlocks, violations = explore(True)
    trace = payload["buggy"]["buggy_deadlock_trace"]
    replay_trace(trace, True, depths[deadlocks[0]])
    endpoint_depth = depths[deadlocks[0]]
    if any(depths[state] < endpoint_depth for state in deadlocks):
        raise AssertionError("buggy deadlock trace is not at the first deadlock BFS layer")
    if any(not list(successors(state, True)) for state in states
           if depths[state] < endpoint_depth):
        raise AssertionError("a shallower buggy BFS layer contains a deadlock")
    if payload["correct"]["buggy_deadlock_trace"] is not None:
        raise AssertionError("correct variant unexpectedly has a deadlock trace")
    print("self-check passed: replayed shortest buggy deadlock and recomputed graph counts")


def main(argv):
    if argv == ["--generate"]:
        generate()
    elif argv == ["--self-check"]:
        self_check()
    else:
        print("usage: model_check.py --generate | --self-check", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
