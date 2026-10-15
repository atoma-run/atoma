"""Independent finite references for the preregistered parallel mission."""
import itertools
import json

items = list(zip('ABCDEFGHI', [6,5,4,4,3,3,2,2,1], [11,10,8,7,7,6,5,4,2]))
best = None
packing = None
for assignment in itertools.product((-1,0,1), repeat=9):
    if assignment[0] < 0 or assignment[7] < 0: continue
    if assignment[1] >= 0 and assignment[1] == assignment[4]: continue
    loads = [sum(w for (_,w,_), box in zip(items, assignment) if box == b) for b in (0,1)]
    if loads[0] > 9 or loads[1] > 10: continue
    value = sum(v for (_,_,v), box in zip(items, assignment) if box >= 0)
    weight = sum(loads)
    if best is None or (value,-weight) > best:
        best = (value,-weight)
        packing = dict(assignment=dict(zip('ABCDEFGHI', assignment)), loads=loads, value=value, weight=weight)

durations = dict(zip('ABCDEF', (3,2,4,2,3,1)))
parents = dict(A=[], B=[], C=[], D=['A','B'], E=['B'], F=['C','D'])
def overlap(a,b,c,d): return a < d and c < b
def find_schedule(horizon, disruption):
    placed = {}
    def search(index):
        if index == 6: return dict(placed)
        job = 'ABCDEF'[index]
        earliest = max([1 if job == 'C' else 0] + [placed[p][2] for p in parents[job]])
        for start in range(earliest, horizon-durations[job]+1):
            end = start+durations[job]
            for bench in ('X','Y'):
                if disruption and bench == 'Y' and overlap(start,end,3,5): continue
                if any(overlap(start,end,s,e) and (bench == b or {job,other} == {'D','E'}) for other,(b,s,e) in placed.items()): continue
                placed[job] = (bench,start,end)
                result = search(index+1)
                if result: return result
                del placed[job]
        return None
    return search(0)
schedules = {}
for disrupted in (False,True):
    for horizon in range(8,16):
        witness = find_schedule(horizon, disrupted)
        if witness:
            schedules['disruption' if disrupted else 'baseline'] = dict(makespan=horizon,jobs=witness)
            break

edges = {'DP':4,'DQ':3,'PQ':2,'PR':5,'QR':2,'QS':6,'RS':2,'RT':5,'ST':3,'TD':6}
routes = {}
for closed in (None,'RS'):
    nodes = 'DPQRST'
    d = {(a,b): (0 if a == b else float('inf')) for a in nodes for b in nodes}
    for edge,w in edges.items():
        if edge != closed: d[edge[0],edge[1]] = d[edge[1],edge[0]] = w
    for k in nodes:
        for i in nodes:
            for j in nodes: d[i,j] = min(d[i,j],d[i,k]+d[k,j])
    candidates = [(sum(d[a,b] for a,b in zip(('D',)+order,order+('D',))),order) for order in itertools.permutations('PQRST')]
    cost,order = min(candidates)
    routes[closed or 'baseline'] = dict(cost=cost,visit_order=('D',)+order+('D',))
quality = dict(cleaned=[['S1',0,2,12,5,True],['S1',1,1,8,3,True],['S2',0,1,3,12,False],['S3',0,1,7,3,True],['S3',2,1,12,-2,False]],
    conflicts=[['S2',1]], invalid=[['S3',1]], superseded_rows=1,duplicate_rows=1,
    aggregates={'S1':dict(count=2,min=3,max=5,mean=4,in_band=2),'S2':dict(count=1,min=12,max=12,mean=12,in_band=0),'S3':dict(count=2,min=-2,max=3,mean=0.5,in_band=1)})
reference = dict(packing=packing,schedules=schedules,routes=routes,quality=quality)
if __name__ == '__main__':
    print(json.dumps(reference,indent=2))
