# Attica command evidence omitted during review — 2026-10-22

Run `b920faf6-7bd7-4e89-87f8-7176c1c97f92` used revision
`f488de32aa9ec8b9bbbfbca39b32226619b7a99a`. Its validator at event
`79ae0ba8-e508-4dbc-8c3b-d68c021afeaa` said the only observed matrix
invocation failed with “No test files found”. Earlier in that same execution,
trace events 855 and 856 had actually executed the compiled matrix against the
fresh and retained builds with exit status zero. Event 849 was the failed
Vitest invocation of a standalone executable, not a discovered test suite.

A bounded read of the validator's transport-evidence section confirmed the
failed command survived while both successful invocations and the successful
ordinary check were omitted. The section declared 74 omitted observations.
Trace-event IDs and attestation IDs are distinct; presence was checked against
exact command requests, not by comparing those IDs.

## Mechanism and correction

`renderTransportEvidence` reserved browser observations and inspected source,
then selected whole shell observations newest first under a fixed character
budget. Later noise could leave enough space for a short failure while a
longer successful execution no longer fit. The omission notice was truthful,
but the reviewer lacked the observations needed to distinguish the outcomes.

The remaining shell budget now shares space across latest request identities
before their payloads. Complete observations remain complete when they fit;
others carry an explicit partial-observation label and bounded head/tail.
The budget remains 24,000 characters, including line separators. Recorded
probes keep priority, command arguments and branches stay distinct, and a
later failure replaces an earlier pass of the same request. The generic
suffix cannot revive superseded shell observations.

The attestation schema also retains shell exit status directly from the raw
tool result before stdout excerpting. Its rendered suffix survives a partial
receipt even when a long request displaces the beginning of the response.
Output text cannot supply that status; older observations remain unknown.
This adds neither a proof obligation nor an automatic approval or freshness
claim. Omitted assertions still require inspection, and nonzero outcomes
still require interpretation against the contract.

## Regression and adversarial checks

A regression exercises the production L1 execution, attesting executor and
actual validator request with long successful commands, browser observations,
source reads and a short failed invocation. It failed on the original revision
because the fresh matrix command was absent. The corrected path preserves
both matrix invocations and ordinary check/build receipts within the same cap.

Counterexamples cover different arguments and branches, a later recorded
failure replacing a direct pass, saturated histories, multiline output trying
to forge host lines, long requests, misleading stdout exit-code text and
legacy observations without structured outcomes. The existing attestation
and Decision calibration tests retain browser, staleness, budget and
request/result controls. The focused set passes 53 tests.

Review deliberately rejects a larger context budget, command-name heuristics,
paid rereviews, automatic acceptance on exit zero, parsing status from output,
and rewriting historical observations. A subsequent product run is required
to measure any effect on retries; this incident is not a latency benchmark.

## Release verification

After a clean npm installation, `release:check:static` passed, including both
TypeScript configurations, lint, documentation, audit, build and compiled
smokes. The full local suite passed 7,859 tests with 36 skipped and one failure:
the pre-existing macOS Docker bind-replacement test for a SIGTERM-resistant
worker. This failure had also been independently reproduced before this patch.
The source tests and assertion remain unchanged. Successful Linux branch CI is
required before main, followed by every exact-revision main/deployment job.

The live Attica run remains on its original executor; this correction cannot
change an already-running run's context. The owner separately requested a
controlled evaluation of evidence budgets, including the cost of retries;
this patch does not establish that 24,000 characters is an optimal budget.
