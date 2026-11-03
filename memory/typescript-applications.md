# TypeScript applications — owner decision 2026-10-16, NARROWED 2026-11-02

**Superseded in part on 2026-11-02:** after round 16 the owner chose ("Ok continue" on the narrowing option) that only a NEW application is strict TypeScript from the skeleton; existing code keeps its language, and existing JavaScript is migrated only when the task or projectContext asks. Implemented on branch feat/direct-depth (docs/decisions/typescript-new-applications-2026-11-02.md). Attica's application code was already strict TypeScript on main b7034bc5 (2026-10-31): 85 TS files, 15 JS shims re-exporting dist, 27 JS tests and a few collection scripts left in JS.

The rest of this note is the rule as of 2026-10-16.

All JavaScript-runtime applications produced or modified by Atoma use strict
TypeScript, including existing projects. The owner explicitly rejected the
new/existing exception and asked for a short uniform runtime prompt: Atoma is
in beta and migration impact is acceptable, including in production.

Migrate only Attica now; do not launch other project migrations implicitly.
The owner cancelled run `e9c1775f-a530-44af-9c8e-ff9989ca0764` and then
requested continuation. It had no recoverable checkpoint. The replacement
migration is run `ae044d1f-9a3d-4b71-ac95-9083a2d28853`,
based on retained partial `6b6b1952-7750-4a02-831a-45c60d0997f4` in project
`07864f7c-d8f2-4023-9fca-afd8a7a51e52`. The owner also cancelled this
replacement at 03:15 UTC. Both migrations are stopped, incomplete and
unpublished. Do not relaunch without a new continuation request.

Policy and rationale:
[decision](../docs/decisions/typescript-applications-2026-10-16.md).

## Application skeleton — owner decision 2026-10-16

The owner approved a versioned shared skeleton: strict TypeScript,
ESLint/typescript-eslint, Vitest, Vite for browser assets, pinned dependencies
and uniform dev/typecheck/lint/test/build/start/check commands. It applies to
existing applications too. Generation uses the existing run_shell surface,
not a new element: direct atoma-scaffold invocation into an empty directory;
existing applications use a separate reference and preserve code and tests.
See docs/decisions/application-skeleton-2026-10-16.md.
