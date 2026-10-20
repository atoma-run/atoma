# Executor admission counts its own reservation — 2026-10-20

The owner requested an Attica run and a production deployment while it executes.
Production run `1bf32e71-97c4-4061-96fd-d8b8dccade5f` remained queued on
`c2183ef4`. The selected executor repeatedly acquired its lease and discovered
the personal models, then released it without starting. Its customer device was
connected, accepting and unassigned. Linux reported about 2.9 GiB available;
the configured per-run reserve was 2 GiB.

The post-configuration memory check included the candidate's own newly acquired
lease among recent reservations, adding another 2 GiB to the base reserve.
Even the first run therefore needed 4 GiB. This contradicted the existing
first-run availability contract and repeatedly restarted the admission attempt.

The recheck now excludes only its exact candidate run ID. The base reserve still
counts that candidate; other live project leases, including other generations,
retain their ramp-up reserves and target-specific sizing. Pre-lease admission
and the configured reserve are unchanged. No leases, device assignments, model
configuration or operational records were edited to unblock the run.

## Adversarial review and regression

The existing source/packaged smoke now gives real executor child processes a
controlled memory reading and a real shared SQLite lease database. Before the
fix it times out waiting for the first run at 1 GiB available. After the fix:

- The first run starts at 1 GiB, preserving the documented availability rule.
- A second starts at 5 GiB: two distinct 2 GiB reserves fit.
- After switching executor generations, a third remains queued at 5 GiB: the
  two old-generation leases plus the incoming reserve require 6 GiB.
- At 7 GiB it starts, including its post-acquisition recheck, which previously
  would have incorrectly required 8 GiB.
- Existing restart, rollback, cancellation, finalization and retirement checks
  still exercise those same live processes. No paid providers are involved.

Excluding all reservations, only local active runs, or the current process PID
would defeat the concurrency protection; none is accepted. Only the unique
candidate run is excluded, after it acquired the lease. The subsystem's
intentional choices retain read-only observation and one coordinator; this fix
adds no alternative admission mechanism or heuristic.
