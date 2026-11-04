# A refused checkpoint discarded Attica's iteration seed

Run `e759d41a-b9e9-4fa4-b88b-e7db9e5efa78` stopped on revision
`2044d64f1868770e0d84beb8a13bba457b77f7b1` with `Remote workspace operation
failed`. Its five implementation results had been refused for incomplete
verification. Exhausting short supervision requested deepening; the backend
drained, then the full checkpoint export refused npm's esbuild hard links.

The retained stopped allocation was inspected read-only, without network or
volume modification: 8,709 files, 196,100,215 bytes, four esbuild paths with
link count two, and no special files. The original workspace and all raw run
evidence remain retained. This was not a demonstrated disk-full, socket-loss,
emulation or production-data failure. Production Attica remained the accepted
57a6ff86 version with 1,155 saved listings.

The checkpoint policy deliberately rejects hard links. Deepening requires
every byte and dependency to remain sealed, so using the filtered publication
inventory as a replacement checkpoint would weaken that contract. Removing
dependencies, changing link topology, raising bounds or treating verification
failures as approval were rejected.

Only checkpoint-export failure after confirmed drain and read-run integrity
checks, before replacement construction, now returns a host-refused partial.
The ordinary finalization path may transfer its filtered artifacts for a later
iteration, with no acceptance, trust or publication granted. Cancellation is
rechecked before landing. Drain failures, changed read runs, changed replacement
digests/provenance and failed replacement cleanup still fail normally.

The regression uses the real runner, tools and child HTTP server with mocked
models. An npm-shaped hard-link pair reproduces `failed` before the fix and
`partial` afterward: the server is reaped, retained bytes and links stay intact,
no deep executor or root acceptance runs, and accounting remains exact. The
control without hard links still deepens normally. The Compute regression also
crosses the real TLS/WebSocket workspace channel, retains the strict checkpoint
refusal and confirms no replacement is created and the connection stays usable.

Verification used a fresh `npm ci` (audit: zero vulnerabilities), all release
static checks, and the full test suite. The first full execution passed 8,719
tests and hit three time limits: native packaging, Docker egress cleanup and
four Chromium launches. Repeating only those three files serially, without
changing timeouts or assertions, passed all 35 executed tests. The focused
runner/workspace/Compute set passed 132 tests. Recovered failures remain in
the private evidence archive; this is not a claim that the first full command
exited successfully. Production activation still requires the clean CI result.
