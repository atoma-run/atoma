# Attica schedule browser-test race — 2026-10-28

The owner requested diagnosis and repair of the intermediate browser failure
retained in [validation 293f7277](compute-review-raw-logs-2026-10-28.md), followed
by an exact MCP retry of the same checkpoint and complete evidence reading.

## Reproduced cause

The defect belongs to `tests/attica-control-recovery-ui.vitest.test.ts` in
`mgtf/atoma-attica-property-flipping`, not to Atoma's runner or review parser.
The published Attica base was `3a003a7d7728678ae83cb1e0d357479b9208fb7e`.
The failing scenario advanced an injected clock to the schedule's due time,
called `tick()`, captured `/api/status` and `/api/schedule`, waited for the UI's
page/listing counters, then asserted on those earlier API responses.

The real server also ticks every second. If that interval admits the due job
first, a second `tick()` returns `{ due: false }` immediately because a job is
already active. This is duplicate-admission protection, not a promise that
joins the existing job. A deterministic reproduction on a fresh build holds
fixture content, lets the real interval admit collection, then observes exactly
that response and `progress.active: true`. After releasing the fixture, a new
status says `complete` / `active: false`; the earlier response remains true.
Thus rebuilding is not a synchronization fix and cannot establish that the
historical failure was caused by stale output.

There is a second independent observation race: page/listing counters can be
visible before a later schedule poll renders its completed history. Holding
only the browser's schedule response reproduces the earlier `#lastRun === "—"`
failure while collection itself has already completed.

## Repair and verification

Attica commit `6e45aa300737e8264f918bbcd19cb0e93521a2b7` changes only that test.
It waits for schedule-save acknowledgment, polls fresh server responses until
the admitted collection and schedule history complete, then waits for the
browser's corresponding progress and history. Every original final assertion
is retained. The scenario now exercises manual admission, a job already owned
by the real interval, and delayed browser schedule/history independently.
Fixture gates are released in `finally`; no production API, application byte,
dependency lock, schedule behavior or timeout ceiling changes.

Verification in an isolated clone with pinned Node v24.20.0 and real Chrome on macOS:

- Root-only `npm ci --include=dev`, followed by `npm run check` with
  `browser/node_modules` absent throughout: typecheck, lint, build, 121 Vitest
  tests and 89 Node tests pass.
- Separate pinned browser installation: all 6 browser files / **31 tests** pass.
  The two added adversarial interleavings account for 29→31; no scenario is
  skipped in the complete browser run.
- Negative controls independently restore the stale status response and remove
  the UI history wait. They fail the original assertions respectively with
  `active: true` and `#lastRun === "—"`. The fixed source is restored afterward.

Root installation reports four existing dependency advisories (one moderate,
one high, two critical); the isolated browser package reports none. This repair
does not change package versions or claim those advisories are resolved.

The exact tested commit was pushed to Attica `main`; a remote read confirms it.
That repository has no release/deployment workflow. This is a published test
repair: it requires no application restart and is not represented as a runtime
deployment or a new accepted Atoma delivery. Active agents' worktrees and the
Atoma primary checkout were not modified.

## Historical retry boundary

The original source `5ff2e4df-32fc-4ab5-8096-2e985bc77640` remains delivered and
accepted. Its initial snapshot `5f3c80fc-a2f8-4bec-be66-e73a06ea0be5` retains the
old test and its goal forbids changing tests. Publishing the repair does not
rewrite that capture. The owner's explicit same-checkpoint instruction is implemented as an exact
historical retry. No new customer run was started and no corrected test was
injected into historical validation.

Production MCP `atoma_compute_validation_retry`, key
`attica-compute-validation-mcp-20261028-03`, created attempt
`7415bf16-e69c-47a9-b516-0605a5260a2d` at 21:40:57.344Z; it was claimed at
21:41:17.344Z by executor `5a37f65493d9315dceb5f78d12176c5a8e8979c9`.
Independent read-only verification of its materialized initial workspace confirms
all 276 entries / 251 files / 4,496,267 bytes, digest
`c1edcd0dbd0908af446794b21d80aece7bf045d312bc72d9f59c2a67fa30dfa5`,
and unchanged initial-context SHA-256
`773f20daff47633f9d4f30ee1d234f88271e7b748b353055ee5d587954e44b5d`.

The private trace is still outside the public MCP reader (`no trace at
7415bf16-e69c-47a9-b516-0605a5260a2d.json`). After that exact response, read-only
SSH supplies the original trace and full evidence. The terminal receipt and
complete reading results follow. An exact historical replay cannot be claimed
as production execution of the new test.


## Linux worker proof

