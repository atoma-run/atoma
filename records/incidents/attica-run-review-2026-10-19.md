# Attica run investigation — 2026-10-19

Production evidence was read through the authenticated Atoma MCP. No run was
started, accepted, published or deployed as part of this investigation.

## Window and evidence

The six newest project runs at investigation time belong to project
`07864f7c-d8f2-4023-9fca-afd8a7a51e52`. All available summary pages were read to
`nextOffset: null`: b04565ec (778 events), 4c120527 (281), 9ac4492f (559),
a58328d2 (20). The two earlier runs have no trace; their complete runner logs
were read instead. Detailed review/planner events were losslessly paged to end.

- `b04565ec-aa95-4748-8702-ea34bb4c266d`: failed in delegation review, before
  implementation. Final planner event `515a59f0-0ed8-4569-8878-4e20bcaf34d2`
  includes a server integration suite that first checks cancellation, lifts it,
  then submits `/api/start` with `maxPages: 0`, expecting 400. Final review event
  `7a7078e2-e1a0-44bf-bdcf-021dd298f6b6` incorrectly says this can launch
  Playwright and requires a fake session. The host readback cut the 22,601-char
  control server at 3,559 chars; its later keyword excerpts stop near startup,
  before the route handler. This is a false refusal, not proof of an app bug.
- `4c120527-c411-4049-b5c5-f7fbbcdbdfef`: launcher-confirmed interrupted
  execution, no eligible checkpoint. The trace ends during planning. The
  complete runner log confirms cancelled outcome and also reports retrieval
  cleanup failure. That wrapper discards the underlying disposal/backend error;
  the available evidence does not establish why execution was interrupted or
  which cleanup failed. No cleanup cause is inferred from the generic message.
- `9ac4492f-78a9-45cd-b642-ce6faf5d89af`: final planner proposes only a textual
  blockage report, explicitly without new execution. Final review event
  `b7b1cf4c-b5fe-429f-8744-e8afddc441f3` correctly refuses it against the
  requested installation/check/build and conditional corrections. Its refusal
  is not a reason to weaken the review contract.
- `a58328d2-18b6-4bf3-9aa0-cbc910e1ec5a`: signal cancellation in trace,
  launcher-confirmed interruption in status. No app defect established.
- `30769ff9-6531-48d3-9943-1d8ccd16c9b7` and
  `33451c25-bc7c-4149-97f5-c0a872bbf7ba`: pre-model checkpoint-export failures
  on linked seed files. Already fixed by `a0c4703c`; see
  [compute state](../../memory/atoma-compute-state.md#repository-seed-transfer-refusal--2026-10-18).

The current GitHub server and security modules corroborate the final suite's
control flow: `/api/start` calls `boundedPages(body.maxPages)` before session
creation or collection, and boundedPages throws for values below 1. The handler
maps maxPages validation errors to 400. A missing fake browser does not make
that negative request a browser launch. This source inspection does not prove
that every other assertion in the plan would pass.

## Correction and limits

`planSuiteFactsBlock` used the 24,000-character phase readback allowance even
though a refusal there spends a top-tier root replan. Its four imported modules
in the final review total 58,215 characters. It now uses the existing
96,000-character root readback allowance, keeping the same six-file read cap,
observation-only reads, truncation notices and semantic review. No execution,
approval, trust or suite requirement changes. Longer files can still be cut;
missing text remains unknown. Maximum model input grows; the runtime adds no
model call. The change supplies evidence, not a guarantee of model agreement.

A production-path regression builds four real imported files at this shape,
places a validation-before-browser branch late in the server, checks that the
host review receives the complete source, and runs the parent suite through the
real isolated runner. It failed before the change and passed afterwards.
Adversarial checks retain unreadable/oversized import handling and the rule
that host reads cannot grant a child blind-overwrite permission. Keyword-based
route classification, automatic approval and dropping browser restrictions
were deliberately avoided: none can establish the complete control flow.

## Validation

A fresh `npm ci` in the isolated worktree completed. The three affected test
files passed (58 tests), including the isolated parent runner boundary. Both
TypeScript configurations, full lint, docs checks and `git diff --check` passed.
No paid replay was used to claim that the model would now approve this plan;
what is verified is that it receives the previously omitted source.

## Numbered source inspection

The same b04565ec summary contains eight `run_shell` refusals of `nl` (first
`fdef5e44-bde7-4de2-8eee-2911e4afac27`, last
`ae065d64-064c-42d3-8dfd-d595d9976aeb`). The default allowlist already admits
read-only inspection utilities, including `cat`, `head`, `sed`, and `od`.
`nl` joins that existing class. `bash -c` could already run it; this removes
friction without adding a new capability. Explicit per-tool restrictions still
win. A regression runs actual numbered-file output including a blank line,
then confirms an explicit echo-only allowlist refuses the same command. It
failed before the addition. This fixes the observed refusal, not a promise
that the model would otherwise have recovered from it.
