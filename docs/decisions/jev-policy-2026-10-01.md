# Jev policy and evidence corrections — 2026-10-01

Implementation follows the review of TypeSafe's [state guidance](https://docs.typesafe.ai/concepts/state),
[confidence](https://docs.typesafe.ai/confidence), [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion),
[entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment), and
[consistency](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook).

## Changes

- Approval questions now include each task constraint. Existing phase proof
  obligations travel through the production validator. Explicitly scoped
  checklist items can be supplied to `jevApproval`; root acceptance criteria
  are never inherited from arbitrary `Task.inputs`. Prose splitting remains a
  fallback, not an assertion that a sentence is atomic. Short or numerous
  requirements are no longer merged. More than 48 items defer to the validator.
  Each result question requires observations matching the item's target and
  check; missing evidence is `not_shown`, and child claims are not observations.
- `ATOMA_JEV_PROGRESSIVE_RECIPES=1` on a run's environment enables the
  experimental roster Choice followed by detailed Choice/Noul checks on the
  top three groups. Default remains one pass. Ranking cannot approve a recipe
  or prove that the full roster has no fit. Deferral preserves the full model
  catalog except recipes explicitly found incompatible. Both calls share the
  normal decision deadline and are recorded, including their costs.
- Twin questions carry both bodies under the same 700-character head/tail
  budget. Comparisons use batches of 16 instead of silently stopping at the
  first 48 entries. Batches share one decision deadline; a failed or incomplete
  comparison saves as before and reports partial coverage. A positive twin
  may stop the scan early; a negative result requires the whole scan. Truncated
  bodies remain incomplete evidence, not a guarantee of semantic equivalence.
- Approval distributions survive in trace events. The historical
  `probability`/`yes.acceptable` fields remain compatible, but the number is
  described as a decision score, not P(all requirements are correct).
  `atoma_jev_calibrate({auditsOnly:true})` also returns per-run/role costs,
  audit costs, same-run model baseline sample counts, estimated net savings,
  and subsequent root refusals, tool failures and fallback events. These are
  correlations, never causal labels or ground truth. No baseline means null
  estimated savings. The response bounds reports to 25 runs, 100 approvals per
  run and 25 references per signal; counts identify omitted run/approval detail.
- Exact fallback caching now includes a SHA-256 identity of model, thresholds,
  actual questions, candidate bodies, task inputs, tier and selection mode.
  Model-only entries cannot bypass Jev. Only successfully examined, parsed
  model fallbacks enter the guarded cache; outages and unknown custom deciders
  cannot populate it. A warm guarded entry requires no additional Jev call.
  JSON framing also removes delimiter ambiguity from the exact input key.

## Adversarial review and validation boundaries

Regression cases exercise the real decider and prefilter: omitted constraints,
independent short requirements, a twin beyond entry 48, interrupted comparisons,
shortlist-relative absence, changed recipe bodies, model-only cache crossover,
and costs with no reference sample. Existing gate, trust, root acceptance,
learning suppression and cancellation tests remain applicable.

No live provider call or controlled quality measurement is part of this change.
The numerical thresholds and pinned model stay unchanged. Corrected state and
questions still require live calibration before claiming a quality gain; the
two-stage option must be compared with the default on the same cases, counting
both round trips, fallback calls, audits and later remediation. Existing random
audits remain a model comparison, not independent correctness labels.

The root checklist is deliberately not copied into phase validation: an
unfinished phase should not be required to satisfy every final delivery item.
The task's own structured proof obligations are the existing scoped source.
No lexical evidence matcher, new paid drafting call, or semantic cache is added.

## Local verification

The seven Jev/cache test files pass: 115 tests, including eight new policy
regressions. Both TypeScript configurations, ESLint and the production build
pass. No provider was called.

The full repository check is not green on this Windows host. An isolated
coordinator failure expects `/control/...` while `path.resolve` returns
`C:\control\...`; the broader suite also reports shell, symlink and retrieval
environment failures outside this change. These failures have not been waived.
The suite subsequently stopped producing output with three workers still alive;
its verified test process tree was terminated. No complete-suite pass is claimed.

`viz:smoke` passes browser OAuth and reports no WebGPU errors or diagnostics,
but fails rendering/scroll timing bounds (welcome P95 50.30 ms; scroll rebuild
P95 64.7 ms). No timing threshold was changed. This is local implementation
verification, not release readiness or evidence of a measured Jev quality gain.
