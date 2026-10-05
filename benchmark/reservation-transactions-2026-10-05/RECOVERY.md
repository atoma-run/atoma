# Reservation transport investigation and continuation

The owner authorised diagnosis, fixes and another production attempt on 2026-10-05.
The original frozen request, scorer and failures remain unchanged.

## Before the third attempt

CI 37268764312 and deployment 37269103478 succeeded for 5ad69908. MCP sentinel
reported no incumbent and an empty analyst queue. No production host log access
was available; the two original generic failures cannot be retrospectively
assigned a provider cause.

A bounded local replay used the exact archived L1 system/user prompt and the
seven production tool declarations with gpt-5.6-luna and Codex 0.156.1. Only
sandboxed file tools executed; the diagnostic aborted before the first run_shell.
It reached list_files, package.json, server.js, test.js, README.md and run_shell
without a provider error. Usage retained on that deliberate abort: input40052,
output7615, cacheRead55296. This is a transport diagnostic, not execution evidence
for the service and not proof that production's interruption was fixed.

The installed app-server protocol exposes codexErrorInfo, including structured
HTTP statuses. Atoma stringified it and applied a prose-only classifier that
ignored both camel-case variants and httpStatusCode. The correction reduces the
typed fields to a fixed vocabulary immediately. No provider prose, unknown
variant values or additionalDetails are retained. Context, budget and policy
refusals cannot trigger a futile exec fallback. A tool already invoked still
prevents fallback/replay; no automatic retry policy was introduced.

Adversarial checks exercise the real client/session parser: unknown variants
with private text, missing HTTP statuses, typed 400/401/429/503, stream errors,
context/budget/policy refusals, retained partial usage and exactly one host action.
Existing tests cover legacy prose, abort, credentials, budget and tool ordering.

third-request.json preserves all ten acceptance criteria and appends the two
observed counterexamples to the original goal (3941 characters). It starts fresh:
failed drafts are not seeds. The reviewed 44-case scorer and the four exploratory
checks remain independent and unchanged. A delivered banner alone cannot pass
this experiment; inspect the published bytes and execute both scorers.

## Third production attempt and reproduced capacity refusal

CI 37270026261 and deploy 37270387745 succeeded for 3027c2ad. Run
`d170c903-f9fa-4403-a7bb-e0003b6e5183` then failed in its first L3 text planning
call, before any tools: 50.315 seconds coordinator time, 5 trace events,
1 LLM call and zero reported usage. Its full paged evidence is retained in
third-attempt.json.gz. The resident analyst also reported session-failed.
This failure therefore was not confined to the app-server tool loop.

The exact L3 prompt was replayed locally with gpt-5.6-sol through the production
text client. Two immediate failures exposed only the safe token `model` in the
initial diagnostic. One separate diagnostic hit its deliberately shorter 60s
silence bound (not a production timeout). A subsequent replay identified a
60-character error containing `selected`, `model`, `capacity`. The installed
Codex 0.156.1 binary contains the fixed provider presentation:
"Selected model is at capacity. Please try a different model."
The existing prose classifier missed this status-less refusal.

After classification was corrected, a real replay of that same L3 request
received the capacity refusal, logged exactly one recovery, then completed on
the SAME gpt-5.6-sol. It returned 4379 response characters; cumulative reported
usage input11455/output1912/cache0. capacity-replay.txt contains only safe
reduced diagnostics, recovery category and result measurements. The response
body was not retained, so this proves transport recovery, not correctness of
the plan. No model switch or account-setting change was made. This local
reproduction does not retrospectively prove the first two tool failures had
that same cause.

The text client now recognises the fixed capacity message and uses its existing
one-retry policy. The app-server may continue one terminal service-unavailable
turn in the same thread, preserving acknowledged tool results, cumulative token
usage and all budgets. It never does so during an unresolved tool, cancellation,
exhausted budget or finalisation. A second failure cannot fall back to exec.
Safe recovery messages are retained by the project runner log. Unknown errors,
auth refusals and arbitrary diagnostic prose do not authorise continuation.

Adversarial regression tests cover success after an acknowledged action, a
second overload, no fallback even before tools after that second overload,
retained cumulative usage, exhausted response budget, abort during the delay,
and a failure while a host side effect is unresolved. Existing unknown/4xx
failure, scope, ordering, credentials and finalisation cases remain in place.

