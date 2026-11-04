# Attica: a ninth Codex tool session refused a busy process pool

## Production evidence

Attica run `58473880-2d64-463a-8461-44417b628a00` ran revision
`58b5afd241e88290b096e2a7a20b28ef87e9f4f4`. It failed at
2026-11-04 02:01:38 UTC with `codex call failed [transport-unavailable]`.
Its 535 trace events contain 35 model calls and 393 read-only tool calls;
there are no `write_file` or `edit_file` events and no delivery manifest.
This failure does not establish an Attica implementation or an MCP outage.

The failed call `1ea7f458-29af-4415-9929-ea398af90998` waited 36,950 ms
for the login lease, then failed before a first response, with zero usage.
At 01:55:40.570 UTC, all eight sibling tool sessions had acquired that
lease and were still running: `ab1d773e`, `993dd1a5`, `cbcde052`,
`497d2791`, `55549aa8`, `710e486b`, `eca0c555`, and `2817c6cf`.
The ninth session released its temporary state in 1 ms and fell back to
the exec transport, which shares the same process ceiling and also failed.
The saved trace exposes a fixed failure code, not a retained low-level
capacity diagnostic; the queue mechanism was reproduced independently.

The complete terminal trace and runner log, all initial files and modes,
and recursively verified raw envelopes are retained privately under
`attica-detail-identity-20261104/repair-58473880`. The decoder verified
510 envelope references, 322 unique payloads, and no omitted captured
command logs. The earlier initial-state archive remains separate.
Preservation of all bytes is distinct from human review of every repeated
catalogue or source-file body in those prompts.

## Mechanism and correction

`completeCodexAppServerToolLoop` previously acquired the login lease,
tried the shared eight-process pool once, and mapped a busy pool to
`CodexAppServerUnavailable`. The caller then tried an exec fallback against
the same exhausted pool. The offline regression held all eight SQLite
seats and observed that fallback instead of a pending ninth call.

Tool sessions now await a seat in that existing SQLite pool. They acquire
the seat before the login lease: holding the login while waiting could
prevent an active session from writing back a rotated credential and
releasing its seat. Admission obeys the request cancellation and existing
silence ceiling. Both admission failures and normal cleanup release the
seat; a timeout or cancellation cannot trigger an exec fallback.

The eight-process ceiling, account-probe fail-fast API, exec wrapper,
model choices, payer, permissions, credential isolation, response/tool
budgets, and no-replay-after-tools rule remain unchanged. No capacity
increase, provider retry, model switch, or credential reset is involved.

## Adversarial checks

The regression exercises the public Codex client and real SQLite seats:
eight held seats, no login lock while waiting, no spawn or fallback before
release, then one declared tool execution and recovery of exactly one
seat. Cancellation and timeout are tested both before a seat and after
reserving one while the login is occupied. A separate real Node process
holds all eight seats to verify the same queue crosses process boundaries.
The existing wrapper crash/reap and account hard-ceiling tests stay intact.

The original regression fails on the old implementation; its raw log is
retained as `codex-seat-before.log`. Targeted and release verification
results are recorded separately with their actual exits. A passing
transport regression is not an accepted Attica delivery: a subsequent
targeted run must still implement and verify the collector repair.

## Verification

Fresh `npm ci` completed with zero audit findings. Both TypeScript projects,
lint and the 144 tests in the three Codex transport files passed. The first
full `npm run release:check` completed its static half, then exited 1:
8,725 tests passed, three failed and 45 were skipped. These were the same
three timed operations seen before this change: the packaging test's 15 s
ceiling, egress cleanup's 3.5 s ceiling, and four Chromium launches' 20 s
ceilings. No new Codex regression failed in that complete invocation.

After that process ended, those three files ran alone with one worker:
35 passed and 13 were skipped in 91.22 s. Their assertions and deadlines
were unchanged. Both full-suite failure and isolated success logs remain
retained; isolated success does not turn the first full command green.
The clean CI release gate must pass before activating this revision.
