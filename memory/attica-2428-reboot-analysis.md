# Attica 2428d930 reboot investigation — 2026-10-23

Owner explicitly asked for detailed analysis BEFORE any relaunch. No relaunch,
product edit, publication or model replay performed. Keep this hold until the
owner steers the next action. Run identified through production MCP: newest
Attica run `2428d930-5008-41eb-a13a-ee0e61735377`, short, revision 36877f8f,
UI refresh after failed action, not the earlier CAPTCHA run.

Full record: [incident](../records/incidents/attica-2428-reboot-2026-10-23/README.md),
with self-contained report.html, full compressed trace, event ledger, journal,
analyst and review, client/server connection excerpts and offline experiment.
All 168 summary events, 143 non-start detail events plus metadata/log were
retrieved completely (220 detail pages, no missing pages).

26m41.540 project elapsed = 45.721s before trace + 425.744s trace + 1130.075s
post-trace lifecycle finalization. Client local-close 07:46:57.514Z, local
stop-confirmed 07:46:59.316Z; reconnect 08:05:47Z permits failed finalization.
Consistent with owner's reboot report, not another nginx/socket-1006 incident.
No delivered manifest; short route has no automatic deep phase checkpoint.

Findings: 3 false Git plan refusals despite journal 6872 completed host sync;
missing dependencies plus unpinned npx Vitest 5.0.5 vs repo 3.2.4; wrong browser
test config and old-case reruns; broad compound c1 recovery refactors working
source; wrong-category baseline-rerun event skill (injection proven, causal
effect unproven); supersedes replaces bundle check with irrelevant green grep.
All 3 executions end at 24 response iterations (25 envelopes); 92 tools total.
stats.refusals=0 counts skill lifecycle, not the 6 negative validator verdicts.

Counterexample EXECUTED: recorded compiled UI in Chromium, synthetic fetch/no
external requests. Remove only refresh version guard: recorded final/negative
predicates still satisfiable while old state visibly renders. Deterministic
old-response-before-fresh assertion passes intact code and fails mutant. This
is not an exact replay of Playwright/Vitest; it proves assertion insufficiency.
Do not eliminate independent criterion review: it caught two false approvals.

Saved analyst verdict incorrectly says no second completed validator verdict:
a0a6c19a refused the still-insufficient test before shutdown. Its 'sound' grade
does not substitute for this investigation. Engine proposals remain unimplemented:
host sync receipt handoff; explicit fresh-sandbox dependency setup; test-only
deterministic remediation; clearer stopped-awaiting-confirmation lifecycle.

## Local correction follow-up (same day)

Owner subsequently requested implementation and regression tests, with a bilan
before relaunch. Local changes now carry repository preparation receipts across
coordinator/environment/runner/delegation, annotate seed dependency availability,
retain probe replacement history, narrow proof remediation without weakening the
criterion, count supervision refusals separately, retain recent analyst reviews,
and expose read-only Compute progress without releasing an unconfirmed slot.
Event recovery now needs a bounded Decision fit after lexical retrieval; missing
or uncertain Decision skips optional guidance with no LLM fallback. Exact
candidate/event answers are reused within the supervision loop. Changed failures
retire earlier recovery context without altering historical trace citations.

The report `corrections.html` beside the incident lists mechanisms, regression
coverage and limits. User requested no run restart until the bilan. No production
run, publication, push or deployment has been performed during these corrections.
Do not mistake mocked regression success for a measured live speedup or a
universal guarantee against future model repetition. The deficient Attica test
still needs a focused deterministic repair in its own project on a future run.

Final verification passed: npm ci, release:check:static and npm test -- --maxWorkers=4. Test Files  556 passed | 4 skipped (560) · Tests  7945 passed | 36 skipped (7981) · Duration  223.46s (transform 7.21s, setup 4.29s, import 101.23s, tests 746.74s, environment 7.16s). Final log, exact patch and SHA-256 receipt are alongside corrections.html. No run restart or deployment.

## Authorized deployment and relaunch — 2026-10-23

