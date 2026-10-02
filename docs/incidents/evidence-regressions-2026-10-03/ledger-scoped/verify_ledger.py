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

    # The report format is deliberately bounded: every assertion is read from
    # its one designated section, never from grammar prose or raw examples.
    headings = re.findall(r"(?m)^## (.+)$", audit)
    sections = {}
    for title in headings:
        if headings.count(title) != 1:
            fail("duplicate audit section: " + title)
        match = re.search(rf"(?ms)^## {re.escape(title)}\n(.*?)(?=^## |\Z)", audit)
        sections[title] = match.group(1) if match else ""
    required_sections = [
        "Observations and raw candidates",
        "Constraints",
        "Surviving alternatives",
        "Arithmetic for every surviving five-movement sequence",
        "Identifiable movements and balances",
        "Ambiguous movements and balances",
        "Resolved values versus plausible guesses",
    ]
    for section in required_sections:
        if section not in sections:
            fail("missing audit section: " + section)

    alternatives = sections["Surviving alternatives"]
    count_claims = [line for line in alternatives.splitlines()
                    if re.fullmatch(r"Exactly (?:two|2) sequences survive:", line)]
    if len(count_claims) != 1:
        fail("survivor count claim is missing, duplicated, or conflicting")
    if len(survivors) != 2:
        fail("derived survivor count is not two")

    arithmetic_section = sections["Arithmetic for every surviving five-movement sequence"]
    for number, (choices, balances) in enumerate(survivors, 1):
        sequence = "(" + ", ".join(signed(x) for x in choices) + ")"
        if len(re.findall(rf"(?m)^{number}\. {re.escape(sequence)}$", alternatives)) != 1:
            fail("missing or duplicate surviving sequence " + sequence)
        arithmetic = "; ".join(
            f"{START if i == 0 else balances[i-1]} {'+' if delta >= 0 else '-'} {abs(delta)} = {balances[i]}"
            for i, delta in enumerate(choices)
        )
        expected_line = f"- Sequence {number}: {arithmetic}. Balances: {balances}. All are nonnegative."
        if arithmetic_section.count(expected_line) != 1:
            fail("missing or duplicate arithmetic for sequence " + str(number))

    identified = sections["Identifiable movements and balances"]
    ambiguous = sections["Ambiguous movements and balances"]

    def unique(pattern, text, label):
        matches = re.findall(pattern, text, flags=re.MULTILINE)
        if len(matches) != 1:
            fail("missing, duplicate, or conflicting " + label)
        return matches[0]

    for index, (movement_id, _, _) in enumerate(MOVEMENTS):
        movement_values = {choices[index] for choices, _ in survivors}
        balance_values = sorted({balances[index] for _, balances in survivors})
        if len(movement_values) == 1:
            actual = unique(rf"(?<!after ){re.escape(movement_id)} = ([+-]\d+)", identified, movement_id + " movement claim")
            if actual != signed(next(iter(movement_values))):
                fail("conflicting movement claim for " + movement_id)
        else:
            if movement_id == "t1":
                pattern = r"^t1 remains ambiguous between \+12(?:,| and) \+17\.$"
                matches = [line for line in ambiguous.splitlines() if line.startswith("t1 remains ambiguous between " )]
                if len(matches) != 1 or not re.fullmatch(pattern, matches[0]):
                    fail("missing, duplicate, or conflicting ambiguity claim for " + movement_id)
            else:
                pattern = rf"^{re.escape(movement_id)} remains ambiguous between {', '.join(re.escape(signed(x)) for x in sorted(movement_values))}\.$"
                if len(re.findall(pattern, ambiguous, flags=re.MULTILINE)) != 1:
                    fail("missing, duplicate, or conflicting ambiguity claim for " + movement_id)
        if len(balance_values) == 1:
            actual = unique(rf"after {re.escape(movement_id)} = (\d+)", identified, movement_id + " balance claim")
            if actual != str(balance_values[0]):
                fail("conflicting balance claim for " + movement_id)
        else:
            rendered = " and ".join(str(x) for x in balance_values)
            pattern = rf"^The balance after {re.escape(movement_id)} remains ambiguous between {rendered}\.$"
            if len(re.findall(pattern, ambiguous, flags=re.MULTILINE)) != 1:
                fail("missing, duplicate, or conflicting balance claim for " + movement_id)

    print(f"verified: {len(survivors)} surviving sequences; normalized.csv and audit.md agree")

if __name__ == "__main__":
    main()
