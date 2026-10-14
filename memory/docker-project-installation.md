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
It predates onboarding prose and is not recorded as client-accepted. Its immutable
bytes remain retained; run `0daa2132-591f-4068-9040-25cba2dccac7` adds the explanation.
The original pilot on 3300/6081 and its 68 collected offers stay separate and
must not be replaced by platform UX work.

Validation of the Application journey: schema/legacy/plain-text rendering and
writer/fallback/validator coverage; real canvas setup and ZIP download at 1600px
and 900px; hosted preview remains direct. Release static checks passed. The full
suite had 6,521 passes and one external example.com fetch failure; the isolated
container suite then passed all 22 tests. The complete GPU/browser smoke passed
after its driver dismissed the notification invitation and read the real scroll
mask (the longer Application tab exposes an extra row at narrow widths).

Production release `8fe426d1` passed the complete CI (38581934011) and deployed
successfully (38583114059). Attica onboarding run
`0daa2132-591f-4068-9040-25cba2dccac7` starts from the exact portable delivery,
with only onboarding metadata and README navigation changes requested.
Its validators repeatedly confused the read-back's 2,114 UTF-16 units with the
README's 2,116 UTF-8 bytes (events `6bb3f5b3` and `b9a7180b`). Ground-truth
presentation now reports both units explicitly; a regression goes through real
file tools and the validation prompt with accented, arrow and astral characters.
The four ground-truth suites pass all 115 tests. This is evidence presentation,
not a new acceptance gate or a claim that every future model will judge correctly.
Fix `efefe36d` passed CI 38586619523 and deployed successfully (38587709734).

Attica `0daa2132` delivered with 3/3 criteria met. Independent manifest comparison:
only atoma.local.json and the two README navigation instructions changed; 95 files
unchanged. The production schema accepts the descriptor with the same 22 allowed
paths and unchanged runtime configuration. The real Application flow and its
receipt entry were checked; the downloaded ZIP is 38,798 bytes with 27 files,
contains the prose in START-HERE.txt, and has identical runtime source to the
previously tested package. No new collection, local-state changes, native Windows
test or client acceptance/publication occurred. Review is saved in the project's
Atoma conversation; the latest delivery is available in Application.
