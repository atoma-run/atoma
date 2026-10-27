# Bounded source context for the mender — 2026-10-27

The mender previously received the sanitized finding and had to locate all
source context itself. Both Claude and Codex now receive a navigation packet
before their first turn. The packet is produced without a model call or an
indexing dependency, by fixed read-only Git commands against the captured base.

The packet contains up to three cited source excerpts (45 lines, at most 3,000
characters each), lexical relative-import candidates, filename-based test
candidates and applicable ancestor AGENTS.md locators, including the intentional
choices heading. A line citation in evidence refines a file-only proposed fix.
This is intentionally partial navigation, not inferred types, semantic symbol
references, a complete dependency graph or verification evidence. The model
still reads contracts in full and the harness still requires regression failure
before the fix, both full typechecks and structured successful verification.

The packet is limited to 14,000 UTF-16 code units and retrieval to ten seconds.
Only regular blobs from src/, tests/ and the root AGENTS.md are eligible;
symlinks, submodules and untracked files are excluded. Blobs above 256 KB are
omitted. No raw trace, quote or free-form finding detail drives retrieval. Git
arguments are fixed, with validated SHA/object IDs, and no repository code is
executed. Retrieval failure falls back to ordinary reading; cancellation still
stops the attempt. Source is untrusted prompt data, appended after template
expansion. Logs report base SHA, packet size and collection duration.

## Measurement

One local, unpaid retrieval on Node 24.20.0 at base
`ed4ebc11bb4072bd4b094f19381efbf975ff67c0`, with locations
`src/atoms/L1Atom.ts:200 src/supervisor/mender.ts:600 src/core/llm.ts:100`,
selected all three files: **8,289 characters in 186 ms**. This measures packet
construction only. No reduction in model turns, tokens or repair time has been
established; that requires comparable actual mend sessions.

## Verification scope

Behavioral tests use real Git repositories and immutable blobs: source excerpts,
TSX and line anchors, import/test hints, contract locators, dirty-file exclusion,
symlinks, untracked paths, traversal, trace exclusion, output bounds, cancellation
and literal prompt placeholders. The real worktree/process pipeline checks both
model transports receive the packet, and that optional retrieval failure still
runs the ordinary regression and publication verification.

Final clean-copy `npm ci` followed by `npm run release:check` passed: both
complete typechecks, lint, audit, build, compiled release/auth and CLI smokes,
and 8,369 tests (67 skipped). Removing only the context argument passed to
`buildMenderPrompt` made the real worktree/process integration test fail at its
packet-presence assertion; restoring it passed. No live model call was used.