## Fourth attempt: phase validation scope

CI 37272038917 and deployment 37272435122 succeeded for 2dfc52a7. Run
`bd3f355f-b11f-4b47-97a3-2783a34d17de` reached real file writes, subprocess
tests and HTTP probes. The operator assistant cancelled it at 06:41Z after
three result refusals; this was not a spontaneous transport failure or a
user-requested cancellation. All 109 events, metadata and log are archived in
fourth-attempt.json.gz. No delivery or publication occurred.

The root plan explicitly assigned construction plus basic startup/route sanity
to phase one, comprehensive subprocess assertions to phase two, and documentation
to phase three. The first two refusals demanded phase two's comprehensive tests
inside phase one. The third refusal instead objected to an additional startup
stdout line. These causes are distinct; calling all three scope errors was an
initial misreading corrected after paging the final event.

The runtime carried original facts to every phase but its explicit scope policy
covered planning and reasoning-only execution, not tool-bearing validation.
The first candidate adds host-owned delegated-task scope to shared task context,
including model and Jev validation. A root task or an input-only originalTask
claim does not acquire that scope. No gate, budget, model pin or criterion changes.

The paired scope-replay.mjs fixes two exact archived validator requests and six
synthetic controls before sampling: a source-only phase with deferred tests, a
current-phase missing test, wrong implementation order, incomplete root delivery,
a child trying to defer its own requirements, and a complete root delivery.
Both arms use gpt-5.6-luna with alternating order and identical evidence.
Archived requests have no forced approval oracle: actual source defects may
justify refusal, but demands for deferred test execution do not. Synthetic
expectations are declared in the script. Record every response and request hash;
this small diagnostic is not a reliability estimate.

The first 16-call pair series (`scope-*`) failed to correct either archived
request; all six synthetic cases passed in both arms. It is retained, not
replaced. The second series (`scope-v2-*`) adds an explicit scope section to the
shared validator system prompt. The first archived case changes from an
out-of-scope refusal to phase approval; the second stops asking for the future
suite in its coaching and instead refuses the extra startup stdout line. Its
reason also retains a vague full-behavior qualification, so this is not evidence
that every scope error is eliminated. All six synthetic expectations hold in
both arms, including wrong source order, missing current-phase execution,
self-authored deferral and incomplete root delivery. Root criteria and gates
are unchanged. These are diagnostic samples, not a reliable success-rate claim.

The startup collision is concrete: start_node_server formerly required a
no-argument entry and LISTENING_ON_PORT stdout, while this task requires CLI
options and JSON readiness. The tool now accepts optional literal argv and a
complete, exact JSON {"port":N} readiness line alongside its existing marker.
Current declarations and runtime guidance reach old stored agents. Spawn is
still shell-free; argv may affect behavior, so it withholds code-only standing
proof. Real-process regressions cover CLI arguments containing spaces and shell
metacharacters, chunked readiness, invalid/incomplete announcements, preserved
source, and ordinary legacy startup, registration, cleanup and concurrency cap.

A separate local probe of the final fourth-run draft reproduced a genuine
server crash for {key:"prototype-test",type:"__defineGetter__"}: its schema
dispatch read an inherited function and called .includes on it. The request
should return 400 invalid, not drop the connection and exit 1. The reconstructed
server (inert fourth-server.js.txt), hash, command and process result are retained
in fourth-prototype-probe.json. The draft had already corrected its initially
rejected empty seed; do not report that earlier version as the final draft.
The fifth request keeps the same ten criteria and appends this concrete
unknown-command regression. The original 44-case and four exploratory scorers
remain unchanged.

Source verification: pinned Node 24.20.0, npm ci, then release:check. The first
full pass exposed two stale prompt-text expectations; startup guidance was
separated from the unchanged durable-document rule and wired into existing
molecules' planning/execution. The rerun passed: 409 test files, 5424 tests
passed, 9 skipped, plus docs/typecheck/lint/audit/build and compiled smokes.
The startup/prompt focused suite passed 37 tests. Both semantic replay series
reproduce offline from their saved responses without paid calls.

## Fifth and sixth attempts: current assertions hidden from phase review

