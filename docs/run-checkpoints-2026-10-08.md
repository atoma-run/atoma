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
no credentials. Workspace files remain in their original location: this is an
in-place continuation with byte/mode verification, not backup or rollback.
Changing a file, adding/removing a directory, encountering an escaping or absolute
symlink, hardlink or special file,
or exceeding the existing workspace bounds prevents continuation. Relative internal dependency links are hashed and copied verbatim. The bounded
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
backend without a host process inventory must have drained gracefully. The
host identity is checked; moving the database to a different machine does not
authorize continuing a potentially live run. PID reuse conservatively refuses.

An interrupted **in-flight phase is never replayed automatically**. There may
already be external effects or learning credits between its last tool call and
the next boundary commit. The earlier checkpoint is not a transaction capable
of undoing those effects. Arbitrary mid-phase recovery needs tool-specific
idempotency and a durable effect journal; this increment does not pretend to
provide them.

## Project and UI integration

`POST /api/projects/:projectId/runs/:runId/pause` records a request; `/resume`
starts a successor using the saved goal and criteria. Both require the original
requester and current member access in the active organisation. Other projects
and organisations are not addressable through the route. The UI and its semantic
keyboard controls dispatch the same action and show request errors locally.

`resumeOf` belongs to the immutable project run receipt and request identity.
Concurrent retries reattach to one successor. Reservation and launch use normal
admission, queue, membership and fresh credential checks. Failed preparation may
be retried while the boundary remains ready; once work begins, no uncertain phase
is replayed. Changing model pins or execution policy refuses before model calls.

The runner binds the checkpoint to the stored requester/org/project/source run,
copies the complete workspace to the new run, verifies both copies, then consumes
the source and claims the successor in one SQLite transaction. Previous artifacts
and traces remain immutable. Repository BASE is copied rather than refreshed from
GitHub, including the imported-repository receipt. The original starting-file
snapshot remains the acceptor's comparison baseline, and inherited browser checks
are replayed without treating paused work as an accepted seed. Publication rechecks current GitHub authority and remote state.
The successor has its own retrieval receipt. Retention holds paused checkpoints
and sources needed by queued/running continuations. This is not recovery from an
arbitrary server crash in a container or from an interrupted phase.

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
limits. Learning rows are retained in the same store and skipped phases earn
no second credit.

## Adversarial design review and regression evidence

The design was checked against the existing landing incident
([progressive runs](incidents/progressive-runs-2026-09-21.md)), scoped proof and
seed inheritance ([seed inheritance](../docs/seed-inheritance-2026-09-25.md)),
and the supervisor's already-durable phase credits. Relevant counterexamples:

- Crash after a tool effect or credit but before checkpoint commit: `running`
  blocks replay, preserving the uncertainty instead of duplicating the effect.
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
SIGKILL inside a phase, workspace mutation, competing claims, live orphan
refusal, fork isolation and budget carry. Existing depth, dispatch, runner,
audit and platform-limit tests cover the unchanged paths. No paid run is used
as a connectivity or correctness test.

Project regressions cover a real runner subprocess with a mocked container
transport, phase pause requests, immutable predecessor bytes, tenant scoping,
idempotent admission and repository BASE preservation. HTTP tests exercise the
real authentication and same-origin gate. `viz:smoke` clicks the Pixi pause and
resume targets and observes their resulting state from a freshly loaded page.
