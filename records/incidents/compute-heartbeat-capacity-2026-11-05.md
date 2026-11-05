# Compute heartbeat saturation interrupted recoverable sessions

On 2026-11-05, two Attica runs stopped after transient transport interruptions.
The server executor had not restarted. The desktop client reported a heartbeat
failure roughly 44–45 seconds after its last acknowledgement, even though the
configured lease was 120 seconds. The cause of the underlying network stalls
has not been established.

## Failure mechanism and repair

The client sends a heartbeat every five seconds. `ComputeLease` retains at most
eight outstanding heartbeat identifiers so that acknowledgements can be
validated. A ninth send threw a capacity error. The client treated that local
queue refusal as a terminal heartbeat failure and stopped the workload before
the lease deadline.

Commit `7b1f0fa9fd970045e29794cc31e986456d98b3b0` exposes the lease's bounded
send readiness and defers periodic sends while the queue is full. It retains
all outstanding identifiers, allowing delayed authenticated acknowledgements
to arrive. It changes neither the 120-second deadline nor authentication,
generation fencing, replay protection, or the queue bound. An acknowledgement
renews from its original dispatch time; skipping a send cannot renew the lease.

## Verification

A regression uses the production TLS client, gateway, channel and store, with
a non-idempotent command in progress. It withholds traffic until eight replies
are outstanding, then restores connectivity and verifies same-session recovery
and a single application effect. Only the periodic heartbeat interval is
accelerated; lease clocks and transport deadlines are unchanged. Against the
previous implementation the workload stops once, failing the expected zero
stops. The repaired path passes. Separate clock-controlled lease tests prove
that delayed replies remain usable and a saturated queue still expires.

Fresh `npm ci` followed by `npm run release:check` passed: 8,731 tests passed,
45 were skipped. The six focused Compute suites passed 149 tests with four
container opt-in skips. CI, CodeQL, all three native installers and production
deployment completed successfully for the repair commit. A read-only check of
the active production revision verified the compiled lease and client hashes,
then exercised saturation, delayed acknowledgements and expiry without paid
model calls. Both selected production sockets identified that revision and
reported ready and idle.

The official desktop installer is **0.5.258**. Workflow run number 257 is not
its version: the installer version calculation also includes the package's
base patch number. Server deployment alone does not update an installed desktop
client. The exact official version must be installed and admitted before the
next live regression; publishing an installer is not evidence of its use.

## Data and evidence

The interrupted runs remain failed; neither produced a delivery or acceptance.
Their complete initial states, terminal traces, raw evidence archives and
retained source trees were preserved privately and checked by digest and file
mode. Independent collector checks still reject those unfinished candidates.

Attica's existing deployment was not replaced. Before and after the platform
repair, its six business data files had identical bytes and modes, including
1,253 listings. Its saved page limit and daily schedule were unchanged. No
collection, pruning, image deletion or manual service restart was performed.
The source manifests and recovered failures remain evidence, not disposable
scratch state. Private customer data and raw traces are not included here.