Owner then explicitly requested commit, deploy, focused temporal-test repair and monitoring.
Source/tests/contracts committed as 9b0b57fc6dc82159ed31a7de5cc61e7b1c5fed42;
CI39935433963, CodeQL39935433513, Compute39935433941 and deploy39936768143 succeeded.
Production REVISION, executor/Compute active sockets and executor health verified exact SHA.
Private investigation evidence and this working memory remain local, excluded from the PUBLIC repository push.

Run b26c9bed-773c-4a9e-9a72-71d8fc621371 DELIVERED 10:19:11.844Z, 597.422s,
18 LLM calls, $0.1853 subscription API-equivalent; 0 plan refusals, 1 result refusal,
1 acceptance refusal, 1 root remediation, 3 executions. No GitHub acceptance/publication.
Manifest 9c85ab0c3cc5562c2cf8cff7008847555f4ac8abb502bd0650747d7f545ec5bf.
Normal sync retains main258318458f42406dc5a519dd72563e1548fc4c48; seed84ae80d1.
Final source and test read from delivered artifacts. Guard restored, error preserved,
fresh state/rows update. Serialized refresh makes fresh request a deterministic
old-processing-completed boundary. Mutant fails and restored test/build/types/lint pass.

Residuals, NOT fixed: c3522aeb falsely rejects this boundary because old data was
rejected rather than displayed, triggering third execution. Ten full-file test
invocations rerun unrelated cases; only two mutant checks select the temporal test.
cec645d1 reruns unchanged green test before remediation. First install killed at
default30s, succeeds once retried with300s (36s actual). First acceptance claims
missing mutant evidence despite recorded mutation/failure/restoration: inspect
evidence projection before assigning a fix. No claim that all loops are eliminated.

All147 summary events and129 non-start detail events fully paged and archived in
relaunch-trace.json.gz; relaunch-result.json includes final status, metadata/log,
commands and findings; relaunch-request.json holds exact idempotent start args.
No active run remains; do not duplicate the timed-out start (300s MCP client timeout).

## Remaining refusal and evidence corrections — 2026-10-23

Owner authorized fixes, regression tests, commit and deployment (no additional live run).
The renderer kept only the latest receipt per command/branch, losing a mutant
failure after restoration. Transport witnesses now carry host exitCode; the
renderer retains at most one earlier nonzero outcome after a final success,
explicitly labelled historical and not automatic mutation proof. A final failure
never revives an old success. Current identities have priority under the budget;
unknown status and model declarations cannot supply historical process status.
Root remediation receives up to 8k shell/write receipts as previousPhaseObservations,
not fresh evidence or tool credit, so a new cell can inspect existing results.
Shared temporal guidance distinguishes handler completion (including discarding
stale input) from rendering, and requires actual serialization for the next request
to establish completion. Concurrent requests remain insufficient. Focused repairs
select the affected case; changed dependencies, missing coverage and explicit
broader obligations still require checks.
Adversarial controls: old-green/final-red stays red; unknown/declaration ignored;
200-command pressure retains latest results; serial guarded succeeds, guard removal
and concurrent completion each fail in real child processes. Mock reviewer still
rejects missing coverage; receipt cannot bypass the zero-action gate. 90 focused
checks passed. On unmodified HEAD plus new tests, four regressions fail (historical
failure lost and smaller evidence budget ignored); eleven controls pass.
Prompt routing is regression-tested, not a guarantee of future model judgments.
Public source release is isolated from the private evidence and concurrent Compute
work. Upstream advanced to bbf22911; final worktree builds upon that commit.

Published correction commit fe65a66df94fc0da279e9d4e4c4059525e691ddb on main.
Clean isolated worktree: /Users/mgtf/.codex/worktrees/temporal-validation-fix/atoma.
Final npm ci and release:check:static pass. Full integrated suite: 7956 pass,
36 skipped, one transient Docker external fetch failure. Unchanged complete
container-isolation file rerun with the SAME login environment and Docker:
30 pass, 7 skipped, including public egress and private-network denial. Earlier
archive-only full suite had three Git-provenance failures; final Git worktree
passes those. No assertions weakened. Logs and patch in remaining-validation/.
CI39943459801 and Compute39943459487 launched; production activation pending.

