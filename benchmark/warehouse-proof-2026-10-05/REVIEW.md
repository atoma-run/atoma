# Production exercise of focused acceptance — 2026-10-05

Run `a239be59-4a72-4592-a634-f3fe3161aff9` used deployed revision `5182794e568f6bb9650cdc499abd56afaad03723`, seeded from partial run `2c03a3f6-1300-407c-a3b0-7fc21dddb0c1`. The original seven criteria were unchanged. The goal added three independently reproduced defects: CRLF error-row numbering, an output-directory alias overwriting an input, and partial publication when the second destination is a directory. `before-io.jsonl` records all three failures before the run.

## What happened

The first edit introduced an ENOENT regression for output directories not yet created. The recorded 11-test suite caught nine failures; later source edits restored the suite. The L2 validator also refused the admitted missing input-byte comparisons for conflicting-duplicate and excess-return cases, then the molecule added those assertions and reran the suite. Recovered edit errors and failed test executions are retained, not removed from the trace.

The global root approved the resulting delivery. **All four focused reviews then ran in production**, returned complete judgments for all seven criteria, and approved. The final criterion reasons are the focused reasons, rather than the global narrative. The host readback included the full 12,412-character test file; the focused prompts contain no cut markers. This exercises the shared readback allowance with a real file substantially larger than the former 6 KB threshold.

The run finished delivered in 709.781 seconds, with 15 recorded calls and $0.1975 subscription-equivalent usage. The four focused calls took **47,669 ms** in total and cost **$0.0204428 equivalent**. These are observed components of one run, not a controlled speed comparison or a cash invoice. Raw calls and arithmetic are preserved in `live-evidence.json.gz` and `summary.json`.

Publication: `mgtf/atoma-stock-reconcile-20261005`, main, commit `37095388058acebef60323890a2457ae868524e7`. A fresh clone was checked out at that exact commit, and all seven file hashes matched the production manifest. Its own eleven tests also passed locally (`local-suite.log`). All 102 events, complete metadata and summary were read to their final page with snapshot checks and archived.

## Independent results and remaining defect

The previously registered nine regression cases all pass (`independent-checks.jsonl`). The three new I/O/CRLF cases also pass (`after-io.jsonl`). Both scripts operate on isolated temporary input/output directories and execute the actual published CLI.

Two positive cases fail (`before-valid-directory.jsonl`): valid `opening.csv` and `events.csv` with outputs in the same directory, directly or through a directory symlink. Neither output name collides with an input. The repair imposed a blanket input-parent-directory ban, and its symlink regression fixture incorrectly treated a safe destination as unsafe. The criterion reviews did not identify this unrequested restriction. Therefore **12 passing regressions and a delivered status are not a claim of complete correctness**.

A narrowly scoped continuation keeps the original seven criteria and adds an eighth explicitly pairing safe shared-directory execution with real input-identity collision refusal. Its request is in `../warehouse-valid-directory-2026-10-05/`. The automatic analyst held the global lease after this run; the continuation waited for it to finish rather than bypassing the lease.

This distinction is material: strict aggregation and complete evidence prevent the identified approval/visibility failures, but semantic review can still miss a new defect. Positive controls remain necessary alongside negative regression cases.

The automatic analyst completed before the continuation and graded this run `sound` with observation-only findings (`analyst.json`); it likewise did not identify the unsafe positive-case assumption. No mender PR was proposed for this run. That verdict is model-authored corroboration of the recorded workflow, not a substitute for executing the independent positive controls.
