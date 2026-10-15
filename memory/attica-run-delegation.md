---
name: attica-run-delegation
description: 2026-10-15 — owner delegates Attica run goals/criteria to me and lets me fix Atoma defects found along the way
metadata:
  node_type: memory
  type: feedback
  originSessionId: 93a1a777-4ebe-4ba2-837c-3dfdd038f471
  modified: 2026-10-15T07:06:20.441Z
---

On 2026-10-15 the owner said « je te fais confiance pour faire avancer Attica et éventuellement améliorer Atoma si tu vois des améliorations / disfonctionnements », after I proposed a goal and criteria for the next Attica run.

**Why:** the project's purpose is to improve Atoma while building the Attica collector through Atoma runs (project decision 4a597731); the owner does not want to approve each goal.

**How to apply:** draft the next Attica run's goal and criteria myself and start it (still offline tests only, no live xe.gr traffic, no production data, unless the owner says otherwise). Review each run's evidence, and fix demonstrated Atoma defects with regression tests, pushing as in [[push-to-prod-authorized]]. Respect quota: the owner stopped runs on 2026-10-15 04:03 for quota and later resumed; ask again if a run would be unusually long or costly. Related: [[property-scraping-priority]], [[attica-haystack-startup]].

State at 2026-10-15 ~09:00 UTC: the project now runs on the owner's Claude subscription (own:anthropic haiku/sonnet/opus via claude-cli). Run 90ad4303 landed partial (c4, c5, c7 met; c1 cancel, c2 Retry-After, c3 CAPTCHA, c6 race unmet: tests mocked the store instead of driving collect()). Run b824d979 (base 90ad4303) asked a technical client question at boundary 0; the owner chose « laisser l'agent choisir »; its resume 69e3f1dc failed after 2 of 3 phases on « You've hit your session limit · resets 9am (UTC) », checkpoint blocked (host_mutation). Next: relaunch from 90ad4303 (or 69e3f1dc if seedable) once quota resets. Open Atoma defect: CLI_QUOTA_REFUSALS in src/core/llmClaudeCli.ts lacks "session limit", so that refusal surfaced as "no JSON found". Never answer an Atoma client question without asking the owner (atoma_run_answer forbids it).

## Continuation review — 2026-10-15, after 10:45 UTC

The owner requested continuing Attica to completion. No new run was admitted
in this continuation: the configured production MCP was not exposed as tools,
and direct discovery returned HTTP 401 (including from host loopback). The
connected browser works, but its integrated assistant cannot inspect arbitrary
runs or select `baseRunId`: its proposal schema lacks that field. Do not put
base selection into a worker's goal or pretend the assistant has MCP tools.
The owner was asked to reconnect the Atoma MCP in Codex.

After the MCP failure, read-only SSH/SQLite inspection confirmed:
- `90ad4303-6a74-4e42-afa1-fb1ca03e4107` is retained/partial, manifest
  `d0cc8a7822f5a581c9f81fb69fdadcfc3b1d553cf363941c0708e8519ba347d5`;
  all 114 workspace file hashes match.
- `b824d979-c4b3-4a51-90e9-e3c1fabc4024` has the same manifest as 90ad4303.
- `69e3f1dc-2460-440e-a23b-3e1126112336` is failed with no manifest, so
  `iterationBase` rejects it. Its two completed phases are not a delivery.

Independent review of 69e3f1dc's four behaviour test files found proofs still
invalid: cancellation tests reset request counters AFTER triggering start/resume
or startup; the active cancellation case instead seeds an idle paused checkpoint;
CAPTCHA tests call savePause and directly clear persisted pauseType, without a
detail navigation and browser verification; concurrency contains the tautology
`refused409 >= 0` and permits multiple successes with `acceptedCount >= 1`.
The injected `new AtticaScheduler(tmpDir, { now })` has its default no-op
`onDue`; `createServer` uses `options.scheduler` as-is, bypassing its own
collector callback. Those schedule ticks cannot prove scheduled collection.
Future tests must keep counters across the action, establish a positive control
that actually navigates, drive the real collector, and assert exactly one winner.
Do not salvage these tests as already verified merely because two phases passed.

Atoma quota-diagnostic fix pushed as `86c10301`: recognize the observed
session-limit refusal only at the start of the response; retain usage and avoid
transport retry. Regression failed before the fix; 40 targeted tests, typecheck,
lint and docs checks passed. CI `38723672048` passed on its second attempt:
the first had one unrelated precondition failure (fixed ports already occupied
in `viz-dev-orphan-reaping.test.ts`; 6,618 other tests passed). Deployment
`38725393781` succeeded; `/home/atoma/current` resolves to the exact full
`86c1030171aa8fa9f1c543c70d598168bc0c02eb` release. No new Attica run,
acceptance, publication or real collection occurred in this continuation.