Deployment confirmed: CI39943459801, security39943458782, Compute39943459487,
deploy39944777665 all succeeded. CI general suite: 7941 passed,52 skipped;
fresh-worker isolation group:119 passed; Mender isolation:3 passed.
Production read-only verification: REVISION=fe65a66df94fc0da279e9d4e4c4059525e691ddb,
executor and Compute active sockets select that SHA; systemd active, PID864119;
executor health ready=true,selected=true,idle=true. No new Attica run started.
Parallel Compute commit e87d87cc arrived after our push and contains fe65a66d;
release worktree fast-forwarded to it, clean and matching origin/main. Shared
checkout and private evidence preserved; do not sweep its duplicate pending
source edits or another agent's work into a later commit blindly.

## Codex MCP disconnect diagnosis — 2026-10-23

Attica relaunch was not started: read-only MCP returned Authentication required.
User reconnected and redirected work to diagnosing Codex-only disconnects.
Read-only projects listing then succeeds. Token audit seq6896 at12:14:44.036Z
revoked Codex client https://chatgpt.com/oauth/codex/client.json for
refresh_token_reuse; reconnect seq6897 at12:23:44.922Z. Among latest40 token
events,17 revocations (Oct18–23), all Codex, all refresh_token_reuse.
Nginx on Oct23:12:14:42Z three POST /oauth/token 200 from
codex-mcp-client/0.163.0-alpha.10.2; at12:14:44,45,49,55Z 400 same UA.
Codex desktop log t0-i1-080137 on Oct23: lines3775 and3828 start connections
for different chats at12:14:37/40Z;3856 ready at43.703Z;3861 Auth required
at44.330Z;3870 reauthenticationRequired at45.678Z. This strongly supports
concurrent/stale refresh state across Codex clients; logs do not expose internal
locks or distinguish every grant in the successful requests, so exact client
race implementation remains inferred. Server reuse revocation itself is proven.
Both ~/.codex/config.toml atoma and ~/.claude.json atoma use the same HTTPS
endpoint without static Authorization headers. Separate atoma-local points to
unavailable localhost5173 and creates unrelated discovery warnings.
Existing tests/mcp-oauth.test.ts concurrent-refresh regression reproduces one
winner, then reuse revocation including the winner's credentials. No real
credentials read, no auth policy/config modified, no paid run launched.

## Secure Codex OAuth workaround and Attica continuation — 2026-10-23

Installed scripts/atoma-codex-auth.py as private ~/.local/share/atoma-codex-auth/auth.py.
Dedicated OAuth grant authorized in browser; access+refresh stored only in macOS
Keychain service run.atoma.codex-oauth.v1. Helper uses private POSIX file lock,
rereads after acquisition, writes renewing marker BEFORE exchange, fails closed
on crash/lost response rather than replay. Server rotation/reuse revocation and
absolute expiry unchanged; no static token. Native Codex logout atoma removed
old saved credentials; config.toml atoma now uses http_headers_helper pointing
to /usr/bin/python3 and installed helper headers, startup45s. Private backup
config.toml.before-atoma-helper-1792758967. Reconnect via HELPER login, NOT
codex mcp login or native OAuth UI (stored native credentials override helper).
Nine fake-credential regressions pass, including12 actual processes/one refresh;
installed Codex0.163.0-alpha.10.2 smoke proves 401 -> helper rerun -> discovery;
Keychain write/read test passes. Dedicated LIVE grant rotated with8 processes,
all received same NEW token; native Codex discovery passes before and after.
No secrets printed or stored in configuration. Typed wrapper, lint, typecheck,
docscheck pass. Source+tests+docs staged separately; no server deployment needed.
Attica original b26c9bed now reported accepted+published18d34c65015b62e4cdbfd5169d899d318b197c38.
New focused temporal confirmation start sent with key
attica-temporal-confirmation-serialized-oauth-20261023-01, exact args in
stable-oauth-run-request.json. Never duplicate this in-flight start. Same saved
accepted baseline, no unrelated suites, mutant failure/restored pass, no publish.


## 2026-10-23 — final false-refusal fixes

