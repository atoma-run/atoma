# Docker installation for customer projects

Owner decision, 2026-10-14: keep Docker as the only local runtime for now;
simplify customer installation inside Atoma for projects needing it (for example,
website scraping with human CAPTCHA verification). Do not build an independent
Atoma desktop agent as part of this iteration.

Implementation: explicit `atoma.local.json` in completed delivery -> Application guide
-> source-only ZIP, Start/Stop macOS and Windows launchers, Docker/Compose checks,
stable per-project state directory and Compose identity, loopback app and optional
verification links. No pairing, remote Docker control, installed-status claim or
implicit local-to-cloud synchronization. Contract: `docs/local-docker-projects.md`.
The Windows launcher is not yet verified on native Windows. Each app must include
and test its portable Compose config and complete source allowlist.

The local-required Application path now explains the software before asking for
setup. The delivery LLM writes bounded `onboarding` prose (whyLocal,
runsOnComputer, dataAndConnections, firstSteps) once, with existing validation
checking it against code. No LLM on page opening. The generic platform flow owns
Docker setup, download/start, app opening, help and manual verification. Old
immutable descriptors show an honest generic fallback. Hosted apps stay direct.

Attica run 1a4dd9b1-e6a7-4729-bba7-7af623c8fec8 delivered the portable package
on 2026-10-14; a real downloaded ZIP was started/stopped/restarted on macOS.
It predates onboarding prose and is not recorded as client-accepted. Do not edit
that saved delivery to retrofit the explanation. A future Atoma run can add it.
The original pilot on 3300/6081 and its 68 collected offers stay separate and
must not be replaced by platform UX work.

Validation of the Application journey: schema/legacy/plain-text rendering and
writer/fallback/validator coverage; real canvas setup and ZIP download at 1600px
and 900px; hosted preview remains direct. Release static checks passed. The full
suite had 6,521 passes and one external example.com fetch failure; the isolated
container suite then passed all 22 tests. The complete GPU/browser smoke passed
after its driver dismissed the notification invitation and read the real scroll
mask (the longer Application tab exposes an extra row at narrow widths).
