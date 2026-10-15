# Approved learning outside delivery

Root acceptance used to await every lesson and its compilation before the
runner printed its delivery epilogue. Commit `04996fbb` parallelized criteria
batches and different owners' lessons, but retained that wait. On the two
production Reading Log runs examined on 2026-10-11, approval preceded trace
closure by 25.987 seconds (`5c6fb5e2-f4a4-47ec-84ee-591580b35c3a`) and
40.302 seconds (`76a9486c-9255-417c-87e9-11f1db991a0e`). These are historical
tail measurements, not a measured speedup of this change.

## Lifetime and authority

The approved pass commits serializable lessons to `skill_learning_jobs` in
the existing product store. The originating actor's author prompt, context
citations, observed-action/probe flags, namespace, declared tools and policy
are captured; refused passes still discard their lessons. No credentials,
tool executors, closures or workspace snapshots enter the job. Recipe
authoring and compilation need only the recorded evidence and the catalog.

Delivery waits for that insert, not for model calls. A separate Node process
uses the existing `SkillLifecycle`, provider construction, Decision,
metrics and tracing. It has no tools. One learner owns the product-store claim
at a time, with different namespaces processed in parallel inside its batch.
Compile-at-learn, exact-id and semantic-twin guards remain in the same engine.

Project dispatch happens after releasing the source run's lease. It rechecks
membership and resolves the original selectors through the existing credential
authority, then refuses a changed L2 payer. A terminal host-finalization error
does not undo a recorded root approval; explicit cancellation blocks dispatch.
Private profile replacement waits while learning is using that principal.
Operator delivery launches a separate process group, so the run launcher's
normal group termination cannot kill the learner.
Each pending operator job gets its process before that parent can exit; the
process waits up to 240 seconds for the shared claim. A still-pending job can
be explicitly retried. Tenant jobs instead return to their resident host for
fresh authorization. The serial burn-in harness
sets `ATOMA_DEFER_LEARNING=0`: its next task must not overlap model work, and
its measurements include the complete original accounting path.

## Persistence, costs and interruptions

Delivery statistics and duration remain the delivery's own measurements.
`ProjectRun.learning` is a separate receipt with status, completed lessons,
calls, tokens and cost. The project's aggregate cost includes both delivery
and learning. Requested and served models, complete prompts, responses,
partial usage and skill decisions are kept under the source run's
`runsPath/learning/`. The ordinary backup already captures both this corpus
and the product store. The source run's remaining token and cost allowances
bound the learner; its wall-clock window is 240 seconds, with a hard watchdog.
The allowance is sealed after the run's pending audits settle. Until then it
is zero: a crash before final accounting retains the approved lessons but
cannot authorize spending an unknown remainder.

Completed lessons are never replayed. A dead claimant is recognized by PID
and birth identity. Work interrupted before entering a lesson returns to the
pending queue. An interrupted lesson is retained as `interrupted`, because a
request may have spent tokens or saved a body before its caller died: silently
reissuing it would make the accounting dishonest. It requires an explicit
operator retry. Failed calls retain reported partial usage and never change
the source run's status. Saved recipe provenance binds it to its lesson so a
retry can finish compilation even when the exact-id guard keeps that body.

Inspect with `npm run skills -- learning [run-id]`; retry with
`npm run skills -- learning <run-id> --retry`. Retry may spend again and cannot
infer the usage of a response lost during process death. Each retry's timestamp
and CLI identity are recorded in the receipt. Operator jobs launch immediately;
project jobs are picked up on the coordinator's next pending-work
wake, delivery, or restart, under freshly checked authority. A changed payer
is never substituted. The queue retains blocked jobs for inspection.

Deployment preflight includes active learning. Learners and their host refuse
to start while deployment admission is closed. Pending jobs survive deployment.
The worker rechecks admission after publishing its claim, closing the race
between the first admission check and a deployment's final idle check.

## Adversarial review

- **Remove only the await:** rejected. `spawnRun` kills the delivered process
  group; the lesson would disappear or write into a closed trace.
- **Learn before root approval:** rejected. It would restore the refused-pass
  learning of run `fc2a68cf`; the approval handoff test includes remediation.
- **Resume using today's default model/key:** rejected. Selectors are pinned,
  the payer is compared, and account authority is re-asked. Tests cover revoked
  membership and a host-key to organisation-key change.
- **Automatically replay every interrupted lesson:** rejected. Neither a
  paid response nor a catalog mutation can be assumed absent after a crash.
  The queue distinguishes untouched work from uncertain work.
- **Let one failed lane close accounting for its siblings:** rejected. The
  worker settles every owner lane before closing its trace and releasing its
  claim. A watchdog handles transports which ignore cancellation.
- **Hide learning cost in a shorter delivery trace:** rejected. The job has a
  separate persisted receipt and trace, including failed-call partial usage.
- **Use a new database or persist credential snapshots:** rejected. The outbox
  lives in the product database; credentials are resolved only at execution.
- **Measure a batch while its previous learner is still running:** rejected.
  Burn-in retains the serial accounting path explicitly.

The worker regression crosses a real process boundary against a local fake
Ollama endpoint and observes both distillation and the compiler refusal. Root
and coordinator regressions establish that delivery settles before learning,
that refused passes produce no job, and that a blocked learner cannot turn a
delivered run into a failure. No paid run is used for these checks.

## Verification on 2026-10-11

Verification used Node 24.20.0 in an isolated Linux checkout. Both TypeScript
configurations, the build, documentation checks, dependency audit and compiled
release smokes passed. The final worker smoke also passed after the deployment
admission fix. Across separate invocations, 269 targeted tests passed in ten
files covering depth routing, the runner, project coordination, learning,
compilation, shared skills and deployment preflight.

The complete release gate is not green on this machine. The process-level
authentication test `fails closed with an ambiguous switch, no provider, or no
canonical public origin` exceeded its existing startup watchdog (SIGKILL,
empty stderr). The same failure reproduced against unchanged `4f3897f7`.
No test deadline or assertion was relaxed. Production latency after this
change has not been measured.
