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


def no_change(_copy):
    pass


def three_survivors(copy):
    path = copy / "audit.md"
    text = path.read_text(encoding="utf-8")
    path.write_text(
        text.replace("Exactly two sequences survive:", "Exactly three sequences survive:"),
        encoding="utf-8",
    )


def and_separator(copy):
    path = copy / "audit.md"
    text = path.read_text(encoding="utf-8")
    old = "t1 remains ambiguous between +12, +17"
    new = "t1 remains ambiguous between +12 and +17"
    if old not in text:
        raise SystemExit("and-separator fixture could not find designated t1 field")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def wrong_t3(copy):
    path = copy / "normalized.csv"
    text = path.read_text(encoding="utf-8")
    old = "t3,receipt,+6|+8,+6,54"
    new = "t3,receipt,+6|+8,+8,54"
    if old not in text:
        raise SystemExit("wrong-t3 fixture could not find t3 row")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def false_t1_identification(copy):
    path = copy / "normalized.csv"
    text = path.read_text(encoding="utf-8")
    old = "t1,receipt,+12|+17,,52|57"
    new = "t1,receipt,+12|+17,+12,52|57"
    if old not in text:
        raise SystemExit("false-t1 fixture could not find t1 row")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main():
    run_case("unchanged", no_change, 0)
    run_case("three-survivors claim", three_survivors, 1)
    run_case("t1 and separator", and_separator, 0)
    run_case("wrong t3 identified_delta", wrong_t3, 1)
    run_case("false t1 identification", false_t1_identification, 1)
    print("all regression checks passed")


if __name__ == "__main__":
    main()
