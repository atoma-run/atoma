# Compute resume after an executor cutover

The targeted Attica run `796769c0-4323-4f93-b1ba-1d293aa3f885` stayed on
executor `de621926` when compatible deployment selected `a48a82cb` at
2026-10-29 22:45:05–07 UTC. Its existing TCP connection continued working.
At 23:13:19 the client replaced a stale transport. Nginx sent each replacement
to the selected gateway, whose in-memory channel map did not contain the
original session. Sixteen upgrades returned HTTP 101 without application bytes.
The client confirmed workload teardown at 23:13:55, reconnected with a new
session at 23:14:01, and the source failed after reconciliation at 23:14:04.
The original executor retired at 23:14:03. The initial network stall's trigger
is unknown; this establishes why reattachment failed after the cutover.

The correction authenticates a resume before consulting the existing
`compute_session_executors` record. A live process birth identity selects the
original generation's public Unix gateway under the configured gateway root.
One bounded relay carries frames to that owner. The owner checks the channel
token, session, credential, machine, lease, execution and project authority.
A draining gateway permits those resumes while refusing fresh handshakes.
Neither the relay nor routing recreates a session, renews a lease or replays
an application command. Tokens, frame bodies and exception text are not logged.

Adversarial review covered unauthorized routing, stale owners, routing loops,
socket-path injection, frame/byte/frame-count bounds, and mixed subprotocols.
The last exposed an admission bypass in the first draft: offering the resume
protocol while negotiating a legacy protocol could enter the old raw-socket
branch. That branch now checks admission too, and the regression exercises it.

The production-path regression compiles a separate gateway process, shares a
real SQLite store, moves a WSS proxy from the original Unix gateway to the new
one with a workspace request in flight, and proves the original request completes
exactly once with the same session and execution and no workload teardown.
The old gateway implementation fails this scenario. Additional real gateway
tests refuse changed credentials, membership, machine identity, session
generation and unavailable routes before creating a relay.

A separate evidence defect was reproduced during this investigation:
`snapshotFile` omitted permissions and the starting-workspace comparison
called a chmod-only change unchanged. Snapshots now retain POSIX permission
and special bits and report permission-only differences. Legacy missing modes
remain explicitly unknown. Real filesystem and private workspace process tests
cover the change. Strict older readers require executor compatibility 4;
deployment must drain earlier generations. Old Compute workspace images still
report unknown permission coverage until their normal image rollout.

The failed customer run was neither accepted nor published. Its initial state,
raw traces, recovered failures and stopped Compute allocation remain preserved.
No customer hosting or data migration is part of these platform changes.
