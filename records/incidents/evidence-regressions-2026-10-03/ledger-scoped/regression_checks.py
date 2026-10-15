#!/usr/bin/env python3
"""Run isolated-copy regression checks for the bounded ledger verifier."""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = ("audit.md", "normalized.csv", "verify_ledger.py")


def run_case(name, mutate, expected):
    with tempfile.TemporaryDirectory(prefix="ledger-regression-") as directory:
        copy = Path(directory)
        for filename in FILES:
            shutil.copy2(ROOT / filename, copy / filename)
        mutate(copy)
        result = subprocess.run(
            [sys.executable, "verify_ledger.py"],
            cwd=copy,
            text=True,
            capture_output=True,
            check=False,
        )
        actual = result.returncode
        if actual != expected:
            detail = (result.stdout + result.stderr).strip().replace("\n", " | ")
            raise SystemExit(
                f"{name}: expected exit {expected}, got {actual}: {detail}"
            )
        print(f"{name}: exit {actual} (expected {expected})")


def audit_section(text, title):
    start = text.index("## " + title) + len(title) + 3
    end = text.find("\n## ", start)
    return text[start:] if end < 0 else text[start:end]


def replace_actual(copy, old, new, label):
    path = copy / "audit.md"
    before = path.read_text(encoding="utf-8")
    section = audit_section(before, "Ambiguous movements and balances")
    if section.count(old) != 1:
        raise SystemExit(label + ": designated actual field was not unique")
    after = before.replace(old, new, 1)
    if audit_section(after, "Observations and raw candidates") != audit_section(before, "Observations and raw candidates"):
        raise SystemExit(label + ": documentation example changed")
    if audit_section(after, "Ambiguous movements and balances").replace(new, "") != section.replace(old, ""):
        raise SystemExit(label + ": more than the intended actual field changed")
    path.write_text(after, encoding="utf-8")


def no_change(_copy):
    pass


def and_separator(copy):
    replace_actual(copy, "t1 remains ambiguous between +12, +17.", "t1 remains ambiguous between +12 and +17.", "and-separator")


def plus_99(copy):
    replace_actual(copy, "t1 remains ambiguous between +12, +17.", "t1 remains ambiguous between +12, +99.", "plus-99")


def remove_actual(copy):
    replace_actual(copy, "t1 remains ambiguous between +12, +17.\n", "", "missing-actual")


def duplicate_conflict(copy):
    path = copy / "audit.md"
    before = path.read_text(encoding="utf-8")
    marker = "t1 remains ambiguous between +12, +17."
    section = audit_section(before, "Ambiguous movements and balances")
    if section.count(marker) != 1:
        raise SystemExit("duplicate fixture could not find designated actual field")
    actual = audit_section(before, "Ambiguous movements and balances")
    after_section = actual.replace(marker, marker + "\nt1 remains ambiguous between +12, +99.", 1)
    if actual.count(marker) != 1 or after_section.count(marker) != 1:
        raise SystemExit("duplicate fixture did not preserve the designated actual claim")
    after = before.replace(actual, after_section, 1)
    if audit_section(after, "Observations and raw candidates") != audit_section(before, "Observations and raw candidates"):
        raise SystemExit("duplicate fixture changed documentation example")
    path.write_text(after, encoding="utf-8")


def survivor_count(copy, count):
    path = copy / "audit.md"
    before = path.read_text(encoding="utf-8")
    section = audit_section(before, "Surviving alternatives")
    old = "Exactly two sequences survive:"
    if section.count(old) != 1:
        raise SystemExit("count fixture could not find designated count field")
    after = before.replace(old, f"Exactly {count} sequences survive:", 1)
    if audit_section(after, "Observations and raw candidates") != audit_section(before, "Observations and raw candidates"):
        raise SystemExit("count fixture changed documentation example")
    path.write_text(after, encoding="utf-8")


def wrong_t3(copy):
    path = copy / "normalized.csv"
    before = path.read_text(encoding="utf-8")
    old = "t3,receipt,+6|+8,+6,54"
    new = "t3,receipt,+6|+8,+8,54"
    if before.count(old) != 1:
        raise SystemExit("wrong-t3 fixture could not find t3 row")
    path.write_text(before.replace(old, new, 1), encoding="utf-8")


def false_t1_identification(copy):
    path = copy / "normalized.csv"
    before = path.read_text(encoding="utf-8")
    old = "t1,receipt,+12|+17,,52|57"
    new = "t1,receipt,+12|+17,+12,52|57"
    if before.count(old) != 1:
        raise SystemExit("false-t1 fixture could not find t1 row")
    path.write_text(before.replace(old, new, 1), encoding="utf-8")


def main():
    run_case("unchanged", no_change, 0)
    run_case("t1 and separator", and_separator, 0)
    run_case("t1 plus 99", plus_99, 1)
    run_case("missing actual t1", remove_actual, 1)
    run_case("duplicate conflicting actual t1", duplicate_conflict, 1)
    run_case("three-survivors claim", lambda copy: survivor_count(copy, 3), 1)
    run_case("four-survivors claim", lambda copy: survivor_count(copy, 4), 1)
    run_case("wrong t3 identified_delta", wrong_t3, 1)
    run_case("false t1 identification", false_t1_identification, 1)
    print("all regression checks passed")


if __name__ == "__main__":
    main()
