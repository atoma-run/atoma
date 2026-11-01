# Round 16 — the direct depth against the single agent it is built from: H16 refuted on both tasks, and the gap is the TypeScript policy, not the acceptance

Run 2026-11-01 08:34–09:09 UTC on branch `feat/direct-depth` at `fa64e08c`
(CI green on that commit), as
[registered the same morning](PROTOCOL.md#round-16--the-direct-depth-against-the-single-agent-it-is-built-from-registered-2026-11-01-before-any-run):
control `--baseline`, treatment the product at its new default depth
(`direct`), both arms on `sub:openai:gpt-5.6-sol` (L3 pin, `ATOMA_BASELINE_MODEL`
unset), three runs per arm per task, 30-minute budget, host path. Anchors in
[`round16/anchor.txt`](round16/anchor.txt): tabstat `--first-archive 54
--last-archive 60`, challenge `--first-archive 60` with its last workspace live.

## Verdict: H16 refuted, the branch is not pushed to `main`

| | tabstat: control | tabstat: direct | challenge: control | challenge: direct |
|---|---|---|---|---|
| full marks | **3 of 3** | 2 of 3 | 3 of 3 | 3 of 3 |
| mean cost | **$0.193** | $0.630 (**3.3×**) | **$0.301** | $0.577 (**1.9×**) |
| mean wall clock | 55 s | 224 s | 116 s | 219 s |
| LLM calls | 1 | 3–4 | 1 | 3–6 |

H16 needed, on each task, (a) at least the control's full marks and (b) at most
1.5 times its mean cost. Tabstat fails both; the challenge fails (b). Under
the registered consequence nothing is pushed, and the cause is reported to the
owner before any change. Rows and every case:
[`results-round16-tabstat.csv`](results-round16-tabstat.csv),
[`results-round16-challenge.csv`](results-round16-challenge.csv) and their
`-scores.json`; the driver's reports
[`ROUND16-tabstat.md`](ROUND16-tabstat.md) and
[`ROUND16-challenge.md`](ROUND16-challenge.md).

## Where the extra cost is

The product's own wrapping is not it. Per direct run, the checklist draft cost
$0.001–0.002 and root acceptance $0.003–0.033 (luna), at most 6% of the run.
The executor is the rest, and it splits on one fact:

| direct run | executor cost | migrated to (or scaffolded) strict TypeScript |
|---|---|---|
| tabstat 1, 2, 3 | $0.696, $0.575, $0.561 | yes, all three (`src/`, `dist/`, eslint, vitest, `tsconfig`) |
| challenge 1, 3 | $0.659, $0.727 (two passes) | yes |
| challenge 2 | **$0.296** | **no**: one `challenge.ts`, like the control ($0.25–0.34) |

The direct executor reads the task context every executor reads, and that
context carries the strict-TypeScript application policy (owner decision
2026-10-16, reaffirmed 2026-10-31: it wins over a goal's "do not rewrite"). The
control reads only the goal. Five direct runs of six followed the policy and
paid for a project skeleton, a migration and its checks; the one that did not
cost what the control costs.

## What the one miss was

Tabstat direct run 2 (13/14) failed `manifest-matches-live`: it recorded
`npm run check` and `npm run build` in `.atoma-probes.json`, and their recorded
output does not replay identically (vitest prints durations). Those two
commands exist only because the run migrated the CLI to TypeScript. It is the
same failure round 13 scored against the supervised arm: a recorded command
whose output can never replay is not a record.

## Remediation and the rest

One direct run of six was refused once by root acceptance and approved on its
remediation pass (challenge 3). No run was cut by the budget, retried after an
error, or judged as text; every acceptance basis was a validation call.

## What the owner has to decide

The implementation of the direct depth behaves as designed: one executor,
judged by the host for under 6% of its cost, as correct as the control on the
challenge. What the check measured is what the product asks of that executor.
Three ways forward, none applied here:

1. **Ship as is.** The direct default costs about 2–3 times one bare agent on
   these tasks because of the TypeScript policy, and stays well under the
   supervised default it replaces (rounds 13 and 15 measured that one at
   $1.45 and $0.93 on the same tasks; other days, so not a registered
   comparison).
2. **Narrow the TypeScript policy for maintenance of existing JavaScript.** It
   would bring the direct executor back to the control's cost on tasks like
   these, and reverses part of the 2026-10-31 decision.
3. **Stop recording non-replayable command output as a probe.** Independent
   of 1 and 2: it is the only correctness miss here and the one round 13
   found, and it is a product defect whatever the default depth.

## Threats

Three runs per arm detect a large regression, not a small one. The tabstat
goal dropped round 13's "Do not rewrite the CLI" clause (owner decision
2026-10-31), which is exactly what let the policy reach the CLI; the
challenge goal is round 15's, unchanged.
