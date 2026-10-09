# Durable sequential checkpoints and project continuation

The operator runner can pause at a validated root phase and continue its saved
plan in a new process. Completed phases are skipped before child selection,
execution, validation and credit. The ordinary final delivery acceptance still
runs. Deep project runs enable checkpoints automatically. Projects shows the
validated phase count, “Pause after the current phase” and “Resume saved work”.
The pause request is persisted in the product store and observed after validation,
never in the middle of a tool. Short, parallel and comparison runs continue normally
without this action. Unsupported workspace contents disable checkpointing without
failing an otherwise valid project run.

```sh
npm run run:build -- --pause-after-phase 1 "Your goal"
npm run run:build -- --resume <checkpoint-id>
```

Use `run:build:dev` for source development. Keep the same store, workspace,
model pins and execution policy. The first command prints the checkpoint UUID;
the second takes no replacement goal, seed or `--clean-workspace`. The phase
number is absolute within the saved root plan. `--checkpoint` records boundaries
without a requested pause; a boundary reached with too little wall time left
also pauses. Explicit CLI checkpoint requests require a sequential deep plan;
seeded work is supported. Nothing changes for operator launches without these flags.

## Persistence and ownership

`run_checkpoints` is a table in the existing product SQLite store, outside the
tool workspace. It stores the original plan/strategy, original phase count,
root actor identity/version, checklist, completed output/summary/provenance,
remaining execution time, consumed tokens/cost and a workspace digest. It stores
no provider credentials. Boundary snapshots (including workspace file bytes) live
in `run_checkpoint_snapshots` and `run_checkpoint_files`, in that SAME backed-up
store, outside the worker mount. Snapshot capture and publication are one SQLite
transaction. Only the latest snapshot still referenced by an unfinished checkpoint
is retained. Workspace entry/file/byte limits apply; absolute/escaping links,
hardlinks and special files refuse capture. A graceful pause still verifies the
original workspace and refuses user edits rather than silently discarding them. Relative internal dependency links are hashed and copied verbatim. The bounded
state envelope is at most 32 MiB.

The root marks the row `running` before opening each phase. It publishes `ready`
only after `superviseLoop` returns a complete, approved result and its learning
hooks have settled. Deferred audit calls must also settle. A parent fallback
without its own approving result verdict cannot create a resumable boundary.
Neither can a result carrying a restoration, exhausted tool budget or uncovered
proof obligation: those review facts must stay in the live acceptance path.
Root review/remediation consumes the checkpoint; a final refusal remains the
ordinary partial-run path.

A SQLite immediate transaction claims one checkpoint for one process. A live
owner prevents another claim. A graceful pause drains the sandbox BEFORE it
seals the boundary, so what the run's processes write while shutting down is
part of the snapshot; it then verifies the workspace again and releases
ownership. A drained backend cannot continue the run: a pausing boundary first
checks that the tree can be sealed, and an unsupported tree keeps the run going
with continuation disabled. Crash recovery also requires a dead
owner and absence of the recorded local children/process groups. A container
backend records its launcher-issued worker UUID. Before recovery, the launcher
must successfully prove that worker (and every predecessor from a transport restart)
absent; a missing connection or engine error
is never absence. The recovery operation is read-only and never stops someone
else's worker. Older checkpoints without a worker receipt still need graceful drain. The
host identity is checked; moving the database to a different machine does not
authorize continuing a potentially live run. PID reuse conservatively refuses.

An interrupted phase may restart from its last sealed boundary only when the
write-ahead journal can establish a restorable suffix. `run_checkpoint_actions`
records each tool/model intent before dispatch, its completion/error, request and
result digests, and results up to 64 KiB (larger ones retain the digest only).
Results are audit records, never cached answers or imported proof. File reads,
listing, writes and edits may repeat against restored bytes. Other tools—including
shell, HTTP, server startup, browser actions and unknown future tools—block replay
of that phase even if their call completed: success does not establish idempotency.
An unfinished tool call blocks replay too. An unfinished or failed model call
also blocks replay because its final bill may
be unknown. Completed usage is committed with its journal outcome.

Registry writes and skill mutations install a recovery barrier BEFORE effects;
registry transactions commit that barrier on the same handle as the counters.
No shared knowledge is rolled back. A phase that already changed skills or earned
credit cannot repeat, including skill match counters. Async-local scope prevents
one library run's barrier from capturing another run's writes. Normal execution
and learning remain enabled; a barrier changes crash recoverability only.

