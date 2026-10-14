# Project hosting

Projects keep deployment optional: none, Atoma, or external. Saving this
preference never starts, stops or migrates an application. In Project settings,
an organisation administrator can explicitly deploy an accepted delivery that
has a GitHub publication receipt. Readiness checks run before it is advertised
as online. Open application admits current organisation members only.

## Supported runtime

The initial hosted runtime supports delivered static sites and Node applications
whose delivery descriptor resolves an entry. It copies retained delivery bytes,
revalidates the accepted manifest and mounts the source read-only. Dependencies
must already be present in the delivery; no install command runs on deployment.
Node applications listen on `HOST`/`PORT` and keep persistent state beneath
`ATOMA_DATA_DIR` (`/data`). Writing beside source files fails deliberately.

Applications run under gVisor, non-root, with dropped capabilities, read-only
root, CPU/memory/process limits and isolated per-deployment networks. Ingress
is a fixed relay published on loopback only. The runtime has no direct internet
route or control-plane access. Browser automation, manual CAPTCHA desktops,
custom secrets, custom domains, application cookies and external hosting
providers are not supported by this initial runtime. A delivered Docker Compose
package is not automatically converted into a hosted application.

Hosting is private to the organisation, including for a public repository.
Opening mints a one-time, thirty-second fragment claim. A host-only HttpOnly
Secure cookie lasts five idle minutes and is renewed by authorised traffic.
Membership is checked on every request, and platform logout revokes grants.
Platform credentials and app-provided cookies never cross the gateway; service
workers and document-domain relaxation are disabled. Applications cannot set
headers that weaken this policy. A stable project address does not carry a
reusable access credential. Reopen through Atoma after an idle session expires.

Stop keeps source and project data. Updates to a stateful Node application
require an explicit stop before deploying another version, so two versions
never write its data simultaneously. The UI explains the resulting maintenance
interval. Static replacement can start before the old version is removed.
Application-level data migrations and rollback are not automatic; retained
bytes are not a backup policy. Operators must include the hosting root in their
backups and monitor its disk usage. There is no automatic deletion of releases
or persistent data, and no enforced per-project disk quota yet.

## Operator installation

The product DB contains deployment receipts, state and the published commit.
The launcher owns all engine operations. Hosted objects use the separate
`dev.atoma.owner=hosting` label and survive launcher/socket/platform restarts;
ephemeral worker/preview sweeps never collect them. Startup reattaches running
containers. Interrupted candidates fail closed and require an explicit retry.

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

One wildcard A record `*.app.atoma.run` points at the hosting ingress. Project
addresses use UUIDs to avoid collisions across organisations. No DNS mutation
occurs when a project is deployed. TLS uses a wildcard certificate obtained with
DNS-01. An operator-scoped Gandi PAT belongs only in the certificate-renewal
service, never in Atoma, the product DB, a project or its runtime.

`deploy/hosting.nginx.conf` routes the dedicated namespace to the hosting
gateway. Install it only after the certificate exists. Keep HTTP redirects and
TLS policy consistent with the operator's existing ingress configuration.
Renewal must run automatically and reload nginx only after `nginx -t` passes.

The host template includes `deploy/atoma-apps-cert.service` and its daily timer
for the existing Gandi/certbot installation. Adjust paths for another host.
