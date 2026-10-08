# Atoma plugin for Claude Code

Connects Claude Code to the hosted Atoma MCP (`https://atoma.run/mcp`) and
adds:

- the `runs` skill (`/atoma:runs`), which Claude loads on its own when you
  talk about Atoma: drafting a goal and acceptance criteria, continuing a
  project, following and investigating runs;
- the `atoma:trace-reader` agent, which reads a run's whole trace with
  read-only tools in its own context and reports the decisive events.

## Install

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
