# Attica polling responses were sent without compression

Attica delivery `78208e3f` was explicitly accepted and deployed at commit
`5b5c7210b457bd42d10bff94a9fa371abce8de95`. Its 1,059 retained listings,
checkpoint, schedule and exports survived the update. The UI nevertheless
intermittently reported a lost control connection and disabled mutations,
then recovered automatically.

## Observations and reproduction

The application stayed ready. Eight direct loopback reads returned HTTP 200:
status took 76–160 ms and schedule 4–12 ms. The status JSON was 652,598 bytes.
No application container restart was observed. Ingress logs contained aborted
reads (499) and partial 200 bodies. Those older logs record endpoints rather
than hosts, so their aggregate counts are not an exact per-project failure rate.

The installed `/etc/nginx/conf.d/atoma-hosting.conf` was byte-identical to
`deploy/hosting.nginx.conf`, SHA-256
`c343c2e44e30dee755f31360ebc6cb534ad3dd38fd4b7b2ab9cbe73ea6c425b8`.
It did not enable compression. The hosted Node response was uncompressed, so
every polling tab transferred the full snapshot each second. The client's
existing read deadline is three seconds, including reading/parsing the body.

`tests/hosting-ingress-smoke.mjs` exercises the actual nginx template through
an isolated loopback HTTP fixture and a real nginx child. An optional
loopback-only `/api/status` URL supplies the exact production response without
writing application state. For this incident, both arms used payload SHA-256
`4571f89eabdb47c37627ce9376d368f2ef5fc77b6fcf6c58ac7864617e9c3cf5`.

At 96 KiB/s, the old template ignored a gzip request and the 652,598-byte
response exceeded the three-second deadline. The updated template negotiated
gzip, sent 99,273 bytes and completed in 1,010 ms; decompression reproduced the
exact original payload. The same harness deliberately confirms that identity
still exceeds that deadline. This reproduces a transport cause of the observed
symptom, rather than establishing the cause of every historical aborted request.

## Correction and verification

The hosting ingress enables negotiated gzip at level 5 for HTML and JSON,
with a 1,024-byte minimum and `Vary: Accept-Encoding`. Private `no-store`
responses remain eligible when a forwarding proxy supplies `Via`. Clients
without gzip or explicitly refusing it retain identity bytes. Small JSON,
event streams, partial responses and already encoded bodies remain unchanged.
The test checks each of those through real nginx, including exact decoded
bytes. It stops only its own child processes and retains its temporary logs.

Nginx owns negotiation and encoding; no new application formatter, cache,
polling loop, authentication path or token is introduced. The gateway's
membership, grants, origin checks and response-header policy remain in place.
Application source, data, execution state and container configuration are not
changed by installing the ingress. A graceful nginx reload applies the
configuration without restarting the application or Docker.

The directive semantics are documented in the
[official nginx gzip module reference](https://nginx.org/en/docs/http/ngx_http_gzip_module.html).
The transport regression is an explicit operator check requiring nginx; the
ordinary source release checks remain the repository's `release:check`.
After `npm ci`, the complete release check passed: 598 test files and 8,699
tests, with the existing four skipped files and 45 skipped tests. Type checks,
lint, audit, build and compiled release/auth/executor smokes also passed.
The documented synthetic ingress smoke passed separately (720,674 identity
bytes, 28,639 gzip bytes, 292 ms at the same limited rate).

Production installation is compare-and-set against the recorded old file,
with a verified backup, original ownership/mode, candidate checksum, `nginx -t`
and a graceful reload. Live verification must confirm the new transfer size,
the unchanged application revision and data hashes, and sustained browser use.
The configuration alone cannot prevent a physical network outage; the existing
read failure and reconnection behavior must remain observable.

## Production result

Revision `95f283c4d5b196b5296c10a181d8e993333ae968` passed CI, desktop
content checks and deployment. The compare-and-set ingress installation
completed at 2026-10-31 00:22:47 UTC: syntax check and graceful reload both
returned zero. The installed file SHA-256 is
`64544047b67c8a99289e79aaa6cc9bce59b2ca3dfdfc1ebf643eb4fd1b62c0bf`;
its original root ownership and 0644 mode were retained. The old file is
backed up at
`/var/backups/atoma-hosting-before-gzip-2026-10-31T00-22-47.521Z.conf`.

A real authenticated Chrome tab was sampled 235 times between 00:25:39 and
00:30:54 UTC. Every sample reported hosted mode and both the collection-start
and schedule-save controls enabled. Neither mutation was submitted. Municipality
filtering, numeric price sorting, typed gap filtering with focus changes and
pagination were exercised successfully. The endpoint-only ingress log over
the verification window contains 368 status responses of 99,318 wire bytes
and 368 schedule responses of 479 bytes, all HTTP 200. The log still lacks
host attribution; these counts must not be represented as a host-labelled SLI.

The final read-only health receipt confirmed the same ready deployment,
accepted run `78208e3f`, application commit `5b5c7210`, 1,059 saved/API listings,
and exact before/after hashes and full modes of all six data/checkpoint/export
files. Application code hashes also remained identical. No new run, collection,
publication, schedule change, Docker restart or application restart was needed.
Raw test failures and successes, installation and CI receipts, full sampled
states, endpoint records and a live screenshot were retained together as the
`attica-connection-fix-20261031` evidence bundle. Five minutes establishes this
verification window, not a guarantee against future physical network outages.
