"""Measure completed branch intervals from the archived production trace."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
record = json.loads((root / 'run.json').read_text(encoding='utf-8'))
events = record['events']
starts = {e['branchId']: e for e in events if e['kind'] == 'branch' and e['op'] == 'start'}
ends = {e['branchId']: e for e in events if e['kind'] == 'branch' and e['op'] == 'end'}
groups = {}
for branch in starts.values():
    if branch.get('aggregationMode') == 'concat' and branch.get('total') == 4:
        groups.setdefault(branch.get('parentBranchId'), []).append(branch)
assert len(groups) == 1, 'Expected one four-way parallel group'
parent, branches = next(iter(groups.items()))
assert len(branches) == 4 and {b['index'] for b in branches} == {0,1,2,3}
assert all(b['branchId'] in ends for b in branches), 'Missing branch completion'
overlap_ms = min(ends[b['branchId']]['ts'] for b in branches) - max(b['ts'] for b in branches)
assert overlap_ms > 0, 'Four branches never coexisted'
root_branches = sorted((b for b in starts.values() if b['actor']['tier'] == 3), key=lambda b:b['ts'])
assert root_branches[0]['branchId'] == parent
assert root_branches[1]['ts'] >= max(ends[b['branchId']]['ts'] for b in branches), 'Integration started before the barrier'
origin = min(e['ts'] for e in events)
intervals = []
for branch in sorted(branches, key=lambda b:b['index']):
    bid = branch['branchId']
    llm = [e for e in events if e['kind'] == 'llm' and e.get('branchId') == bid]
    tools = [e for e in events if e['kind'] == 'tool' and e.get('branchId') == bid]
    intervals.append(dict(index=branch['index'], id=bid, start_s=(branch['ts']-origin)/1000,
        end_s=(ends[bid]['ts']-origin)/1000, llm_calls=len(llm), tool_calls=len(tools)))
print(json.dumps(dict(branches=intervals, all_four_overlap_s=overlap_ms/1000,
    integration_start_s=(root_branches[1]['ts']-origin)/1000, barrier_respected=True),indent=2))
