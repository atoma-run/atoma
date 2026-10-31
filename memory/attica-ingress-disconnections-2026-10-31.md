# Attica intermittent hosted-control disconnections

Owner explicitly requested repair, verification and production deployment,
preserving all data and other agents' work. Completed without a new Atoma run.

- Platform fix `95f283c4`: negotiated nginx gzip for hosted HTML/JSON. Old
  polling response 652,598 bytes exceeded the existing 3 s client deadline at
  96 KiB/s; exact production response completes in 1,010 ms after compression.
  Real nginx regression fails on old config and passes on new config, with
  exact decoded bytes and compatibility checks. Full release check: 8,699
  tests passed, existing 45 skipped; CI, desktop content gate and deploy green.
- Compare-and-set ingress installation 2026-10-31 00:22:47 UTC, root:root 0644,
  verified backup, nginx syntax check and graceful reload successful. No Docker
  or app restart. Config SHA 64544047b67c8a99289e79aaa6cc9bce59b2ca3dfdfc1ebf643eb4fd1b62c0bf.
- Live Chrome: 235 healthy samples across 5m15s, no observed lost control state
  or disabled start/save controls. Filters, numeric sorting, typed input/blur
  and paging verified. No collection or schedule mutation. Endpoint-only log
  window: 368 status + 368 schedule HTTP 200 responses, no aborts, status
  99,318 wire bytes. Log has no host attribution; do not invent a host SLI.
- App stays accepted run 78208e3f-569b-4c28-945b-f1a8d2b4bdad, commit
  5b5c7210b457bd42d10bff94a9fa371abce8de95, deployment
  2d03ae1e-f82a-4aae-b077-4544745aab0b. All 1,059 listings retained;
  six data/checkpoint/export hashes and full 0600 modes identical before/after.
- Full incident and reproduction: records/incidents/attica-hosted-poll-compression-2026-10-31.md.
  Raw evidence bundle: /Users/mgtf/.codex/visualizations/2026/10/27/01a17e33-a1fb-7a62-bd3f-0b05141ffc62/attica-connection-fix-20261031.
- Other agents' local main and intentional untracked
  memory/attica-retry-evidence-followup-2026-10-30.md were untouched.
  Never inspect production process environments. No active run or new
  acceptance/publication is required for this platform transport fix.
