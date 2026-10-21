# Per-device Compute runtime pins — adversarial self-review

This is a self-review, not an independent review. Attica's existing immutable
image reports the newer published runtime identity; the default still names
the older one. Both image generations remain admitted. A global replacement
would fix this Mac while breaking older clients, so it was rejected before
any production mutation.

- Preserve the runtime/model integrity comparison and both admitted generations.
  Select a host-owned override for the immutable device receipt; no tenant input,
  image guess, payer switch, client update or protocol/storage change is needed.
- Reuse the existing HaystackLaunch schema. Keep the server-only map outside
  the unchanged Compute image import closure. Only the selected launch enters
  the host run process; never expose another device's configuration.
- Admission, readiness and dispatch share one selector. Invalid JSON, invalid
  raw UUID keys (including object metakeys), invalid values or a map over64KiB
  refuse Compute admission; hosted runs ignore the unused map. Unmatched
  devices retain both legacy fallback steps.
- The first regression run, after canonicalizing the Mac tempfile path, failed
  the selected-device and invalid-map cases while other-device and hosted
  controls passed. These exercise the coordinator, remote service, real
  mock-ranking process and production tool, rather than source text.
- The one-time operator artifact appends only the exact affected device's
  configuration and keeps the full original environment byte prefix. Existing
  conflicting maps, changed defaults/models, a no-longer-admitted worker,
  symlinks and concurrent changes are refused. Original bytes stay in a
  private0600 host backup; owner/mode and atomicity are preserved.
- Fifteen scratch-file checks and the production dry-run passed. No production
  config has been changed yet. A next ordinary run must still observe retrieval
  ready; generic framing does not establish that this was its only failure.
- The c6 bounded transport omission is recorded without adding a vocabulary
  selector, unbounded prompt, extra model call or automatic override. Three new
  Attica description counterexamples remain product work through ordinary runs.

Full final-source release verification and all exact-revision CI/deployment
checks remain required before the next product admission. No configuration
application or activation is claimed before its own verification.

## Final local verification

Fresh `npm ci` completed without vulnerabilities. All release static checks
passed, including both TypeScript configurations, lint, documentation, audit,
build and compiled smokes. The final full suite passed 7,843 cases and skipped
36; its only failure is the already isolated macOS Docker bind replacement
problem in `container-isolation.test.ts:86`. The test remains unchanged. Full
Linux branch CI is required before main, followed by every exact-revision
main workflow, deployment and active revision/configuration verification.
The final targeted suite passed 30 cases with two existing Docker skips.

## Observed production result

All exact-revision main workflows and deployment succeeded. At 20:37:23 UTC
the actual active release and executor were verified as `f659c3e2`; the
compiled selector preserved the legacy default and selected only this Mac
override. The next ordinary run prepared retrieval successfully in 354,531ms.
Its later partial application result is documented in the incident record;
no full application acceptance is claimed.
