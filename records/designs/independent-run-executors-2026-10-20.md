# Independent run executors — 2026-10-20

The owner approved replacing the global deployment drain for ordinary releases.
A continuously busy service must accept new work on the new release while work
already admitted finishes on its original release.

## Implemented boundary

The existing `ProjectRunCoordinator` remains the single admission/finalization
implementation and `spawnRun` remains the process driver. A private Unix RPC
listener reuses the existing server's authenticated runtime wiring in executor
mode. The web owns neither the run driver nor its lease. Executor generations
have separate systemd cgroups, immutable cwd/code and revision-specific worker
images. The selected socket is the admission pointer; queued work keeps the
existing project run receipt rather than gaining a second task record.

Cancellation is durable in the primary store and the owner polls it. Operator
records remain bounded projections of the existing run record, also in that
store. Live process birth identities protect other generations during recovery.
Global capacity and memory admission include reservations held by old generations.
Deferred learning is re-authorized and dispatched by the selected host. Already
running learning, naming, analyst/assayer work and notifications finish in their
own generation. Model calls, provider authorization and cost recording are unchanged.

Atoma Compute WSS goes directly from nginx to each executor gateway. A web
restart cannot tear down an executing connection. Idle devices reconnect through
the new socket; a device whose run is still preparing is retained too. Preview
control/streams are private RPCs to the owner of the authenticated device session.
Browser preview grants retain their prior fail-closed restart behavior. The
activator reclaims their remote previews asynchronously after stopping the web;
executing and preparing device runs remain untouched.

The producer-local journal bus still owns push delivery. A separate bounded
committed-row subscription supplies MCP resource notifications and the analyst
across processes; it never republishes onto the push bus. Push requests have a
15-second deadline so they cannot indefinitely retain an otherwise idle host.

Rotating OAuth credentials use a primary-store process mutex across generations.
The owner re-reads tokens after acquisition; a live owner is never replaced.
Graceful web shutdown finishes its exchanges before exit. A killed owner is
reclaimed by PID/birth identity, without holding SQLite across network I/O.

## Activation and rollback

The activator compares `EXECUTOR_COMPATIBILITY` in both releases and checks the
old executor. A match skips the global pending-deployment row, run lease and
write freeze. Initial migration, incompatible upgrades and incompatible rollback
keep the original full drain. A compatibility bump is required before an
incompatible schema, lease, RPC or commons-writer change. Maintenance waits for
all hosts to report idle, including work beyond the run lease, then stops every
old writer before starting the new version. Such migrations must retain rollback
readability or carry an explicit backup/restore procedure.

The old executor stays available until the candidate web passes health. Only
then does an explicit retirement marker permit the old host to exit after its
own work settles. Failure restores the old release, admission/compute pointers,
web dependency drop-in and worker tag. A candidate that admitted work is retired
rather than killed. A same-revision activation never reinstalls an executing
generation's modules or rebuilds its image in place. Web `Wants`/`After` starts the
selected executor after a reboot without a reverse lifecycle dependency.

The optional mender refresh is a separate root-owned systemd job, serialized by
its own lock. It resolves the deployed revision after acquiring that lock and
never holds the user run lease while building its checkout/image.

## Adversarial checks of accepted mechanisms

- A pooled HTTP connection follows the old inode after an active symlink swap.
  The first process smoke reproduced this; RPC uses a fresh connection per call.
- A new coordinator cannot classify another live executor's run as an orphan.
  Recovery uses the existing lease owner/birth-identity check, and the frontend
  performs no reconciliation. An idempotent retry returns the original run.
- Demotion between queue selection and preparation must not kill admitted work.
  Dispatch checks selection, leases serialize ownership, and retirement waits
  for the driver's complete finalization. Preparing device sessions are retained.
- An idle old executor cannot exit before rollback is ruled out. Retirement is
  an explicit post-health action, not merely a lost admission pointer.
- A new generation cannot inherit the mutable worker tag or an in-place npm
  reinstall. The unit pins its release and image; same-revision redeploy skips
  preparation for an executing generation.
- Delayed learning cannot be stranded because the new host booted in standby.
  Selection wakes both persisted execution and deferred-learning queues.
- A web restart cannot cancel a remotely owned operator run. Its in-memory
  driver remains in the independent host; receipt and cancellation are durable.
- Cross-process events cannot duplicate pushes. Persisted subscribers have
  their own cursor and never enter the producer-local push listener bus.
- A public device socket cannot expose host-authority commands. Its listener
  only accepts the existing authenticated device WSS protocol; execution RPC
  has a distinct service-owned 0700 parent and a 0600 socket.
- Host configuration paths are data in systemd units: rendering quotes literal
  dollar/percent/space characters, preserves `%i`, and restores the previous
  drop-in on rollback. Private socket paths are bounded by encoded byte length.

## Verification

The source process smoke exercises two genuine executor processes, three runs
in separate organisations, an exiting frontend process, successful delivery in
both generations, rollback before retirement, idempotent reattachment,
cancellation of old-generation work from a fresh frontend, and exit only after
explicit retirement. Its compiled counterpart is part of `release-smoke.mjs`,
including production `npm ci --omit=dev` verification. No model call is made.

Additional tests exercise compatible/incompatible/failed-health activation,
rollback across compatibility numbers, reboot/unit rendering, private socket
ownership and duplicate listeners, unknown commands, bidirectional preview
streams, preserving preparing device connections, and cross-process journal
subscriptions without producer-bus replay. Full release verification is required
before activation; the first production transition still drains legacy work.

The implementation at `00d96a50` passed the complete [Linux branch CI](https://github.com/atoma-run/atoma/actions/runs/39405506765): static release verification, the general suite, a fresh worker/preview/workspace image with enforced container isolation, and mender credential isolation. `npm run viz:smoke` passed on the development machine. A separate quota-free boot of the actual compiled authenticated server in executor mode verified private health, the public Compute socket refusing host RPC, selection and retirement.

Local `npm run release:check` completed its static half and then reported 7,725 passing tests, 32 skipped and one failure: Docker Desktop retained the old bind-mount inode after the workspace directory was archived/recreated. Rebuilding a separate verification image reproduced the same failure, and a direct probe showed writes reaching the archived directory although Docker inspect still named the original path. The tool backend and test were unchanged. The exact container test passed with a fresh image on native Linux; no test was weakened or skipped to hide the local failure, and Docker was not restarted.

The packaged process smoke also boots the actual authenticated server in executor mode with Compute enabled and an explicit `--db`. It checks primary-store precedence, the public device socket refusing host RPC, selection and retirement. Server startup propagates the selected primary path to default-path readers and children; a CLI flag cannot silently create a second operator-receipt store.

Account-profile disconnect checks also consult running learning claims in the shared store, including their owner's birth identity, so a fresh frontend cannot revoke credentials still used by another generation's learner.

The first host activation refused the rendered unit: `WorkingDirectory` and `EnvironmentFile` consume scalar paths, whereas `ExecStart`, `Environment` and mount dependencies parse word lists. Quoting every field passed the original rendering assertions but made systemd see a non-absolute working directory. Rollback restored the previous healthy web release. The renderer now distinguishes these syntaxes, and `systemd-analyze verify` parses the exact staged unit before any serving process stops. The Linux regression uses the real parser on the same host-path data, including spaces, dollar and percent characters. Parser semantics: [systemd load-fragment.c](https://github.com/systemd/systemd/blob/v252/src/core/load-fragment.c#L2397).
