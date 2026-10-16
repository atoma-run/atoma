---
name: delegation-review-replay
description: How to replay recorded root delegation reviews offline through the Codex transport (Mac), and what the 2026-10-16 replays measured
metadata:
  type: reference
---

On 2026-10-16, before landing two delegation-review fixes (8cf68c80, 8059f2ac), I replayed the exact recorded tier-2 review calls of Attica runs 7a7af324, aaa6b442 and 63feeb3c through Atoma's own `CodexCliLlmClient` (gpt-5.6-terra, `ROOT_DELEGATION_REVIEW_PARAMS`). The local Mac `codex` CLI is logged in (`~/.codex/auth.json`), so the replay needs no Windows workarounds. It bills the owner's ChatGPT subscription, about 50 s per call.

How:
- Copy full traces without loading them into context: `ssh mgf@atoma.run "sudo -n sh -c 'cat /home/atoma/state/projects/orgs/*/projects/<project>/runs/<run>/traces/<run>.json'" > local.json`.
- A tsx script (`.mts`, top-level await) imports the worktree's modules by absolute path. Variant "old" sends the recorded systemPrompt and userContent verbatim. "new" swaps the text from `== REQUIRED DELEGATION CONTRACT REVIEW ==` through "...no classification is required." for the worktree's `DELEGATION_REVIEW_REQUEST`. "conv" also inserts `previousRefusalsNote` built from the run's earlier refusals, after the "Discovery allowed here" line.

Measured:
- Browser demand (event 0ae547e8): old prompt 2/3 demanded UI coverage by a suite; new 0/3.
- Helper-only suites (1c91c9cd, 9b3710b9, 0ae547e8, 4ae9d293): refused 100% with the final text.
- A first, laxer convergence text approved 9b3710b9 in 1 of 4 samples. Never land a review rule without a replay on the known-bad plans.

Old plans replayed with forwarded requests still refuse, because they were written without those requests; only a live run measures the planner side. Related: [[attica-run-delegation]], [[validator-prompt-replay]].
