# Tool-evidence budget pilot, 2026-10-22

**The pilot does not establish 24,000 characters as an optimum. It demonstrates both a selection defect and a cost tradeoff that cannot be evaluated from prompt cost alone.** The production selection repair is deployed at `00546c625d4bc2da3be77da3b1f26e2da8f41555`; the default remains 24,000 characters pending stronger end-to-end evidence.

Open `report.html` for the interactive comparison and retry-cost sensitivity calculation. `analysis.json`, `followup-source-complete/analysis.json` and `verification.json` contain the numerical results. The report is self-contained and makes no external requests.

## Projection audit

The preregistered audit reconstructed 67 completed L2 result validations from three related Attica runs. Eligibility required an exact match with the actual baseline 24k rendered evidence lines, not a best-effort reconstruction. The b920 development incident was explicitly identified as previously known, not held out. Only numeric metrics, hashes and identifiers left the production host; prompts, command text, artifacts and raw traces did not.

Across 1,137 latest-command receipt **occurrences** (some repeated across contexts), the old selector retained 335 / 503 / 738 / 1,023 at 12k / 24k / 48k / 96k. The repaired selector retained 746 / 983 / 1,119 / 1,137. At 24k this is 44.2% versus 86.5%. Partial receipts count as retained identities/outcomes, **not** complete assertion coverage or freshness. A larger cap also changes proportional read reservations; this evaluates the production selector's budget behavior, not a separate allocation policy.

These results justify fixing the demonstrated disappearance of successful commands. They do not establish which cap minimizes total cost or produces correct deliveries.

## Initial model series: preserve the confound

All 80 preregistered tool-free `gpt-5.6-luna` calls completed without transport or parse errors. Five independently executed library fixtures, eight selector/budget arms and two repeats were compared serially on the existing owner subscription. The 64 judgments of oracle-incorrect cases all refused them. The oracle-correct fixture was refused in 10 of 16 judgments.

Several positive-case refusals reasonably requested proof of the otherwise-available sixth book. The seed source establishing that fact was absent from every initial prompt. Therefore these oracle disagreements cannot all be called false refusals caused by truncation. Additionally, the prepared 48k and 96k requests were identical in this initial series; differences between their model judgments measure variation, not a budget treatment.

The complete initial inputs and responses remain unchanged. Direct cost was **$0.26052996 subscription-equivalent**.

## Separately registered source-context control

The follow-up was registered before any of its calls. A before-call amendment preserved its first prepared version, supplied the actual independently executed implementation in complete 1,000-character read pages, and raised identical unrelated shell padding from 16 to 64 records so all eight arms genuinely differed. Every raw source page was checked against the canonical 1,600-character observation cap. Tests and oracle labels were unchanged. The 12k render may still omit source pages; that is an observed effect of the budget, not an extra fact supplied only to one arm.

All 40 calls completed without transport/parse errors. The 32 oracle-incorrect judgments all refused. On the single oracle-correct case:

- The old selector refused at 12k (seed/precondition source omitted), accepted at 24k, refused at 48k (test execution receipt omitted), and accepted at 96k.
- The repaired selector refused at 12k and 24k (test receipt omitted under 65 distinct shell commands), and accepted at 48k and 96k.

The receipt's disappearance is mechanically observable in the frozen requests. The result also shows a remaining capacity limitation of the repair: it prioritizes recorded probes and bounds the number of direct-command excerpts that fit. It does not guarantee preservation of every command under arbitrary evidence pressure. This experiment adds no runtime gate or automatic approval.

Increasing a greedy selector's budget need not monotonically preserve a particular receipt. Selecting relevant proof and supplying required preconditions both matter. This is one positive fixture, with one follow-up call per arm, not a population estimate.

Direct follow-up cost was **$0.12957308 subscription-equivalent**; both series together cost **$0.39010304 equivalent**. These are canonical model-price equivalents on the existing subscription, not a separately billed API invoice.

## Cost of retries

Cache state materially affected observed prices. The analysis reports actual usage/cost and a separate no-cache price sensitivity calculated through the same pinned `estimateCostUsd`/`pricesFor` functions. Cache reads are added back to uncached input for that calculation; no duplicated billing formula is introduced.

In the five-case follow-up distribution, the repaired selector's mean no-cache equivalent cost increased from $0.00534948 at 24k to $0.00630124 at 48k: **$0.00095176 per judgment**. The one correct case was refused at 24k and accepted at 48k. Under this artificial case mix, one such extra retry in five judgments reverses the direct-cost ranking once a retry costs more than **$0.0047588 equivalent**. This is a labelled sensitivity calculation, not measured full-run savings or a production refusal frequency. False approvals are reported separately and never treated as cheap successful decisions.

The actual Attica interval after refusal `79ae0ba8` through the first root acceptance check contained **13 model calls, 91 tools, 470.505 seconds elapsed and $0.54252156 equivalent**. It included concurrent or unrelated work. It is **not** valid to attribute all of it to evidence omission or claim that the repair saves this amount. Other historical windows overlap and must not be summed.

The owner is therefore right to include retries in the relevant cost. A causal optimum requires paired ordinary runs with the same goals, inputs, models, payer, sandbox, limits and a preregistered stopping rule, while recording shared-catalog/order effects. Another unchanged 90-minute Attica run plus review did not fit the authorized session. No late run was admitted to manufacture that evidence.

## Reproduce and verify

Use pinned Node 24.20.0 and an isolated source checkout at `00546c625d4bc2da3be77da3b1f26e2da8f41555`. Set `ATOMA_EVAL_SOURCE_ROOT` to its absolute path. `node --import tsx analyse.mjs` and the same command with `--followup` recompute the two analyses; `node --import tsx verify-study.mjs` verifies both complete measured series, immutable request hashes, model identity, pre-call registration, call counts, distinct follow-up inputs, and canonical costs. `node render-report.mjs` rebuilds the HTML.

`replay.mjs` without `--live` prepares requests without paid calls. The live path spends quota and has a terminal-run receipt guard, serial calls, a first-error stop and the fixed 06:55 UTC study deadline. Do not remove those guards or silently change measured requests. The follow-up has its own driver and immutable files. The fixture re-execution command is the existing `benchmark/proof-replay-2026-10-04/prepare.mjs`; it independently reproduced all original/mutated outcomes while preserving the older measured series.

The numerical cohort and request identities are in `projection-audit.json`, each `execution-plan.json`, and `verification.json`. This is a retrospective selection audit and a small previously known fixture pilot, not an unseen cross-product benchmark or end-to-end delivery experiment.
