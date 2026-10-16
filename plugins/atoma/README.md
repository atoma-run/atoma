# Atoma plugin for Codex and Claude Code

Connects Codex or Claude Code to the hosted Atoma MCP (`https://atoma.run/mcp`) and
adds:

- the `runs` skill (`atoma:runs`), which the host can load when you
  talk about Atoma: drafting a goal and acceptance criteria, continuing a
  project, following and investigating runs;
- in Claude Code, the `atoma:trace-reader` agent, which reads a run's whole trace with
  read-only tools in its own context and reports the decisive events.

Codex reads traces directly through the MCP tools when the Claude Code agent
is unavailable. Starting a run uses Atoma quota; the tools available depend
on your account's role.

## Install in Codex

From a local checkout of this repository:

```bash
codex plugin marketplace add /absolute/path/to/atoma
codex plugin add atoma@atoma
```

Connect the Atoma server from Codex's MCP settings, then start a new task to
load the installed skill and tools. The Codex manifest includes the official
Atoma crystal logo and starter prompts.

## Install in Claude Code

```bash
claude plugin marketplace add atoma-run/atoma
claude plugin install atoma@atoma
```

Then run `/mcp` in a session and sign in to `plugin:atoma:atoma` through your
browser. The tools you see depend on your role in your organisation.

If you already registered the server with `claude mcp add ... atoma`, remove
it (`claude mcp remove atoma --scope user`) so the tools do not appear twice.

## Self-hosted instances

The plugin connects `atoma.run`. For another instance, register its endpoint
directly: `claude mcp add --transport http --scope user atoma <origin>/mcp`.
