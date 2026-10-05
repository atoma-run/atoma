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