Committed/deployed 1d1dced6 and 46529043 (release caaa3356). First live confirmation 23838688 exposed lost intermediate successful build receipts and was cancelled; second b3a9752c delivered with zero plan/result/acceptance refusals and zero root remediations. Mutant failure then restored success observed; root receives the earlier build chronologically. 7970 local tests pass, CI/deploy/desktop green. One executor-only duplicate mutant/restored pair remains to create a distinct manifest command; do not claim all redundant execution eliminated. Evidence in records/incidents/attica-2428-reboot-2026-10-23/heartbeat-b3a9752c/ (private, untracked). No client acceptance/publication. Existing monitoring automation remains paused.

## Compute probe-history rollout — 2026-10-23

Run `3e07ee61-4c24-4330-b32e-186fa5cc6438` delivered but repeated the guard mutant/restoration pair. Its server revision included the merge fix, but the device's pinned worker `7f2cda61…` still had OCI revision `dbbcbbbe`. No alternative merge path: the outdated packaged writer lost same-command history. Regression in `tests/container-isolation.test.ts` crosses the compiled container and readback for both 1→0 and 0→1. Both cases fail on the old image and pass on corrected code and the official new ARM64 digest.

Commit `c8fcb060d06f19b343ff245b78bbe83cae293b24` adopts only the worker pins, stores verified architecture receipts, and documents the separate Compute rollout requirement. Image workflow39989572653 (source8b9a2252) succeeded on ARM64/AMD64. Static release, fullsuite7988passed29skipped, native smoke, CI39990930240, CodeQL39990930444, desktop39990932496 and deployment39992472111 passed. Production REVISION verifiedc8fcb060. No gates weakened.

Compute0.4.97 installed on the Mac from locally packaged bytes whose content hash exactly matched the official CI receipt `d08a7ba55744ba295d521fd4ae37507d04108960cd406584f164b0973c6e271b`; all ASAR files compared to the verified bundle, codesign verification passed. Previous app preserved at `/private/tmp/Atoma Compute-before-c8fcb060.app`. Preparation selected worker `sha256:cbd1e3827bd7e6b3bcb6dce25522de68fd95fe4ba2ba869d1bdb4f2e8b683211`; other component pins, pairing, credentials and security controls retained. Two explicit verified worker digests and app0.4.97 were added to production admission, activated by normal deployment. Device reconnected and idle confirmed.

Confirmation run `ae0a0f20-2b0e-40b6-ae91-a9320453cd98` (key`attica-compute-history-20261023-01`) queued17:12:03UTC behind assayer:clear-stale-persistence-errors (acquired17:06:05UTC). Native start call is exec cell754; a timeout never authorizes another start. Attempted documented yield-background preemption was blocked by automatic approval review for lack of explicit user approval to interrupt the independent assay. User question pending; do not bypass or retry without that approval. Existing heartbeat now follows ONLY ae0a0f20 every5minutes, quiet on unchanged status. Live proof still outstanding; no acceptance/publication. Preserve concurrent unrelated checkout changes.

## Follow-up: native OAuth override and completed ae0 — 2026-10-23

User explicitly declined Assayer preemption; never interrupt it for Attica.
Desktop log confirms native Atoma OAuth logins at16:24:34,17:26:02,17:54:25UTC
reintroduced credentials taking precedence over the configured serialized helper.
Helper Keychain status remained ready. Removed ONLY native credential with Codex
mcp logout atoma; production native discovery via helper passed,9 fake-token
regressions passed, native fake401 smoke reran helper exactly once and discovered
tools. No server policy or credential lifetime changes. Native UI Connect can
reintroduce the override; use helper login when its grant actually needs renewal.

