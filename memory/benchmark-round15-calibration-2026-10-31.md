---
name: benchmark-round15-calibration-2026-10-31
description: "2026-10-31 — owner approved a control-only calibration on four Attica SWE-style tasks plus the challenge corpus to find where one agent fails, then round 15 (6 vs 6) on retained tasks; state and where things live"
metadata:
  node_type: memory
  type: project
  originSessionId: 45327728-5279-46b5-99cc-bb4f31b3b2b4
  modified: 2026-10-31T18:17:52.450Z
---

After rounds 13-14 refuted H13/H14 on tabstat (controls at ceiling), the owner approved on 2026-10-31 a two-step plan: (1) CALIBRATION, control arm only (terra, n=3 per task), on tasks where a single agent might fail; (2) ROUND 15 on the tasks retained by the fixed rule (1 or 2 full marks of 3): 6 treatment vs 6 control, H15 = atoma strictly more full marks per task; cost reported, not hypothesised. Consequences are pre-registered in `benchmark/PROTOCOL.md` ("CALIBRATION — pre-registration, 2026-10-31").

Corpus: four SWE-style tasks from the private Attica repo history (seed = parent of a real fix commit, score = that commit's tests held out, fail-to-pass verified): attica-a1 Unicode search (44f703e), a2 control volume (4e66dfb, goal authored by me), a3 start-admission lock (b403443), a4 persistenceError (cf0f359); plus `benchmark/attica-challenge-v1` via `benchmark:models` (container, terra + sol). Seeds and held-out bundles live OFF-TREE in `~/.atoma/benchmark-seeds/<task>/` and `<task>-heldout/` (private corpus, never committed); digests are in the protocol. Scorer: `benchmark/verify-heldout.mjs <workspace> <task-id>` (copies the bundle in, `npm ci` if needed, `npm run build`, vitest JSON; one check per test, skip = fail), called by `score-round.mjs --scorer verify-heldout.mjs --marker package.json`. Configs: `benchmark/experiment-cal-attica-a{1..4}.json` (atomaRuns 0). Work happens in the worktree `~/dev/atoma-bench` (branch bench/round13 = main), never in the dirty main checkout.

CALIBRATION RESULT (2026-10-31 19:16 UTC): the four Attica tasks are at the ceiling (terra 3/3 full marks each, $0.16–0.85, 2–5 min, 11/12 deliveries pass the repo's `npm run check`); only attica-challenge-v1 is retained (terra 2/3 in the container; the failed run read the prompt text inside the form body only). Decision file: `benchmark/calibration-2026-10-31/CALIBRATION.md`. Round 15 amended: both arms through the `benchmark` driver on the host, `experiment-round15.json` (6 vs 6, 30 min), scored by `benchmark/verify-challenge.mjs` (corpus suite via this repo's vitest). Owner must give the go before round 15's treatment spend (promised in chat).

**Why:** the thesis can only be tested where the control is below the ceiling; tabstat/wclite/csvstat controls were 3/3 or 6/6 in every round.

**How to apply:** after the calibration, write `benchmark/calibration-2026-10-31/CALIBRATION.md` with the retention decision, then register round 15's configs only for retained tasks. Owner decisions already taken: TypeScript rule wins over goal prohibitions ([[typescript-rule-over-goal-prohibition]]); Attica may be used as corpus. Related: [[benchmark-round13-14-2026-10-31]], [[no-full-suite-beside-compute]] (disk was at 96% / 18 GB free at launch; Attica workspaces with node_modules are ~150 MB each).