Revision e7d84a57 passed CI 37276117028 and deploy 37276558656. The fifth
run, `9b4f1082-f173-42cd-9880-af3dd835e314`, failed its first L3 planning
call with structured service-unavailable after the bounded retry (46.463 s,
five trace events). No tool work or delivery occurred. This confirms useful
failure classification, not capacity availability. Its full trace is retained.

The sixth request keeps all ten criteria and the 3,995-character goal, but
uses short topology to avoid the intermittently unavailable L3 planner. This
is explicitly not a same-topology benchmark. Run
`8d819d66-1de2-4050-8ee0-119db03d1969` ran on e7d84a57, produced 220 events
and 26 reported LLM calls ($0.2310 subscription-equivalent accounting), and
was cancelled by the operator assistant at 07:40:31Z after repeated phase
refusals. No delivery or publication occurred. The complete trace is retained.

The initial suite contained real defects and missing checks. Root acceptance
correctly demanded stronger tests, including actual SIGKILL and refused
receipt recovery. The remediation then added these assertions and executed
npm test successfully. Its prior read_file observations were correctly marked
superseded after edits. But the phase validator saw only a 400-character head
of the current 6,461-character test file. Three refusals continued demanding
assertions already present, eventually penalising the molecule and its skill.
This is an evidence-visibility defect, not proof that the whole suite was done.

`reconstruct-sixth.mjs` reconstructs the file before the first repeated refusal
from successful write/edit events and verifies each subsequent read against
that reconstruction. It checks replacement counts, applies seven edits and
two read snapshots, and preserves the inert result in
`sixth-test-at-first-refusal.js.txt`. It executes none of the generated code.

The correction extracts the existing root bounded reader into fileEvidence.ts
and supplies current superseded-file reads through shared phase ground truth.
Only current-attempt host records referenced by this result select refresh
paths. A later write by another branch may retire those bytes; another branch's
unreferenced reads do not join the evidence. Jev and its model fallback receive
the same block. Root acceptance retains its single combined criteria/refresh
budget. No model call, acceptance gate, criterion or model pin is added.

Adversarial review: stale bytes stay omitted; missing reads establish unknown,
not absence; current source alone is not executed proof; a prior failed command
or an edit after execution cannot be converted into success by readback. Host
reads bypass attestation and do not earn branch/skill/checklist credit. Paths
outside the workspace, other attempts and forged references do not select
reads. Failed reads count against the four-file bound; complete files share
24,000 source characters, retaining existing root excerpt behavior above that
bound. Production-path regressions cover these cases plus Jev/model equality
and unchanged root behavior.

`readback-replay.mjs` freezes one exact archived refusal and four synthetic
controls: correct assertion executed; wrong assertion executed; assertion never
executed; assertion edited after execution. Both arms use the same Luna model
and system prompt; only the candidate receives the shared reader's current
file block. Order alternates. The archived case has no forced approval oracle:
remaining real gaps must still be refused. Saved requests/hashes/responses
make the diagnostic replayable offline. This is not a success-rate estimate.

All ten replay calls completed. The archived baseline again claimed that
SIGKILL recovery, key-order equivalence and expiry-state assertions were absent.
With current readback it instead identified actual remaining gaps: successful
same-key concurrency (the existing concurrent retry ran after stock exhaustion),
full state after contenders, and refused-receipt replay after stock changes.
It still refused the incomplete suite. The positive control changes from an
unknown-assertion refusal to approval. All three negative controls remain
refused in both arms; the candidate names the wrong assertion or missing
post-edit execution explicitly. All four candidate synthetic expectations hold.
The 222 focused tests pass, including shared Jev/model evidence and root limits.

The resident sixth-run analyst again graded the run sound with no findings.
Its report is retained as sixth-analyst.json; that model assessment did not
detect the visibility defect demonstrated by the archived requests and paired
replay. Its generic attribution of cancellation to the user is not the actual
operator history: this assistant cancelled the repeated refusal loop.

Release verification on pinned Node 24.20.0: npm ci then release:check passed,
including docs, both TypeScript configurations, lint, audit, build, compiled
smokes, and 410 passing test files (5,422 tests passed, 19 skipped). The ten
semantic responses reproduce offline without paid calls. The seventh request
preserves the sixth request exactly except its new idempotency key.

## Seventh attempt: complete refusal feedback before remediation

