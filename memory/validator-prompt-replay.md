---
name: validator-prompt-replay
description: "2026-10-03 offline replay of mender PR #12 (validator prompt rule) on run d5ca365f — prompt did not help, luna miscomputes, terra 10/10; how to replay a recorded verdict on Windows"
metadata:
  node_type: memory
  type: project
  originSessionId: 90e132dd-b787-4d70-8e1c-bbb667b2151a
  modified: 2026-10-03T14:15:36.924Z
---

Mender PR #12 ("ground counterexample coaching", +18 lines in VALIDATION_SYSTEM_PROMPT) was
replayed offline on 2026-10-03 against the exact recorded call: run d5ca365f, event 049716ea,
Cambium (L3) validating Sclereid's reasoning RESULT. Ground truth by exhaustive search: 15
original states, 12 modified states, so the correct verdict was approve.

- The false "13 states" was NOT prior coaching (the PR's premise): luna invented it on the first
  pass. The analyst verdict also wrongly says the task requested 13.
- False rejections, n=10 each, on gpt-5.6-luna: old prompt 2, PR trimmed to its first half 1,
  full PR 4. Several full-PR rejections fabricated invalid witnesses. No measurable benefit.
- gpt-5.6-terra with the OLD prompt: 10/10 approved.
- Intermediate validations run on `validationModel = modelForTier(1)` (L2Atom, by cost
  discipline). 196e6bbb moved only the ROOT text review to tier 2. So on main this failure can
  still recur. Using tier 2 for reasoning-mode RESULT validation is an open owner decision
  (cost: terra ≈ $0.043 vs luna ≈ $0.005 per verdict here).

**Why:** a prompt rule validated only by mocks can look right and still make the live model
worse. Use a replay of the recorded prompt as the proof before landing a validator rule.

**How to apply (replay on Windows):** get the userContent through MCP
`atoma_run_trace section=event`, and build the system prompt from the run's revision. Call it
through `CodexCliLlmClient` with a `spawnFn` that:
- runs `C:/Users/mgf/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe` with the full env (Atoma
  spawns bare `codex` with a stripped env, so you get transport-unavailable);
- drops the `default_permissions` / `permissions.atoma-text-only.*` `-c` pairs, because Windows
  Codex refuses the split-read filesystem sandbox. This is harmless for text-only calls.

WSL codex is not logged in.

Related: [[supervisor-mender-state]], [[supervisor-replay-exception]].
