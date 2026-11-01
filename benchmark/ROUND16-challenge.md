# Benchmark result

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-sol agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=3: mean $0.3009, median $0.3137
  runs: 0.314, 0.337, 0.252
atoma n=3: mean $0.5774, mean excluding run 1 $0.5308
  runs: 0.671, 0.301, 0.761

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 3 runs: $-0.8296 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.6706 → second half $0.5308

-- held-out task (novel, same family): memorisation control --
  baseline n=3: mean $0.3009
  atoma    n=3: mean $0.5774
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