Recovery builds a private new directory from the stored snapshot, checks its digest,
then renames it into place. CLI recovery archives the interrupted workspace beside
it; a project successor restores into its own new workspace. Files, directories,
modes and internal relative links survive; links are materialised after files so
they cannot redirect writes. On Linux capture pins directory descriptors; macOS
rechecks canonical ancestors but retains its platform's residual rename race.

## Project and UI integration

`POST /api/projects/:projectId/runs/:runId/pause` records a request; `/resume`
starts a successor using the saved goal and criteria. Both require the original
requester and current member access in the active organisation. Other projects
and organisations are not addressable through the route. The UI and its semantic
keyboard controls dispatch the same action and show request errors locally.

`resumeOf` belongs to the immutable project run receipt and request identity.
Concurrent retries reattach to one successor. Reservation and launch use normal
admission, queue, membership and fresh credential checks. Failed preparation may
be retried while the boundary remains ready. Failed interrupted runs expose
“Recover validated work” only when the journal permits it; blocked runs show the
reason. Cancelled runs do not offer recovery. No uncertain action is replayed. Changing model pins or execution policy refuses before model calls.

The runner binds the checkpoint to the stored requester/org/project/source run,
consumes the source and claims the successor in one SQLite transaction BEFORE
restoring its snapshot into the new run. The saved root actor is compared after
that claim, because the successor's own catalog seeding can move its version; a
changed actor hands the untouched source back and finishes the successor in one
transaction, so the source stays as resumable as it was (code review 2026-10-09, 1.4).
Legacy graceful checkpoints keep the
verified workspace copy path. Previous artifacts
and traces remain immutable. Repository BASE is copied rather than refreshed from
GitHub, including the imported-repository receipt. The original starting-file
snapshot remains the acceptor's comparison baseline, and inherited browser checks
are replayed without treating paused work as an accepted seed. Publication rechecks current GitHub authority and remote state.
The successor has its own retrieval receipt. A failed source has no artifact
manifest, so recovery reuses its recorded starting corpus, not interrupted files. Retention holds paused checkpoints
and sources needed by queued/running continuations. Crash recovery is conditional,
not an exactly-once guarantee for arbitrary external actions. Comparison reruns
of crash recoveries are refused: the predecessor workspace contains interrupted
work and is not the sealed snapshot the recovery started from.

## Proof and accounting

Completed summaries are labelled historical on resume. Attestations, witness
references, proof coverage, tool results and validation traces are not loaded
into the new process. Runtime endpoints may have disappeared. Remaining phases
and the final root acceptor must establish the evidence they need normally;
a checkpoint is never a delivery approval.

Each process gets its own immutable trace and records only its own new usage.
The launch log links the continuation ID and previous trace. The budget meter
carries prior consumption forward without recording those calls again; a pause
does not buy a fresh token/cost allowance. Remaining wall time excludes the time
spent paused and is bounded by the next launch's timeout and current platform
limits. An ungraceful interruption keeps the original absolute deadline
(downtime consumes the remaining allowance); a missing completion never invents
zero model spend. Learning rows are retained in the same store and skipped phases earn
no second credit.

## Adversarial design review and regression evidence

The design was checked against the existing landing incident
([progressive runs](incidents/progressive-runs-2026-09-21.md)), scoped proof and
seed inheritance ([seed inheritance](../docs/seed-inheritance-2026-09-25.md)),
and the supervisor's already-durable phase credits. Relevant counterexamples:

- Crash after an external action or credit but before checkpoint commit: the
  journal or host-mutation barrier blocks replay. File-only completed work with
  settled spend restores the previous snapshot and may restart the unfinished phase.
- Crash between action completion and budget persistence: both persist in one
  transaction; an unfinished model call blocks recovery.
- Corrupt snapshot, escaping paths or links: build and verify in a private new
  directory before touching the original. No original file is overwritten.
- Concurrent shared-catalog mutation: only the originating async run is marked;
  its mutation and registry barrier share a transaction, including rollback.
- Engine outage, surviving worker, old launcher: refuse recovery; do not infer
  shutdown from the runner's death or broaden the launcher to arbitrary inspect.
- Two resumptions read the same ready boundary: transactional claiming admits
  one before either may start tools.
- A surviving server or process group: refuse recovery until it is gone;
  cleanup merely sending TERM is not a release.
- Edited workspace or mutated execution policy: refuse before model work and
  leave user files intact.
