# Text delivery through the full project runner

Production revision: `958d4219c4f474e2c94175cefffa43bb610dcc2c`.
These are diagnostic runs, not a comparative benchmark. Both completed without
operator cancellation; earlier cancelled attempts are not terminal-outcome evidence.

| Run | Elapsed | Observed outcome |
| --- | --- | --- |
| `c8c67a68-91ca-4205-ab71-6c9c90460333` | 1658.852 s | Root refusal after one remediation; final audit invented resources. Coordinator then failed on empty inventory. |
| `36606853-fde0-444e-b4a1-6122857d1c4c` | 588.476 s | Correct final arithmetic accepted after remediation; coordinator failed because no publishable file existed. |

The MCP summary was paged through all 363 and 222 events respectively, and
both final metadata documents were read to the end. Jev selected Xylem in both.

## Mechanisms

The first plan omitted task durations and assignments from the child description.
Neither tier passed the original request; sequential phases passed only a summary.
The molecule searched for a source file instead of using the supplied facts. Root
remediation recovered the complete model, but a later audit invented R1/R2/R3 in
place of M1/M2. The root correctly refused it.

In the smaller problem, a correct text response received this mechanical coaching:
“No successful tool action was observed.” Event
`05099414-94ea-40b4-91be-2c5350201be2` records it. An earlier phase wrote
`timetable.md`, was restored, and the root refused that pass. The final corrected
answer was accepted (`a0dcf3ef-f2da-4395-b193-4d742f46c255`), but project
finalization required a nonempty file inventory and recorded failure.

## Correction and adversarial review

- Preserve one original task across L3/L2 delegation, including structured input
  and constraints. Child inputs cannot impersonate it. Keep phase scope separate.
  Validators receive facts separately from phase requirements; the root checklist
  stays scoped. Jev calibration replays the same separation from recorded prompts.
- Pass the preceding structured answer, bounded with an explicit truncation
  marker, alongside the summary; never silently treat a truncated answer as whole.
- Declare reasoning execution structurally in the existing planner call. Disable
  tools and executable skills on that task and all descendants, including fallback.
  A descendant asking for tools cannot widen the parent. Only this declared mode
  bypasses the observed-action gate. File builders still need witnessed actions.
- Declare text delivery independently: research can need tools and still deliver
  text. Preserve the result in its trace and atomically record its inventory, even
  when empty. Do not invent an answer file or publish an unchanged input repository.
- Keep semantic root acceptance. Text declaration grants no automatic approval;
  failed/cancelled trace checks, inventory path/size checks and refusal outcomes
  stay intact. Empty ordinary file delivery still fails. A partial answer remains
  partial instead of being rewritten as a host failure.
- Refuse manual publication of text deliveries too. Existing manifest hashes
  are stable because new fields are optional and never backfilled.

Regression coverage exercises actual L3→L2→L1 dispatch, direct and fallback LLM
requests, the runner declaration file, coordinator completion and publication
reservation, plus existing file-action and inventory regression suites. No paid
model call is needed for these tests. Live validation of the fix requires deployment.

## Production follow-up on revision 0b02fa7c

Deploy workflow `37011512311` installed `0b02fa7ccb836fbceedc7b39113cbe1a2098e8ec`
at 13:13:48 UTC. Its workflow head was the later translation commit `3466f1ac`;
the downloaded release receipt and all three run traces identify `0b02fa7c`.

| Run | Elapsed | LLM calls | Subscription-equivalent USD | Outcome |
| --- | --- | --- | --- | --- |
| `30f5e5df-f6ac-4e16-98cf-4a16f8fa5628` | 166.462 s | 15 | 0.0689 | Tiny scheduling regression delivered; bound 6. |
| `6e88f329-08c6-4de9-891d-3f0375a59140` | 179.299 s | 11 | 0.0692 | Full scheduling regression delivered; bound 8. |
| `763ca259-dffd-4946-89ab-18c9c75be7e2` | 269.832 s | 12 | 0.1435 | Phloem created; malformed replan terminated execution. |

The first two reused Xylem, invoked no elements, delivered text with an empty
inventory, and passed root acceptance without remediation. The second was seeded
from the first text delivery. These are individual regression observations, not
a controlled performance comparison: registry trust and other code changed.
The summary readers reached their ends (64, 56 and 47 events), and metadata was
read completely for each run.

The third project asked for exact Bayesian inference over three urns and an audit
of a with-replacement shortcut. Jev deferred the root choice; the router requested
a new tissue. Event `3350ee5c-c64b-4f6e-9683-a8196b13982f` records the platform
author using `sub:openai:gpt-5.6-sol`. Event
`4ebfaf5d-a81f-4c0b-891c-081879231305` records Phloem's creation. Its reusable
capability prompt decomposes probabilistic analyses and independent verification
across cells. Its first plan declared text delivery and four reasoning phases.

### Result coaching contaminated the next plan

In event `c39405c3-0422-43dd-a65d-fa9f2526911e`, Insulin returned correct
arithmetic as plain Markdown instead of the required result envelope. The
without-replacement evidence is 1/2, posterior (8/15, 16/45, 1/9), and predictive
probability 22/45. Replacement changes evidence to 5/12 and prediction to 133/270
while preserving the posterior. The mathematical answer was not the failure.

The non-JSON result gate injected coaching
(`97946741-cb78-4b9f-a7fd-a24f396d8e55`) demanding output/summary. Supervision
correctly restarted at planning, but that coaching and the reasoning system
prompt both demanded a result. Event `9c006c44-8a5c-4f05-9af0-80970b52f1b4`
therefore returned an output/summary envelope with a plan nested inside output.
The strict plan parser rejected it and the run failed.

The correction separates reasoning-plan guidance from execution guidance and
makes envelope coaching explicit about both phases. It changes no parser, gate
disposition, retry budget, or supervision sequence and adds no model call.
The regression drives real L2 delegation and L1 execution: a prose first answer
is rejected, the actual coaching reaches the next planning request, and a second
execution returns the accepted envelope with no tool access. Existing fallback
coverage still exercises tiers 1, 2 and 3. This correction needs its own deployed
rerun; the successful scheduling runs above do not validate it.
