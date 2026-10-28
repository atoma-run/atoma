# Explicit Compute validation retries — 2026-10-28

The owner requested an MCP command to retry a terminal automatic Compute
validation. `ff8f34a1` added `atoma_compute_validation_retry`, durable
principal-scoped idempotency receipts, saved prior job metadata, separate
attempt directories and claim/completion fencing. It requires the retained
initial capture and uses the existing assayer budgets, idle gate and exclusive
lease. Both MCP generations and the compiled CLI were exercised without paid
model calls. Local release verification passed 8,534 tests, and CI, CodeQL
and the desktop content workflow passed.

## Production deployment exposed stale executor receipts

Deployment [40746266297](https://github.com/atoma-run/atoma/actions/runs/40746266297)
entered compatibility maintenance at 18:34:09 UTC. After stopping the idle
selected executor, the activator waited for another generation's leftover
socket/receipt to answer health. That owner no longer existed, so it could
never answer. The MCP stayed reachable but reported `assayer: null`.

Read-only checks established that the only lease was `deployment:178650`, with
no child process group. Both receipt owners were gone under the existing
`recordedProcessLive` birth-identity policy:

- `50ff44fd`, PID 161423, receipt SHA-256
  `6f973fc843489f51dbc316f50e5b5d65d4222f0485d5735d52dee0cd09ff055d`.
- `e4f55aac`, PID 3578954, receipt SHA-256
  `473081f514cf93a6fdcdad8668730786c7fd976b7ad83a1fcb921ae0a21c801a`.

Their exact receipts and dead sockets were moved, with a verified manifest,
to `/home/atoma/state/supervisor/deployment-receipts/ff8f34a1-stale-CO9qe7`.
No service or run was manually stopped/restarted. The existing activator
continued and confirmed `deployed ff8f34a1` at 18:42:17 UTC. The next compatible
UI release then activated normally.

The permanent correction skips a receipt only when its recorded owner is
proven gone, preserving the receipt and avoiding a service stop based on stale
metadata. Live, malformed and unverifiable identities still wait/refuse. The
regression executes the actual maintenance Bash block and its Node probe;
existing tests retain the requirement for idle proof before stopping a live unit.
The root-owned activator must be reinstalled separately from an immutable release.

## Production discovery exposed an SDK error-schema mismatch

The authenticated production catalogue exposed all three inputs and the
idempotent write annotation. A quota-free unknown-source probe then raised
`Structured content does not match the tool's output schema`: the 2025 SDK
validates structured errors too, once `tools/list` has cached the schema.
The source tests had exercised refusals before discovery, while the schema
catalogue tests only exercised successful receipts.

Discovery now precedes refusal and idempotence tests in both protocol eras.
The regression reproduced the production failure before the fix. The new tool's
output schema now declares the union of the canonical attempt receipt and the
existing typed service problem, both JSON objects. Success fields are unchanged;
no error is reclassified as a successful receipt. All 110 targeted MCP/deployment
tests passed. No Attica validation was started by these implementation checks.

Follow-up local release verification passed `npm run release:check`: 8,542 tests,
43 skipped, both TypeScript configurations, lint, audit, docs/build and compiled
release smokes. The dependencies came from the same lockfile's successful
`npm ci`; no dependency or model quota changed.

## Verified production follow-up

Revision `9b53b99e333222573a5c9a22ec670470f193d0af` passed
[CI 40748979599](https://github.com/atoma-run/atoma/actions/runs/40748979599)
and [CodeQL 40748978503](https://github.com/atoma-run/atoma/actions/runs/40748978503).
[Deployment 40749941116](https://github.com/atoma-run/atoma/actions/runs/40749941116)
completed successfully. The authenticated Atoma MCP reported that exact selected
executor release with no in-flight assay or last error.

A fresh 2025 SDK client authenticated through the configured Atoma headers helper,
discovered the public catalogue (64 tools), and confirmed the retry input names
and idempotent write annotation. Its unknown-source call then returned the actual
structured `not_found` refusal with `isError: true` and a readable 404 message,
after cached output-schema validation. It created no validation or paid run.

The root-owned activator was installed atomically under `/home/atoma/.deployment.lock`
from that immutable release, after checking both source and copied bytes against
SHA-256 `34255eb10598352cd319c216ea86ee76d8a3ee9636b9c19e262c83b61ce36b44`.
Its previous hash exactly matched the old published source, so no local customization
was replaced. The previous bytes remain at
`/var/backups/atoma-deploy/atoma-deploy-f819882f4c819ec1afb2531b5423a1dc8b88c46d6a61aff2d07b0cfb9bfab50c`.
Ownership/mode are root:root 0755; no service was manually restarted for installation.

The [Compute desktop workflow 40748979652](https://github.com/atoma-run/atoma/actions/runs/40748979652)
also passed all three native jobs (Windows x64, macOS Intel and ARM), verified
every installer/update asset and published
[compute-desktop-preview-9b53b99e3332](https://github.com/atoma-run/atoma/releases/tag/compute-desktop-preview-9b53b99e3332).
