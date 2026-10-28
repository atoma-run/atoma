# Same-checkpoint Attica repair and Compute interruption — 2026-10-29

The owner selected a new repair from the historical checkpoint, followed by
automatic validation. The exact request is retained in the private evidence
archive. It permits changes only to the recovery browser test and one additive
Vitest exclusion; it does not authorize client acceptance or publication.

## Source run

Production MCP started `a2cc0c98-0510-4d77-838d-a26b4cf0bff7` with key
`attica-schedule-race-repair-20261029-01`, base
`38bfe415-018e-406f-8609-326779646429`, short depth. The start call timed out
after 300 seconds; no second start was issued. The selected executor was
`5a37f65493d9315dceb5f78d12176c5a8e8979c9`. Compute was initially disconnected;
using its normal reconnect action admitted this assignment on the Mac.
The installed desktop remained 0.5.200; no app or image update occurred.

The runner stopped at 2026-10-28T22:42:33.226Z before its current molecule
returned. The public run closed FAILED at 22:54:54.219Z after reconnecting
Compute confirmed workload stop. Production explicitly reports that no
cancellation was requested. The trace's `cancelled: true` / `shutdown requested`
is runner shutdown accounting, not evidence that the person cancelled.

The client records transport interruption at 22:40:23.282Z, failed heartbeat
at 22:40:55.495Z, stop confirmation, then a five-second reconnect handshake
timeout. The server's matching session diagnostic records lease expiry at
22:42:33.221Z, 120.655 seconds after its last received message, with one tool
invocation pending. This establishes connection loss and expiry; it does not
identify the underlying network cause. A system-wide journal request was
rejected by automatic security review; a later query limited to this executor,
window and exact run/session identifiers succeeded. No service restart,
lease mutation or other agent interruption occurred.

## Initial state

Snapshot `7568f3e3-2b6f-435f-897a-83ef34e8df3e` has digest
`c1edcd0dbd0908af446794b21d80aece7bf045d312bc72d9f59c2a67fa30dfa5`:
276 entries, 251 files and 4,496,267 file bytes. Paths, kinds, modes and bytes
match the historical initial workspace. The new goal and one-item acceptance
checklist are intentionally captured in a new context, SHA-256
`f5f296ef70d115f21aa249ce9ad598259a3cadc4bf35cb96db6da0a20d042218`.
The complete checkpoint blob and exact context were exported privately;
local verification checks every exported file against the saved index.
A separate read-only comparison of the automatic validator's materialized
initial directory checks every file byte and complete mode: zero differences.
An early verifier compared permission bits against full `stat.mode` values;
that diagnostic-script mistake was corrected before asserting identity.

## Independent source review

A stopped local allocation remains in the managed volume. A no-network,
read-only helper container read that volume; no customer code was executed.
Comparison at the actual `current/` volume subdirectory finds exactly the two
allowed file modifications, zero missing initial entries and no extra
non-scratch source files. Every other initial file, including generated dist,
application code, data, other tests and dependency locks, remains byte-identical.
Dependencies and `.atoma-scratch` were excluded and explicitly inventoried.
This is forensic inspection of interrupted work, not a delivered manifest.

The repair is NOT accepted:

- The parent planner event `fd66eb06-df51-4f71-b02c-53b6be57ff34` contradicts
  the goal by asserting the existing recovery exclusion must be absent.
  Edit `6eb31176-c27d-4f36-b8ec-b1e0931da1ea` follows that mistake: the new
  search exclusion replaces the old recovery exclusion instead of adding it.
  Clean root-only checks then fail five cases on absent Playwright. Passing
  checks in a workspace with browser dependencies do not satisfy that check.
- The parent's suite imports `vitest.config.ts`; its module fails to load with
  the generic native-binding message. The assertion never executes. Two
  refusals are recorded before escalation from CarbonDioxide to Cortisol.
  The generic npm message alone does not prove a corrupt installation.
- Browser suites did pass 29 cases in intermediate versions. The final retained
  recovery file has only one combined scheduled scenario, not the required
  three independent interleavings. Its latest focused run,
  `2aa3e2ba-5dc7-44a5-a81d-87f0ea92230e`, fails 1/6 with a 15-second UI wait
  timeout after introducing a held schedule route. Earlier green output does
  not verify these final bytes.
- A later genuine stale-status mutant fails after two invalid ReferenceError
  attempts; those failures are retained. Removing the history wait in
  `f8ef5b56-8407-455c-a89c-dfd61f286c17` still passes 6/6. That negative
  control does not demonstrate the independent history race.

The source records $0.24381596 across 12 completed LLM calls (11 Luna, one
Terra). The interrupted final execute call has tool evidence but no completed
model response. No success, delivery, acceptance or publication is inferred.

