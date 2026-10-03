# Diagnostic experiments after reconnecting MCP — 2026-10-03

The owner requested continued experimentation after the unresolved text-audit
false approvals. Five production runs were executed serially in three new
projects, all on release `e4ee061075118c7ec3474dba9da837dd786dc0ac`. No
runtime code, account model defaults, or trust state was manually changed.

## Preregistered cases and independent review

The editorial battery contains four candidates: invalid ending with a false
all-pass claim (A), valid text with a false rejection claim (B), a five-word
line with a false four-word claim (C), and valid text with a correct claim (D).
B and D have identical candidate bodies. Expected values were saved before
launch. A comparison rerun preserves the original goal, criteria and empty
starting workspace and changes only the requested L1 selector to Terra.
L2 remains Terra and L3 Sol. This changes execution and root review together;
it does not isolate reviewer capability.

The fair-division oracle enumerates all six feasible assignments. The scoped
follow-up changes only B's valuation of d from 9 to 0. The confounding case
uses supplied fictional counts with known within-group, pooled and
standardized rates. Reference calculations are reproducible without model
calls:

```sh
python docs/incidents/evidence-audit-comparison-2026-10-03/recompute-oracles.py
```

## Results

| Case | Run | Calls | Seconds | Subscription accounting USD | Independent result |
|---|---|---:|---:|---:|---|
| Editorial, Luna L1 | 2b0f701b-7977-4ab5-9536-955fd4406911 | 6 | 107.926 | 0.0816 | FAIL: A, B, D wrong; C correct |
| Same editorial, Terra L1 | 4278b3f6-5833-4bb9-9f7a-7bfedfc6677c | 6 | 90.347 | 0.1402 | PASS: all four cases correct |
| Fair division | f13734c2-b7eb-4d10-aa86-ba2df4cecca5 | 10 | 221.403 | 0.1548 | PASS: complete enumeration and conclusions |
| One-preference update | 13dbffa7-a190-49c3-b48d-06a07e9f1f05 | 10 | 209.746 | 0.0742 | PASS: ties, frontier and changed envy correct |
| Confounding / standardization | 07c7aeab-a49b-4d47-b23c-8654bb3c0d7f | 8 | 129.845 | 0.1402 | PASS: arithmetic and causal limits |

Total: 40 calls, 759.267 seconds of run time and $0.591 subscription
accounting, not an additional API invoice. Every production status says
delivered, including the independently failed editorial result. Every
artifact manifest declares text with zero files; no publication was made.

### Editorial failure is downstream of a correct root plan

Mesophyll's Luna-arm root plan explicitly supplies the correct observations
for all four cases. Insulin's final answer instead reports A as compliant
with dawn/dusk and B/D as noncompliant with home/dusk. The Luna root reviewer
approves all three wrong rows as matching the source. Counts and acrostics
are correct, and C's long line is detected. This is one false approval and
two false rejections of candidates, not merely a bias toward all-pass claims.

The Terra arm uses the same Mesophyll and Insulin and gets all observations,
verdicts and author disagreements right. Sequential trust changes and
nondeterministic plans remain confounders; four related candidates in one
run are not four independent model trials. No universal model upgrade is
justified by this small diagnostic sample. The default Luna false-approval
defect remains OPEN; these runs do not fix it.

### Allocation controls pass with Luna

Parenchyma uses two phases in both runs. In the baseline, A=ab and A=ac are
Pareto-optimal; A=ac uniquely maximizes sum (27) and product (180).
A=ab/ac/bc are envy-free; the dominated A=bc case is correctly distinguished
from Pareto optimality. All six utility rows and all thirteen listed
dominance relations match independent enumeration.

After changing B(d) to zero, the frontier is A=ab/ac/ad, sum maximizers are
ac and ad (18), product has unique maximizer ad (81), and only ac/ad are
envy-free. Every own/other valuation and the changes from the earlier result
are correct. The answer remains scoped to the requested numerical update.

### A new tissue is authored for stratified analysis

The confounding run creates **Collenchyma** through
`platform-tissue-author`, recorded on `sub:openai:gpt-5.6-sol`.
Its reusable workflow covers stratified rates, direct standardization,
weighted pooling and causal limits. The saved author response contains no
case-specific counts or method names and permits multiple L2 cells when
independent verification is useful. The executed root plan uses one compact
reasoning phase.

The final result gives 90%/20% for X and 95%/80% for Y within strata; both
pooled rates are 83%. At a common 50:50 mix, X is 55%, Y is 87.5%, a 32.5
percentage-point difference. It explicitly does not infer randomization,
within-stratum comparability, absence of confounding or a causal effect.
The final corrective sentence is consistent with those descriptive results.

## Evidence and limits

All summaries were read to `nextOffset=null`; metadata and selected full
L3 plans, executions and result-verdict events were paged to completion.
The evidence directory retains requests, outputs, model selectors,
release provenance, timings, user criteria and manual assessments. New
projects are editorial-audits-20261003, fair-division-20261003 and
archive-confounding-20261003.

This is diagnostic evidence, not a controlled benchmark or proof of
general reliability. The next correction should address the failed
execution/review policy with both valid and invalid controls. Adding more
assurances to the prompt or treating delivered status as truth has already
failed. The successful arithmetic cases also argue against a blanket claim
that the cheaper model cannot do structured reasoning.

