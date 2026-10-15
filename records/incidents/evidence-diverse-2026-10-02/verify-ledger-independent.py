"""Audit the published ledger and challenge its checker on isolated copies."""
import csv
import itertools
import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
candidates = [(12, 17), (-9, -4), (6, 8), (-15, -13), (10, 16)]
survivors = []
for moves in itertools.product(*candidates):
    balance = 40
    balances = []
    for delta in moves:
        balance += delta
        balances.append(balance)
    if min(balances) >= 0 and balances[2] == 54 and balances[4] == 51:
        survivors.append((moves, balances))
with (root / 'normalized.csv').open(newline='', encoding='utf-8') as handle:
    rows = list(csv.DictReader(handle))
assert len(rows) == 5 and len(survivors) == 2
for i, row in enumerate(rows):
    assert row['id'] == f't{i+1}'
    assert {int(x) for x in row['candidate_deltas'].split('|')} == set(candidates[i])
    values = {moves[i] for moves, _ in survivors}
    assert (row['identified_delta'] == '') == (len(values) > 1)
    if len(values) == 1:
        assert int(row['identified_delta']) == next(iter(values))
    assert {int(x) for x in row['possible_balance_after'].split('|')} == {b[i] for _, b in survivors}

cases = {
    'unchanged': None,
    'wrong_csv_value': ('normalized.csv', 't3,receipt,+6|+8,+6,54', 't3,receipt,+6|+8,+8,54'),
    'wrong_report_count': ('audit.md', 'Exactly two sequences survive:', 'Exactly three sequences survive:'),
    'equivalent_paraphrase': ('audit.md', 't1 remains ambiguous between +12, +17.', 't1 remains ambiguous between +12 and +17.'),
}
results = {}
for name, change in cases.items():
    case_dir = Path(tempfile.mkdtemp(prefix='atoma-ledger-audit-'))
    for file in ('normalized.csv', 'audit.md', 'verify_ledger.py'):
        text = (root / file).read_text(encoding='utf-8')
        if change and change[0] == file:
            assert change[1] in text
            text = text.replace(change[1], change[2])
        (case_dir / file).write_text(text, encoding='utf-8')
    result = subprocess.run([sys.executable, 'verify_ledger.py'], cwd=case_dir, capture_output=True, text=True, timeout=10)
    results[name] = {'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
assert results['unchanged']['exitCode'] == 0
assert results['wrong_csv_value']['exitCode'] != 0
print(json.dumps({'independent_survivors': survivors, 'csv_correct': True, 'checker_challenges': results}, indent=2))