CI 37280903883 and deployment 37281366450 succeeded for 480b1be4.
Run `715ffc74-7a0a-41a4-9e0e-0be0993ec01c` confirms that revision in its
provenance. It ended partial after 1,028.313 seconds, 21 model calls and
$0.1795 subscription-equivalent accounting. All 158 events, metadata and log
are archived. Its artifact manifest is retained; there was no publication.
The next ordinary run can seed this partial workspace, unlike the preceding
cancelled drafts. The eighth request retains the exact goal and ten criteria.

Phase validation now actually includes complete current superseded files:
e04a4039 and 0ab3a946 carry the shared host-read block, including the current
test body, without restoring obsolete observations. Phase repair made progress
and passed. The service also removed an unjustified nonempty seed-array rule
and trimming of literal identifiers. Recovered startup and edit errors remain
in the trace. `reconstruct-seventh.mjs` reproduces four deliverable files from
observations/edits, checks every read snapshot, and verifies exact byte lengths
and SHA-256 against the final partial manifest. It runs no generated commands.

A different review error remained: the first root refusal and one later phase
refusal treated the illustrative clock-0/ttl-5 example as an absolute boundary.
The visible sequence had already advanced to clock 5 before reserving the
confirm-first ttl-5 hold, so its expiry was 10; the later advance-first hold
expired at 15. Adding isolated tests at zero was redundant evidence, not a
change to the expiry rule. The final root refusal instead named genuine gaps:
successful receipt replay after SIGKILL/restart and missing/extra-field,
wrong-type and range assertions. The first global review had marked those met,
so the one remediation was spent before these gaps reached the executor.

The resident analyst's seventh report calls this sound and attributes stopping
to wall-clock budget. Preserve that fallible assessment separately: the actual
run ended after its bounded root remediation with remaining refused criteria,
not at the 5,400-second timeout, and the exact-boundary refusal was not a correct
reading of the earlier fixture.

### Rejected prompt-only candidate

A shared derived-boundary reminder was tested against both exact archived
requests and four predeclared controls, with alternating baseline/candidate
order on the same Luna model. The positive shifted-boundary case and the
negative past-boundary, unknown-prestate and explicitly mandated absolute-value
cases all match expectations in both arms. But the candidate retains the wrong
absolute-5 objection on both archived requests. The baseline itself varies,
identifying real gaps on the first archived request this time. This does not
support shipping the reminder: it was removed from production. Both frozen
guidances, exact requests, all twelve responses and results are retained in
boundary-*; the replay uses the frozen candidate rather than silently testing
a different prompt after removal. These samples are diagnostic, not an accuracy
claim. The harness initially omitted the model selector for its subsequent
focused pass; it failed before sending that pass, then resumed the saved twelve
responses with the explicit Luna selector.

### Earlier complete criterion inventory

The root now invokes the existing bounded focused review on a completed file
candidate with user criteria even when the holistic verdict refuses. Previously
only provisional approvals received this review. This supplies all criterion
gaps to the first remediation. Focused approvals cannot override a global
refusal; when both refuse, both reasons are preserved. Focused judgments remain
the checklist source of truth. Mechanical rejections, landed results, text and
drafted lists retain their existing paths. No tools, retries, model upgrades,
new proof credit or new gates are introduced. The cost change is explicit:
at most six cheapest-tier, tool-free calls on a previously skipped refused
candidate, for the existing twelve-criterion bound.

Adversarial controls traverse real root acceptance: all five criteria are
reviewed after a global refusal, earlier success/refusal narratives stay out,
all focused gaps survive together, and even unanimous focused approval cannot
remove the independent global refusal. Missing/malformed judgments still fail
closed. Existing criterion, depth, ground-truth and Jev tests retain behavior;
fixtures now supply the focused responses also required on refused candidates.

The focused replay uses the actual production helper, with the rejected prompt
reminder removed. Its five calls inspect all ten criteria on the FIRST refusal's
host evidence. It identifies missing full-state atomicity checks (c2), apply-once
concurrency assertions (c4), successful receipt persistence (c6), and incomplete
assertions (c10); it correctly reads the shifted boundary as met (c3). It also
asks for Node-version evidence (c1). c7 is accepted from source plus observed
representative failures rather than requiring an exhaustive executed schema
matrix. These remain semantic judgments, not a claim that batching finds every
gap. The mechanical fix guarantees the inventory runs before remediation, not
that its judgments are infallible. All seventeen saved responses replay offline.