Run ae0a0f20-2b0e-40b6-ae91-a9320453cd98 completed delivered. All56summaryevents
read (nextOffset null), full relevant tool/LLM events paged to end. Trace17:38:05
through17:40:35UTC,revision d6510ab6,5LLMcalls,$0.0519346,no refusal.
Two actual guard-removal/build/failure/restore/build/success pairs remain:
first mutant24e99fd9 exit1 at temporal waitForFunction testline233, restored
f6a64f6f exit0; second mutant628e5fa4 exit1, restored9c814030 exit0.
Assets alternate control-C5EGUhtu(mutant) and control-C8q7zR1k(restored).
Read2e6fca40 BEFORE second pair already contains replacementHistory exit1;
therefore worker history fix works. Repetition happened inside single L1execute,
before any validator, under distinct vitest invocation for durable mutant entry.
No claim that loops are eliminated. No test assertion edits. Three separate
validation calls (cell/root/criteria), all approved; no retry rounds. Root npm ci
first timed out30s then succeeded with180s; browser ci succeeded once. Bare
vitest initially failed127 then corrected invocation failed on actual assertion.
Final manifest dd92a449 retains history AND separately named mutant entry.
No delivery acceptance/publication/new run. Monitoring remains paused because
existing run is terminal, not because connection is unavailable.

## L1 execution receipt fix — 2026-10-23

User requested correction of within-execution mutant/restoration repeat, regression,
commit/deploy and live Attica verification without Assayer preemption.
Commit33726146b9ba2b66ba3975a86d353ff47948772b pushed main; origin matches.
withProbeExecutionHistory wraps only L1 execution, retains up to two preceding
same-exact-request results across serialized worker replies, excerpts each output
field at2000chars with truncation flags, max40request identities. Returned history
is reporting evidence, not coverage verdict, replay input or suppression of tools.
No worker change required. L1 integration runs real failing assertion/restoration
through JSON-serialized replies; test checks history after exactlytwo executions.
Latestfailure, unknown/unrecorded outcomes, distinctrequests and attemptisolation
covered.32focusedpass. npmci/staticreleasepassed; firstfullsuite had unrelated
inherited-checks-browser afterEach10s timeout, isolated8pass; fullsuite maxWorkers8
7985passed38skipped,559filespassed4skipped. No assertions/timeouts weakened.
CI40001971897 pending; Pushmain40001970994; Computedesktop40001971941.
Do not launch newrun before exactrevisiondeployment. Same approved start args as
ae0, base1cb, new idempotency key needed exactlyonce. No Assayer interruption.
CI40001971897 SUCCESS; Compute40001971941 SUCCESS. Deploy40002988092 SUCCESS;
productionREVISION33726146 verified via authorized mgfSSH before launch.
Started SAME goal/base/criterion with keyattica-execution-history-20261023-01:
run91dc352f-90da-4b7e-934e-f3bbeb89a113 created18:25:27UTC, queued.
Assayer harden-async-run-cleanup case2/2 without on d6510ab6; no interruption.
Monitor reactivated for ONLY91dc; traceoffset0, liveconfirmation pending.
Full startargs /private/tmp/attica-execution-history-start.json; don'tduplicate.

## Live verification completed — 2026-10-23

Run91dc352f delivered18:30:39.443UTC after normaladmission18:27:11.880UTC,
no Assayer interruption. Trace18:28:02.014→18:29:50.243UTC revision33726146.
All44summaryevents pagedtoend; full tool and validator events read.
EXACTLY ONE PAIR: guardremove082060ab; mutantbuild eb2d58f9 produces
control-C5EGUhtu.js; mutanttest b7e5a71a exit1, real boundary waitForFunction
at tests/control-button-ui.vitest.test.ts:233. Restore57733b10; restorebuild
d73af496 producescontrol-C8q7zR1k.js; restoredtest c75ba166 exit0 and
executionHistory.previousObservedResults retains actual prior exit1+stderr.
Manifestread a8fb48a2 contains replacementHistory exit1, onlylatesttest baseline0.
Initial test bytes equal previousae0, no testwrites anywhere in44events.
One installation command npmci&&npm--prefixbrowserci succeeds26.5s, no retry.
One plan, one execution, three distinct validators (cell/root/criteria) each
approvefirstpass, no refusals/replans/re-executions.5LLMcalls,$0.04236036.
No generic all-runs guarantee: this is one live confirmation of this scenario.
Startclient timedout300s afterqueue+execution; readonlystatus provesdelivered,
neverrestarted. Monitorpausedafterterminalreview. No clientacceptance/publication.

## Report-correction hardening and the delegationReview misread — 2026-10-24

