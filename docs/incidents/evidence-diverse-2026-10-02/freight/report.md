# Transportation decision report

## Instance

Supplies are `A=7, B=9, C=8`; demands are `X=8, Y=6, Z=10`. Costs (rows A, B, C; columns X, Y, Z) are:

```text
[[4, 6, 8],
 [5, 3, 7],
 [6, 5, 2]]
```

Route `A->Z` is forbidden (`x_AZ=0`). The route `B->Y` has capacity `k`, equal to 4 in the baseline and 5 in the increased-capacity scenario. All shipments are nonnegative integers.

## Rigorous optimality and uniqueness certificate

Let `a=x_AX`, `b=x_BY`, and `z=x_BZ`. The balance equations and the forbidden route imply:

```text
x_AY = 7-a
x_BX = 9-b-z
x_CX = b+z-a-1
x_CY = a-b-1
x_CZ = 10-z
```

Substitution into the objective gives:

```text
C = 4a+6(7-a)+5(9-b-z)+3b+7z
    +6(b+z-a-1)+5(a-b-1)+2(10-z)
  = 96-3a-b+6z.
```

Nonnegativity yields `a >= b+1` and `z >= a+1-b`. Hence, for any feasible shipment with `b <= k`,

```text
C >= 96-3a-b+6(a+1-b)
  = 102+3a-7b
  >= 105-4b
  >= 105-4k.
```

Equality throughout requires `b=k`, `a=b+1=k+1`, and `z=a+1-b=2`. These values determine every matrix entry, so whenever this equality case is feasible it is the unique optimizer. The matrices below are feasible, attaining the bound; therefore each is rigorously and uniquely optimal. The verifier independently enumerates all bounded integer choices and checks the same conclusions.

## Baseline scenario: `B->Y` capacity 4

```text
       X  Y  Z
A      5  2  0
B      3  4  2
C      0  0  8
```

Row sums are `(7,9,8)` and column sums are `(8,6,10)`. The forbidden shipment is `x_AZ=0`, and `x_BY=4<=4`.

Cost:

```text
5*4 + 2*6 + 3*5 + 4*3 + 2*7 + 8*2
= 20 + 12 + 15 + 12 + 14 + 16
= 89
```

The certificate gives the lower bound `105-4*4=89`; thus cost 89 is the unique optimum.

## Increased-capacity scenario: `B->Y` capacity 5

```text
       X  Y  Z
A      6  1  0
B      2  5  2
C      0  0  8
```

Row sums are `(7,9,8)` and column sums are `(8,6,10)`. The forbidden shipment is `x_AZ=0`, and `x_BY=5<=5`.

Cost:

```text
6*4 + 1*6 + 2*5 + 5*3 + 2*7 + 8*2
= 24 + 6 + 10 + 15 + 14 + 16
= 85
```

The certificate gives the lower bound `105-4*5=85`; thus cost 85 is the unique optimum.

## Verification

Run `python3 verify_transport.py`. It uses only the Python standard library, exactly enumerates bounded integer parameter triples, reconstructs each matrix, validates all constraints, recomputes costs, and checks both optimum values and the number of optimal matrices.

The verifier exits nonzero if any disagreement is found.
