# Complete evidence retention and model-sized review contexts

Owner request, 2026-10-22: retain complete evidence, let validators request
complementary recorded pages, and size active context to the selected model.
[Decision and implementation boundaries](../records/decisions/complete-evidence-reading-2026-10-22.md).

Full attested requests/results and host read-back replies are gzip/Base64 archives
with byte length and SHA-256. The 24k/48k evidence retention ceiling is gone.
Native tool/page limits still bound what was actually returned; legacy lost bytes
cannot be recovered. Initial excerpts are presentation windows, not retention.

Validators can request ids, UTF-16 offsets, lengths and literal searches from
host-whitelisted immutable snapshots. No tool replay or new execution credit.
Superseded read/write/edit bodies stay archived but out of current judgement.
Protocol faults never blame the child or trigger implementation replay at root.
Parallel criterion batches settle before a fault leaves the run.

Large host presentations also keep a complete host_review_context archive.
Only their token-measured preview is reduced; original task/criteria and policy
stay mandatory. These snapshots bypass active proof/credit and are trace-only.

Capacity comes from transport-specific model metadata or the host snapshot's
ATOMA_MODEL_CONTEXT_WINDOWS. Local o200k_base BPE estimates input tokens,
reserving output and 15% tokenizer/protocol headroom. Other tokenizers can differ;
unknown capacity is explicitly unverified. Never treat gzip as fewer model tokens.

Sequential checkpoints retain historical archives in the existing product store's
run_checkpoint_evidence rows, outside the bounded plan payload. Restored ids resolve
by get() only; forAttempt/forBranch remain fresh. New traces retain historical tags.
Live trace deltas omit attestation archives; full canonical traces preserve them.
Bounded MCP projections keep their own materialization limits and are not resume readers.

Adversarial Bugbot review covered protocol faults, stale preview/page/write bodies,
checkpoint restoration, sibling model calls after errors, delta amplification and
snapshot config forwarding. Regressions cross real runner processes with mocked
providers, including a >200k archive read after cold continuation.

Integration on 2026-10-27 retained main's chronological command history and
remediation inventory. CI exposed repetitive BPE work on large padded sources:
token counts now memoize at most 128 bounded chunks per call, preserving exact
counts and retaining no evidence between calls. Native macOS ARM typechecking
also needs a 4 GiB Node heap (fresh full-program check peaked near 2.9 GB).

Compute initial-state retention (2026-10-27): `run/initialState.ts` captures the
fully prepared execution filesystem through the checkpoint transfer boundary,
before backend/probe work. Immutable data-only context and resolved criteria
join the snapshot; continuation plans/prefixes and archives are retained without
restoring old spend, process authority or fresh execution credit. Verification
restores the raw snapshot at launch and deepening. Scope/retention/integrity are
checked before claiming budget. Referenced-run expiry invalidates dependent
captures; shared GC also handles stores with no checkpoint table. Compatibility
2 drains earlier executors before activation because their GC lacks these refs.
Legacy seeded runs lacking a capture remain unavailable; external connector
grants are never replayed. The independent hosted controller uses current models.

### Production Compute continuation check — 2026-10-27

Attica source b0dc0b41 retained all 249 accepted files (4,461,828 bytes), modes
and directories; independently recalculated snapshot digest 3c2c3337468f0a90d0ede0bc6ac61081080350c7a47f96f179d6810057ebf086.
Automatic verification f74435ac started without intervention, restored identical
task inputs, then landed at the 60,000-token ceiling (162,966 consumed); its
job is `inconclusive`, with no counter or recipe changes. Do not call this a pass.
Attica 939f57b6 paused at 1/2 validated phases, snapshot ba2ef0e8-9495-478c-8cfa-ebdc95d0e087,
digest 6f6f5de907860460a93b162d26a70f03914f00b3c83c650f2ff48c7f89d9c04a.
Real admission exposed two guards tests had missed: a Compute checkpoint names
`/workspace/current`, not its control-plane delivery path; and its next allocation
is empty before restore. Check the sealed snapshot for authorized continuations,
retain requester/scope/policy/budget checks and local in-place edit detection,
and verify every byte through the normal restore receiver before execution.
The regression must use the actual coordinator admission and a new workspace
service process per segment, with its seed explicitly bound by the fixture.

