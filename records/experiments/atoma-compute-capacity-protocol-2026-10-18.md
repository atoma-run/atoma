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

## Frozen workload and execution rules

The exact source inputs and mechanical scorers are registered in
[`corpus.json`](../../benchmark/compute-capacity-2026-10-18/corpus.json), SHA-256
`20c7b827fa05d47a312718b277f3c683829c30f4c860ea861ea2d71b73d3e671`.
Its PDF is the committed `tests/fixtures/retrieval-documents/pricing.pdf`, SHA-256
`4036ffeef4485d291c667e90a1660cfbde8eb20c0ac9de16b33aed5fa8f36b11`.
Each run performs the whole sequence and streams an additional 8 MiB fixed
payload. There are 60 batch samples, representing 320 runs, not 60 individual
runs. Use the shared runner with deterministic scripted model replies; the
same reply and tool argument sequence is replayed in both arms. Never replace
Chromium, Haystack, checkpoint SQLite writes or preview proxying with mocks.

Freeze the source revision, worker/workspace/retrieval/preview image digests,
Python runtime identity, embedding/reranker content pins and query prefix before
sample 1. Preserve them with the raw process/cgroup samples, traces, initial and
final stores and scorer outputs. Record every threshold environment variable.
The server and clients must run the same code and image generation. One active
run per client allocation remains in force. A colocated transport microbenchmark
must be labelled separately and cannot satisfy this capacity acceptance rule.

Cold means a fresh project/model embedding cache in both arms. Warm means one
unmeasured preparation with that same corpus and model identity on each execution
host; record its outcome and do not retain it only for the client arm. Start each
measured batch behind a barrier after provisioning, but include run preparation,
search, transfers and preview opening in its measured work. End only after
publication and confirmed workload teardown. Preloading image/model downloads
is outside the timed window and must be reported separately.

Sample memory from the complete attributed server process tree/cgroups every
100 ms and report the sampling interval beside its maximum; do not add independent
per-process peaks measured at different times. Count complete CPU usage of exited
children/cgroups, not merely the surviving orchestrator's process usage. Include
server storage and preview relay in both arms, and retain client usage separately.
Collect network bytes in both directions, peak queued transfer bytes, SQLite
committed bytes/second and transaction hold/wait time, wall time, preview latency
and every scorer result. Missing telemetry invalidates the sample without removing
its failed/interrupted outcome from the report. Do not rerun failures until they
silently become successful samples.

For each concurrency/cache cell report five-sample medians and all raw values.
Compute reduction as `1 - median(customer server) / median(hosted server)` for
CPU and peak RAM separately. Zero/missing denominators are unavailable, not 100%
savings. The 50% target requires both metrics in every cell and all functional
scorers passing. Report failures, latency and traffic even when the target fails.
No measurements have been executed under this protocol; Docker correctness tests
and a single developer workstation are not a substitute for the registered fleet.
