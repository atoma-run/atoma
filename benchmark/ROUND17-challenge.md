# Benchmark result

```
== PRE-REGISTERED RESULT ==

control  : one sub:openai:gpt-5.6-sol agent, plain tool loop, self-certifying
treatment: atoma, L1=sub:openai:gpt-5.6-luna L2=sub:openai:gpt-5.6-terra L3=sub:openai:gpt-5.6-sol

baseline (frontier direct) n=3: mean $0.3307, median $0.3511
  runs: 0.355, 0.351, 0.286
atoma n=3: mean $0.3139, mean excluding run 1 $0.2994
  runs: 0.343, 0.271, 0.328

H1 SUPPORTED: cumulative break-even at run N* = 2.
cumulative delta after 3 runs: $0.0504 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.3430 → second half $0.2994

-- held-out task (novel, same family): memorisation control --
  baseline n=3: mean $0.3307
  atoma    n=3: mean $0.3139
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
