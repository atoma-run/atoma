# Attica run and Compute runtime drift — 2026-10-21

The owner authorized an autonomous five-hour run/fix/deploy session, ending at
23:33:16 UTC. Atoma engine revision `e1e9face` was fully checked on Linux and
activated before the first new Attica run. It keeps unresolved acceptance
judgments in the remediation scope; it adds no model call or automatic vote.

## Delivered run

Run `00669e94-caad-4866-b487-dfe359bec458` delivered after 47 model calls,
$0.8576 subscription-equivalent accounting and one root remediation. Its
manifest is `89ab0e1ec178e88376ea09076cd54af076b371170cc5cf775e036dcf46df4907`.
All 232 saved files were hashed on the host and verified locally. A full
artifact export was rejected by automatic approval review; the safer route
verified all data on the host, fetched only five explicitly named code files
(22,317 bytes) into a private directory, and reused previously verified local
files. No new data or evidence file was transferred.

The two original JavaScript entrypoints match their read-run bytes and modes.
All 48 historical data/evidence files are unchanged. Only three source files
and their two compiled outputs changed. Independent ordinary clean-copy
installation, check and build succeeded: 80 Vitest cases and 92 Node cases.
The seven document cases, twelve overlapping lifecycle cases, empty-result
resume, ten document-envelope cases and synthetic fixture flow all passed.
These counts overlap and must not be added as independent observations.

The complete 306-event terminal trace was reviewed, including seven negative
verdicts, eight failed shell calls and three failed recorded probes. Failures
were recovered before delivery. The first c6 focused refusal could not see a
real clean-copy check in its bounded transport projection (110 observations
were omitted); the subsequent recorded-probe repair supplied it. This record
does not introduce a new selection heuristic or treat omitted evidence as a
failed implementation. Exact event identities are in [run1-review.json](run1-review.json).

Three additional adversarial ordinary-description cases still fail: visible
security-check prose, a quoted human-verification sign in a listing, and
non-rendered JSON description text. They are new follow-up work, alongside
all ten unchanged positive/negative controls. The executable offline witness
is [document-envelope-v5-probe.cjs.txt](document-envelope-v5-probe.cjs.txt), with
[observations](run1-envelope-v5.json). The literal witness is archived as text,
not repository source. Replay it with `node --input-type=commonjs -
/absolute/verified/app --assert < document-envelope-v5-probe.cjs.txt` (one line).
No live property traffic or real browser
profile was used. The known separate Chromium setup/cleanup failure remains
outside this run's scope; no whole-browser success is claimed.

## Compute retrieval configuration

Retrieval preparation failed after 80,063 ms. Its container remained running,
not OOM-killed; all uploads finished before the generic preparation refusal.
The server's Compute setting still expected runtime identity `7a8803e1`, from
the 18 October release. Read-only inspection of the existing immutable image
reported `eaf4e660`, matching the checksum-verified 19 October published receipt.
The configured model content identities match the image manifest. Details are
in [run1-retrieval-runtime-mismatch.json](run1-retrieval-runtime-mismatch.json).

The runtime mismatch necessarily rejects a successful initialization. Generic
error framing does not prove that no earlier failure also occurred. The host
still admits both 18 October (`7a8803e1`) and 19 October (`eaf4e660`) worker
releases. Replacing the global expected runtime would therefore break older
admitted clients; that shortcut was rejected before any production mutation.

The correction adds host-only `ATOMA_COMPUTE_HAYSTACK_CONFIG_BY_DEVICE`, a
UUID-to-existing-HaystackLaunch map. Admission, readiness and dispatch use the
same selector; dispatch reads the immutable run target. An exact override is
selected for the affected Mac. Other devices keep the existing Compute/server
fallback; hosted runs ignore the map. Invalid maps refuse admission before any
row, lease or driver. Raw keys are UUID-validated before record parsing, and
the entire map is bounded to 64 KiB. The full map never reaches the run process.
The server-only contract is outside the unchanged Compute runtime import
closure, so this repair needs no client, image, protocol or storage change.
Runtime/model integrity checks still judge the actual device and remain strict.