The repaired file also passes **8/8 tests**, including all three schedule
interleavings, in real `/usr/bin/chromium` inside an isolated Linux worker.
The existing `atoma-worker:validation-logs-release-20261028` image was reused,
never rebuilt or retagged. The disposable container had network disabled,
2 CPUs / 3 GiB, dropped capabilities and no-new-privileges; it built the app
before executing the test. Its removal was confirmed afterward. Locked Linux
packages were prepared outside the container with scripts disabled. An initial
install issued from the wrong temporary directory failed EUSAGE; that failure
and the corrected installation are both retained. The complete proof log has
4,885 identical tar provenance-xattr warnings, represented losslessly by their
exact text and count during reading; all other output was read in full.

## Terminal production result

Attempt `7415bf16-e69c-47a9-b516-0605a5260a2d` ended at
**2026-10-28T21:52:13.618Z**, **10m56s after claim**, with MCP verdict
**inconclusive**. It spent **$0.1351742**, 20 GLM-4.5-Air calls, with no budget,
token or deadline exhaustion. Two molecule type-success credits were recorded
(Sucrose v6 and Ammonia v17, validated by Idioblast); no new recipe, prompt patch
or learning call was recorded. Neither a passing browser check nor positive
individual criterion batches overrides the refused final acceptance.

The full chronology matters:

1. The first molecule initially copied an empty temporary directory instead of
   `/workspace`; its apparent CLEAN_COPY_OK marker was insufficient and npm ci
   failed without a lockfile. It corrected the copy, then root-only check passed
   (121 Vitest + 89 Node tests, typecheck, lint, build). Both browser runs failed
   the old schedule/history assertion at line 383: 28 passed / 1 failed each.
2. Criterion response `58dd3075-8c29-42e9-9939-76cf82fae0fd` for c5/c6 omitted
   the required top-level `reasoning`. Root acceptance
   `74e3d6c9-cbc0-4180-8a67-c517188fad16` was refused with those criteria
   unjudged; c1–c4 were positive. A root remediation followed.
3. The second molecule repeated a correct clean-root verification, again
   121 Vitest + 89 Node tests. The third browser run passed all **29 tests**,
   including the two focused files / five cases. No test bytes changed and no
   main-workspace rebuild was observed between the three browser commands.
4. Final c1/c2 response `8d2d7dea-73b6-4fe9-a2ac-20bb58e407c9` emitted `reason`
   instead of required `reasoning`. Final acceptance
   `d6bc9f87-86ba-4cb2-835e-8a54a7d64cf1` was refused: c1/c2 unjudged,
   c3–c6 positive. Exact reason: `Criterion review incomplete: invalid verdict
   JSON. Obtain a complete evidence-based review; no implementation defect is
   established.` This is the terminal review-format failure, not a browser
   execution failure or a successful six-criterion validation.

Fallible model annotations are not promoted to facts. Two earlier failures do
not prove the test always fails. The script `test:browser:ui` does not build the
application first. The three extra Vitest offline-runtime tests do not replace
the 89 Node tests. The second molecule's claim that no pre-existing failure
was exposed only describes its own phase; two browser failures remain in the
same run. The independently controlled reproduction establishes the races.

Read-only final integrity checks still match the original 276-entry initial
snapshot and context hashes above. Only `vitest.config.ts` changes (459→516
bytes); the other 250 initial files and modes remain unchanged. The generated
probe manifest is recorded separately. Production Docker inspection after
termination finds no remaining container for this attempt. Source acceptance
at 19:19:06.300Z, publication at 19:19:20.657Z and artifact manifest
`2d2ce950a3dd16d02b786d49c44a69acaa676eed0a14dd448f7231759f2e7dbb`
remain unchanged; the direct test-fix commit is a separate GitHub publication.

## Complete evidence closure

Read every execution prompt and response, all **81 events / 20 model exchanges /
54 attestations**, and all **68 archive occurrences / 37 unique decoded bodies**
(770,728 occurrence bytes / 314,659 unique bytes). Every gzip envelope's decoded
length and SHA-256 was verified. Seven captured log paths contain six distinct
bodies / **48,153 bytes**, with no capture omissions; every byte was read,
including both failed browser logs and the successful third run. The complete
25,430-character host log was also read. Exact references to previously read
identical bodies avoid interpreting repeated content as new evidence. An
independent inverse verifier reconstructs every archive, event, attestation and
execution-metadata object from the reading representation and compares it with
the original. The unused initial type catalogue remains in the raw trace.

Original trace: 2,957,857 bytes, SHA-256
`5667196304c5c1f901ccfd21e1280f1eb0baa0b56815814deb6d1532248bf1bc`.
Private local archive `attica-validation-7415bf16.tar.gz` in this chat's artifact
folder retains 169 payloads plus internal SHA256SUMS, including the original
trace, decoded archives, prior reference bodies, all raw logs, integrity
receipts, reproduction, patch and positive/negative verification logs.
Its internal checksums were reverified inside the compressed archive; mode 0600,
archive SHA-256 `374eca2e33b433b13d5bd77c1edc665212d475e0f93f1933046097043e6bcbca`.
No credential/header output or extra remote upload is included. No further
paid retry or model replay was started after this terminal result.
