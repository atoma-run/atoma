# Project hosting

Projects keep deployment optional: none, Atoma, or external. Saving this
preference never starts, stops or migrates an application. In Project settings,
an organisation administrator can explicitly deploy an accepted delivery that
has a GitHub publication receipt. Readiness checks run before it is advertised
as online. Open application admits current organisation members only.

## Supported runtime

The initial hosted runtime supports delivered static sites and Node applications
whose delivery descriptor resolves an entry. It revalidates the accepted delivery,
then copies and verifies the exact Git commit recorded by its publication receipt,
including client files preserved during publication. Later branch edits are not
deployed. The accepted runtime capability and entry must still match; a source
read or verification failure leaves the running application untouched. Original
run bytes and acceptance manifests remain unchanged. Source is mounted read-only. Dependencies
must already be present in the published source; no install command runs on deployment.
Node applications listen on `HOST`/`PORT` and keep persistent state beneath
`ATOMA_DATA_DIR` (`/data`). Writing beside source files fails deliberately.

On the Free plan, pages a browser opens carry a small "Powered by Atoma" mark
in the bottom-right corner; Pro and Team do not. Atoma adds it as it serves the page; your published code does not contain
it. Clicks pass through the mark to your application.

Applications run under gVisor, non-root, with dropped capabilities, read-only
root, CPU/memory/process limits and isolated per-deployment networks. Ingress
is a fixed relay published on loopback only. The runtime has no direct internet
route or control-plane access. The optional browser capability below adds a
private manual-verification desktop and public Internet proxy. Custom secrets,
custom domains, application cookies and external hosting providers remain unsupported. A delivered Docker Compose
package is not automatically converted into a hosted application.

Hosting is private to the organisation, including for a public repository.
Opening mints a one-time, thirty-second fragment claim. A host-only HttpOnly
Secure cookie lasts five idle minutes and is renewed by authorised traffic.
It opens the project's application, not one deployment of it, so an update
does not sign visitors out.
Membership is checked on every request, and platform logout revokes grants.
Platform credentials and app-provided cookies never cross the gateway; service
workers and document-domain relaxation are disabled. Applications cannot set
headers that weaken this policy. A stable project address does not carry a
reusable access credential. Reopen through Atoma after an idle session expires.

Atoma checks each online application every 15 seconds with a request to `/`
that may take 10 seconds. An application busy with its own work, such as a
browser collection on one CPU, can miss one: it stays online until three checks
in a row fail, and a slow answer is neither recorded nor journaled. A container
that is gone is marked unavailable at once; an application is online again at
its first good answer. While it is not online (unavailable, stopped or
starting), a visitor who opened it from Atoma gets a plain "This application is
temporarily unavailable. Please try again in a moment." page (503,
`Retry-After: 15`), API requests included, and keeps their access. Anyone else
gets the answer of an unknown address.

