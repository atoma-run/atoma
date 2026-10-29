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

## Deployed fixes and delivered repair 36e940ba

Runtime 10dd6021 and then 36d647b8 deployed successfully. Full supported release
verification passed 8,572 tests / 44 gated skips; the packaged isolated worker passed
49 real isolation/retention tests. The parent suite now rejects native Vite/Vitest
configuration imports before delegation, teaches additive exclusions and complete
shell output, and reads existing explained criterion decisions when a verdict
omits global reasoning. The two exact historical malformed review responses were
normalized offline without changing decisions or making paid calls.

New source 36e940ba-18df-436f-9ff9-65fd7a45b97a delivered 2026-10-29T00:51:53.611Z
from the owner-approved repair goal and original 38bfe415 checkpoint. Initial
snapshot d183cf1a has the same c1edcd0d digest:276 entries, 251 files, 4,496,267 bytes.
Full base64 export, saved context, every mode and the hosted initial materialization
match. The initial and hosted workspace root modes are 755. The private host copy
of the delivered source has root 700; every entry mode remains preserved.
Independent comparison and all 251 manifest hashes confirm exactly the two allowed
files changed; 249 files and every other entry are identical. No client acceptance
or publication occurred; 5ff2e4df remains the accepted reference.

The final focused suite passes 8 tests including the three interleavings; the
stale-status mutant fails two original assertions and the missing-history-wait
mutant fails the original #lastRun assertion. Restored positive control passes 8.
An isolated fresh build and the full browser configuration pass 31 tests / 6 files;
the clean root-only copy passes 121 Vitest + 89 Node tests with browser/node_modules
absent before and after. Recovered typecheck errors and the /tmp noexec esbuild
installation failure remain in the evidence. An early shell exit means the later
lines of that composite command did not execute; separate later calls establish
the actual install/build/browser results. Git is unavailable in the worker;
whole-workspace hashes, not a successful trailing shell command, establish scope.

## Hosted replay 03f5cf43: capacity refusal before all shell execution

The automatic job queued 00:52:34.217Z and ended INCONCLUSIVE 01:07:46.083Z.
Private run 03f5cf43-d2ca-4796-a745-e40c9c641e6c uses runtime 36d647b8 and the exact
immutable initial state. It consumed 21 calls / $0.2527196 / 2,596,760 tokens including
cache in 15m03s; the $0.25 fence stopped further acceptance, while 8M / 30min remained.
Every shell call failed before process creation:50 ENOSPC scratch-HOME errors plus
two allowlist refusals; two server starts also failedENOSPC. There is no hosted
browser or clean-copy verification to claim. A registry failure and a skill
revision did occur, honestly recorded as countersChanged/recipesChanged=true.
No final root acceptance ran. The final private workspace is separately archived:
276entries,only the same two files changed,249 files unchanged,all entry modes preserved.

A model-free disposable container of the deployed worker, without any project or
host mount, reproduces mkdtempENOSPC and zero unprivileged available blocks.
The product-state and root volumes have free space; containerd's configured root
is on /mnt/HC_Volume_104738584, a distinct 49GB volume at 100%. Read-only diagnostics
retain daemon identity, filesystem capacity, inode state and cache inventory.
Docker reports 21.66GB of build cache, 9.3GB reclaimable. Removing unused build cache
older than 24h while retaining 8GB was proposed; automatic approval review rejected
shared production cache deletion without explicit owner approval. The owner then authorized that exact operation; it reclaimed 493.9MB, but the
worker still reproduces ENOSPC. The detailed cache inventory showed that retaining
8GB could not free enough space. A replacement operation retaining 4GB of unused
cache, including recent entries, awaits explicit approval. No image, run evidence, application data,
worktree, active agent or intentionally local change has been removed or changed.

The follow-up source raises the finite validation cost fence to $1 while retaining
8M billable tokens / 30min and every acceptance requirement. The regression admits
the observed cost and still rejects both cost/token overruns before another
transport call.18focused tests pass; npmci/audit green, full release check pending.
Deployment and MCP retry of SOURCE 36e940ba must follow successful verification
and recovered worker capacity, preserving the same snapshot/context. Do not start
another customer-device repair for this already delivered source.

## Complete preserved reading

Both exact original traces and host logs, all prompt/event fields, final source
and private workspaces, initial export/context and hash comparisons are retained
under /tmp/attica-validation-finish-20261029 pending the final private archive.
Source: 84 events, 83 attestations, 62 unique gzip archives, 615,983 decoded bytes.
Hosted: 140 events, 88 attestations, 30 unique gzip archives, 450,511 decoded bytes.
Every gzip SHA256/length and each lossless reading view is inverse-verified;
all bodies and both full run.log files were read to the end. Exact prior bodies
are referenced only after prior complete reading; the view's alias table retains
them with their hashes. Source book 223,643 chars and hosted book 308,927 chars were
read in contiguous 32k ranges, including initial type metadata and final verdicts.
Hosted original trace SHA256:
2b754dbc72a81d34b3dbfff033075fbca7837c5eb52f37defd057d52fc5f52a0.
Source MCP reconstruction is object-equal to its original host trace. The source
worker does not provide separate temporary-log snapshots; complete transport
output archives are present. Failed commands that never spawned have no stdout
or exit code to recover; the raw tool exceptions are preserved instead.

### Private archive and verified follow-up commit

Budget follow-up commit `375294a14a43fffc0656bb3c19e07b94c2b3285e` is verified and
pushed to `codex/compute-validation-evidence`. Main and the deployed runtime remain
`36d647b8cf52138f655129a4d6ed66b754707492` while storage recovery is pending.

The complete before-retry evidence is retained in this [private archive](/Users/mgtf/.codex/visualizations/2026/10/27/01a17e33-a1fb-7a62-bd3f-0b05141ffc62/attica-36e940ba-validation-03f5cf43-before-retry-20261029.tar.gz).
SHA256: `71201849da3ce0ebde11c7e02dceee0d38ba9c7d5b9ba173623b8acf7f202224`.
All 487 files were hash-verified inside the archive; it has mode 0600. This is a
frozen receipt of the inconclusive attempt, not a passing hosted verdict.
