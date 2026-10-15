#!/usr/bin/env python3
import csv
import itertools
import re
import sys

START = 40
CHECKPOINTS = {3: 54, 5: 51}
MOVEMENTS = [
    ("t1", "receipt", (12, 17)),
    ("t2", "dispatch", (-9, -4)),
    ("t3", "receipt", (6, 8)),
    ("t4", "dispatch", (-15, -13)),
    ("t5", "receipt", (10, 16)),
]

def derive_survivors():
    survivors = []
    for choices in itertools.product(*(values for _, _, values in MOVEMENTS)):
        balance = START
        balances = []
        valid = True
        for index, delta in enumerate(choices, 1):
            balance += delta
            balances.append(balance)
            if balance < 0 or (index in CHECKPOINTS and balance != CHECKPOINTS[index]):
                valid = False
                break
        if valid:
            survivors.append((choices, tuple(balances)))
    return survivors

def fail(message):
    print("ERROR: " + message, file=sys.stderr)
    raise SystemExit(1)

def signed(value):
    return ("+" if value >= 0 else "") + str(value)

def main():
    survivors = derive_survivors()
    if not survivors:
        fail("derivation produced no survivors")

    with open("normalized.csv", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        expected_header = ["id", "kind", "candidate_deltas", "identified_delta", "possible_balance_after"]
        if reader.fieldnames != expected_header:
            fail("normalized.csv header mismatch")
        rows = list(reader)

    if len(rows) != len(MOVEMENTS):
        fail("normalized.csv row count mismatch")

    for index, ((movement_id, kind, candidates), row) in enumerate(zip(MOVEMENTS, rows)):
        if row["id"] != movement_id or row["kind"] != kind:
            fail("normalized.csv movement identity mismatch at " + movement_id)
        if row["candidate_deltas"] != "|".join(signed(x) for x in candidates):
            fail("raw candidate mismatch at " + movement_id)
        movement_values = {choices[index] for choices, _ in survivors}
        balance_values = sorted({balances[index] for _, balances in survivors})
        expected_identified = signed(next(iter(movement_values))) if len(movement_values) == 1 else ""
        expected_balances = "|".join(str(x) for x in balance_values)
        if row["identified_delta"] != expected_identified:
            fail("identified_delta mismatch at " + movement_id)
        if row["possible_balance_after"] != expected_balances:
            fail("possible_balance_after mismatch at " + movement_id)

    with open("audit.md", encoding="utf-8") as handle:
        audit = handle.read()

    # audit.md is a bounded report format, not a general natural-language parser.
    # The count declaration is exact; only the designated t1 ambiguity field
    # permits the equivalent comma or "and" separator.
    if "Exactly two sequences survive:" not in audit:
        fail("audit must declare exactly two surviving sequences")
    if audit.count("Exactly two sequences survive:") != 1:
        fail("audit must contain one exact survivor-count declaration")
    if "Exactly three sequences survive:" in audit:
        fail("audit contains a conflicting survivor-count declaration")
    if len(survivors) != 2:
        fail("derived survivor count is not two")

    for number, (choices, balances) in enumerate(survivors, 1):
        sequence = "(" + ", ".join(signed(x) for x in choices) + ")"
        if f"{number}. {sequence}" not in audit:
            fail("missing surviving sequence " + sequence)
        arithmetic = "; ".join(
            f"{START if i == 0 else balances[i-1]} {'+' if delta >= 0 else '-'} {abs(delta)} = {balances[i]}"
            for i, delta in enumerate(choices)
        )
        expected_line = f"- Sequence {number}: {arithmetic}. Balances: {balances}. All are nonnegative."
        if expected_line not in audit:
            fail("missing arithmetic for surviving sequence " + str(number))

    for index, (movement_id, _, _) in enumerate(MOVEMENTS):
        movement_values = {choices[index] for choices, _ in survivors}
        balance_values = sorted({balances[index] for _, balances in survivors})
        if len(movement_values) == 1:
            if f"{movement_id} = {signed(next(iter(movement_values)))}" not in audit:
                fail("missing identifiable movement claim for " + movement_id)
        else:
            rendered = ", ".join(signed(x) for x in sorted(movement_values))
            expected_claim = f"{movement_id} remains ambiguous between {rendered}"
            if movement_id == "t1":
                # Sole grammar exception: comma and \"and\" are equivalent
                # separators in the designated t1 ambiguity field only.
                pattern = r"t1 remains ambiguous between \+12(?:,| and) \+17"
                if not re.search(pattern, audit):
                    fail("missing bounded t1 ambiguity claim")
            elif expected_claim not in audit:
                fail("missing ambiguity claim for " + movement_id)
        if len(balance_values) == 1:
            if f"after {movement_id} = {balance_values[0]}" not in audit:
                fail("missing identifiable balance claim for " + movement_id)
        else:
            rendered = " and ".join(str(x) for x in balance_values)
            if f"after {movement_id} remains ambiguous between {rendered}" not in audit:
                fail("missing ambiguity balance claim for " + movement_id)

    required_sections = [
        "## Observations and raw candidates",
        "## Constraints",
        "## Resolved values versus plausible guesses",
    ]
    for section in required_sections:
        if section not in audit:
            fail("missing audit section: " + section)

    print(f"verified: {len(survivors)} surviving sequences; normalized.csv and audit.md agree")

if __name__ == "__main__":
    main()