## Automatic validation

The job was automatically queued at 22:55:16.554Z and claimed at
22:55:16.611Z. Its hosted run is `d79d05f0-6187-4892-b1f5-dea4197ecfe2`,
using the same captured initial state and new repair goal. It is a separate
ordinary repair replay; it cannot retroactively deliver the failed source.
The MCP trace reader refuses this private run with `project run not found`;
read-only SSH supplies the saved private trace afterward.

Terminal result and complete reading receipt are appended after the job ends.

### Terminal result and reading receipt

The automatic job ended **inconclusive** at 2026-10-28T23:04:54.125Z,
9m37.514s after claim. The private runner ended at 23:04:48.526Z with delivery
refused: `Root acceptance could not finish within the landing budget`.
Its full log gives the precise earlier cause: **1,500,997 billable tokens,
including 1,397,312 cache-read tokens, exceeded the 1,000,000-token ceiling**.
The 900-second deadline and $0.25 ceiling were not reached. Cost was
$0.07753246, four completed GLM-4.5-Air calls. `countersChanged` and
`recipesChanged` are both false. The assayer health label `compute-validated`
means that background processing ended; it does not override this job verdict.

The hosted molecule correctly adds the missing exclusion. It first waits for
completion while still holding fixture content, times out, then repairs that
ordering and passes the focused six-test suite. A genuine stale-observation
mutant fails. Several attempts to remove history/reflection waits still pass;
none proves the required independent history interleaving. The last edit leaves
`// mutant: schedule/history reflection waits removed` in the final test.
The full browser suite and clean root-only install/check were never run, and
no final restored positive control exists. No result-review or root acceptance
model response ran after the token ceiling. The molecule's claimed atomic
schedule explanation is its own interpretation, not an independently established
refutation of the previously reproduced race.

Independent final comparison finds only the two allowed files changed and
249 initial file bytes unchanged, with no initial file missing. The final
recovery file is 29,972 bytes, SHA-256
`7a440140919256eb0212c83d71e4c1bc073b4a86c126f028d653790048a9a898`;
the config is 516 bytes, SHA-256
`b13afa283f989c1489199d8f1c1fbfa0766712d08ceb60915864df44fe9eeff2`.
All original final assertions survive, but manual admission is no longer
exercised by this scheduled scenario and there are not three independent cases.
The final workspace archive has all 251 files, excludes dependencies/internal
scratch, and hashes to
`14f2b1bc13d08b865aca297729a957908da94e234075f55cda30a205086c74a8`.
It is evidence, not a publishable repaired delivery.

Reading covered all **183 source events / 12 completed model responses /
133 attestations / 130 unique decoded full-evidence archives**, plus all
**53 validation events / 4 completed model responses / 45 attestations /
42 unique decoded archives** and both complete host logs. Every gzip archive's
length/hash and the lossless reading view's inverse reconstruction were checked.
Exact repeated text uses verified full-hash references to previously read bytes;
original traces, MCP pages, aliases and frozen reading prefixes are retained.
The original private validation trace is byte-stable across the terminal reads,
SHA-256 `8c3811bcf7d944a07a3dc2110132e7f76ccd5829e522479f8f3cf7a36143e854`.
The source trace hash `ee1ffc8cf2998149a5ea86eac8680beee59a69b82ba512f4c80bce69122405b9`
identifies its MCP reconstruction, not an asserted hash of the runner's original
file. Source host log: 11,375 code points; validation host log: 28,295.

The hosted commands themselves pipe test output through `tail`/`grep` and
record the pipeline's exit code. A pipeline can therefore report exit 0 for a
failing test. No `/tmp/*.log` snapshots were produced in this replay. All
available output was read; command-filtered-away output cannot be recovered or
claimed as a preserved raw test log. This is a remaining evidence limitation.

No new Attica acceptance/publication, application deployment, image rebuild,
service restart, model-quota retry or source-code fix was performed after these
failures. The previously independently verified Attica test fix remains
`6e45aa300737e8264f918bbcd19cb0e93521a2b7`; it must not be misrepresented as
this interrupted run's delivery. The source's parent-suite contradiction and
module-load failure, connection interruption, unproved history control and
validation token exhaustion remain open. A repeat without addressing these
causes would not be evidence of their correction.

The private archive `attica-repair-a2cc0c98-validation-d79d05f0.tar.gz`
contains 800 checksum-verified evidence files (40,838,035 compressed bytes),
SHA-256 `15c9904dfeb94cfe4b8b49cdc1681aadddb50aa00b96358f710b18036f640759`.
It is retained locally with mode 0600; no project bytes or credentials were
published with this incident record.
