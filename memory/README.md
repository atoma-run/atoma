# Shared project memory

This directory is the working project memory, shared through Git. Start with
[MEMORY.md](MEMORY.md); read topic notes as needed. The root `AGENTS.md` asks
coding agents to read that index and write durable project memories here.
Current code and project contracts take precedence over dated notes.

## Claude Code setup (once per checkout)

After cloning or pulling, run from the repository root:

```sh
node scripts/setup-project-memory.mjs
```

Restart Claude Code and check the directory with `/memory`. The script sets
`autoMemoryDirectory` to this checkout's absolute `memory/` path and enables
auto memory in the ignored `.claude/settings.local.json`, preserving other
settings. Run it again if you move the checkout. No notes are copied or deleted.
Each worktree can run the command to use its own versioned memory directory.

Claude Code requires an absolute or home-relative path for this setting:
[storage documentation](https://code.claude.com/docs/en/memory#storage-location).
The machine-specific configuration stays out of Git.

## Sharing changes

Pull before starting work on another computer. Review, commit and push changes
to `memory/` after updating notes; resolve concurrent edits through Git as with
code. There is no automatic commit or push. Do not store credentials here.

The initial 39 notes were imported on 2026-10-11 from the external Claude
project memory directory. That old directory is retained as a backup and is no
longer the configured memory location after setup.
