"""Read artifact JSON/CSV as data and check against independent finite oracles."""
import csv
import itertools
import json
from pathlib import Path
import sys
from oracle import reference, items, durations, parents, overlap, edges

root = Path(sys.argv[1]).resolve()
def read(name): return json.loads((root/name/'result.json').read_text(encoding='utf-8'))
p = read('packing')
assignment = p['assignment']
assert set(assignment) == set('ABCDEFGHI')
assert all(v in ('X','Y',None) for v in assignment.values())
assert assignment['A'] is not None and assignment['H'] is not None
assert assignment['B'] is None or assignment['B'] != assignment['E']
weight = sum(w for i,w,v in items if assignment[i] is not None)
value = sum(v for i,w,v in items if assignment[i] is not None)
assert (value,weight) == (reference['packing']['value'],reference['packing']['weight'])
assert p['objective'] == dict(total_value=value,total_selected_weight=weight)
assert p['omitted_ids'] == sorted(i for i in assignment if assignment[i] is None)
for box,capacity in (('X',9),('Y',10)):
    load = sum(w for i,w,v in items if assignment[i] == box)
    assert load <= capacity and load == p['loads'][box]['weight']

s = read('schedule')['scenarios']
for key,expected_key in (('baseline','baseline'),('bench_Y_unavailable_3_5','disruption')):
    scenario = s[key]
    jobs = scenario['schedule']
    assert set(jobs) == set(durations)
    for job,row in jobs.items():
        assert isinstance(row['start'],int) and row['start'] >= (1 if job == 'C' else 0)
        assert row['bench'] in ('X','Y') and row['end']-row['start'] == durations[job]
        assert all(jobs[parent]['end'] <= row['start'] for parent in parents[job])
        if key != 'baseline' and row['bench'] == 'Y': assert not overlap(row['start'],row['end'],3,5)
    for (j,a),(k,b) in itertools.combinations(jobs.items(),2):
        if a['bench'] == b['bench'] or {j,k} == {'D','E'}:
            assert not overlap(a['start'],a['end'],b['start'],b['end'])
    assert max(v['end'] for v in jobs.values()) == scenario['makespan'] == reference['schedules'][expected_key]['makespan']

r = read('routing')['scenarios']
assert len(r) == 2
for scenario,key in zip(r,('baseline','RS')):
    available = {frozenset(edge):w for edge,w in edges.items() if edge != key}
    walk = scenario['walk']
    assert walk[0] == walk[-1] == 'D' and set(walk) == set('DPQRST')
    cost = sum(available[frozenset((a,b))] for a,b in zip(walk,walk[1:]))
    assert cost == scenario['cost'] == reference['routes'][key]['cost']
    assert scenario['permutation_count'] == 120 and len(scenario['order_costs']) == 120
    assert len({tuple(v['order']) for v in scenario['order_costs']}) == 120

q = read('quality')
assert q['cleaned_rows'] == 5 and q['duplicates'] == [4] and q['superseded_rows'] == [0] and q['invalid_records'] == [8]
assert q['conflicts'] == [dict(records=[5,6],revision=1,sensor='S2',time=1)]
for sensor,expected in reference['quality']['aggregates'].items():
    a = q['aggregates'][sensor]
    assert (a['retained_count'],a['calibrated_min'],a['calibrated_max'],a['calibrated_mean'],a['in_band_count']) == (expected['count'],expected['min'],expected['max'],expected['mean'],expected['in_band'])
with (root/'quality'/'cleaned.csv').open(encoding='utf-8',newline='') as handle:
    actual = [[r['sensor'],int(r['time']),int(r['revision']),float(r['raw']),float(r['calibrated']),r['in_band'].lower() in ('true','1')] for r in csv.DictReader(handle)]
assert actual == reference['quality']['cleaned']
print(json.dumps(dict(packing=[value,weight],schedule=[8,10],routing=[19,25],quality_retained=5,independent_checks='passed'),indent=2))
