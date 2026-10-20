# Attica: lost observations and self-reported test outcomes

Run `ba6b0a21-ee0b-48a8-ad8d-a46e8d1d33c5` ran on production revision
`5a1622bcff9e13b4040b79cf26e7c13475d57078`, from 05:32:40 to 06:57:58 UTC
on 2026-10-20. It landed partial after 228 model calls, seven escalations and
one root repair. Its $7.4471 is subscription-equivalent accounting, not an
additional API invoice. All 2,519 summary events, the complete final result
and runner log were read through the production MCP. Referenced detail events
were concatenated to the end before parsing.

The earlier [planning-context fix](attica-planning-context-2026-10-20.md)
worked: planner event `260e855e-0097-4ea7-93e9-ffc2f86f4725` received the
previous review's host facts, including `nextDueAt`, and its revision passed.
The new failure was not a planning exception or the 90-minute deadline.

## What failed

The final parent suite `11b23f66977e545a` failed seven of seven scenarios
(acceptance event `2d1879b9-89b1-4c25-b604-f910b06632cc`). The implementation
phase's failure blocked final compiled-UI verification and documentation.
No Attica acceptance or publication took place. Those failures are not seven
established application defects: several assertions and scenario helpers were
themselves wrong.

Three Atoma mechanisms contributed:

- A direct `run_shell` observation had no reservation in the 24,000-character
  evidence selection. Browser observations, file reads and `record_probe`
  observations had reservations; remaining executions competed for a suffix.
  Review `91d462db-1b69-4fe7-b0a1-0e626622c1cc` omitted 247 observations.
  Its transport block retained an inspection command but no installation or
  check execution. It then requested those checks again. Earlier successful
  runs are not automatically current proof, but omission cannot establish
  that a command never ran.
- Both text aggregators passed the task description and model-authored
  summaries/outputs to synthesis, but no typed criteria, tool witnesses or
  parent-test observations. Final synthesis
  `b782bf9d-f5b8-4a1f-9c19-45fa1b63626d` explicitly reconstructed a thematic
  c1–c12 list because it lacked the official list. It also reported earlier
  executed work as unavailable. Carrying evidence in the returned Result did
  not make it visible to the model composing that Result.
- Parent suites delegated all scenario setup and observations to a test
  helper the same implementation child authored. Reviews `8b4c40fb` and
  `a7053631` correctly caught fabricated outcomes. Later reviews focused on
  whether the helper called the supplied factory; the final child suite proved
  only that property while the behavioral parent suite still failed 7/7.
  Calling a real factory does not make independently invented counters,
  statuses or persistence summaries reliable. Some expectations also used
  unsupported field names or mixed real and injected clocks.

The L2 planner did receive its refusals: the complete system prompt of
`2462f980-437d-4eb9-a044-83d9e1c57160` contains coaching and verbatim
feedback. Looking only at userContent would have misdiagnosed another missing
feedback channel. No change to retry budgets, routing models or trust follows
from this incident.

## Corrections

`renderTransportEvidence` now reserves space for direct shell observations
after the existing recorded-probe reservation. Selection keeps the latest
request outcome, failures included, and distinguishes arguments, attempt and
branch. Notes do not create another check. A later direct rerun of a recorded
command replaces its earlier outcome in the reservation. The total budget,
browser retention and inspected-source reservation stay unchanged. Surplus
observations can still be omitted explicitly; no selection establishes that
old source, dependencies or runtime state are unchanged.

L2 and L3 synthesis now share `synthesisContextLines`: exact scoped criterion
ids/text, constraints, the existing bounded transport-evidence block, and the
existing host parent-test block. Reports remain separately labelled fallible.
No repository-input blob is copied, no tools are replayed and no acceptance or
trust credit is added. No additional model call is introduced.

The single shared parent-suite sufficiency instruction now distinguishes
application observations from a child-authored test helper's claims. The
parent owns the contract-bearing setup/actions/observations; factory-call
coverage supplements behavioral assertions. External fixtures and legitimate
utilities remain permitted. Review also distinguishes a planned interface or
expected failing regression from an impossible interface, and does not demand
the finished repair before it can be delegated. Existing semantic review and
the blocking-defect contract remain in force; no lexical gate was added.

## Adversarial review and regression evidence

This is a mechanism review against the existing browser-retention, stale-read,
recorded-probe, delegated-scope and parent-test contracts, not an independent
model vote or a claim that a live model will always judge correctly.

- Forty later source reads must not erase observed installation and a failed
  check rerun from the actual L1 execution → validator request. This regression
  failed before the change. The failure remains visible; an initial pass is
  not substituted for it.
- Different command arguments and different branches must retain separate
  observations. A later direct failure must replace a recorded pass of the
  same request, even amid forty other shell commands. Existing recorded
  mutation-proof, browser, superseded-source and calibration tests still pass.
- Both real L2 and L3 dispatch → synthesis paths must receive original scoped
  ids/text and observed compiler failure beside a contradictory branch report.
  These two regressions failed before the change. Reported probe claims do
  not become transport facts, a large repository input is not resent, and the
  synthesis call remains tool-free with the same call count.
- A fixture feeding controlled external responses remains legitimate. A test
  utility arranging inputs is not automatically the product under test.
  Conversely, a helper that calls createServer and returns constant successes
  cannot be its own oracle; one factory assertion proves only the call.
- A new API explicitly requested by the task may be declared before it exists.
  An arbitrary `id` alias or status invented only by a test is not such a
  requirement. A red regression before the repair is expected, not grounds
  to refuse planning solely because the current code is still broken.

The changes do not repair or publish the partial Attica workspace, do not
weaken its failed suites, and do not establish a successful full recipe.

Local verification on pinned Node 24.20.0: fresh `npm ci`, 215 targeted tests
across 11 files, both typecheck configurations, focused ESLint, `docs:check`,
`git diff --check`, and the compiled `npm run build` all passed. A new paid
Attica run was not used as a substitute for these regressions.
