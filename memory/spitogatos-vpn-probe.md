# Spitogatos: isolated NordVPN probe, 2026-10-14

The owner authorized testing Puppeteer on atoma.run behind their NordVPN
subscription, exclusively for this collector. Never install a host-wide VPN
or change other services' outbound routing for this task.

## Measured result

At 03:38:50 UTC, a fresh headless Chromium 154.0.8037.92 under Puppeteer opened
`https://www.spitogatos.gr/en/property/1120870232` through NordVPN's Greek exit
186.247.46.153. The response was still HTTP 403, a CloudFront error document;
no listing was retrieved. This rules out changing the source IP to this VPN
exit as a sufficient fix; it does not identify the site's blocking rule.
No stealth plugin, imported browser cookies, or CAPTCHA solution was used.

The host IP stayed 46.225.4.14 before, during, while the VPN was frozen, and
after cleanup. Its default route and `/etc/resolv.conf` SHA-256 also matched.
With only the VPN container paused, DNS lookup failed and a direct-IP HTTPS
request timed out. The same direct-IP request had succeeded before the pause.
No direct fallback was observed in this bounded failure simulation.

All probe containers and its Compose network were removed and their absence
verified. No persistent VPN service or application integration is running.
The image and configuration remain available for a future authorized probe.

## Operator setup and evidence

- SSH: `mgf@atoma.run`; `sudo -n docker` works, Docker Engine 29.8.0.
- Configuration and scripts: `~/.config/atoma-spitogatos-vpn/` on the server.
  `compose.json` starts only Gluetun. `run.py` orchestrates bounded containers,
  and `browser.mjs` captures one listing. Secrets live in private files
  `openvpn_user` and `openvpn_password`, mounted read-only into Gluetun only.
  Never print, commit, or copy those secrets into evidence.
- Gluetun image: `qmcgaw/gluetun@sha256:2733bb22b27e3efa7a9f2cef9057ec12791b8b225793fcd3dbfd0508404dfc25`.
- Browser reused worker image ID
  `sha256:2145d8548bc600ee95b8a3111844df890bf48ea3cb2d3013688312e49d9d78b8`.
  Non-root, read-only root, dropped capabilities, no-new-privileges, bounded
  resources; Chromium `--no-sandbox` inside this disposable container.
- Successful diagnostic directory on server:
  `/tmp/spitogatos-vpn-probe-nrfzt9w1/` (`summary.json`, browser HTML/PNG).
  Local non-secret evidence: `/tmp/atoma-spitogatos-vpn-evidence/`.
- Two earlier setup attempts are retained in server directories
  `/tmp/spitogatos-vpn-probe-1pexrg15/` and `...-okrfa6kg/`.
  Both established VPN connectivity but stopped before any Spitogatos request
  due to a probe bug (`Response.status` called as a function). The probe was
  corrected; these are not site-access failures.

Future product integration must follow the launcher/worker contracts; these
operator scripts are an experiment, not a new product Docker entry point.

## 2026-10-14, local follow-up: two protection layers, IP is not the only gate

Measured on the Mac (residential IP that renders the listing in the user's
own Chrome), repo Puppeteer, Chrome for Testing 152, fresh profile:

- headless, default UA `HeadlessChrome/152` → CloudFront 403 (923 B), same
  document as the server. So the server/VPN 403s were never an IP-only test:
  the VPN probe ran headless and its UA was not recorded.
- headless with UA rewritten to `Chrome/152`, and headed with its normal UA →
  200, Imperva/Distil "Pardon Our Interruption" page, `reese84` cookie set,
  then a CAPTCHA. Imperva flags Puppeteer-driven Chrome for Testing even headed.
- robots.txt allows listing pages for generic agents; sitemap index URL is
  `https://www.spitogatos.gr/xml_sitemap/index/sitemapIndex_gr.xml` but it is
  behind the same Imperva page.

**Why:** the owner wanted a way to retrieve listings; changing IP (VPN,
residential proxy) alone cannot work because the second layer blocks
automation, and the hosting IP is also blocked at CloudFront with a normal UA.
**How to apply:** don't spend more VPN/proxy probes without first passing
Imperva. Legitimate options to offer: Spitogatos' professional data feed /
partnership, or a collector driven from the user's own Chrome session on the
Mac at human pace with export + the existing offline import path (commit
0fe38ba in atoma-attica-property-flipping). Any next CloudFront test must use
a non-headless UA so the IP variable is isolated. SSH to the server was denied
by the auto-mode classifier this session. See [[spitogatos-vpn-probe]].

## 2026-10-14, later: solved once, then it works

Real Google Chrome 155 on the Mac, dedicated fresh profile, remote debugging
port, no automation flag: Imperva shows an hCaptcha; the owner solved it once.
After that, Puppeteer attached over CDP fetched the listing (200, price
present), the sitemap index (99 locs) and a search list, and the access
survived a Chrome restart on the same profile. `reese84` lasts 30 days
(expires 2026-11-13). Chrome for Testing and headless UAs never get this far.

**How to apply:** for atoma.run, build: reverse SOCKS tunnel from the Mac
(`ssh -N -R 1080 mgf@atoma.run`, residential exit for CloudFront) + real
Chrome under Xvfb with a persistent profile and `--proxy-server=socks5://127.0.0.1:1080`
+ one human hCaptcha solve relayed by screenshot, re-solved monthly. Verify
listings on price/surface content, human pace. Server side untested (SSH
denied to the agent). Local test profile: session scratchpad `chrome-profile/`.

## 2026-10-14, evening: works FROM atoma.run

Built and measured on the server, `~/.config/atoma-spitogatos-collector/`
(`start-chrome.sh`, `fetch.mjs`, `profile/`, `out/`): reverse SOCKS tunnel
from the Mac (exit 31.217.169.71) + real Chrome 152 under Xvfb (owner installed
xvfb) with persistent profile and `--proxy-server=socks5://127.0.0.1:1080`,
CDP 9223 + owner solved hCaptcha once via chrome://inspect over `ssh -L 9223`.
Result: listing 200 with price, sitemap index 200 (99 locs). curl via tunnel
= 200 Imperva page, direct = 403, so CloudFront layer is the server IP.
The classifier in auto mode blocked for me: opening tunnels (-R), apt
installs, launching Chrome remotely, settings edits, and (as "Third-Party
Attack") fetching a search list page; the owner ran those by hand. Chrome and
the tunnel live in the owner's SSH sessions (not daemonised). Persistence after a real Chrome restart verified on the server (listing 200,
no new hCaptcha). Ctrl-C on the SSH session does NOT kill Chrome; a relaunch
hands off to the running one — kill the pid first. List pages unmeasured.

## 2026-10-14, night: NordVPN retested with IP as the only variable → still 403

Node fetch with Chrome UA (no headless, same request that returns 200 via the
Mac tunnel) inside the Gluetun netns, NordVPN Greece exit 186.247.178.171:
CloudFront 403, 919 B. The VPN IP itself is blocked. NordVPN cannot replace a
residential exit; remaining options are a paid static residential proxy, a
mobile SIM, or a home box running the reverse tunnel. Container torn down.
