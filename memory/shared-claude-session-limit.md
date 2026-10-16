---
name: shared-claude-session-limit
description: My Claude Code subagents and Atoma runs on own:anthropic share the owner's Claude session limit; a 66-agent workflow killed Attica run 492b3334 (2026-10-16)
metadata:
  type: feedback
---

On 2026-10-16 around 03:40–04:20 local, a 66-agent forensic workflow (9.5M subagent tokens) hit "You've hit your session limit · resets 8am (Europe/Athens)". At the same moment Attica run 492b3334 (own:anthropic via claude-cli) failed with "session limit · resets 5am (UTC)": the same account and the same reset.

**Why:** the owner's Claude subscription pays both my Claude Code subagents and every Atoma project run configured `own:anthropic:*`. A large fan-out can starve the run the owner asked for.

**How to apply:** before heavy agent work, read `atoma_project_readiness` for the project's models. While a run on `own:anthropic` is in flight, do not launch large workflows: keep verification fan-outs small (two lenses, about a dozen agents) and run them after the run ends. Since 2026-10-16 Attica runs on `own:openai` (codex-cli, ChatGPT subscription), so my usage no longer competes with its runs, but my own session can still stop mid-workflow: keep each workflow resumable. Related: [[attica-run-delegation]].
