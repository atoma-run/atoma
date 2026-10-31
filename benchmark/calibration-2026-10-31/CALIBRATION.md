# Calibration — 2026-10-31: where does one agent fail?

Pre-registered in `benchmark/PROTOCOL.md` ("CALIBRATION — pre-registration,
2026-10-31 20:20 UTC"). Control arm only (`--baseline --comparison`,
`sub:openai:gpt-5.6-terra`), three runs per task, scored from outside both
arms. Retention rule, fixed before the first run: a task enters round 15 at 1
or 2 full marks of 3; 3/3 is the ceiling and is dropped.

## Results

| task | control full marks | cost per run | wall clock | `npm run check` on the delivery |
|---|---|---|---|---|
| attica-a1 saved-listing Unicode search | **3/3** (3/3, 3/3, 3/3) | $0.236, $0.205, $0.157 | 110 s, 129 s, 109 s | 3/3 pass |
| attica-a2 control polls with retained history | **3/3** (4/4, 4/4, 4/4) | $0.697, $0.852, $0.641 | 269 s, 299 s, 218 s | 2/3 pass (run 2: one `prefer-const` lint error, nothing else) |
| attica-a3 /api/start admission lock | **3/3** (2/2, 2/2, 2/2) | $0.345, $0.322, $0.310 | 207 s, 145 s, 170 s | 3/3 pass |
| attica-a4 persistenceError | **3/3** (2/2, 2/2, 2/2) | $0.599, $0.402, $0.506 | 289 s, 270 s, 299 s | 3/3 pass |
| attica-challenge-v1 (container, 8 cases) — terra | **2/3** (8/8, 6/8, 8/8) | $0.189, $0.117, $0.141 | 196 s, 104 s, 188 s | n/a |
| attica-challenge-v1 — sol (second arm of `benchmark:models`) | 3/3 (8/8, 8/8, 8/8) | $0.271, $0.264, $0.261 | 127 s, 139 s, 132 s | n/a |

Score files: `results-attica-a{1,2,3,4}-scores.json` (held-out bundles,
`verify-heldout.mjs`, archives `build.prev31`–`build.prev41` and the live
`build` for a4 run 3, mapping verified by mtime); `challenge-{1,2,3}/arm-*/score.json`
(the corpus suite through `atoma-verify` in the worker container). Driver
output: `REPORT-attica-a*.md`, `results-attica-a*.csv`; `npm-check.log`.

## Decision

- **Dropped (ceiling):** attica-a1, a2, a3, a4. One frontier agent repairs a
  real repository, with the fix commit's own tests held out, three times out
  of three on every task, for $0.16–0.85 and 2–5 minutes, and leaves the
  rest of the repository's `check` green in 11 deliveries of 12.
- **Retained:** attica-challenge-v1, terra at 2/3. The failed run
  (`challenge-2/arm-2`) returned `false` on the goal's own development
  example: its prompt test reads the visible text of the `<form>` body only,
  and "Verify you are human" sits in the `<h1>` above the form. A reasoning
  defect on stated input, not an environment failure; `holdout-challenge`
  fails for the same reason. The signal is one run in three on an
  eight-case pure function: a coarse sieve, as registered. Round 15's 6 vs
  6 is the measurement.

## What this says about the corpus

The four repository tasks were the hardest work available with a mechanical
scorer, and the control solved all twelve. The territory the thesis needs —
work a single agent gets wrong one time in three — was found once, on the
smallest task here, and not on any repository repair. Round 15 runs on what
the rule retained; a second calibration on harder work (multi-module
features, cross-cutting changes with held-out suites) is the owner's call
and is not implied by this one.
