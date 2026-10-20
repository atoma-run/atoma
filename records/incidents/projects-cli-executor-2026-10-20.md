# The project CLI missed independent execution — 2026-10-20

The owner authorized a three-hour Attica run/fix/push loop. The production MCP
returned `Authentication required`; the browser session and authorized operator
SSH still worked. Reviewing the documented `projects run --as` fallback exposed
an incomplete executor migration: the CLI constructed a local coordinator even
when the host selected an independent executor. It could not dispatch a customer
device, and its local/global idle wait could not follow a remotely owned run.
Its generated request key also could not be reused after a disconnected command.

The CLI now reads the existing validated executor socket setting and uses the
same coordinator RPC as the web. It watches only its own persisted run receipt,
including queued work. A user-supplied `--idempotency-key` uses the shared schema;
the random default remains available. An executor-recorded admission is not
journaled twice. An unavailable configured executor never invokes a local driver.
No new authentication, token, privilege, runner or store is introduced.

The production CLI process regression uses the real private protocol and product
SQLite shapes with a quota-free admission host. It exercises disconnect before
dispatch, queued/running waiting, an unrelated queued organisation, a terminal
failure, retries before and after completion, invalid keys, unavailable socket
and duplicate admission journaling. There are no provider credentials or paid
calls. The existing multi-executor process regression also passes.

This repairs the documented operator path; it does not fix or claim acceptance
of Attica's HTTP tests. The original 400/404 mismatch is a separate unsupported
test convention: unmatched GET /api paths hit the existing POST guard. Further
application work must diagnose raw responses and request preconditions through
ordinary Atoma runs, rather than change correct status behavior to satisfy it.
