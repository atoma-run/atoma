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
