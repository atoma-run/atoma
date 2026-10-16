# Versioned application skeleton

All JavaScript-runtime applications produced or modified by Atoma adopt the
same application tooling contract, including existing applications:

- Strict TypeScript for application source and maintained tests.
- ESLint with typescript-eslint and type-aware rules.
- Vitest for unit and integration tests; Vite for browser assets.
- `dev`, `typecheck`, `lint`, `test`, `build`, `start`, and `check` scripts.
- A package lockfile and explicit supported Node version.

`check` runs typechecking, lint and tests. `build` produces the runnable output.
Final acceptance needs observed success on final source and behavioral checks
of the built application. Neither example tests nor the presence of scripts
establishes product correctness. Existing behavior and assertions are preserved
when adopting the tooling.

## Generation

Use the existing `run_shell` element with `command: "atoma-scaffold"` and
`args: ["web", "."]`. The utility is part of that element, not a shell PATH
executable; it must be invoked directly, not from bash or a compound command.
`node` provides the Node server/CLI starting point; `web` and `fullstack`
share a browser build and Node serving foundation. Application code can extend
that foundation without adding an Atoma runtime dependency.

The destination must be empty. For an existing application, generate into
`.atoma-skeleton`, inspect the reference and adapt the application's existing
configuration and entrypoints. Do not replace its source, data or tests with
starter files. The reference directory is not a deliverable.

Run `npm ci --include=dev`, `npm run check`, and `npm run build` in the generated
project. Browser projects build into `dist/client`; the Node entry is
`dist/server/server.js`. `npm start` uses that compiled entry and respects
`HOST`, `PORT`, and the `LISTENING_ON_PORT` readiness convention. Adjust hosting
configuration and any framework-specific files to the application's real needs.

## Maintenance

The generator and lockfile are packaged with the tool worker. Updating the
skeleton changes its version and tests its generated projects; existing apps
are adapted deliberately, never overwritten at launch. No task classification
heuristic, new element, supervisor command replay, or additional model call is
introduced. Runtime policy is shared with planners, execution and review.

`npm run application:skeleton:smoke` runs after the Atoma build, installs each
variant in a fresh directory, checks and builds it, starts its compiled server,
and verifies that source/test type errors, floating promises and failing test
assertions actually fail their commands. It is part of `release:check:static`,
so the existing required CI job gates deployment on it.

Design review: [adversarial cases](../../records/reviews/application-skeleton-2026-10-16.md).