Three deployed fixes on the report-correction path (51fbfe77, 58d90d31, 14b47fa1): an
unavailable correction takes the ladder instead of failing the phase; a cut or unreadable
correction reply gets one tool-free second chance (reformat / re-ask at 16k); a result
refused again as report-only gets a second correction (MAX_REPORT_CORRECTIONS=2) then the
ladder. None has live proof yet.

Owner then authorized Attica runs again. Run f41efe87 (13:40–13:51 UTC, $2.34, revision
52ffd2a8) FAILED with nothing of its second plan executed: the root delegation reviewer
(gpt-5.6-terra) refused five plans because "the plan omits the mandatory delegationReview
object" — the reviewer's OWN approval field, never a plan field. Each refusal cost a
gpt-6-astra replan and was fed back as a previous refusal. Fix bc1d659b (merge 03810f95):
`misreadDelegationReview` reclassifies such a refusal as a reviewer fault (re-review on the
validation model), both review prompts say whose field it is. Earlier same-day runs 87471f50
(Compute execution interrupted, 9 result refusals) and 84f9b4a4 (cancelled at 48 s) proved
nothing. Next step once 03810f95 is active in production: relaunch the same offline
validation goal from base 91dc352f under a NEW idempotency key; watch result refusals,
mutant/restoration pairs and report-correction events.

Relaunch 9a2f8487 (14:09–14:15 UTC, $0.51, revision 03810f95) FAILED on a different slip:
a RESULT verdict with a stray `,"` did not parse and the ValidationError left the loop.
Zero plan refusals this time (delegationReview fix held). Fix 7ff51d03: one tool-free
reformat turn per unparseable verdict (`verdict-repair` role), then `result-review-fault`
re-judging up to MAX_PLAN_REVIEW_FAULTS, then blameless escalation. Relaunch again once
7ff51d03 is the active executor generation, under a NEW idempotency key.

## Run 9e134e49 (revision 7e31a188) — analysed 2026-10-24, corrected 2026-10-25

DELIVERED after 58 min, $4.97, 188 calls; the delivered TEXT says every required check was
blocked by "Cannot fork"/EAGAIN. Host receipts: npm run check 0, test:browser:ui 0,
test:browser 0 by minute 32. CORRECTED: the negative control was NOT cleanly established.
Branch 0e096fb7 (~minute 23) mutated without rebuilding and its focused test PASSED on the
stale asset; the same line-233 waitForFunction timeout also hit the GUARDED asset once.
So the root acceptor's "guard-removed assertion passed" was TRUE, and the validator's demand
for the stale values was defensible: a waitForFunction timeout does not discriminate. Attica
follow-up (a run that edits files): make the temporal assertion print the observed values.
Real Atoma defects, fixed in b6f13c5c: (a) every worker under --init, finished run_shell /
record_probe commands kill escaped process groups (detached Chromium survived runner
timeouts and exhausted the Compute worker's 256 tasks from ~43 min); (b) root text review
told an accurate report of unperformed required work supplies none of it; (c) delegation
review told existing real-browser suites already route their behaviour (its dom-interaction
demand made molecules start a server and Puppeteer browser beside the suites). Not changed:
fan-out push (third plan genuinely parallelised two installs). Compute rollout DONE 2026-10-25: pins
567218bf (arm64 1a6f95fc, amd64 668f926c); production atoma.env admission +0.4.123 and both
digests (backup atoma.env.before-compute-escaped-groups-20261025), active from executor
59883d5d; Mac app 0.4.123 installed (0.4.112 kept at /private/tmp/Atoma Compute-0.4.112-
before-567218bf.app), preparation via ~/.atoma/compute/desktop-preparation.json marker,
worker pin switched, device reconnected (generation 158). No Attica run started since.
See [[validation-runs-too-slow]].

## Local validation of Attica — 2026-10-25

Owner approved validating locally instead of a deep run. GitHub head 18d34c6 equals run
9e134e49's saved workspace file for file (repo also carries a stale built
dist/browser-assets/assets/control-BvrG6edU.js that the build deletes). Ran inside the
published compute-worker image 1a6f95fc (NODE_ENV must be unset or npm ci skips dev deps):
npm ci + browser ci ok; npm run check 0 (27 vitest files / 83 tests, node --test 94/94);
test:browser:ui 0 (7/7); test:browser 0 (10/10). Negative control once with rebuilds:
mutant asset C5EGUhtu, focused test exit 1 at line 233 waitForFunction (7.3 s); restored
byte-for-byte 83a5edcb, asset C8q7zR1k, focused test 3/3 pass at ~2.4 s. In a clean
container the control discriminates; the earlier line-233 failure on guarded code came from
a polluted worker. Still worth making the assertion print observed values (needs a run).

