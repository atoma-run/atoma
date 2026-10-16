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

## What the plugin sends, and where

The plugin runs nothing on your machine: it has no hooks, scripts or local
server. It connects your client to one remote server, `https://atoma.run/mcp`,
over HTTPS, after you sign in to Atoma in your browser (OAuth). What your
client sends through the Atoma tools, such as a goal, acceptance criteria or an
answer to a run's question, goes to atoma.run, which processes it to carry out
the run. Starting a run uses your Atoma quota and sends the work to the AI
model providers configured for your organisation. Results, traces and files
come back from atoma.run as tool output.

See the [privacy policy](https://atoma.run/privacy), the
[terms of service](https://atoma.run/terms) and [support](https://atoma.run/support).

## Self-hosted instances

The plugin connects `atoma.run`. For another instance, register its endpoint
directly: `claude mcp add --transport http --scope user atoma <origin>/mcp`.
