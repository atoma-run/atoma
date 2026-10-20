# Attica root planning context — 2026-10-20

Production MCP identified the newest failure as
`df6802a9-a5d8-4a1b-84d0-bb6974a52aa0`, after the earlier broad failure
`d543fe1d-c89e-493f-958e-43d0080ae10a`. All 419 summary events and the
runner log were read to the end. Five root contract reviews and the final
proposal were read without detail-page omissions.

The latest task concerned durable cancellation. Its five implementation plans
were refused for distinct gaps: navigation cleanup counted as collection;
a self-dependency; an opaque scheduler result; missing plan-level integration;
and a scheduler field/source-graph mismatch. These refusals do not establish
that the application itself is broken. No implementation was dispatched.

A concrete context defect made repair harder. Review a186a5e6 requested a
`nextRunAt` assertion without seeing the scheduler interface. The final planner
prompt (event51578a54, 77,203 characters) retained that request but contained
neither `nextDueAt` nor the host's imported-module block. Final review01fe3029
received 153,574 characters, including the real scheduler's `nextDueAt`, then
refused the plan for using `nextRunAt`. Review facts never reached the planner;
only prose refusals and requests did. Review9b672f52 approved an earlier plan,
but the unchanged mechanical contract correctly refused its missing root suite.

The root repair loop now forwards only its latest bounded host-facts block on
the existing planner-feedback channel. It reuses the existing observation-only
reads and source allowance; it performs no extra tool or model call. A parse
retry retains those facts, a later reviewed plan replaces them, and another
root task starts without them. Repository text remains labelled untrusted;
truncation establishes nothing. Task constraints, prefilter inputs, execution
permissions, five-attempt budget and semantic/mechanical review are unchanged.
Additional planner input can cost tokens; no model-agreement or spending gain
is claimed before live measurement.

A regression uses the real root planner, root review and filesystem-backed
host reader. A deliberately fallible reviewer names the wrong field; the next
planner needs the actually observed module to repair its suite. It fails
before the change. Two variants pass after it, with and without an intervening
unparseable plan. They also prove no prefilter/constraint pollution, no facts
leaking into a separate task, and no blind-overwrite permission from host reads.
The three affected suites pass (102 tests), as do both TypeScript configurations,
focused lint and docs checks. The parent-suite tests retain real runner-boundary
cases. No paid model replay was used for these checks.
