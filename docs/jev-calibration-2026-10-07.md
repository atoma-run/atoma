# Jev production review and audit coverage — 2026-10-07

The October 1–7 corpus supports keeping the decision thresholds, while
improving result-audit coverage and consistency of task context. It does not
establish calibrated probabilities or an independent false-approval rate.

## Recorded evidence

[The corpus](../benchmark/jev-audit-2026-10-07/corpus.json.gz) records the MCP
source, window, run revisions, per-role counts/costs, original decision
distributions and annotations for all sixteen Jev-approved results. The
[annotation index](../benchmark/jev-audit-2026-10-07/approvals.json) is readable
without decompressing the corpus. It covers
160 project traces across the six organisations queried, beginning October 1
at 00:28 UTC and ending with the run started October 7 at 09:16 UTC. Six
operator traces are recorded separately. Every summary page was read to its
end; bounded outcome reports were read backwards in date windows to exhaust
their 25-run cap. Selected full events were paged to completion. No new Jev
evaluation or model run was made for this analysis.

Project traces contain 1,340 Jev events: 775 prefilters, 211 plan judgments,
112 result judgments, 69 compilation decisions, 93 effort decisions and 80
recipe-comparison events (including intermediate batches). Jev approved 108
plans and sixteen results. All nine observed plan audits agreed with Jev;
there was no result audit. These are model references, not ground truth.

Six result approvals in three runs preceded a root refusal. The annotations
retain those signals without calling them six false approvals:

- `cc7ed6f1`: altered raw observations survived despite matching summaries.
  The exact-preservation execution prompt did not carry the original table.
  The next report phase used those observations as its source. Both received
  score 0.94; the root required correction.
- `c8c67a68`: a phase approved at 0.88 lacked the original resource model and
  no-files constraint. Its plan already requested a file. The root refused
  incorrect resources and a forbidden file.
- `81375f01`: inherited-check regressions and later incomplete replay explain
  the root refusals; they are not independent labels of each phase judgment.

The first two runs predate the original-task and declared-reasoning fixes in
[the October 2 record](incidents/text-delivery-2026-10-02.md). The current
delegation path already preserves one original task through L3 → L2 → L1.
The inherited-check case also predates subsequent verification corrections.
Historical scores must not be fitted as though all these runs used today's
policy. Every `independentCorrectness` value in the review remains null: root
acceptance alone does not prove local correctness, and no blinded independent
adjudication of all sixteen decisions was performed.

## Implementation

- Keep `JEV_AUDIT_RATE = 0.1` for plans; use `JEV_RESULT_AUDIT_RATE = 1`
  for results. Every eligible Jev-approved result schedules its ordinary
  model validator as an audit, at both supervision tiers and through forks.
  An explicit numeric `createJevAudit(rate)` still overrides both subjects;
  a custom registry without `resultRate` retains its shared `rate` behavior.
- Audits remain observational: they cannot reverse an approval, add trust,
  credit a skill, or trigger a repair. They use the existing validator/model,
  evidence and `jev-audit` role. Failed or deadline-cut audits remain unknown;
  scheduling all results does not guarantee a completed reference for each.
  The runner's existing settle bound and accounting stay unchanged.
- Tool-bearing molecule planning/execution and supervisor fallbacks now use
  `taskContextLines`, as model and Jev validation already do. Execution was
  missing the current task's explicit constraints, and fallbacks omitted them
  in both planning and execution. The host-owned typed `originalTask` also
  wins over a stale or forged input mirror and renders without that mirror.
- The root planner retains its checklist; delegated phases do not inherit it
  as local requirements. The tool-bearing molecule planner also retains its
  existing checklist context, including when a whole-task prefilter shortcut
  skips supervisor planning. Original facts/constraints stay binding, without
  making forthcoming phases a prerequisite for the current phase.

This adds one ordinary validation call per eligible result approval, rather
than a 10% sample. It adds no execution or verification tool replay. Costs
remain attributable to `jev-audit`. Decision thresholds, questions, model,
trust bypass, recipe floor and effort holdout are unchanged. Reassess the
result sampling rate once scoped, completed reference judgments provide a
useful sample; no automatic reduction or accuracy claim is built in.

## Adversarial review and checks

The accepted mechanism was checked against the source-loss incidents, the
later [phase-scope correction](incidents/planning-scope-2026-10-03.md), and
existing audit/evidence contracts:

- A forged `inputs.originalTask` cannot replace the typed original, and
  rendering does not mutate caller inputs or strip their stored checklist.
- The same exact CSV and explicit constraints reach actual tool-execution
  prompts at tiers 1, 2 and 3, including both supervisor fallback paths.
- Root planning still sees its checklist at both tiers; phase execution and
  validation do not acquire unrelated final acceptance items.
- A model audit refusal leaves Jev's result approved. Result sampling through
  a fork still occurs when the random draw excludes a plan; legacy opt-outs,
  failure handling and bounded settling remain covered.
- Existing production delegation tests cover original inputs through both
  tiers, sequential previous results, reasoning-only tools, and phase proof.
  Calibration parsing continues to read the real validator prompt layout.

No lexical gate, synthesized constraint, new model judge, threshold fitting,
or automatic rejection was added. Mocked regression tests prove propagation
and audit behavior, not a live gain in judgment quality.

Validation: the six targeted files passed all 57 tests. Documentation checks,
both TypeScript configurations and ESLint passed. The full suite passed 5,623
tests, skipped nine, and failed three outside these changes: two graphics
assertions being updated concurrently and a process-seat timing test. Their
three files subsequently passed all 27 tests in isolation. This is not a
claim that the complete suite passed in one invocation.
