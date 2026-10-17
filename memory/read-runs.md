---
name: read-runs
description: atoma_run_start readRunIds (2026-10-17, d30ff0d7): a run reads up to 3 other runs of its project as .atoma-runs/<id>/ copies; how to use it in goals and its known limits
metadata:
  type: project
---

Shipped 2026-10-17 (9e1e3772, 9c4fd13d, d30ff0d7) after three adversarial review rounds. Motivating incident: Attica run 2e6bdcfc could not "restore files to the bytes of run 50019ee0" because a run only saw its seed; later goals pasted lines and sha256 values instead.

**How to apply in a goal:** pass `readRunIds` (1-3 retained delivered or partial runs of the same project, not comparison reruns; together at most 64 MiB and 10,000 saved files; refused with rerunOf/resumeOf and with conversationApproval). Copies land at `.atoma-runs/<run id>/<path>` with their saved modes before any model call. Name the files to restore or compare in the criteria: root acceptance compares each saved path a criterion writes out in full (optional ./ or /) with this run's file, on the host. Do not ask parent suites to read `.atoma-runs` (the runner's snapshot excludes it; the precheck refuses such a suite): prove restores with sha256sum/diff in a shell step.

**Known limits (decision record docs/decisions/read-runs-2026-10-17.md):** write_file/edit_file refuse `.atoma-runs/`, but the shell can still edit a copy (detected as touched, not prevented); phase validators do not read the host lines; a paused reader keeps its copies until it is continued or expires; projects created before application skeleton v2 lint `.atoma-runs` with `eslint .` (Attica uses explicit paths, unaffected); no viz picker or assistant-proposal support yet. Related: [[attica-run-delegation]], [[parent-tests-review-fixes-state]].
