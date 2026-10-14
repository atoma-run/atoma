# Project deployment direction — 2026-10-14

Owner decision: project creation -> runs -> preview -> explicit client acceptance
and GitHub publication -> optional deployment. Deployment is a mutable setting
on the project: none (default), Atoma, or external. A project can be complete
without deployment, including documents, analyses and scripts.

Remove the recent local Docker onboarding from the platform and model prompts.
Do not infer local execution from CAPTCHA or require Docker Desktop by default.
Do not delete immutable deliveries, the Attica pilot/browser profile, or its 68
collected offers. Spitogatos stays paused; xe.gr remains the product priority.

Saving a destination is configuration only: no deploy, migration, stop or update.
Future deployment actions must name an accepted/published version; transitions
must preserve the current deployment until the replacement is ready. Preview
remains temporary, not production hosting. Persistent runtime, browser/manual
verification, data retention and external hosting connections remain to build.

Implemented in this iteration: persisted org-scoped preference, admin-only
same-origin update with stale-write protection, project settings in GPU and
accessible UI, honest availability copy. No hosting executor is claimed.

Attica project context revision 8 records this superseding owner decision,
including manual CAPTCHA handling without prescribing a local customer runtime.

Validation: 515 focused tests across project storage/service, permissions, UI,
preview, assistant, rendering and event contracts; typecheck, lint and docs
checks passed. Build and MCP OAuth browser smoke passed. The complete GPU
smoke passed after the new scenario used the intended viewport and restored
the conversation before continuing the upstream-setting scenario. Focused
Chrome journeys passed at 1600px and 900px with explicit save and re-entry.

First CI attempt: 6,509 tests passed; the French parity check still saw the
removed installation keys because tests and translation run independently on
the original revision. The translation job removed the obsolete keys in
`bb841255`; the two locale/build-contract suites then passed all 20 tests.
The other failure was npm audit ECONNRESET, not an advisory; a fresh audit
returned zero vulnerabilities. Ship from the synchronized catalog revision.

Release `1f7664b2` passed CI `38596917871` (6,510 tests passed, 23 skipped)
and production deployment `38597966959`. A fresh production MCP project read
confirmed Attica exposes `deploymentDestination: none`; its existing runs and
repository are retained. The hosting executor remains unimplemented, as the
settings screen states.

## Hosted runtime implementation — 2026-10-14

The `codex/project-hosting` change adds explicit deploy/open/stop operations in
Project settings, separate from the destination preference. Deployment requires
accepted, published, retained bytes; a private org-scoped gateway serves stable
`p-<project UUID>.app.atoma.run` addresses. A separate hosting launcher owns
persistent gVisor containers and data, outside ephemeral preview cleanup.
Static and Node entries are supported initially. Node state belongs in
`ATOMA_DATA_DIR`; stop preserves it. Node updates currently require stop first.
Browser desktops, external egress and CAPTCHA collection are still unsupported:
do not claim this deploys the complete Attica collector yet.

The operator confirmed SSH `mgf@atoma.run`. Existing preview TLS already uses
Gandi via root-only `/etc/letsencrypt-preview/gandi.ini` and the
`/home/atoma/certbot-preview` environment. Reused this mechanism without copying
or displaying its credential. Created wildcard A `*.app.atoma.run` ->
46.225.4.14 and certificate `atoma-apps` (expires 2027-01-12). Installed a separate
`atoma-apps-cert.timer` because the existing preview renewal pins its own cert.
Nginx routes the namespace to loopback 4411. No per-project DNS writes are needed.

Immutable hosting image built on the host:
`sha256:7057759bffc9589424cf18f999975e3abbbee9d2d77d7a3c36ab1a1df8ec8dcc`.
Real gVisor smoke proved HTTP, state retention across stop/start, and denial of
host-control-plane and external network access. Product activation and release
are recorded separately once verified; infrastructure setup alone is not a
successful product deployment. Preserve the local Attica pilot and its data.

Verification before publication: fresh `npm ci`, full `release:check` passed
(6,537 tests, 10 skipped), full GPU browser smoke passed, explicit deployment
journey captured at 1600x900 and 900x700. Final server container smoke also
served a static site after the Node retention/isolation checks. Regression
coverage includes real launcher process/socket connections, stale deployment
requests, org permissions, acceptance/publication checks, gateway claims and
CSRF, failed predecessor cleanup, and stop versus health-check races.
