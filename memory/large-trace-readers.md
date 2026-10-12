# Large trace readers — 2026-10-13

Production run `b5077432-aa14-43c6-b04f-c9a155336c6b` ended with a
33,969,659-byte trace (1,151 events). The shared 32 MiB file ceiling caused
HTTP 413 on the timeline, MCP `overCeiling`, and a false finalization failure
(`run trace exceeds the control-plane scan ceiling`). The trace's own result
was partial. Evidence was not deleted or rewritten.

The ceiling now bounds whole-file materialization and selected projections,
not the coordinator's constant-memory shape scan. The existing byte scanner
also indexes top-level fields and event ranges. Large HTTP responses stream
complete/delta JSON with backpressure; MCP and run lists capture selected
fields/events. One open descriptor keeps each read on one atomic recorder
snapshot. Individual captures and aggregate projections stay bounded.

Regressions cross the real HTTP process and coordinator finalization paths,
plus MCP detail pagination, Unicode/chunk boundaries, duplicate JSON members,
atomic file replacement, symlink refusal and malformed EOF.
