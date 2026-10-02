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
