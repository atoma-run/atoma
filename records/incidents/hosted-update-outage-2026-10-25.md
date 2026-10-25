# A hosted update's outage, before and after preparing first — 2026-10-25

Owner decision of 2026-10-25: an update stays an explicit click, prepares
everything before it stops the online version, and holds visitors during the
swap. This records what the outage was and is, measured through `DockerHosting`
itself ([script](hosted-update-outage-2026-10-25/outage.mts)).

## Method

Docker 29.8.2 on Docker Desktop (macOS, Apple silicon), runc: the script drops
`--runtime runsc`, so gVisor's container start is NOT included. The application
is a one-line Node HTTP server, the relay the real `previewIngress.js` from
`atoma-worker:latest`. Three rounds per arm, medians below; rounds agreed
within 50 ms.

- Before: stop relay then application with ten seconds' grace each, then a
  full creation and start, readiness polled every second.
- After: `createHosting` before the stop (not counted: the online version still
  serves), stop the application with ten seconds' grace and the relay with
  none, start the created objects, readiness polled every 250 ms.

## Results (ms)

| Application | Arm | Stop | Start | Readiness | Outage |
|---|---|---|---|---|---|
| ignores SIGTERM (no handler, PID 1) | before | 20,617 | 521 | 6 | 21,149 |
| ignores SIGTERM | after | 10,599 | 305 | 6 | 10,911 |
| exits on SIGTERM (`--sigterm`) | before | 10,588 | 530 | 6 | 11,127 |
| exits on SIGTERM | after | 509 | 311 | 7 | 825 |

Creating the objects before the stop took 245 ms. Copying and revalidating the
delivery also moved before the stop; this one-file delivery makes it negligible.

## Reading

The remaining ten seconds for an ordinary Node application are its own stop
grace: as PID 1 without a handler it ignores SIGTERM and is killed when the
grace ends. `docker create --init` would forward SIGTERM to a child that dies
on it at once; it was not adopted because it is unverified under gVisor
(`scripts/hosting-container-smoke.mjs` on the host is the check to run first),
and shortening the application's grace was refused: it is the one process that
writes the project's data.
