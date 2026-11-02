# Benchmark result

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-sol agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=3: mean $0.2040, median $0.1937
  runs: 0.242, 0.194, 0.176
atoma n=3: mean $0.2025, mean excluding run 1 $0.2234
  runs: 0.161, 0.244, 0.203

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 3 runs: $0.0043 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.1608 → second half $0.2234
```