Independent executable checks against the EXACT manifest-matching seventh
server, without local source repairs: reviewed frozen suite 44/44, exploratory
suite 4/4, inherited-property regression suite 7/7. All 55 pass. Outputs are
seventh-verify-reviewed.jsonl, seventh-exploratory.jsonl and
seventh-prototype-regression.jsonl. This is a correct partial-draft measurement,
not a published-delivery claim and not evidence that the draft's own tests
contain all requested assertions. The next run must complete those proofs and
publish before completion is claimed.

The first complete release check passed static verification and 5,421 tests,
but three existing root fixtures lacked a second mock response now that refusals
also receive focused review. They were corrected to supply concrete criterion
judgments; the restored-observation and complete-source assertions remain.
The focused rerun passed before repeating the full release gate.

The final full release:check passed after those fixture updates: 410 passing
files, 5,434 passing tests, 9 skipped, including container isolation, plus all
static/audit/build/compiled gates. No production prompt change from the rejected
boundary experiment remains. The seventeen-response diagnostic reproduces
offline; the intended code change is the timing and preservation of focused
criterion review, covered through root acceptance and remediation input.

## Eighth attempt: a growing manifest displaced the assertions

Run b873c5a2-bfb0-499b-85e9-f1bcc18a520e ran ef10b044 from the seventh
partial seed, with the same goal and ten criteria. It ended partial after
965.145 seconds end to end (34 LLM calls, 222 events). The complete criterion inventory did execute on
both refused root candidates. Recovered revision-fixture failures and an
escaped edit argument are preserved in the full archive. The final draft was
reconstructed from observed reads/edits and matches its four file hashes.

The final host read-back selected server.js, README.md, test-api.js and the
16,533-character internal probe manifest. Their combined size exceeded 24,000;
the reader reverted EVERY long file to a 1,200-character head and keyword
snippets. The successful-receipt restart assertions existed and had executed,
but vanished from the review. The analyst correctly noticed wasted work but
called the final refusals correct without distinguishing missing assertions
from invisible ones; its independent report is preserved, not adopted as truth.

The shared source reader now leaves the internal manifest to its existing
schema/observation reader unless a criterion explicitly names that file.
Hidden named paths are supported too. This avoids consuming a source slot and
budget with the same growing operational record. The same four-read and
24,000-source-character limits remain. Small files give unused shares to larger
files; oversized files retain a bounded head and matching lines rather than an
all-or-nothing batch cliff. Failed reads, cancellation, traversal exclusions,
staleness labels and the no-execution-credit boundary remain unchanged.

Adversarial review: this cannot infer unseen assertions, bind a later edit to an
earlier execution, suppress manifest schema findings, or accept a result. An
explicit manifest criterion still gets its bytes. At 24,000/24,001/100,000 source
characters, tests exercise full coverage, graceful truncation, and the bound.
The production phase path verifies a growing manifest cannot displace source
and test bodies; existing root and Jev paths also pass. 54 targeted tests and
both TypeScript configurations passed.

Fourteen paired diagnostic responses are preserved in budget-* (three archived
requests and four controls; same Luna model, alternating order, no tool replay).
Providing the actual full bodies lets the receipt reviewer see SIGKILL/restart
and both receipt assertions. Wrong, unexecuted, or subsequently edited
assertions remain refused; the executed positive control is accepted only when
its body is visible. The global and focused concurrency reviewers nevertheless
accept weak same-key assertions by combining equal response bytes with source
inspection, without a direct apply-once full-state assertion. This is a remaining
semantic limitation, NOT evidence that all review judgments are now reliable.
The deterministic fix is evidence visibility, not a guarantee of semantic
accuracy. The final published artifact still needs the independent frozen
executable scorer and a source review.

The first complete release gate passed static/build/compiled checks and 5,428
tests; one old fixture still asserted the former 1,200-character truncation.
Its expected head boundary was updated to the shared-budget value while keeping
the late curl-line assertion. The repeated full release gate passed: 410 files,
5,439 tests, 9 skipped, including container isolation. The 14-response diagnostic
also reproduces offline. No acceptance threshold or requested criterion changed.

## Ninth attempt: unchanged reads also lose their middle

