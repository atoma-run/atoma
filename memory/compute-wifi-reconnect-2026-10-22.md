# Compute Wi-Fi reconnection — 2026-10-22

Owner scope: fix only reconnection after a Wi-Fi change, then commit locally;
explicitly NO PUSH. This overrides previous autonomous release permission.

Completed local commit: `804946696ec55a7faf915ee9cb7263350bce207d`
(`fix(compute): reconnect live sessions after network changes`). It is on primary
`/Users/mgtf/dev/atoma` main and on the clean managed worktree branch
`codex/compute-wifi-reconnect` at
`/Users/mgtf/.codex/worktrees/compute-interruption-cause/atoma`.
Primary was advanced locally from f9 through the already-pushed diagnostic a3
commit, then this new commit. No push, deployment, run or automation change.

The opt-in transport keeps the same in-memory logical channel, session and
execution within the unchanged 30-second lease. Two missing heartbeat replies
(10 seconds) trigger replacement of a silently stale TCP socket. Resume checks
token, credential, persistent machine, current session/lease, execution and
project/membership authority. Sequence/acknowledgement state prevents duplicate
application dispatch; bounded retained frames are drained one TCP write at a
time. Resume epochs fence old sockets. Explicit stops, process restart, expiry,
revocation and queue overflow remain terminal. Both client and server must be
updated; legacy peers retain the former fail-closed protocol. No retry of a new
run, no context/validator/model changes.

Adversarial checks cover lost command/result/ACK, pending allocation, stale OPEN
sockets, second loss during resume negotiation, stale socket callbacks, forged
identity/token/machine/session/ACK, revoked authority, expired local/server
leases, malformed frames, queue count/byte bounds, bounded backlog flushing and
old-server subprotocol echo compatibility. A separately compiled Node client
process performs a non-idempotent effect exactly once across real TLS migration.
No independent agent review was claimed or run.

Validation: full `npm run release:check` exit 0, 553 test files passed / 4 skipped,
7905 tests passed / 36 skipped. One further resume-handshake-loss regression was
added after that suite loaded; the final focused run passed that regression,
the compiled separate-process test and legacy interoperability (3 tests).
Both TypeScript configurations and full lint passed again afterward. Desktop
bundle built successfully. Targeted base matrix: 96 passed / 4 existing skips.
The commit hook lint passed, the managed worktree is clean, and the primary
changed source/test paths match the verified commit.

Preservation: all five pre-existing modified tracked files and six overlapping
untracked incident files retained exact bytes/modes (11 hash comparisons).
Only the six old incident paths were temporarily backed up to
`/tmp/compute-wifi-primary-backup-80494669` for the local fast-forward, then
restored byte-for-byte. Their enriched report/evidence remain unstaged changes;
do not stage them or the unrelated AssistantPanel/viz-assistant edits with a
future source change. Baseline hashes: `/tmp/compute-wifi-primary-preservation.json`.
