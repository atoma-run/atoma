# Benchmark result

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-sol agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=3: mean $0.1926, median $0.2040
  runs: 0.204, 0.207, 0.167
atoma n=3: mean $0.6295, mean excluding run 1 $0.5899
  runs: 0.709, 0.591, 0.589

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 3 runs: $-1.3107 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.7086 → second half $0.5899
```
