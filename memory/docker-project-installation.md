# Docker installation for customer projects

Owner decision, 2026-10-14: keep Docker as the only local runtime for now;
simplify customer installation inside Atoma for projects needing it (for example,
website scraping with human CAPTCHA verification). Do not build an independent
Atoma desktop agent as part of this iteration.

Implementation: explicit `atoma.local.json` in completed delivery -> Files guide
-> source-only ZIP, Start/Stop macOS and Windows launchers, Docker/Compose checks,
stable per-project state directory and Compose identity, loopback app and optional
verification links. No pairing, remote Docker control, installed-status claim or
implicit local-to-cloud synchronization. Contract: `docs/local-docker-projects.md`.
The Windows launcher is not yet verified on native Windows. Each app must include
and test its portable Compose config and complete source allowlist.

Attica's current local v3 pilot is a derivative of cancelled run 7d3373ba, plus
caller-tested fixes. Do not relabel it an accepted Atoma delivery or mutate saved
run artifacts to add the descriptor. Its next accepted delivery needs the portable
Compose file/descriptor before this guide can appear in its production project.
