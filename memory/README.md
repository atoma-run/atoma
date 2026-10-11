# Portable project memory

This directory contains a snapshot of Atoma's project-specific Claude memory,
copied on 2026-10-11. Start with [MEMORY.md](MEMORY.md) for the index.
The 39 original Markdown files retain their content; trailing whitespace and
final blank lines have been cleaned up for Git.

## Using it on another computer

1. Clone or pull this repository.
2. Locate the external project memory directory associated with the new Atoma
   checkout in Claude Code. Its path depends on the computer and checkout path.
3. Back up any existing memory there, then copy or merge the Markdown files
   from this directory, excluding this README, into that directory.

The original source directory was
`C:\Users\mgf\.claude\projects\c--Users-mgf-dev-atoma\memory`.
Do not reuse that machine-specific directory name blindly on another computer.
Keeping this snapshot in Git does not automatically install it as agent memory.
An agent can also read these files directly from the repository when requested.

These notes include dated findings and machine-specific paths. Check them
against the current code and project contracts before acting; the current
`AGENTS.md` files remain authoritative. This is a snapshot, not automatic
synchronization: future external memory updates must be copied back explicitly.
