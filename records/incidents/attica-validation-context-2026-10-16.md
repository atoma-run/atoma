# Attica validation context — 2026-10-16

Run `492b3334-c99a-4227-8706-698e17068a39` stopped on a Claude session limit
after 44m10s. The earlier analysis records 82 model calls, 355 tools and 24
refusals among 38 model validations. These are one run's measurements, not
an estimated speedup from the changes below.

## Demonstrated contradictions and repairs

- Event `1486a9f8-2d84-4b02-9be7-65b3c4c7299c` rejected a direct plan for its
  one-entry `subtasks` wrapper. `planSchema` itself inserts that wrapper and
  `aggregation: concat` into a direct `proposedAction` plan. Validation now
  labels that host normalization while preserving the complete plan payload.
- `phaseCriteriaLines` demanded executed checks for every criterion, even
  static source properties, and emitted the same instruction at plan time.
  This contradicted the validator's plan/result and source/behavior rules.
  The shared phase context now distinguishes these and recognizes an executed
  test's actual HTTP sequence without requiring a duplicate manual probe.
- Focused review retained `previousRunLanding` despite claiming blindness to
  earlier verdicts. That host input is now excluded alongside earlier results.
  Starting repository excerpts remain available but are explicitly historical.
- Event `4327e8bf-23fa-44a6-8891-e562269ebd4e` judged c5/c6, assigning a scheduler
  test failure to the deletion criterion. The review prompt now explicitly
  keeps each judgment local to its criterion and recognizes equivalent assertions.
  This event is NOT the c3/c4 review; the interactive analysis had grouped its
  reference under the wider finding about mixed criteria.
- The validator's eighth worked example required pasting tool stdout and rerunning
  commands despite the runtime evidence policy. It now asks for genuinely missing
  evidence and recognizes a terse summary backed by host observations.
- Planning guidance keeps tests with implementation repair before reporting;
  an explicitly independent review can still report failures without repairing them.

These are context corrections, not a lexical override of model refusals or a
new automatic approval gate. No tier/model pin, call budget or credit rule changes.

## Adversarial review

Reviewed against `src/atoms/AGENTS.md`, the existing validator examples,
`ASSERTION_EVIDENCE_GUIDANCE`, `STATEFUL_EVIDENCE_GUIDANCE`, delegated scope,
read-only phases and the parser's actual normalization.

Countercases retained: a coherent wrapper does not excuse missing actions;
static source does not prove required execution; a passing total without relevant
assertions is insufficient; stale files cannot establish current state; an
independent review must not be turned into an editing phase; an unmet compound
criterion still fails even if another criterion passes; historical diagnostics
are not deleted from executor context; declared tools remain authoritative.

Regression tests cross the production parser, delegated context and validator
request paths, including propagation of a refusal without an added call. Mocked
tests verify context delivery, not that a model will always understand it.
No paired live-model accuracy or latency improvement has been measured.

## Retained Attica bytes

The MCP reports no artifact manifest and refuses artifact listing. Read-only SSH
found the workspace under the failed run's project directory. With explicit owner
approval, code/tests/report were copied locally, leaving production untouched.
The 24 control tests reproduce 22 passes and two CAPTCHA setup failures.
The complete suite on the recovered final bytes reproduces 61/63 in 5.2 seconds
on Node 24.20.0/macOS (the original run used Linux). The 60/63 in the trace was
before its last unverified edits; these two measurements are different snapshots.
Both failing tests seed a paused checkpoint before `/api/start`; the collector
correctly preserves that pause and never reaches the fake CAPTCHA detail response.
Longer sleeps cannot establish that prerequisite.

The final Retry-After restart test writes a new checkpoint after restart, so its
passing result does not establish the requested persistence. `loadCheckpoint`
also swallows every SyntaxError as absence, changing the original error path;
the start-error regression fails before acquiring the lock and therefore cannot
prove release after acquisition. These need behavioral corrections in the Attica
project, followed by a complete suite on its final bytes, not blind acceptance of
this failed workspace. Reuse the real server's scheduler callback.
