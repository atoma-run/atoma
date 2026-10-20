# Attica: inspection asked to prove an already repaired state

Run `e457d2c8-74f1-49e3-b1b7-4d4df1deba31` ended partial after 168
LLM calls ($8.0514 API-equivalent usage). Its discovery branch
`89c20abe-111f-4cf4-a605-946428443254` made 21 LLM calls over 474 seconds
($0.234595 API-equivalent). These are observations, not estimated savings.

The L2 plan at event `60487661-9363-40a5-99ad-7eb283b2c81c` asked its
first child to establish a normalized row without an own `id` property,
while explicitly forbidding edits. The source still contained that bug.
The child correctly observed `ownId:true`. Six result reviews rejected it:
`d3d78d32`, `8e16ec37`, `2f13637a`, `59f24c36`, `f962b818`, `9ef3b016`.
Some feedback requested a repair during that read-only phase.

The host had correctly marked root criteria as context (`unassigned:true`)
for discovery. Dispatch preserved that status. However,
`criteriaAssignmentLine` told planners that **every** listed criterion
would become the child's requirement. The planner copied the desired end
state into the child task. The read-only task banner appeared in verdict
requests but not planner/executor task context.

The correction distinguishes binding criteria from contextual evidence
routing, exposes the existing host read-only marker to every task-context
consumer, and asks planning and contract review to catch an inspection
whose success requires a repaired state. It does not override verdicts,
infer phase intent from keywords, or remove root acceptance criteria.
Read-only execution and workspace restoration are unchanged.

Regression coverage exercises real L2/L3 planner request construction,
mixed user/drafted/context criteria, dispatch retaining contextual status,
and root criteria remaining binding. Both new planner cases failed before
the change. Existing read-only restoration and validation-context tests
also pass. These deterministic tests establish prompt construction and
host behavior, not a guarantee that a live model will follow the guidance.

The same run also introduced application regressions: `safetyStop` became
an unconditional null, `adapter` omitted its safety checks and reported
constant request counts, and `duplicates` always returned an empty
possible-duplicate list. Its final clean check still failed three Node
suites. Those require an ordinary Attica correction run with the preceding
JavaScript source available for comparison, preserved historical tests,
and complete clean-install/check/build evidence. The normalizer's removed
`id` alias must not be restored with those historical behaviors.
