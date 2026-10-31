# Benchmark result

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-terra agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=3: mean $0.3257, median $0.3218
  runs: 0.345, 0.322, 0.310
atoma n=0: mean —, mean excluding run 1 —

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 0 runs: — (positive = atoma cheaper in total)
trend across the atoma series: first half — → second half —

-- held-out task (novel, same family): memorisation control --
  baseline n=3: mean $0.3257
  atoma    n=0: mean —
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
