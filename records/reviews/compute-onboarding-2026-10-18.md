# Compute onboarding and hosted admission review — 2026-10-18

Owner decision: customers connect a computer before running their projects;
only platform administrators may execute project runs on Atoma servers.
Permanent application hosting is unchanged.

Adversarial review of the accepted mechanism:

- Hiding the hosted radio alone would leave HTTP/MCP/CLI starts open. Admission
  checks the coordinator's current authority resolver, never a request boolean.
  Production HTTP and CLI construction both supply the AuthStore resolver.
  The ungated local operator retains its existing identity-free path.
- Legacy hosted project rows remain readable. No device is selected implicitly;
  explicit project grants and target compare-and-set remain mandatory.
- Continuation uses the source run target, not a newly edited project target.
  Changing the project cannot turn a hosted checkpoint into remote execution.
- Idempotent reattachment remains a read. Fresh admission, queued dispatch,
  asynchronous preparation and the final driver call recheck hosted authority.
  Authority lookup failure refuses hosted work. Device work uses its existing
  device/org/project checks independently of the platform-admin flag.
- The device target mutation checks the persisted admin flag. Owner/admin roles
  within an organisation do not grant hosted execution. Both GPU and keyboard
  settings hide that option when the server does not authorize it.
- Onboarding inventory is session/org scoped and contains only names, ids and
  connection booleans. No credential or pairing secret is returned. Revoked
  devices do not count as connected setup. Errors remain actionable.
- Browser polling has a separate per-identity budget from native pairing, so
  onboarding refreshes cannot consume the client redemption allowance.
- Installation links pin the CI artifact and checksum. The page escapes all
  content, offers only fixed architecture images, validates the configured
  server origin before showing commands, and retains its restrictive CSP.
  Node/Docker installation remains an explicit user step.

Evidence: targeted device, HTTP, project UI and coordinator tests, plus onboarding
component tests and the compiled TLS browser smoke. Full release verification and
production deployment results are recorded in the task's durable memory.
