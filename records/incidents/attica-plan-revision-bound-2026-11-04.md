# A plan revision must retain the whole plan's suite budget

Attica run `05614ddf-41d5-4891-b192-b3a600082eda` ended failed on
2026-11-03 at 23:35 UTC, before its implementation phase. Its read-only
discovery completed, then the root contract review requested durable-store,
CSV-header and HTTP assertions. Four subsequent planner-authored suite
replacements were refused by the delta schema: 8,871, 8,184, 8,149 and 8,207
characters, respectively. The five-attempt root budget ended normally; no
unreviewed plan executed and no customer delivery was published.

`parentTests.ts` defines an 8,000-character planning target, a 12,000-character
newly authored suite bound and a 32,000-character stored schema bound. Whole
plans already use the authored bound after schema parsing. M3's original delta
schema instead made the planning target a hard bound. The same suite could
therefore be accepted in a whole-plan reply and refused as `suite.replace` or
`suite.split`. This supersedes that specific 8,000-character delta decision in
[the original design](../designs/replan-loop-2026-10-23.md); the other delta
bounds and review rules remain.

The correction reuses `parentTestSuiteSchema` for delta source bytes and split
suites. `applyPlanDeltas` already passes the resulting complete plan through
`withinAuthoredBounds`, so the existing authored bound and typed `suite-size`
feedback now apply to both reply shapes. The planning text keeps the 8,000
target and names the common 12,000 hard bound. No source is truncated,
reformatted or synthesized. This changes neither model token budgets nor run
admission, the saved suite schema, mandatory review or suite execution.

## Regression and adversarial checks

The production `parsePlanPair` path accepts byte-identical 8,001-, 8,871- and
12,000-character suites as whole plans, replacements and splits. The three
new equivalence cases failed against the previous parser with its observed
8,000-character error. The actual root refusal/replan/review/execute test now
uses an 8,871-character replacement and still requires the amended plan's
mandatory review before exactly one execution.

12,001-character sources remain refused in whole plans, replacements and
splits. Wrong base digests, invalid indices, forward dependencies, more than
six deltas or more than two suite-bearing deltas remain refused. Existing
suite syntax checks and reviewer restrictions remain unchanged. Replaying
the four recorded replies through the corrected parser preserved every suite
byte and found no TypeScript syntax refusal. That replay performs no model
call or application execution and grants no review approval.

Private evidence includes the complete 418-event terminal trace, original
runner log through shutdown, the retained initial state and all compressed
tool evidence. The 402 evidence envelopes (272 unique payloads) passed their
byte-length and SHA-256 checks. The failed source run remains failed; its
historical record is not rewritten into a successful repair. The currently
hosted Attica delivery and its data are outside this platform change.
