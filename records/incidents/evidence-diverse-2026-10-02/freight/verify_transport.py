#!/usr/bin/env python3
"""Exhaustively verify both integer transportation scenarios."""

import json
import sys
from itertools import product


def load_solution():
    with open("solution.json", encoding="utf-8") as handle:
        return json.load(handle)


def enumerate_feasible(instance, capacity):
    supplies = [instance["supplies"][key] for key in ("A", "B", "C")]
    demands = [instance["demands"][key] for key in ("X", "Y", "Z")]
    costs = instance["costs"]
    feasible = []

    # a=x_AX, b=x_BY, z=x_BZ; all ranges are finite from supply/demand bounds.
    for a, b, z in product(range(supplies[0] + 1), range(capacity + 1), range(demands[2] + 1)):
        matrix = [
            [a, supplies[0] - a, 0],
            [supplies[1] - b - z, b, z],
            [b + z - a - 1, a - b - 1, demands[2] - z],
        ]
        if any(value < 0 for row in matrix for value in row):
            continue
        if [sum(row) for row in matrix] != supplies:
            continue
        if [sum(matrix[row][col] for row in range(3)) for col in range(3)] != demands:
            continue
        if matrix[0][2] != 0 or matrix[1][1] > capacity:
            continue
        value = sum(matrix[row][col] * costs[row][col] for row in range(3) for col in range(3))
        feasible.append((value, matrix))
    return feasible


def fail(message):
    print("FAIL:", message, file=sys.stderr)
    raise SystemExit(1)


def main():
    solution = load_solution()
    instance = solution["instance"]
    expected = {
        4: (89, [[5, 2, 0], [3, 4, 2], [0, 0, 8]]),
        5: (85, [[6, 1, 0], [2, 5, 2], [0, 0, 8]]),
    }
    scenarios = {scenario["capacities"]["B->Y"]: scenario for scenario in solution["scenarios"]}

    for capacity, (expected_cost, expected_matrix) in expected.items():
        scenario = scenarios.get(capacity)
        if scenario is None:
            fail("missing scenario for capacity %d" % capacity)
        feasible = enumerate_feasible(instance, capacity)
        if not feasible:
            fail("no feasible matrices for capacity %d" % capacity)
        optimum = min(value for value, _ in feasible)
        winners = [matrix for value, matrix in feasible if value == optimum]
        if optimum != expected_cost:
            fail("cost disagreement for capacity %d: %d != %d" % (capacity, optimum, expected_cost))
        if winners != [expected_matrix]:
            fail("optimal matrix disagreement for capacity %d" % capacity)
        if scenario["objective_value"] != optimum:
            fail("solution objective disagreement for capacity %d" % capacity)
        if scenario["matrix"] != expected_matrix:
            fail("solution matrix disagreement for capacity %d" % capacity)
        if scenario["optimal_matrix_count"] != len(winners) or scenario["unique_optimum"] != (len(winners) == 1):
            fail("uniqueness disagreement for capacity %d" % capacity)
        print("capacity=%d optimum=%d optimal_matrices=%d" % (capacity, optimum, len(winners)))


if __name__ == "__main__":
    main()
