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

Production activation completed: source `e407d518` passed CI `38605384578`
and deployment `38606462452`. Startup ordering `31a7b99b` then passed CI
`38605995345` and deployment `38607560833`; the host's current symlink now
points to that exact release. Hosting was enabled under deploy-preflight's
held admission/run lease. Both `atoma` and `atoma-hosting-launcher` are active;
public Atoma returns HTTPS 200 and an unknown application host returns the
private gateway's 404 (not nginx 502). The later platform release preserved
the active hosting gateway. The service drop-in orders the socket-ready
launcher before web startup; config lives in `/home/atoma/config/hosting.env`
and the five `ATOMA_HOSTING_*` web settings. Capacity is initially two.

A real signed-in Chrome session verified Attica's Project settings exposes
Hosted application and deploy/open/stop controls. No hosted deployment was
started for Attica: its accepted/published run `0daa2132` is retained but has no
eligible web deployment candidate in the current descriptor. Its existing
portable Docker/browser package still needs hosted browser/CAPTCHA support.
No customer run was started, no local pilot data or browser session was moved.

## Hosted browser / manual verification implementation (2026-10-14)

Owner explicitly requested the hosted browser and CAPTCHA journey. Browser
capability is declared in accepted/published `atoma.hosting.json` (version 1,
node-browser, relative Node entry), not inferred from site names. Fixed host
image owns Chromium/Xvfb/noVNC and the persistent /data/browser-profile. Apps
connect to ATOMA_BROWSER_URL and link ATOMA_BROWSER_DESKTOP_URL, keep checkpoints
under ATOMA_DATA_DIR, and recheck after human verification. No automatic CAPTCHA
solver. Public-only egress uses the existing wildcard proxy (all public TCP
ports, private/loopback/link-local denied); app stays on the isolated bridge.
Desktop HTTP/WS use the hosted grant; WS checks origin and revalidates membership,
claim and deployment every second. Explicit stale Chromium singleton cleanup is
safe only because the deployment store enforces one project data writer.

Validation: release:check passed (6,541 tests / 10 skipped); 17 focused tests;
real Linux gVisor runtime passed headed desktop/WS, private-network refusal,
public HTTPS, synthetic checkpoint and profile/data across container recreation.
Real Chrome passed HTTPS claim, rendered noVNC canvas and logout disconnection.
The first restart test caught a stale profile singleton referring to the previous
container hostname; fixed without clearing the profile. Test fixtures are not
real CAPTCHA proof. Runtime image built on host:
sha256:08b2ed6df051b28328cce45668578e9e41f13962d2fb560cae7eb67fb8ea60f5.

Attica adaptation runs through Atoma, not direct collector edits:
bec269a3-18c4-477b-8e55-3512e0ef17f6, accepted seed 0daa2132, idempotency
attica-hosted-browser-captcha-20261014-v1. Started with explicit owner scope;
MCP start exceeded its 300s client wait, but the run continued. Follow status,
never start a duplicate. As of this note it is still repairing validation gaps;
no new client acceptance, publication or Attica deployment claimed. Existing local
pilot, its profile and 68 offers remain untouched. Platform rollout follows CI
and the normal live-run drain gate; browser image and nginx WS config must be
activated on the host after the platform release is live.

Guided desktop follow-up: the application-provided desktop URL now opens a small
verification page with instructions, reconnect state and Back to application,
using noVNC's RFB module without exposing its technical toolbar. Real Chrome
rendered the headed browser and verified logout disconnect through the private
HTTPS gateway. Final guided runtime image:
sha256:4aad7be141ab93a14ba96558abd0bd62cc6134306921e13529e1fca20ba14700.
The platform implementation commit 247e55e1 passed CI 38612498763; deployment
38613620283 is waiting at the normal activation stage while Attica runs.

Desktop copy is now rendered at image-build time from the canonical en.json
product catalog (only the hostedBrowser.* slice enters the runtime). No target
locale was hand-authored. Final image including this build contract:
sha256:037aae04e48bc9ca9c65a15a821265d0f9748a59f57aff62af5641c993fee103.
Full viz:smoke passed, including MCP OAuth and real GPU client checks. The
browser UI smoke additionally exercises Back to application before reconnecting
and revoking the grant. Root/progress validation of Attica is still in flight;
its old 1/3 criterion snapshot is not a final delivery verdict.

Production activation: source 6ff6d144 passed CI and deployed. The browser image
and nginx WebSocket configuration were activated under the deployment drain
guard; all services and the private gateway passed health checks.
Attica bec269a3 finished partial: its three functional criteria passed, but its
guide exposed the internal CDP endpoint. Follow-up 30e53f08-120b-4526-a90a-8f03c178065c
delivered with both criteria met; only README.browser.md changed (100 files
unchanged). Manifest a7b8f4cf41837b9dd51f3ee1bc6ccfc2d59e0bd1c34bffd9a0f1b0f15d2ed53d
awaits client acceptance. No new Attica publication/deployment is claimed.
A proposed global validator clarification was blocked by automatic approval
review as broader than the integration and reverted; it is not in this release.

Packaging review caught a missing app dependency. The runtime now supplies
locked Playwright 1.55.1 through NODE_PATH, without npm installation at startup.
The Linux gVisor smoke attaches via Playwright from the app before testing
desktop, restart persistence and network isolation; all passed with image
sha256:bc60dc463b22155cdbdc444bc446ab23152afc9f24545b24077e2e1d703b5867.
This newer image still requires activation after packaging release checks.
