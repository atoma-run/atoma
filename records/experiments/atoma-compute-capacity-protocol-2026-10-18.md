# Atoma Compute capacity experiment — preregistration

Status: protocol only; no measurement or gain is claimed.

## Question and arms

Does moving execution and retrieval to customer compute reduce Atoma server
CPU-seconds and maximum resident memory by at least 50% on the same workload?

Compare hosted and customer-device execution on the same commit and day,
with identical pinned images, seeds, budgets, tool scripts and deterministic
mock model responses. Include Node build/tests, Chromium verification,
read-only restoration, Haystack cold and warm indexing, checkpoint transfer
and an interactive preview. No paid model calls.

Run at 1, 5 and 10 simultaneous runs, one organisation per run. Repeat each
arm/concurrency/cache condition five times, alternating arm order. Record
server/client hardware, OS, Docker resource allocation, network latency and
throughput. Do not compare different code revisions or reuse a warm cache in
only one arm. Use separate client execution slots for concurrent runs.

## Measurements

Collect whole-process-tree/cgroup server CPU-seconds, peak resident memory,
client CPU/memory, transferred bytes, transfer queue peaks, SQLite write time
and lock waits, run duration, preview response time and completion count.
Report raw samples and medians with the hardware/window beside every claim.
Account for the hosted orchestrator, model transport, storage and preview
relay in both arms. Count failed and interrupted samples; never omit them.

## Acceptance and rollout

All deliveries and restored checkpoints must match the executing scorers.
No duplicate uncertain operations, orphan workloads or cross-org access.
The initial capacity target is at least 50% reduction in server CPU-seconds
and peak resident memory for each registered concurrency level. Report cold
and warm results separately. Record latency/transfer regressions even if the
resource target passes. No automatic increase to the production run ceiling;
choose the new ceiling from measured residual server headroom after review.
