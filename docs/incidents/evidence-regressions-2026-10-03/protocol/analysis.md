# Two-process mutual exclusion model-checking study

## Model

`model_check.py` is an offline implementation using only the Python standard library. It performs an exhaustive breadth-first search from the initial state `(0, 0, false, false, 0)`. A state is exactly the five-tuple `(pc0, pc1, flag0, flag1, turn)`, where `pc=3` denotes the critical section. Each edge is one atomic step by exactly one process; every component not assigned by that step is unchanged. BFS evaluates both actors at every state, retains every enabled labeled edge and a predecessor, and discovers states in canonical tuple, actor, and transition order.

The transition labels are `p0:pc0->pc1`, `p0:pc1->pc2`, `p0:pc2->pc3`, and `p0:pc3->pc0`, with the analogous four labels for `p1`. For process `i` and `j=1-i`: `pc=0` sets `flag[i]=true` and advances to 1; `pc=1` sets `turn=j` and advances to 2; `pc=2` advances to 3 only when the variant's guard holds; and `pc=3` sets `flag[i]=false` and returns to 0. No other component changes in any of these atomic transitions.

The correct variant uses the `pc=2` guard `not flag[j] or turn == i`. The buggy variant changes only that guard to `not flag[j]`; all other transitions are identical. States and edges are serialized in deterministic BFS/discovery and process-transition order, with integer state indexes in edge records. Thus the two graph differences isolate the effect of removing only the turn disjunct.

## Graph construction and checked properties

For each variant, BFS starts at `(0, 0, false, false, 0)`, assigns canonical integer indexes in discovery order, and records all enabled edges, not merely first-discovery edges. The stored predecessor map reconstructs shortest traces. The resulting canonical graphs each contain 20 reachable states: the correct graph has 34 labeled edges and the buggy graph has 32.

For every reachable state, the checker tests mutual exclusion by requiring that `pc0` and `pc1` are not both `3`, and tests deadlock-freedom by requiring at least one enabled transition. It emits `results.json` with both state graphs, labeled edges, counts, violations, deadlocks, and the shortest buggy deadlock trace reconstructed from BFS predecessors.

The executable self-check reloads `results.json`, independently recomputes both graphs, compares states, edges, checks, and counts, and replays every transition in the serialized buggy counterexample against the applicable buggy relation. It also checks that the trace endpoint is a deadlock, that no buggy deadlock occurs at a shallower BFS depth, and that the trace length equals the BFS depth of the first deadlock. This makes the counterexample shortest: every shorter reachable prefix is non-deadlocked, and the listed atomic transitions reach the first deadlock layer.

## Results and interpretation

The correct variant has 20 reachable states and 34 labeled edges. It has no mutual-exclusion violation and is deadlock-free. The buggy variant also has 20 reachable states, but only 32 labeled edges: removing the `turn == i` disjunct removes exactly the two `pc=2 -> pc=3` progress edges that the correct relation permits. Mutual exclusion still holds in the buggy graph: no reachable state has both program counters equal to `3`.

The buggy graph nevertheless contains a deadlock. Its complete shortest trace is:

```text
(0,0,false,false,0)
  --p0:pc0->pc1-->
(1,0,true,false,0)
  --p0:pc1->pc2-->
(2,0,true,false,1)
  --p1:pc0->pc1-->
(2,1,true,true,1)
  --p1:pc1->pc2-->
(2,2,true,true,0)
```

At the endpoint both processes are at `pc=2`, both flags are true, and `turn=0`. In the buggy variant each process requires the other flag to be false, so neither transition is enabled. The trace has four atomic transitions. BFS predecessor reconstruction supplies this path, and the checker confirms that its endpoint is a deadlock while no reachable buggy deadlock occurs at a shallower BFS layer. Therefore it is shortest: every reachable state at every smaller depth has at least one enabled transition.

Structurally, the correct guard `not flag[j] or turn == i` lets the process whose turn it is pass when both flags are raised; the buggy guard removes that escape hatch. The change can therefore create a circular wait without creating a mutual-exclusion violation. Mutual exclusion holds for both variants, while only the correct variant is deadlock-free.

These finite-state checks do **not** prove starvation-freedom or fairness. No fairness assumption was supplied. Deadlock-freedom means that some transition is enabled in every reachable state; it does not mean that every process eventually progresses. Exhaustive safety and deadlock checks do not prove starvation-freedom; that would require additional scheduling assumptions and liveness analysis.

## Usage

```text
python3 model_check.py --generate
python3 model_check.py --self-check
```

Generation writes `results.json`; self-check reads it and exits successfully only when the serialized graphs, counts, and counterexample replay pass independent checks.
