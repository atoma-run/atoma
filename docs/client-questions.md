# Client decisions during a run

Deep, non-comparison project runs can pause before opening a sequential root
phase when proceeding requires an unresolved choice belonging to the client.
The root's next phase, goal, captured project context, earlier client answers
and latest completed result inform one bounded, tool-free tier-1 planning call.
Routine technical choices, repository investigation, recoverable errors and
permissions already granted should proceed autonomously. Missing excerpts are
not evidence that a client choice is missing. The assessment must explain why
the client must decide, identify the unresolved choice, and offer 2–4 options
with consequences. Free-text answers remain possible.

This is a model judgment, not a keyword detector. The first implementation has
no live accuracy or unnecessary-question-rate claim. Its call is recorded as
`plan` by `run-client-question`, uses the run's resolved L1 model, is capped at
1,536 output tokens and shares the ordinary run budget. Invalid/truncated
assessments fail rather than fabricate a question or authorization. There is
no polling or model call while the run waits for its client.

## MCP workflow

- `atoma_run_status` and task results expose `clientQuestion` and
  `awaitingClientAnswer`. The execution segment ends as `partial` and frees its
  normal run lease. The existing task result remains readable after reconnect.
- `atoma_run_question(projectId, runId)` reads that segment's question, answer,
  and `canAnswer`/`canResume`. `waitingForClient` becomes true only after the
  backend has drained and the project run has finalized its pause.
- Ask the client the recorded question. Only their actual answer may be sent to
  `atoma_run_answer(projectId, runId, questionId, idempotencyKey, answer)`.
  `answer` holds an offered `optionId`, nonempty `text`, or both. Do not request
  credentials or put secrets in these fields.
- The answer operation records data only; it starts no model call. Then call
  the existing task-enabled `atoma_run_resume` on **that source run**. This
  keeps scheduling, spend authorization, task tracking and resume idempotency
  in the existing path. Retrying a failed resume does not require answering
  the question again.

Only the original requester, still a member of the active organisation, may
answer. Viewers can read; platform-admin cross-org reads retain the audit gate
and never grant write access. GET/POST `/api/projects/:id/runs/:run/question`
uses the same service, with authentication and same-origin protection for POST.
Wrong question/run/project/organisation, nonexistent option, an undrained
boundary, archived project and expired workspace are refused. An identical
answer retry returns the recorded receipt; changing a recorded answer conflicts.
It cannot silently overwrite a decision already consumed by another process.

## Durable boundary and answer scope

`run_client_questions` lives in the same product SQLite database as
`run_checkpoints`. The host records the question identity, source run, phase,
requester and time. A question and its workspace checkpoint are committed in
one transaction. Immutable question/answer triggers and an immediate answer
transaction protect races. The original checkpoint remains the reference;
resumption uses the existing single-claim operation and a new scoped run.

A question may pause at the initial planned boundary with zero completed
phases, or after any complete approved phase. The empty prefix is resumable
only with its recorded client question; ordinary incomplete checkpoints remain
refused. No tool is interrupted to ask a question. Completed phases, credit and
external actions are not replayed. Backend drain, workspace digest, worker
absence, snapshot integrity and remaining-budget checks remain mandatory.
An unanswered question blocks the reader used by every resume path, including
a direct CLI invocation. The answer is checked and attached before claiming a
continuation, so an answer write cannot race a live worker consuming it.

Recorded answers travel in the checkpoint's `clientAnswers` task input. The
answered boundary replans the remaining work through the ordinary root planner,
with the answer and bounded historical summaries. The host retains the exact
completed prefix; the old unexecuted suffix is replaced, including any obsolete
clarification-only phase. The remaining plan must stay sequential. Its strategy
and reconciled question identity are persisted together before dispatch, so a
recoverable crash after planning does not plan again. Ordinary pause/crash resumes
retain their saved plan. This uses the existing L3 planning budget and does not
consume a root remediation. The answered boundary skips its question assessment once. Child-authored inputs
cannot replace these answers. A response applies to its particular question;
it changes neither the frozen project context revision nor the goal, acceptance
criteria, shared skills or publication permissions. A permanent rule still
requires explicit confirmation via `atoma_project_context_update` for future
runs. Older question records remain on their source run; a later segment's new
question gets its own immutable record.

Answer text is limited to 2,000 characters; accumulated answer context is limited
to 32 answers and 24,000 encoded characters. Oversized answers are refused
atomically, never silently shortened. A lineage exhausting these bounds needs
a new scoped run. Waiting consumes no execution time or tokens; already consumed
spend and the remaining execution budget carry into the resumed segment.

## Deliberate limits and adversarial review

The mechanism is available at safe sequential root boundaries, not inside an
in-flight tool, nested phase, parallel plan, short run, comparison run or
operator run. An ambiguity arising inside a phase becomes visible at a later
safe boundary through completed work; this feature does not make arbitrary
mid-tool interruptions recoverable. An unvalidated phase or failed snapshot
still disables/refuses durable continuation under the checkpoint contract.

The review exercised zero/completed prefixes, another process consuming the
answer, expired wall time while safely waiting, immutable retries, changed
answers, forged option ids, wrong principals/organisations, child input forgery,
undrained backends, and preservation of the predecessor workspace. Existing
checkpoint tests retain the external-effect, double-credit, corruption and
live-owner refusals. Model judgments are mocked; these tests prove protocol
and persistence behavior, not that every real ambiguity will be classified
correctly. Live calibration should measure necessary questions versus avoidable
interruptions before broadening the intervention points.

## Live regression, 2026-10-08

Production source `f8d0bb51-2d0d-4520-ad79-ad5ed846d980` paused before a
clarification-only phase. After the client delegated a refund-policy choice,
continuation `113ed33f-7373-4f39-b348-9e94027e3dc4` received the answer but
executed the stale phase and asked again. Root acceptance refused it; one
remediation eventually delivered the correct files. The fix refreshes the suffix
before dispatch, without a semantic detector or an extra validation loop.
Fresh-process regressions cover zero and completed prefixes, obsolete text plans,
exactly one root acceptance, unchanged credits, and a crash after the new plan
was persisted. These mocked tests establish the protocol, not live model quality.
