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