## Attica hosting outage and launcher staleness — 2026-10-25

Attica hosting already exists (destination atoma, attica-property-scraper.app.atoma.run,
manifest node-browser). Deployment 7d52d539 (2026-10-18, run 76acabf8) broke when an apt
upgrade restarted dockerd at 05:00 UTC: containers came back with swapped IPs, relay targets
10.210.3.2:8080 = itself. Cause: hosting launcher started 2026-10-16 00:23 UTC, 7 min before
pin fix 6aa7c5e0, never restarted by deploys, so 7d52d539 has no IPAMConfig. Fix e762e3c1
(deployed): releaseWatch exit 75 when current changes and idle; web retryingStart; health
check skips unreachable launcher. Owner did both actions the classifier refused me: launcher
restarted 06:25:57 UTC on e762e3c1; deployment 19ce1bb6 of b26c9bed (commit 18d34c6) READY
06:31 UTC, addresses pinned (app .2, proxy .3, relay .4 of 10.210.1.0/24), relay upstream =
app, HTTP 200. Old 7d52d539 stopped. Chrome "JS from Apple Events" left OFF. Next: product run.


## Codex helper deadline correction — 2026-10-28

The owner reports repeated Codex reconnects while Claude Code works. The desktop
log at 05:23:07.078Z explicitly kills the HTTP header helper after ten seconds;
nginx records its /oauth/token request as 499 at that instant. The helper's
network timeout was 15 seconds. Read-only comparison of the local refresh hash
with the primary production store proves it was consumed, its access replaced,
and server access expiry became 06:23:11.715Z: rotation completed about 4.6 s
AFTER client cancellation, leaving the new credentials irretrievably unsaved.
The old grant is not revoked, but must not be refreshed with the consumed token.
No token/hash was printed. Native Codex grants were also recreated after the
helper installation and repeatedly revoked for reuse, an independent competing
credential source; no active connection or native credential was removed here.

The CLI helper now forks a detached renewal owner before locking, redirects all
client stdio, and sends only persisted headers over a private bounded pipe.
Client/group death cannot interrupt refresh persistence. Overall deadline75s
raises through subprocess cleanup; Keychain subprocesses have5s limits, so a
late writer cannot outlive the lock. Only the existing pre-consumption503
`temporarily_unavailable` from /oauth/token restores the unused ready state;
lost/unknown responses and worker death still fail closed. Server policy is
unchanged: rotation, replay revocation, one-hour access and30-day grant expiry.

Fifteen fake-credential regressions pass:12 concurrent managed clients/one
exchange, actual HTTP plus group kill, ordinary output, worker death, explicit
503 classification and delayed Keychain write under the worker deadline.
Native Codex0.156.1 app-server integration (all real MCP/plugin connections
turned off ONLY in that temporary process) uses a11.5s token fixture: initial
connection reports the actual10s helper timeout; detached owner persists; the
next native connection discovers fixture_read in0.08s with exactly one refresh.
No model request or real OAuth credential was used. Temporary proof runner:
/tmp/atoma-codex-deadline-integration.py; results under
/var/folders/xx/g4fq_5v13xd_7g3svk48qg6w0000gn/T/atoma-codex-deadline-mw3rsjrh.
The second native fixture also expires access before tools/list and returns401:
Codex reruns the helper, obtains changed headers, and discovers the tools, with
two sequential (not replayed) refreshes. Full release:check passed8,517 tests.
The private installed helper was atomically replaced after checking it matched
the old tracked source; a code-only0700 backup was retained. CLI atoma reports
unknown auth status (helper), so no competing native credential was removed.
One helper login was started because the old refresh was proven consumed;
final browser consent and live discovery are still pending at this writing.
