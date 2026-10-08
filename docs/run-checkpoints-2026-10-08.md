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
owner prevents another claim. A graceful pause drains the sandbox, verifies the
workspace again, then releases ownership. Crash recovery also requires a dead
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
restoring its snapshot into the new run. Legacy graceful checkpoints keep the
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
