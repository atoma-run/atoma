# The deployment's critical path, 7 to 11 minutes in ten days — 2026-10-24

A push to `main` deploys when CI is green, so the time to production is the
CI wall. It was ~7 min around 2026-10-15 and ~11 min from 2026-10-18. This is
what the GitHub Actions logs said, what a local A/B said, and what changed.

## Where the time went

| CI job (run of 2026-10-15 vs run of 2026-10-24) | 10-15 | 10-24 |
|---|---|---|
| Test suite, whole job | 6.5 min | 10.8 min |
| of which `npm test` | 313 s | 598 s |
| Static checks and release build | 2.2 min | 5.0 min |
| of which `release:check:static` | 93 s | 253 s |
| Deploy workflow (after CI) | < 1 min | < 1 min |

Daily medians of `npm test` on `main` (one to three runs sampled a day):
~320 s through 10-15, ~450 s on 10-16, ~540 s from 10-18, 470–630 s since.
The step is the commits of 10-16 (parent-owned test suites, the application
skeleton smoke), 10-17 and 10-18 (workspace RPC, Atoma Compute). Nothing
slowed down on 10-23: the checkpoint split changed nothing on CI, where the
worker cap stays at 4.

Runner noise is large: the same commit ran in 254–390 s on 10-15 and in
381–604 s on 10-23 (±30%). One run proves nothing; the medians do.

## More work, or a saturated runner?

| vitest summary | CI 10-15 | CI 10-24 | Mac, 4 workers, 10-15 code | Mac, 4 workers, HEAD |
|---|---|---|---|---|
| test files | 469 | 566 | 470 | 566 |
| wall | 313 s | 598 s | 217 s | 225 s |
| tests, summed CPU | 930 s | 1 747 s | 759 s | 749 s |
| import, summed CPU | 204 s | 430 s | 64 s | 104 s |

At equal worker count on a 14-CPU machine, HEAD costs what the 10-15 code
cost: the 96 new files add 200 s of CPU and the unchanged files lose 210 s
to the loopback static server (a macOS-only gain: `python3 -m http.server`
reverse-resolved the host name for 5 s per boot there, not on Linux).

On CI the UNCHANGED files are 32% slower for the same test counts
(`viz-auth-gate` 109 → 182 s for 31 tests, `retrieval-benchmark` 28 → 46 s
for 61). That is oversubscription: ubuntu-latest has 4 vCPUs, vitest runs
4 workers on them, and 98 of the 566 files (72 of 470 before) spawn real
child processes — tsx runners for the checkpoint fixture, viz servers,
workspaces, executors — which compete with the workers for the same CPUs.
Imports double per file for the same reason.

The three checkpoint files show it: 107 s in one file on 10-15, 271 s
summed across three files on 10-24 (42 s against 73 s on the Mac).

## What tsx costs, measured

The child processes' cost is the work they do, not their TypeScript loader.
On the Mac, warm cache: the checkpoint child's import graph takes 0.5 s
under tsx and 0.25 s compiled; the viz server's 1.0 s and 0.45 s. A
checkpoint test costs 2–8 s because it RUNS a run. Precompiling the
children for CI only was therefore not done: a CI-only code path for ~60 s
of CPU out of 1 747.

## What was done

- The test job runs as three `--shard`s on three runners. Vitest shards by a
  hash of the path: simulated on the measured durations, the three shards
  sum to 658 / 468 / 621 s of CPU against an ideal 582, better than the
  size-based heuristics tried. The `DiscoveryReporter` used to switch
  itself off under `--shard`; it now narrows its queue with the configured
  sequencer's own `shard()` and a shard that loses one of its own files
  still reddens (`tests/test-discovery.test.ts`).
- `application:skeleton:smoke` runs its three kinds concurrently with
  asynchronous npm calls: 86 s one after the other on the static job.
- The static job (5 min) is now the longer half; `typecheck` 40 → 67 s and
  `docs:check` 27 → 48 s between the two dates are its next items.
