# Attica same-checkpoint repair — 2026-10-29

Owner chose a new repair from historical checkpoint, then automatic validation.
Source a2cc0c98-0510-4d77-838d-a26b4cf0bff7, key
attica-schedule-race-repair-20261029-01, base 38bfe415. Do not duplicate it.
Terminal FAILED: transport loss and session expiry; no user cancellation.
Normal Compute reconnect confirmed stop; app remains 0.5.200, now ready.
Initial snapshot c1edcd0d: 276 entries / 251 files / 4,496,267 bytes verified
in DB, complete private export and hosted materialization, modes included.

Automatic hosted validation d79d05f0-6187-4892-b1f5-dea4197ecfe2 ended
INCONCLUSIVE at 2026-10-28T23:04:54.125Z. Its token ceiling stopped it at
1,500,997 including cache reads vs 1,000,000; $0.07753246 / four GLM calls.
No counters or recipes changed. Never infer success from health's generic
compute-validated label. All recorded source/validation proofs read to end.

Open: parent planner contradicts additive exclusion, suite imports config
and fails native-module loading before any assertion; source final browser
test fails. Hosted replay restores exclusion but leaves history mutant, lacks
full browser/clean root checks; no final acceptance review ran. Do not accept,
publish or treat these final test bytes as the independently verified 6e45 fix.
Commands piping through tail/grep discard raw output and mask test exits; no
raw log snapshots produced. All available evidence archived, not missing bytes.

Record: [full evidence](../records/incidents/attica-same-checkpoint-repair-2026-10-29.md).
No runtime source edits or deployment this turn; no active agents/local work touched.