### Equivalent root versions and bounded proof volume — 2026-10-28

The same Attica checkpoint stayed ready after dd260d83 refused Meristem v10
against v12: archived v10 and live v12 had exactly identical prompt, ordered
complete tool declarations and params. Catalogue refresh without project search
and a later project bootstrap caused the intervening versions. `savedRootActor`
now admits only that exact archived equivalence under the same immutable atomId,
returns the CURRENT version, and therefore re-reviews the remaining plan instead
of reusing the old version's approval. Real changes, absent/corrupt history and
identity changes still hand the source back. No rollback or old phase credit.
Compute verification's fixed volume bound is 1,000,000 billable tokens: the old
60,000 stopped complete cached proof reads at 162,966 for $0.0137. Every cache
read still counts; $0.25 equivalent spend, 240 seconds, rolling four attempts and
ordinary platform ceilings still independently stop the attempt. Cold-process
regression restores identical behavior at a new version, resumes into a new
workspace process, checks one fresh root review, and verifies only the suffix
executes again in independent validation.

### Intermediate reviews and Unicode fingerprints — 2026-10-28

Automatic Attica verification 95f0c58f completed, but its two child review
faults came from missing GLM-4.5-Air API capacity metadata: the 32,768 fallback
could not hold mandatory instructions and evidence protocol. The provider's
documented API window is 128k (https://docs.z.ai/guides/llm/glm-4.5); output
and 15% headroom remain reserved, with per-selector overrides taking precedence.
Its fallback then changed Python json.dumps from ensure_ascii=False to the
default True: the RÉSUMÉ-CORRECTIONS.md path changed the serialized digest
from 1b5a71d3 to edc30bc8, with all 248 excluded-tree files byte-identical.
Forward the existing host run-start snapshot reader through nested forks and
show its bounded raw-file comparison at child RESULT review too, explicitly
workspace-wide with no branch attribution. Capped/unreadable paths stay unknown;
neither digest-format differences nor host unchanged counts approve behavior.
Runtime fingerprint guidance preserves exact serialization and literal paths;
there is no Unicode normalization, baseline replacement or command replay.

The four-per-24h automatic admission limit originated in implementation commit
45ec6771, not an owner request. On 2026-10-28 the owner explicitly questioned
that unrequested limit and authorized ONE additional attempt for now. Do not
describe four/day as an owner decision or infer unlimited extra starts. The
operator-only source-scoped authorization in the existing queue detail/ledger
admits one never-started job past the ordinary ceiling, atomically and once;
normal per-attempt cost, token, time, provenance and lease rules still apply.

Before granting the extra attempt for ee825326, read-only production preflight
found Meristem v14 versus v15: identical identity/prompt/params and common tool
declarations, with only search_project_docs/list_mcp_tools/call_mcp_tool absent
on the host. A stored optional capability is no current authority. Continuation
may narrow only the established HOST_TOOL_NAMES set, with unchanged ordered
survivors and a fresh review of the suffix; worker removals, additions or changed
declarations still refuse. Initial bytes/history and prefix credits are untouched.

## Owner policy update — 2026-10-28

The owner explicitly removed the four-starts-per-day ceiling and requested a
validation deadline long enough to finish. Compute verification now has a
15-minute deadline; the 1,000,000-token and $0.25 equivalent cost stops remain.
There is no daily admission count or exceptional authorization path. Legacy
never-started budget-wait rows are ordinary FIFO jobs. Each source is still
claimed once, with atomic audit; uncertain completed attempts are not retried.

The previous continuation ee825326 and its automatic replay ff106d92 ended
with the latter inconclusive (deadline during child RESULT review, $0.21107116,
no counter/recipe change). All 40 events and 26 full archives were read/verified.
The source initial snapshot 1dd655b6 retained 250 files, 4,468,648 bytes and 44
historical archives; the replay changed only README by one 48-byte insertion.
The historical guide has a real omission: its test:browser command block lacks
tests/xe-chromium.test.ts. Preserve that evidence; repair in a new iteration
from the retained phase-boundary source 69775aee, not by rewriting old bytes.

## Production confirmation — 2026-10-28

Policy b2cde385 deployed; CI, CodeQL, native installers and real-browser smoke
passed. The retained 69775aee boundary was already consumed, so the owner-approved
repair started c749d7b7 from its identical 250-file snapshot (digest 5119c980…).
Only the guide changed, adding the missing 26-byte Chromium operand. Pause after
phase 1, then actual continuation ce495110 delivered 2/2; only README changed
by 62 bytes. Its sealed initial snapshot 31a0999c/e65f073b… is byte/mode identical
to all 275 source-boundary entries; actor/plan/checklist/completed prefix and
all 17 historical archives match. All 249 unrelated files/modes remain unchanged.

Automatic validations adcc475a (364 s, $0.27690602 with post-acceptance learning
stopped on cost) and fd0a03a0 (210 s, $0.239939) both completed. Both criteria
passed; only freshly hosted observations changed counters, no recipes changed,
and device observations stayed withheld. Seven automatic starts in 24 h
demonstrated removal of daily admission. All 300 events and 260 full archives
were read, decoded and integrity-checked; intermediate quoting, bad regex and
report/baseline errors are retained. Reports sometimes rebased after their own
edit; independent sealed-byte/mode comparisons establish actual preservation.
Private downloaded evidence: /tmp/attica-no-cap-20261028; canonical traces and
initial snapshots remain in the production store/supervisor directories.
Attica was neither client-accepted nor published.

The owner then requested fixing Windows packaging. f7ac788a's Windows npm ci
failed inside node-gyp 12.4.0 after HTTP 200 for Node 24.20.0 headers, before
configure (Completion callback never invoked). Local same-version install
succeeded; no Python/compiler failure was established. Windows CI now prepares
complete official headers + architecture-specific node.lib with bounded curl,
verifies official SHA-256 and header version, extracts from disk, then supplies
node-gyp's documented package-config nodedir. Ordinary install scripts remain
enabled; a real native SQLite smoke follows installation.

Explicit manual preview/publication now rebuilds and republishes identical app
bytes when requested. Automatic pushes still deduplicate. Publication receipts
carry the actual bundled installer version outside the content hash, with the
same run number in the shared content and native jobs; every native runner
checks both hash and version. Both channel ancestry and version monotonicity
are checked under the existing publication serialization, including reversed
completion of two builds of one revision. Legacy receipts without version stay
readable; a receipt lacking version cannot replace a versioned channel.

2026-10-28: the owner reported a corrupt macOS Finder icon in Compute 0.5.198.
The published and installed ICNS match: 512 px is correct, 16 px decodes to
unrelated pixels, and one retina representation has the wrong dimensions.
A checked-in ICNS generated by Apple's sips/iconutil replaces automatic PNG
conversion. Native macOS tests decode all ten representations and check the
brand colors; the original published icon fails that regression. afterPack
checks exact icon bytes, and icon content participates in release deduplication.
The real local bundle's icon bytes match, and NSWorkspace/AppKit renders the
correct icon at Finder sizes. release:check passed 8,512 tests on 2fec89b2 plus
this fix. An Electron smoke timed out under concurrent suite load; the isolated
rerun passed. The installed app was only read, never patched or restarted.

2026-10-28 continuation: the owner asked to continue Attica. Fresh official MCP
SDK connection via the repaired helper works; this chat's existing tool bridge
still failed to answer reads, so it was not used for an uncertain start. Exact
next request is retained at /tmp/attica-functional-next-20261028/start-args.json,
key attica-listings-local-search-20261028-01, base accepted/published ce495110.
Run641c34d6-7ee7-4215-b5d4-09c6496864e7 adds local identifier/location/description
search in Annonces, counts/no matches/clear and query preservation on refresh,
proved through offline Chromium. No live site traffic or auto acceptance.

The run stayed queued with no trace/model call: Mac9baf was connected, accepting,
idle, app0.5.200, but BOTH web/executor loaded exact app versions only through
0.4.150. Its image24f58a was already allowed. Operational correction appends only
verified0.5.200, retaining10 prior versions/all images/ownership/mode, with private
backup atoma.env.before-compute-0.5.200-20261028-105722. No run was recreated.
24 existing configuration/admission tests and docs check pass. The companion
release record and documentation cover preview approval too; activation through
normal CI deployment and the queued run's subsequent execution remain to verify.

OWNER PAUSE — 2026-10-28T11:00Z: the user explicitly said not to relaunch the
run for now. Run641c34d6-7ee7-4215-b5d4-09c6496864e7 was still queued with
startedAt=null; cancelled through the MCP and re-read as cancelled at
2026-10-28T11:00:06.884Z, with no trace/model execution. Do not start, resume,
rerun or replace it until the owner explicitly asks to continue. The local task
watch was stopped. The exact app-version policy fix is already recorded/pushed
in74d53451 and its normal CI activation may finish, but must not trigger a new
run. The former accepted reference ce495110 remains unchanged.

OWNER RESUMPTION — 2026-10-28T15:35Z: explicit "Ok tu peux continuer"
revokes the pause above. Leave641c34d6 cancelled. New authorized functional
run6277e0e0-eb15-425d-b577-37c44876638c uses key
attica-listings-local-search-20261028-02 and the same accepted ce495110 base,
local Annonces search scope and five offline-browser criteria. Both production
web and executor74d53451 now load approved app0.5.200. Compute reconnected
through its normal Connect action; run started15:36:54Z on Mac9baf. Follow this
run, never duplicate its start. No client acceptance/publication is authorized.
Arguments, task receipt and paged evidence are under
/tmp/attica-functional-next-20261028/resumed-02/.

2026-10-28T16:29Z continuation: run6277e0e0 ended partial3/5 after40m16s,
96 calls, $3.4028 subscription-equivalent. Search was implemented and narrowed
back to identifier/location/description after unrelated fields had crept in.
Final check passed121 Vitest+89 Node tests; focused real Chromium passed3/3;
two parent suites passed2/2 each. Final c3/c4 reviews refused on omitted
excerpts despite readable complete snapshots; no client acceptance/publication.
All705 events and691 gzip archives were downloaded, decoded and SHA/size
verified (8,028,583 decoded bytes). Initial snapshot4593f3a8 retains275 entries,
250 files/4,468,736 bytes, digest1fdcd0a035b6ff46ba0683be06aeb6c50ddf7768ca473901e8427d6fe72b1d93.
Manifest comparison:4 authored files changed plus5 generated bundle changes;
242 other files unchanged. The new guide names a label inaccurately.

Automatic hosted validation b0c5b174 ended inconclusive at16:23:58Z after
219s/13 calls/$0.31548366: its $0.25 spend policy stopped it after discovery,
before implementation. Four independently reviewed inspection successes changed
host counters; no recipe changed. All76 events/89 full archives were read and
integrity-checked. This is not a successful independent feature verification.

Owner explicitly authorized replaying the recorded criterion review through
local Codex/gpt-5.6-luna after automatic approval review requested consent for
transmitting the captured code/evidence. The proposed stronger reading prompt
still refused without a read; the original prompt requested pages then approved.
One pair is exploratory, not a general quality measurement. Do not ship the
unproven prompt change. Replay artifacts remain under resumed-02/evidence/replay.

Full test inspection also found real coverage gaps: exports are checked after
clearing rather than while filtered; refreshed cards are counted without
asserting the exact new ID, and key uniqueness is checked after clearing.
Continue through Atoma, not direct collector edits. Short proof-repair run
38bfe415-018e-406f-8609-326779646429 started16:29:51Z, base6277e0e0,
key attica-listings-proof-repair-20261028-01. It must preserve control.ts/html
bytes and all existing assertions, add a small explicit proof suite + browser
include, and fix only the guide's search label. Same five behaviors, stronger
exact-ID/export/request assertions, local fixtures only. Follow to terminal;
never duplicate start. Arguments/task watcher: proof-repair-03 under the same
temporary directory. Acceptance and publication still belong to the owner.

Run38bfe415 DELIVERED5/5 at16:36:55Z (251s,8 calls,$0.17930188). The new
proof actually compares all four fixture IDs and complete valid export bytes
while filtering, records requests before navigation, proves zero collection
requests/navigation, and checks the exact added ID/query/focus/unique keys
while the filter remains active. Existing3+new2 Chromium tests passed. Guide
label corrected. Comparison: one new test, README label and browser include
only;248 unchanged files. All69 events/83 archives decoded and verified
(1,223,565 bytes). Automatic independent validation started16:37:12Z.

Independent review then caught default-suite leakage: root vitest.config.ts
glob includes the new proof but its explicit browser exclusions omit it.
Root check ran123 instead of121 Vitest tests and now requires optional browser
dependencies. Do not accept this configuration yet. Short run
5ff2e4df-32fc-4ab5-8096-2e985bc77640, base38bfe415, key
attica-browser-proof-isolation-20261028-01, created16:38:05Z, may edit ONLY
vitest.config.ts to add the exclusion. Requires an actual clean temporary-copy
root-only npm ci/check with browser/node_modules absent, followed by both
focused Chromium files (5 tests) on final assets. Six criteria retain the five
behaviors and add root-only isolation. Arguments/watcher: browser-isolation-04.

2026-10-28T16:54Z: owner asked who occupied the slot. It was our hosted
automatic validation of38bfe415, shadowfc4a9b26, since16:37:12Z. Its worker
used network-none, repeatedly failing registry.npmjs.org installation with
EAI_AGAIN. It ended inconclusive16:53:00Z,37events/30archives fully decoded
and integrity-checked190,087bytes,4calls/$0.03197732, no counter/recipe changes.
Run5ff2e4df began16:53:01Z; follow it rather than duplicate its start.

Targeted Atoma correction selects existing container-egress for automatic
Compute verification, preserving host allowlist/proxy/private-address policy
and initial-state authority filtering. Regression failed before on three
launcher assertions including an actual npm process, then92targeted tests pass.
Full npmci+release:check passes8518tests/589files (43tests/4files skipped).
Real compiled Docker smoke on existing immutable47705e7f6323 passes npm200
and control-plane/raw-gateway denial; shared worker tag untouched. Incident:
records/incidents/compute-validation-egress-2026-10-28.md. Deployment pending.

2026-10-28T17:28Z: d34c80cf deployed with CI, desktop packaging and CodeQL
green; main later advanced to1d120c7d plus locale5dcaf8e0. Run5ff2e4df
delivered6/6 at16:57:19Z; onlyvitest.config.ts changed,250files unchanged.
All47events/49fullarchives read and verified590,878bytes. Ordinary root-only
copycheck passed121Vitest+89Node, focused Chromium5/5, scratch removed.
No client acceptance/publication. Its old-version automatic shadowa5cdee15
ended inconclusive17:13:09Z after900s,5calls/$0.03135426; all42events and
25fullarchives read/verified12,395bytes, no independent credit changes.

Owner explicitly requested stopping that old verification and retrying exactly
the same checkpoint with the deployed correction. It was already terminal.
Manual request owner-retry-egress-20261028-01 took the ordinary exclusive lease,
online-backed-up store and copied all prior evidence before atomically auditing
and requeuing ONLY source5ff2e4df. Backup sibling directory has that request
suffix under production supervisor/compute-validation. Initial capture5f3c80fc
digestc1edcd0dbd0908af446794b21d80aece7bf045d312bc72d9f59c2a67fa30dfa5 unchanged.

Retry8b76bba0 stopped17:24:02Z before any model call: the runner still rejected
egress at two guards, despite the launcher's corrected flags. The previous fix
was incomplete. Cold-process regression now forwards --egress (previously it
silently omitted it): both pause/question continuation cases failed then pass
after the runner correction. Actual compiled CLI smoke also reproduces the old
failure and guards claim/container/non-tenant/no-replacement authority. Fix and
full release verification in progress; then resume the SAME capture, retaining
8b76's log/ledger too. Local evidence directory: validation-egress-retry-05 under
/tmp/attica-functional-next-20261028. Do not create another Compute source run.

17:32Z: npmci+release:check passes8521tests/589files (43tests/4files skipped),
including the compiled admission smoke and both cold continuation variants.
The old backup passes readonlyquick_check; do not modify its archived evidence.
Next authorized retry is prepared at validation-egress-retry-05/retry.mjs:
stable request owner-retry-egress-20261028-02, expectedprior8b76bba0, verifies
the active compiled CLI then archives current attempt/store and independently
materializes/hashes the SAME initial capture before requeue. Execute only once
the runner correction is actually deployed. It is idempotent by its ledger
request marker and never changes a running attempt or creates another source.
