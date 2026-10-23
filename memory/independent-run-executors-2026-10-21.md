# Independent executor deployment — reverified 2026-10-21

Owner resumed the request for version coexistence instead of a global idle gate.
The implementation already exists and is deployed; do not implement a second
runner or restart project work to prove connectivity. Earlier real-run evidence:
[Attica live deployment](attica-live-deployment-2026-10-20.md).

Current source in the clean isolated `/private/tmp/atoma-independent-executors`
checkout was fast-forwarded to origin/main9f4739f3. Shared dirty source untouched.
`src/projects/executorHost.ts`, `executorTransport.ts` and the existing coordinator
implement independent generations. `deploy/host-deploy.sh` selects compatible
activation, pins the revision-specific release/image and atomically switches
admission. The old generation owns its running work, finalization and accounting
until retirement. The frontend never reconciles external executions.

Read-only production MCP health succeeded first. SSH then verified:
- Current release97bbb34a9839c78e643bc3100053ab20beafd60e.
- Active web PID2823002; Wants its independent executor generation.
- Executor health: compatibility1, readytrue, selectedtrue, idletrue, release97bbb34a.
- Installed activator and current release host-deploy.sh share SHA256
  89d4469e9793115cb7dd7918ab79f59cb94cb8143deae306636de2fe40c83fbe.
- No service restart, deployment, paid run, device modification or acceptance.

Pinned Node24.20.0, four targeted files passed31tests:
executor-process, executor-transport, deployment-pipeline, projects-executor-cli.
The real subprocess regression exercises cutover, rollback, frontend replacement,
old-run delivery/cancellation, durable reattachment, no replay and retirement
after pending host work. The packaged variant is already part of release-smoke.
No source defect/change was established by this recheck; do not manufacture an
extra code change or push solely to repeat the existing implementation.

Compatibility remains explicit: additive/readable shared-store changes coexist;
incompatible writers/storage/RPC require incrementing EXECUTOR_COMPATIBILITY and
the exceptional full maintenance drain. A web restart can briefly reconnect API
clients; this is not zero-downtime HTTP routing. Running work remains owned by its
executor. Compute gateway sessions bypass the web through nginx.

Attica's separate automation remains PAUSED under the owner's no-new-run order.