Stop keeps source and project data. Updating a stateful Node application stops
it before the new version starts (see [Updating an application](#updating-an-application)),
so two versions never write its data simultaneously.
Static replacement can start before the old version is removed.
Application-level data migrations and rollback are not automatic; retained
bytes are not a backup policy. Operators must include the hosting root in their
backups and monitor its disk usage. There is no automatic deletion of releases
or persistent data, and no enforced per-project disk quota yet.

## Updating an application

When a newer delivery is accepted and published, Project settings, the
conversation's run card and that run's result page offer **Update the
application** to organisation administrators; other members are told to ask
one. Versions are described by the run's title and acceptance date, with the
commit only as secondary detail. Nothing updates on acceptance, even by choice,
static sites included: updating a stateful application interrupts it while it
restarts, so it stays an explicit click behind a plain confirmation (owner
decision, 2026-10-25). The first deployment is **Put the application online**.
The confirmation names the version and the deployment it was asked against: if
another version is accepted or the deployment changes before **Confirm**, it is
withdrawn rather than confirming something else, and leaving the screen
withdraws it too. A version that did not start stays explained on its run's
card and result page after a reload, including while the earlier version is
still online beside it.

One request (`POST …/hosting/update`, same-origin, same authority as deploy)
does what Stop then Deploy did. It checks the deployment the person saw and
that the candidate is still the newest accepted version. It then prepares the
new version while the online one keeps serving: the exact published source copied and
verified after revalidating the retained delivery, networks and containers created but
not started. A preparation failure stops nothing. Only then does it stop every
runtime that may hold the data and reserve the new version; the store refuses
a start beside such a runtime, so two versions never write the data. A stop
that fails ends the request with nothing started. Static applications keep
their no-downtime replacement.

During that swap the gateway holds the project's visitors instead of answering
errors: a request that passes the usual access checks (grant, membership,
origin) waits up to 45 seconds, 64 per project and 512 overall, and is served
by the new version once it answers. A browser desktop's WebSocket reconnection
waits the same way. Past those bounds, or if the new version fails to start,
visitors get a plain "This application is being updated. Please try again in a
moment." page (503, `Retry-After: 10`), never a bare 502. Other projects are
unaffected.

After the stop only the start and readiness remain. The stop gives the
application ten seconds to exit, so a Node application without a SIGTERM
handler (which ignores it as PID 1) is down about ten seconds longer than one
that closes its server and exits: on a Docker engine without gVisor, about
11 s against under 1 s, where both took 10 s more before this change
([measurement](../records/incidents/hosted-update-outage-2026-10-25.md)).

If the new version does not start, or cannot be reserved once the old one has
stopped, the status says so and offers **Put the previous version back**
(`…/hosting/restore`): the version the update stopped, recorded on the new
deployment, redeployed through the same checks. Retention holds the online
version and that previous one, and the offer disappears when its bytes are
gone. Deploy and Stop remain available on their own.

Compatibility: a release from before 2026-10-25 (17fef5ac) reads deployment
rows strictly and refuses every field it does not know, which breaks every
hosting listing. Rows written since may carry `previousRunId`, and from
2026-10-26 `readyAt` and `replacedRunId`: one boot of that release gives every
running deployment `readyAt`. Before rolling back past 17fef5ac, remove all
three from every row
(`UPDATE project_hosted_deployments SET record = json_remove(record, '$.previousRunId', '$.readyAt', '$.replacedRunId')`).
Readers from this release on ignore fields a later release adds, including
the two facts of 2026-10-26: when a deployment first served (`readyAt`) and
which version was serving when it was asked for (`replacedRunId`). The project
conversation tells each deployment from them, and from nothing else: a version
that never served is never "no longer online". Browser tabs opened before an
update of Atoma need a reload to offer these actions.

Rejected: sequencing Stop then Deploy in the browser (a lost second request, or
another administrator's deploy in between, left the site down or raced it); a
put-back target chosen by the client (the host records what it stopped);
updating automatically on acceptance, which would stop a customer's site
without a click; and blue-green for a stateful application, which would run two
writers of its data, two schedulers and two browsers on one Chromium profile.

## Operator installation

The product DB contains deployment receipts, state and the published commit.
The launcher owns all engine operations. Hosted objects use the separate
`dev.atoma.owner=hosting` label and survive launcher/socket/platform restarts;
ephemeral worker/preview sweeps never collect them. Startup reattaches running
containers. Interrupted candidates fail closed and require an explicit retry.
A web restart between an update's preparation and its reservation leaves that
version's created, never-started objects without a deployment row. The next
web start lists the launcher's hosting objects by their identity labels and
stops every deployment no running row names, networks included; its release
directory stays, like a stopped deployment's. A launcher older than that
listing, or an engine error, leaves them for the following start. Objects
created before 2026-10-25 carry no identity labels and are never listed.
The hosting launcher restarts itself on the active release: when `current`
points elsewhere and no request is open, it exits with status 75 and
`Restart=on-failure` starts the new code. Hosted applications keep serving
meanwhile. The web keeps retrying its hosting start every ten seconds, and a
health check that cannot reach the launcher leaves the application's state
unchanged.

Build the fixed image with `npm run build:hosting`. Configure an immutable
image digest or engine content ID, never the mutable build tag. The relay uses
an immutable packaged worker image. The fixed `static.mjs` is included in the
hosting image; no control-plane code enters that image.

For a host installation, use `deploy/atoma-hosting-launcher.service` and a private
`/home/atoma/config/hosting.env`:

```
ATOMA_HOSTING_SOCKET=/home/atoma/hosting-control/launcher.sock
ATOMA_HOSTING_ROOT=/home/atoma/hosting
ATOMA_HOSTING_IMAGE=<immutable hosting image>
ATOMA_HOSTING_RELAY_IMAGE=<immutable worker image>
```

Pre-create the two hosting directories for the service identity, with the
control directory private. The control plane must see the same source
projection. The hosting-only launcher refuses worker and preview operations.
An integrated launcher can instead expose the same operations on its existing
socket when `ATOMA_HOSTING_ROOT` and `ATOMA_HOSTING_IMAGE` are configured.

The web environment selects:

```
ATOMA_HOSTING_ENABLED=1
ATOMA_HOSTING_DOMAIN=app.atoma.run
ATOMA_HOSTING_SOCKET=/home/atoma/hosting-control/launcher.sock
ATOMA_HOSTING_PORT=4411
ATOMA_HOSTING_MAX=2
```

The gateway binds only `127.0.0.1`. `ATOMA_HOSTING_MAX` is the global count of
starting/ready deployments, checked transactionally before allocation; a
candidate consumes a slot while its predecessor is still running. Hosting does
not consume an LLM run slot. Disabled or unavailable hosting leaves the saved
project preference intact and reports its unavailability.

## DNS and HTTPS

One wildcard A record `*.app.atoma.run` points at the hosting ingress. No DNS
mutation occurs when a project is deployed.

A project's address is `<label>.app.atoma.run`. The label is chosen once, when
the destination is first saved as Atoma (or at the first deployment of a
project saved earlier), and stored on the project.
The host's `api:` tier-1 model proposes candidates from the project's name and
brief, on the platform's credential like run titles, and its receipt is kept.
Only one to three words of `a-z` joined by single hyphens are accepted, and
reserved platform words are refused. Labels are unique across every
organisation: the first free candidate wins, then the project's slug and name,
then the slug's first words plus a random word. A model outage never blocks a
deployment. A project deployed before labels existed keeps `p-<project UUID>`
until it receives one, then moves to it; reopen it from Atoma.

An organisation administrator can change the address in Project settings. The
previous address then answers with a permanent redirect (308, path and query
kept) to the project's current address, for good: a retired label is never
assigned again, to that project or any other, because browsers cache permanent
redirects without expiry. Renaming twice still redirects in one hop. The
database refuses any rename that would drop a redirect.

Readable labels are guessable, so the gateway answers an unknown address and a
private one identically: the address does not reveal whether a project exists.
A retired address is the exception by design: its redirect reveals that it
existed and names the current address, never the application behind it. TLS uses a wildcard certificate obtained with
DNS-01. An operator-scoped Gandi PAT belongs only in the certificate-renewal
service, never in Atoma, the product DB, a project or its runtime.

`deploy/hosting.nginx.conf` routes the dedicated namespace to the hosting
gateway. Install it only after the certificate exists. Keep HTTP redirects and
TLS policy consistent with the operator's existing ingress configuration.
Renewal must run automatically and reload nginx only after `nginx -t` passes.

The host template includes `deploy/atoma-apps-cert.service` and its daily timer
for the existing Gandi/certbot installation. Adjust paths for another host.
Install `deploy/atoma-hosting-order.conf` as an `atoma.service.d` drop-in when
hosting is enabled. The launcher's readiness command waits for its socket before
the web service starts, including after a host reboot. Hosted containers are
not tied to either service's lifetime.

## Hosted browser capability

A delivery opts in with a declared `atoma.hosting.json`:

```json
{"version":1,"runtime":"node-browser","entry":"browser/control-server.js"}
```

Both the descriptor and entry must be in the accepted, published artifact
manifest. The descriptor is bounded and hash-checked; it does not accept engine
commands, images, mounts or environment overrides. Ordinary Node/static hosting
remains unchanged. The host must configure `ATOMA_HOSTING_BROWSER_IMAGE` with an
immutable digest built from `docker/hosting-browser.Dockerfile`.

The fixed runtime owns headed Chromium, its persistent `/data/browser-profile`,
and the remote desktop. The application listens on supplied `HOST`/`PORT`, writes
checkpoints and exports beneath `ATOMA_DATA_DIR`, and connects to the existing
browser via `ATOMA_BROWSER_URL` (Playwright `connectOverCDP`, existing context).
The browser image supplies pinned Playwright through `NODE_PATH` for CommonJS
applications; no dependency installation runs when a deployment starts.
It must not launch or close that browser. `ATOMA_BROWSER_DESKTOP_URL` is the
same-origin desktop link; open it in a separate tab. The application owns its
pause/checkpoint/recheck state and user-facing explanation. Manual verification
never implies success: recheck before resuming, preserving progress on failure.
No CAPTCHA-solving service or automatic CAPTCHA interaction is provided.

The desktop HTTP and WebSocket routes require the same short-lived private
application grant, exact upgrade origin and current organisation membership.
Established sockets recheck access every second; expiry, logout, membership
removal, stop or deployment replacement closes them. Application status polling
keeps the HTTP grant cookie alive; after expiry reopen from Atoma. During an
update, a reconnecting desktop waits for the new version. CDP and VNC
ports are never published. Nginx must forward WebSocket upgrades (see the supplied
hosting configuration). Browser output and input are available to authorised
project users; use this session only for project work.

Browser deployments remain non-root, read-only and gVisor-isolated, with 1536 MiB
RAM, 1 CPU and 256 PIDs. A per-deployment egress proxy uses the host-owned public
Internet policy (all TCP ports), resolves and pins public addresses, and rejects private/loopback/link-local
network targets. No direct uplink reaches the application. The profile and data
survive application and platform restarts; an update stops the previous Node
deployment before the new one starts. The Linux smoke script exercises a synthetic manual
checkpoint, desktop WebSocket, persisted profile/data and network isolation.
A real third-party CAPTCHA still requires client verification after deployment.

Operator validation: `scripts/hosting-container-smoke.mjs` runs on Linux with
gVisor, after `npm run build`, with `ATOMA_HOSTING_IMAGE` and
`ATOMA_HOSTING_RELAY_IMAGE`. It creates a deployment's objects, starts those
same objects at their pinned addresses, prepares a second version while the
first serves, swaps them with the data kept, and leaves nothing listed. Do not
run it while the web service restarts: its boot sweep removes unrecorded objects.
`scripts/hosting-browser-smoke.mjs` runs on Linux with the
three immutable hosting image variables; it creates and removes its own fixture
containers and data. `ATOMA_BROWSER_SMOKE_HOLD=1` leaves that fixture available
for three minutes for `scripts/hosting-browser-ui-smoke.mjs <forwarded-relay-port>`
on a development machine. The latter creates a temporary self-signed HTTPS gate,
opens it in Chrome, verifies an actual rendered desktop, then revokes access.
