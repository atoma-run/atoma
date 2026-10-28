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
