# Application skeleton review — 2026-10-16

The accepted design is a deterministic utility in the existing run_shell
surface. It carries the same scope, tool observations and mutation handling
as other run_shell calls. Explicit shell allowlists still apply. No element
identity, worker handshake, agent rank or supervisor execution privilege changes.

Adversarial cases considered:

- Existing files, including a package or data file: refuse a nonempty target
  before writes. An existing app obtains a separate reference and keeps its code.
- Traversal and symlink escape: resolve target and each generated destination
  through ToolSandbox; create files exclusively. A concurrent writer can cause
  a partial generation, never permission to overwrite its files.
- Non-application tasks: no files are injected into workspaces at launch.
- Build-only transpilation, tests outside typechecking, floating promises and
  tests that never run: the generated check command covers source and tests;
  executable negative probes deliberately fail each relevant command.
- Placeholder tests: runtime guidance explicitly requires product behavior
  checks in addition to skeleton examples.
- Static-web molecules without shell: the existing delegation policy assigns
  tooling and build to a shell-capable child; no scope broadening.
- Old stored methods and fallback proof turns: reuse the shared runtime policy.
- Prompt layout drift: rerun Decision calibration regressions along with policy
  propagation tests; preserve TASK_CONTEXT_HEADER.
- Worker packaging: JSON lockfile is a direct import copied by tsc; the worker
  copies dist/tools. The closure reader uses import declarations, not import-like
  text inside generated source. The compiled smoke creates fresh applications.
- Dependency drift: direct versions plus a full lockfile, tested via npm ci.
  Updating dependencies is a deliberate skeleton revision.

Limits: the skeleton is a supported starting configuration, not a semantic
proof that future edits retain full coverage. Final acceptance still reviews
actual source/configuration and observed checks. This adds no lexical gate or
automatic approval. Browser asset serving is smoke-tested here; user journeys
remain the application's responsibility and existing browser verification path.
