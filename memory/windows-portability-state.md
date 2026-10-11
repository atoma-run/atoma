---
name: windows-portability-state
description: "atoma on Windows — audited 2026-08-30/31; what is broken, what is fixed, where the full report lives"
metadata:
  node_type: memory
  type: project
  originSessionId: 4ce9c95d-912e-4d9a-a02e-e85e063b3414
  modified: 2026-08-31T16:20:18.512Z
---

Two-pass audit (31 agents, all empirical claims executed on the host) established: atoma's static chain (typecheck, lint, build, compiled MCP, viz build) works on Windows, but the run-execution path is POSIX-only — only 2 `process.platform` branches in 238 src files. Full report (8 blockers, 8 majors, fix plan): https://claude.ai/code/artifact/35776af0-0929-4118-a06a-c89975e20f9e

DECISION C IS MADE (2026-08-31): **Windows is a development host, not a run host.** `src/run/platform.ts` is the one definition (darwin + linux); `spawnRun` refuses before the spawn via the `--- spawn failed ---` log shape, and `doctor` fails on `run-host`. No override switch, on purpose. So the remaining win32 run-path defects (spawn('npm'), taskkill, run_shell allowlist, MCP lease "unverifiable"=occupied) are MOOT rather than pending — and the lease one is deliberately left fail-closed: relaxing an identity check for a platform that no longer starts runs would trade real safety for nothing. Still open but low value: `scripts/i18n.mjs` `command -v codex` + group-kill (translate is a CI/operator task), `scripts/viz-gpu-smoke.mjs`.

Committed AND pushed 2026-08-31 (74dfc7f, 7c572ea, 00dd6e4, 8d2aec0; origin/main == HEAD, release:check rc=0 with 0 vulnerabilities and both compiled smokes green): (1) the SECURITY item — sandboxChildEnv scratch HOME now unconditional + win32 USERPROFILE/HOMEDRIVE/HOMEPATH pinned to scratch, platform injectable, HOME removed from allowlist (src/tools/sandbox.ts); (2) the whole contention-flake class — viz-auth-gate watchdogs 30s + ownExitCode (SIGKILL≠success) + file default 60s via vi.setConfig; precommit-staging 60s; mcp-run-lock both cross-process tests hold leases via stdin (no fixed windows) + DIED-on-close verdict fallback; puppeteer-orphan-reaping counts its own descendants (ps tree walk), not machine-wide pgrep (a global count measured -6 under parallelism — puppeteer launches Chrome detached into its OWN group, the reap travels through the child exit handler); (3) DiscoveryReporter in vitest.config.ts — queued specs must report back or the run reddens, shard/interrupt-aware, proven by nested-vitest e2e (tests/test-discovery.test.ts). Adversarially reviewed (19 agents): 4 confirmed findings all fixed, 4 refuted. Earlier same day: check-agent-docs.mjs separator bugs + predicates + .gitattributes + devcontainer (committed 85905db/59bc26a/c6658aa, pushed).

A recurring lesson, now three times over: a win32-only defect is INVISIBLE to this repo's CI, so the fix is not enough — the predicate must take an INJECTED platform/path implementation so the Linux suite exercises the failing regime (agent-docs-predicates, sandboxChildEnv(extra, platform), pathIsInsideDir, spawnRun({platform}), DoctorDependencies.platform). Conversely, pin the platform in suites that would otherwise flip on a Windows dev machine (tests/doctor.test.ts).

RESULT: `npm run check` fully green on WSL Debian in BOTH shapes — full parallelism AND --maxWorkers=4 (240 files, 2897 tests) — first time on this machine. Devcontainer at .devcontainer/ mirrors CI (node:22.13.0-bookworm). No Docker socket inside, on purpose: atoma spawns its own worker containers by host path (containerExecutor.ts bind mount), so socket-in-container would make workers siblings with wrong paths. Runs belong in WSL2, not in the devcontainer.

CI is ubuntu-latest only (all 5 jobs) — Windows breakage is structurally invisible to CI. The open AGENTS.md decision: support Windows as a host, or make doctor fail fast on win32. Silence is the current (worst) state.

2026-09-06 check on the Windows host (Node 24.16): `npm run check` red ONLY in the known POSIX suites — symlink EPERM (sandbox-security, viz-run-index), temp-dir `rmSync` EPERM (viz-auth-gate, backup), `tar` (backup), "supervisor commands require POSIX process groups" (analyst, mender-pipeline), codex-less i18n-pipeline — plus load-induced worker timeouts that pass alone (viz-client-components). typecheck, lint, docs:check green; all viz suites green. The WSL Debian clone `~/dev/atoma` is at dfbb4c0 (Sep 1) with 5 uncommitted local files (github http, viz server, auth-gate tests) — someone's in-progress work; do not sync into it or use it as the gate without realigning it first.
