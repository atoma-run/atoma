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
