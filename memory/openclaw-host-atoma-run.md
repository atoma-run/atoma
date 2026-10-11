---
name: openclaw-host-atoma-run
description: "OpenClaw gateway on the atoma.run VPS; 2026-09-15 moved onto the ChatGPT subscription via the codex plugin (native ~/.codex home), openai/gpt-5.6-sol for all agents, no 5.3 on a ChatGPT account, no passwordless sudo"
metadata:
  node_type: memory
  type: project
  originSessionId: 1756d934-2ac0-4f58-8702-b7ae9a1ebddb
  modified: 2026-09-15T14:02:54.478Z
---

OpenClaw (2026.9.2) runs on the same Hetzner VPS as atoma (`ssh mgf@atoma.run`,
config `~/.openclaw/openclaw.json`, WhatsApp channel, agents main/maria/coder/atoma).
On 2026-09-15 it was moved from z.ai GLM (rate-limited) to the user's ChatGPT
subscription (plan `prolite`, account mgf@iotanet.net):
`@openclaw/codex@2026.9.2` installed and enabled (pin to the host version;
2026.9.4 needs host >=2026.9.4), OAuth profile `openai:default` created with
`openclaw models auth login --provider openai --device-code --agent main`
(needs `ssh -tt`), every agent plus `subagents.model` and `utilityModel` on
`openai/gpt-5.6-sol`.

THE SUBSCRIPTION IS ONLY USED WHEN THE APP-SERVER RUNS IN THE NATIVE `~/.codex`
HOME (`auth_mode: chatgpt`). Left alone, OpenClaw prepared an API key from
`~/.openclaw/secrets.json` (`/providers/openai/apiKey`), spawned per-agent
isolated homes under `<agentDir>/codex-home` with `auth_mode: apikey`, and every
turn was billed per token. What fixed it: `auth.profiles["openai:default"]`
declared as oauth + `auth.order.openai: ["openai:default"]`, the isolated homes'
`auth.json` moved aside, and the stale app-server children killed so they
respawn with `CODEX_HOME=/home/mgf/.codex`. Also set (pending a restart)
`plugins.entries.codex.config.appServer.clearEnv` for OPENAI_API_KEY and
`homeScope: "user"`. The API key stays in the secrets store because OpenAI STT
(WhatsApp voice notes) needs it.

Verify the route, never trust the agent's self-report: probe the app-server
`account/read` (expect `type: chatgpt`) and grep a turn's marker token under
`~/.codex/sessions` rather than the isolated homes.

Subscription catalogue (app-server `model/list`, 2026-09-15): gpt-6-astra
(default), gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5. No 5.3: the rate
limits expose a `codex_bengalfox` / "GPT-5.3-Codex-Spark" bucket but the API
answers "The 'gpt-5.3-codex-spark' model is not supported when using Codex with
a ChatGPT account". `gpt-5.3-codex` is API-key only.

**How to apply:**
- No passwordless sudo. The real service is the SYSTEM unit
  `openclaw-gateway.service`; `Restart=on-failure` means a clean stop does NOT
  come back. The user restarts it themselves with sudo; a transient
  `systemd-run --user` unit works but crash-loops if the system one is running
  (it owns the state directory).
- `openclaw config set <path> <json> --strict-json` hot-reloads; plugin config
  (appServer.*) and plugin enable/install need a gateway restart.
- The user works on the VPS in parallel (Codex CLI, Control UI): re-read the
  config before editing, and check who started what.
- Backups: `openclaw.json.before-codex-chatgpt-20260915-130143`,
  `openclaw.json.before-subscription-fix-20260915-135307`.
See [[public-domain-atoma-run]].
