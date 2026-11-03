---
name: benchmark-round13-14-2026-10-31
description: 2026-10-31 — rounds 13-14 DONE and merged to main (51a157ca): H13 and H14 refuted, controls 7/7 at $0.14-0.19 vs atoma 6/7 at $1.45; registered consequence = no new gate until supervision measurably buys correctness
metadata:
  type: project
---

On 2026-10-31 the owner asked to validate the Atoma thesis ("il est temps de valider l'hypothèse"). Round 12 (2026-08-16) had refuted the correctness hypothesis on the registered protocol and nothing had been measured since.

State:
- Registration commit: `bench: register rounds 13-14` on branch `bench/round13`, pushed before any run; the worktree is `/Users/mgtf/dev/atoma-bench` (origin/main 4fd83276 + that commit). The main checkout was 60 commits behind origin and carries another session's dirty files, so the measurement runs from the worktree.
- Driver: `treatmentProtocol: "current"` (no `--comparison`, `ATOMA_DEFER_LEARNING=0`) measures the shipped protocol; `score-round.mjs --scorer verify-tabstat.mjs --marker tabstat.js`.
- Pins: L1 sub:openai:gpt-5.6-luna, L2 gpt-5.6-terra, L3 gpt-6-astra (production pins of Attica run 78208e3f). Round 13 control = terra; round 14 control = astra, no treatment runs.
- Local state of the main checkout archived (not deleted) to `~/.atoma/archive/pre-round13-2026-10-31/` (atoma.db*, skills/, runs/).
- Workspace anchor: highest build.prev before round 13 = 8 → `--first-archive 9`; round 14's anchor is written to `atoma-bench/benchmark/round14-anchor.txt` (expected 22 → `--first-archive 23`).
- Logs: `atoma-bench/benchmark/driver-round13.log`, `driver-round14.log`.

**Why:** the owner wants a reproducible answer, published either way, before more platform surface is built. H13 = correctness strictly greater AND mean cost ≤ terra-direct; H14 = correctness ≥ AND cost < astra-direct. A third correctness refutation commits the README to say supervision buys no correctness on this family, and freezes new gates.

**How to apply:** after the runs, score with `node benchmark/score-round.mjs --csv benchmark/results-round13.csv --first-archive 9 --scorer verify-tabstat.mjs --marker tabstat.js --out benchmark/results-round13-scores.json` (round 14 likewise with its anchor), inspect every failing check against the artefact before recording it, write ROUND13.md/ROUND14.md with the driver output verbatim, update the README's historical-measurements paragraph, then merge the branch into main (push = deploy). Do not edit `src/` in the worktree or the main checkout while the rounds run. See [[validation-runs-too-slow]] and [[no-full-suite-beside-compute]].

**Result (2026-10-31, merged to main 51a157ca, CI/deploy followed):** terra direct 7/7 full marks at $0.139/run, sol direct 7/7 at $0.188/run; atoma (luna/terra/sol, current protocol) 6/7 at $1.450/run (10.4×), 1,053 s vs 63 s, cost rising across the series, det=0 everywhere. L3 = 53% of atoma spend, role plan = 50%, execute = 10%. Mechanism: `APPLICATION_TYPESCRIPT_GUIDANCE` (skeleton decision 2026-10-16) made every run migrate the JS CLI to strict TS against the goal's "do not rewrite", and run 1 distilled it into skill `migrate-cli-to-strict-ts`, reused on runs 3-6. Owner-level follow-ups still open: whether the skeleton guidance should yield to an explicit goal prohibition; whether to keep building gates at all (registered consequence says no); the benchmark branch `bench/round13` equals main and can be deleted. Traces archived at `~/.atoma/archive/pre-round13-2026-10-31/round13-14-traces.tar.gz`; the pre-round local store/skills/runs are in the same directory (restore them to the main checkout if local operator state is wanted back).