[correct-compute-runtime.py](correct-compute-runtime.py) is a one-time operator
artifact, dry-run by default. It appends only the selected device's override,
requires the exact legacy identity and matching model identities, and refuses
an existing map needing a separate merge. The full original file remains an
unchanged prefix, preserving the legacy default and other clients. Applying
creates a private 0600 backup, preserves owner/mode, checks concurrent changes
and fsyncs an atomic replacement. Fifteen synthetic checks and an actual
production dry-run passed without production mutation. The artifact prints
neither credentials nor environment contents. Application and activation are
recorded in session memory only after they actually complete.

Two coordinator regressions failed before the source fix: the selected Mac
received the wrong runtime, and an invalid map reached reservation. Other-device
and hosted positive controls passed. The tests cross coordinator dispatch,
remote retrieval service, a real mock-ranking subprocess and production search.
Additional cases cover both runtime-integrity outcomes, exact UUID selection,
legacy fallbacks, invalid keys/settings, unrelated invalid entries and bounds.
No model call, retrieval algorithm, proof credit or acceptance rule changes.


## Second run: partial, independently verified

Run `070688f0-4191-4c34-ad43-7d574a8f8c9e` ended partial at 22:10:22 UTC:
219 model calls, 10 escalations, one deepening and one root remediation,
$9.6565 subscription-equivalent accounting. Its manifest is
`673997bddb638d5228aebe5d99a80af386715ab314d09e657f19bd9538a6531d`.
[The structured review](run2-review.json) records the outcome and proof limits.

The full 35 MB trace export was rejected by automatic approval review. The safe
alternative scanned all 1,883 events on the host and read bounded metadata,
all 42 negative review reasons, 45 failed-tool diagnostics and 173 probe
inventories through the terminal event. No complete raw trace was copied or
read locally. All 233 saved files were hashed on the host; only 13 explicitly
named code files and source maps (96,492 bytes) were transferred into a private
folder. Previously verified local base files completed an exact reconstruction.
All 233 sizes, hashes and modes match, including after independent tests.
Both original JavaScript entrypoints and all 48 historical files are unchanged.

The three requested ordinary-description/JSON positives now pass. Saved
compiled output passes all 13 V5 cases, but differs from the final source:
its short-message detector became an exact phrase allowlist without a matching
saved rebuild. After a fresh source build, the inherited paragraph
`Please verify you are human` wrongly returns 200 and clears durable CAPTCHA.
Four additional genuine challenge cases also wrongly return200. The baseline
passes all four added negatives. The saved compiled version fails one of them.
The [unchanged controls plus four counterexamples](document-envelope-v6-probe.cjs.txt)
and [baseline](run2-envelope-v6-baseline.json), [saved](run2-envelope-v6-saved.json)
and [fresh-source](run2-envelope-v6-fresh.json) observations preserve that distinction.
Replay the witness with `node --input-type=commonjs - /absolute/verified/app --assert`
and redirect the `.cjs.txt` file to stdin; use synthetic fixtures only.

Independent fresh installation, typecheck and standalone build succeeded.
The ordinary maintained suite passed 82 Vitest and 92 Node tests without new
skips or discovery exclusions. The full ordinary `check` still fails two lint
errors: an unused declaration import and an unsafe CommonJS assignment.
Document/lifecycle, empty-resume and fixture probes pass. These controls overlap;
do not add them as independent samples or claim whole-browser success.

Atoma correctly refused delivery. Earlier successful checks belong to earlier
source snapshots; they cannot establish the final source. The three model
self-executions actually served the L1 model while retaining supervisor
provenance, as designed. All 215 direct HTTP-tool calls observed were loopback.
No additional engine rule, model call, test weakening or fabricated base proof
was introduced to turn this partial run green. The selected 90-minute profile
and review margin prevent another admission within this session.

## Production correction verified

The guarded device override was applied at 20:22:50 UTC with a private host
backup, retaining every original environment byte and the legacy runtime.
Main CI 39669814410, CodeQL 39669814394, Compute desktop 39669814395 and
Deploy 39671397306 all succeeded for engine `f659c3e2`. The active release,
executor and compiled selector were checked independently before the second
admission. Its ordinary retrieval preparation then became ready in 354,531ms.
The first acceptance event 3134c51b also preserves c4/c6 disagreements as
unjudged, confirming `e1e9face` on a new real run. Both engine fixes were
activated before their following product run; the partial Attica application
was not accepted or published.