97504226 passed CI 37290445930 and deployed through 37290975164. Run
4c1a1e8c-30bc-4e89-8dc7-266bceca812f started from the eighth partial. Its first
execution reused the current test body without modifying it. The transport's
1,600-character head/tail read therefore remained current, so the superseded-
read selector did not request its missing middle. Receipt assertions were again
invisible. This run was cancelled after confirming the root/criterion requests,
before spending another broad repair; the full 70-event trace is preserved.
It is not a delivered run and does not become the next seed.

The transport now records a structured responseTruncated fact for a file read
whose observed response it actually cuts. File text cannot forge that field;
old records without it remain unknown. The single contract helper combines
these reads with superseded reads. Root and phase readers use the same helper,
with phase witness/attempt boundaries, existing restoration filtering and the
same four-read/24,000-character bounds. No file must be edited just to make its
assertions visible. No extra LLM call, execution, gate or proof credit is added.

Production-path regressions cover an unchanged read with its assertion in the
omitted middle, followed by execution, at BOTH phase and root acceptance. All
root criterion calls receive the body, while the attestation log remains byte-
identical. A literal [truncated] and a responseTruncated field inside short file
content trigger nothing; the exact 1,600/1,601-character boundary is exercised.
Ninety-eight focused tests passed. The two-call current-read replay uses the
actual ninth receipt-review request and derives read-back candidates through
parseExecutionObservation/fileReadsNeedingReadback from its raw observed tools.
The baseline refuses invisible receipt assertions; the candidate identifies the
existing executed SIGKILL/restart assertions. The earlier semantic limitations
still apply. Earlier experiments retain their historical header string and
reproduce offline rather than silently changing their frozen request hashes.

The complete release gate for the unchanged-read fix passed after npm ci:
410 passing files, 5,432 passing tests, 19 skipped, plus static/audit/build and
compiled smokes. The two new diagnostic responses reproduce offline.

## Tenth attempt: delivered, published, independently checked

c21b7114 passed CI 37292512769 and deployment 37293013287. Run
e6655476-edf3-4c48-93f7-8fb9b2e77bb7 used that exact release and the eighth
partial seed, retaining the same 3,995-character goal and ten criteria. The
current test body reached root and focused review, including its middle.
The initial holistic approval did not bypass the focused refusal: c4 lacked
direct apply-once state/revision assertions. That ONE gap reached the root
remediation. The agent added a capacity-one contention fixture and same-key
checks of both 200 statuses, response-byte identity, revision, and complete
state, then executed the updated suite. All ten final judgments were met.

The run delivered in 426.449 seconds end to end, with 18 LLM calls, 110 events,
and one root remediation. This is one successful SEEDED continuation after the
archived failures and corrections, not a cold-start or comparative speed claim.
Publication created the private repository at:
https://github.com/mgtf/atoma-reservation-transactions-20261005
Exact commit: 49cdfd3bd81b216ed9afde8b4eb6bcad9fa63e30 (main).
GitHub's actual branch ref was read; the clone was detached at that commit.
All five file sizes/hashes and the tracked inventory match the Atoma manifest.
The server is byte-identical to the eighth draft; the test changes are the
atomic full-state check and the contention/apply-once fixture, reviewed before
local execution. No local artifact changes were needed or published.

Independent execution against that exact clone on Node v24.20.0, with a minimal
environment, isolated temporary directories, bounded subprocesses and cleanup:
- reviewed frozen contract scorer: 44 passed, 0 failed;
- exploratory type/Unicode cases: 4 passed, 0 failed;
- inherited-property command regressions: 7 passed, 0 failed;
- the artifact's own npm test: exit 0, all assertions passed.

The 55 independent checks include concurrent contention/retries, atomic state,
receipt bytes, and restart/crash sequences. Raw outputs and exit codes are in
tenth-*.jsonl and tenth-independent-checks.json. Publication/hash verification
is in tenth-publication-verification.json; inert exact published files are in
published/*.txt. The full trace is tenth-attempt.json.gz, paged through its end.
The four original freeze hashes still match; no failed assertion was weakened
in this run. The previously documented business-error-priority oracle correction
remains isolated in verify-reviewed.mjs.

Remaining limitations are explicit. Model verdicts are not universal proof.
The generated contender fixture hard-codes last-a as the winner, which is a
fragile test assumption; our independent scorer permits either legitimate
winner and checks the complete resulting state. Both suites passed here, and
no claim of flake-free tests or infallible future semantic review is made.
