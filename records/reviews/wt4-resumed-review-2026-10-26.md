# Resumed review of the a4dcf853 corrections

The recovered worktree ended at `abe377c4`, with five commits based on
`4c8a8682`. Its final Claude workflow reported eight findings, but seven
verification agents hit the weekly quota. The workflow's empty `confirmed`
array was not a completed review: missing verifier results had been included
under `refuted`. This continuation reads the findings and production paths
again rather than accepting that aggregation.

## Disposition

- **Conflicting scope instructions — corrected.** The unconditional claim that
  every change named by the current Task is required contradicted the enclosing
  phase's explicit exclusions. Explicit conflicts now go back to the parent;
  only otherwise do current-task requirements apply. An output list remains
  non-exhaustive, so a missing filename alone neither defers required work nor
  establishes ownership by an unseen sibling. No new mechanical gate or
  filesystem ownership inference is introduced.
- **Unseen sibling assignments — narrowed.** A description that overlaps an
  unseen sibling is a defect in the parent plan, not something this reader can
  establish from an omitted output. The old proposed rule would reject valid
  supporting-file changes. The text now explicitly refuses to invent sibling
  ownership. Existing plan review and output-collision checks remain in place.
- **Cut context — clarified.** A head/tail excerpt can lose either assignments
  or exclusions. The omission label now states both uncertainties. It cannot
  guarantee preservation of omitted scope; the 3,000-character bound remains.
- **Nested local runners and registry retries — corrected together.** The
  unqualified `npx --no-install` example could search the wrong package root
  and perform registry resolution before refusing an absent package. Guidance
  now gives `npm run --prefix` for scripts or an explicit `cd` and local binary
  through the supported compound shell path. A production `run_shell` test
  checks the nested cwd, a quoted argument, a nonzero runner exit, and an
  immediate missing-binary exit without npm resolution.
- **Corpus retention after abnormal stop — corrected.** Boot reconciliation,
  already protected by the machine ownership lock, reclaims only labelled
  UUID-shaped allocation corpus volumes after confirming workload absence.
  Workspace, snapshot, shared cache, unknown and foreign volumes stay. Busy
  corpora stay and are retried at the next boot. No age-based workspace
  retention was restored. Tests exercise the real launcher with a fake engine,
  plus a real Docker stopped-container/corpus fixture.
- **Already confirmed stop — corrected.** The `stopped` dispatcher phase keeps
  the nonterminal `stopping` stage while its message states that the computer
  already confirmed and the host is closing the run. Pending confirmation
  keeps the reconnect instruction. Service tests cover status, polling and
  review without mutating the persisted lifecycle.

The remaining recovered changes preserve the canonical web prompt, batch only
independent calls, carry host-owned enclosing scope through delegation, and
project pending Compute state without changing leases or finalization.
The scope tests exercise L3 → L2 → L1 planning, execution and both reviews,
including a forged child input and passthrough delegation. Mocked models prove
context delivery, not a measured reduction in production refusals or cost.

## Local verification

Node 24.20.0, independent `npm ci` (the former shared node_modules symlink
was removed first), then `npm run release:check`: successful. Both TypeScript
projects, lint, docs, audit (zero vulnerabilities), build and compiled smokes
passed; Vitest reported 579 passing files, 8,344 passing tests and 43 skipped
cases. The subsequently added real-Docker fixture also passed typecheck and lint.
`npm run compute:desktop:build` passed.

Fresh `npm run build:worker` and `npm run build:workspace` images then passed
all 56 tests in `desktop-compute.test.ts`, `container-isolation.test.ts` and
`egress-sidecar-lifecycle.test.ts`, with both image environment variables and
`CI_REQUIRE_DOCKER=1`. This includes the abandoned-corpus fixture. The initial
nested-cwd assertion exposed macOS's /var → /private/var alias; it was fixed to
compare canonical paths before the successful full check. No paid Atoma run
was started to validate this change.