- Stale proof: serialized phases contain no proof fields; root acceptance runs
  again even when all phases came from an earlier process.
- New strict spend ceiling: carried consumption can refuse the first new call;
  old calls do not inflate the new trace's accounting.

`tests/run-checkpoint.test.ts` launches separate Node processes with the real
runner, supervision, local tools, registry and skill credit. Only the provider
is mocked. It covers orderly pause/resume, SIGKILL at a committed boundary,
SIGKILL inside a phase after file writes, after shell effects and after credits,
corrupted snapshots, workspace mutation, competing claims, live orphan
refusal, fork isolation and budget carry. Existing depth, dispatch, runner,
audit and platform-limit tests cover the unchanged paths. No paid run is used
as a connectivity or correctness test.

Project regressions cover a real runner subprocess with a mocked container
transport, phase pause requests, immutable predecessor bytes, tenant scoping,
idempotent admission and repository BASE preservation. HTTP tests exercise the
real authentication and same-origin gate. `viz:smoke` clicks the Pixi pause and
resume targets and observes their resulting state from a freshly loaded page.

The recovery policy was checked against the same seed/credit incidents above and
the launcher disconnect contract: no lexical command classifier, approval inferred
from an old trace, counter rollback, or cleanup request mistaken for absence.
`tests/launcher-workers.test.ts` kills a real worker process behind a fake engine
and verifies the new-connection absence proof, including engine failure. Container
packaging/isolation tests remain the proof of the actual image boundary.

## MCP iteration follow-up (2026-10-08)

The client enters through Atoma's MCP. Pause and continuation now have MCP
doors (`atoma_run_pause`, `atoma_run_resume`), with continuation using the same
durable project task contract as starting a run. `atoma_run_compare` compares
two saved delivery inventories; status, trace and file readers remain the
sources of acceptance evidence and verified content.

### Owner decision: client acceptance precedes GitHub publication

Resolved on 2026-10-08: deliver, let the client test/review, obtain explicit
acceptance, then publish to GitHub. This applies to project deliveries generally,
not only an opt-in iteration mode. Existing published receipts remain unchanged.
The MCP acceptance call binds the exact manifest hash and records the client,
time and review summary. A failed publication retains this receipt for retry.
No approval is inferred from the model's delivery verdict. Text-only deliveries
can be accepted without publication. A push may trigger an existing repository
pipeline; Atoma does not configure or claim a deployment through this operation.

`atoma_run_start` now takes optional `baseRunId` with a new goal, selecting a
retained delivered or partial non-comparison run of the same project. It is part
of immutable request identity and survives queued process restart. Both admission
and launch validate the saved manifest against the selected bytes; unavailable,
expired or changed files refuse rather than silently choosing another version.
The ordinary automatic seed policy remains when the field is omitted.

Status and readiness expose `acceptedReferenceRunId`, derived from the newest
accepted delivery by run creation order (run id breaks ties), not acceptance
request arrival order. New unaccepted, partial or failed candidates never advance
this reference. Existing publication alone is not fabricated client acceptance.
Retention holds the reference of an active project and every base needed by a
queued/running iteration. Historical references remain readable after expiry.

Explicit selection skips remote refresh at launch, including imported PR/fork
projects. It copies the selected workspace through the existing runner and carries
its repository BASE/debt, text history and retrieval corpus. Publication still
requires fresh client acceptance and the existing remote authority/conflict checks;
selecting an older version is not a GitHub reset or force push. Imported selections
require a recorded repository base; unresolved legacy debt stays a publication
refusal. A separately mutable project reference/rollback command is not introduced.

Adversarial iteration review covers a newer candidate appearing while queued,
process restart, same key with a different base, foreign org/project, missing or
mutated bytes, and combinations with comparison or checkpoint continuation.
Existing seed-inheritance, progressive-run, host-path, repository-sync and recovery
contracts still apply: no duplicated runner, inherited approval, lost remote edits,
new LLM calls or expiry fallback. MCP tests use both protocol eras, queue tests
cross a real child-process boundary, and publication tests use stateful fake GitHub.

Adversarial review of the publication gate covers foreign organisations and
projects, viewer writes, mismatched manifest hashes, partial/comparison runs,
expired bytes, duplicate calls, remote failures and restart persistence. It
retains the existing incident-driven byte revalidation, branch ownership,
non-fast-forward and first-publication crash-repair guards. An unaccepted newer
candidate must not prevent the client from publishing an older reviewed version;
a newer accepted/published version still prevents rollback.
