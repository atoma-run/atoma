---
name: suite-module-reach
description: Module-reach host fact in delegation reviews (2026-10-17); pre-registered stop rule and what to count from traces
metadata:
  type: project
---

The HOST FACTS block of every delegation review with suites ends with a line naming written modules no suite imports, names or calls into (`src/atoms/parentSuiteReach.ts`), when it can be computed. Firings are countable from traces: review prompts containing "Modules this plan writes that no suite imports". Gate and corpus: records/reviews/suite-module-reach-2026-10-17.md.

**Stop rule (verbatim, pre-registered):**
- A false claim (the module is imported, named, called, or reached through an application module at that workspace state) is fixed or disabled before the next run.
- Remove the line after 2 unjustified refusals (refusals citing a module whose behaviour the task does not name) in its first 10 firings.
- Remove it if, at 20 firings, justified catches do not outnumber unjustified refusals.
- With fewer than 5 firings in 30 days, remove it and record the counts.

**How to apply:** per firing, check the claim against the workspace at that review (false claim?), then classify the review's verdict: justified catch (refusal naming a module whose behaviour the task or criteria name), unjustified refusal, or no effect. Related: [[parent-tests-review-fixes-state]], [[suite-dispute-measurement]].
