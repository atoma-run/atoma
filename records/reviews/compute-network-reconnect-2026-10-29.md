# Compute fresh-connection retry review — 2026-10-29

The installed desktop client confirmed the previous run stopped at 12:51:37 UTC,
reconnected at 12:51:45, lost transport at 12:56:45, confirmed teardown at
12:57:19, then failed its fresh socket with `ENOTFOUND` at 12:57:26. No further
connection appeared before the 13:31 inspection. The application remained open;
the project UI reported its device disconnected. The existing lifecycle exits
when this single fresh connection fails, and its machine retains the rejected
connection-attempt promise, so adding a retry alone cannot reconnect that owner.
The application hosting remains independent and online.

The change retries only explicitly classified, pre-session DNS/socket failures
whose actual teardown completed successfully. It retains the same locked
inventory, reconciles before every connection and refreshes capacity before the
next attempt. Delay doubles from one second to a thirty-second ceiling; the
user's disconnect signal cancels backoff. It never replays controls, workspace
commands or an interrupted run. The existing bounded transport reattachment
protocol and lease remain unchanged.

Adversarial review considered the previously recorded failure boundaries:

- A certificate or identity refusal is terminal, including a real TLS failure
  and a wrong credential tested against the production gateway/client path.
- A protocol failure, missing handshake, late frame or post-session failure
  cannot acquire the new retryable error classification. A socket error after
  `ready` is excluded even before the first heartbeat succeeds.
- A failed or unfinished engine teardown cannot trigger another attempt. The
  real refused-socket regression holds cleanup unresolved, verifies the
  connection promise remains pending, and checks both successful and failed
  cleanup outcomes.
- Inventory ownership is not released between attempts. A real second machine
  is refused while the first reconnects successfully after a real closed-port
  failure; reconciliation occurs again without allocating or replaying work.
- Docker/resource failures remain terminal. Capacity is read afresh rather
  than frozen from the first connection. Cancellation and a drained session
  do not create a new connection.
- No raw exception payload, frame, credential or remote close message is
  copied into diagnostics or used to decide retries. Classification uses the
  existing bounded diagnostic error codes, excluding TLS codes.

Verification: 91 focused tests passed (4 existing image-dependent cases skipped),
including actual TLS, primary-store authority, inventory and teardown boundaries.
Full release verification and CI/deployment receipts are recorded separately in
the cycle memory and retained command logs; this note does not claim they have
finished before their results exist.
