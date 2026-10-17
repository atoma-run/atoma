---
name: read-runs
description: atoma_run_start readRunIds (2026-10-17, d30ff0d7): a run reads up to 3 other runs of its project as .atoma-runs/node_modules/<id>/ copies; how to use it in goals and its known limits
metadata:
  type: project
---

Shipped 2026-10-17 (9e1e3772, 9c4fd13d, d30ff0d7) after three adversarial review rounds. Motivating incident: Attica run 2e6bdcfc could not "restore files to the bytes of run 50019ee0" because a run only saw its seed; later goals pasted lines and sha256 values instead.

**How to apply in a goal:** pass `readRunIds` (1-3 retained delivered or partial runs of the same project, not comparison reruns; together at most 64 MiB and 10,000 saved files; refused with rerunOf/resumeOf and with conversationApproval). Copies land at `.atoma-runs/node_modules/<run id>/<path>` with their saved modes before any model call. Name the files to restore or compare in the criteria: root acceptance compares each saved path a criterion writes out in full (optional ./ or /) with this run's file, on the host. Do not ask parent suites to read `.atoma-runs` (the runner's snapshot excludes it; the precheck refuses such a suite): prove restores with sha256sum/diff in a shell step.

**Layout (moved the same day, before any production use):** the copies first sat at `.atoma-runs/<id>/`, where ESLint flat config, Vitest's default include, Jest and Prettier walked them (one old defect failed a whole-tree check; a clean copy made Vitest count another run's tests). Under `node_modules` every tool that skips dot-directories or node_modules skips them, v1 skeleton projects and imported repositories included; `npm ci`/install/prune leave them alone. Still reaching them: a Vitest config with an anchored exclude plus the default include, `npm pack`. Predicates still recognise the old spelling; a continuation sealed with old-layout copies is refused (RunnerConfigError, source handed back), never migrated.

**Known limits (decision record docs/decisions/read-runs-2026-10-17.md):** write_file/edit_file refuse `.atoma-runs/`, and since the same day the worker mounts `.atoma-runs` read-only (kernel stops shell edits; guard refuses a symlinked source; only host-side changes are merely detected; Docker Desktop shows a false "directory moved" after a worker crash); phase validators do not read the host lines; a paused reader keeps its copies until it is continued or expires; a copy's TypeScript cannot run in place under Node type stripping (copy it out); no viz picker or assistant-proposal support yet. Related: [[attica-run-delegation]], [[parent-tests-review-fixes-state]].
