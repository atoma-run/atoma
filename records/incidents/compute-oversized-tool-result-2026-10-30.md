# Oversized Compute tool results reported as connection loss

Observed during Attica runs `6fe2d326-2c0a-404b-92a9-1cba07b2a421`
and `3a81397b-90dc-4f40-96ef-85b68cfa237c` on the installed Compute
0.5.224 client. Failed test diffs exceeded the 1 MiB application-frame
budget. The command had executed, but `computeClient.send` threw
`Compute transport unavailable` before sending its result. The error reply
fit; a subsequent command succeeded on the same connection. This lost the
full returned result and mislabeled a payload refusal as an outage.

A real TLS/WSS regression reproduced that sequence without a model or Docker.
An independent full Attica check produced a 7,407,340-byte failure log. A
later successful bounded command could capture the saved file, but this does
not recover the first invocation's output after the file was overwritten.
Historical missing evidence remains unknown.

## Change and adversarial review

Small success/error frames retain their existing wire shape. Large success
results use the existing complete gzip/Base64 evidence archive (byte count
and SHA-256), including command exit, Unicode, nested archives and log tail.
Decoded bytes have the existing worker response limit, `WORKER_FRAME_BYTES`
(32 MiB). The complete outer frame must still fit 1 MiB. Results that exceed
either bound fail explicitly with a size error; this is not an unbounded
transfer mechanism and does not repair upstream output truncation.

The server checks session, pending request, execution generation and current
authority before inflating. It checks decoded length, hash, exact UTF-8 and
envelope before removing that pending request. Corruption fences the pending
effect rather than leaving an unresolvable promise. No command is replayed.
The gzip output limit prevents a declared-small decompression bomb; the schema
rejects oversized declared lengths before allocation. Frame bounds, lease,
admission, image pins and transport queues remain unchanged.

Rejected shortcuts: raising the global WSS limit for every channel, cutting
the result to fit, treating a command's nonzero exit as a transport error,
and clearing the pending request before archive verification. Multipart
streaming was not needed for the demonstrated compressible test logs; an
incompressible oversized result remains an explicit refusal.

## Verification and rollout

The real gateway/client WSS regression retains the complete failed result and
then executes one small command on the same live connection. Negative WSS
cases cover hash/length/inflate-budget corruption, wrong id/generation and
revocation. Unit cases cover unchanged legacy replies, frame bounds, raw and
compressed size refusal, malformed UTF-8 and envelope shape. A compiled child
client remains covered by the existing WSS migration suite.

Roll out the server before distributing the updated desktop/CLI client.
Older clients remain readable by the new server. An older server refuses the
new archive reply; no handshake flag or implicit downgrade is introduced.
Deploying the server alone does not fix an installed 0.5.224 client. This
change does not require a worker image replacement.

Local verification: clean `npm ci`, both TypeScript configurations and all
static release smokes passed. The focused WSS/codec suite passed 96 tests
with four existing optional skips. The full suite passed 8,653 tests but
failed six files (seven test failures, four suite setup failures, 64 skips):
Docker refused writes to containerd metadata and volume/network creation
with a read-only filesystem; gateway startup and archive-copy tests timed
out under the concurrent load. The earlier static attempt encountered host
ENOSPC and retained its failure log. These failures are not a passing release.
The two timeout files passed when replayed alone (three tests, unchanged
deadlines/assertions). Fresh branch CI and Docker retests must be green
before production.
