# Memory index

## How to work
- [Push to prod authorized](push-to-prod-authorized.md) — I push to main (= prod) myself after verifying, fetch+rebase first; watch CI + deploy
- [Verification speed](verification-speed.md) — targeted tests + checks before an ordinary push; CI gates the deploy
- [No cooling-off](no-cooling-off.md) — fix incidents in-session, but adversarially review every gate/prompt rule/parser salvage first
- [Shared checkout staging](shared-checkout-staging.md) — never stage from a status listing; never reset --hard/stash the shared tree
- [Worktree junction hazard](worktree-junction-hazard.md) — remove node_modules junctions before `git worktree remove --force`
- [Reader-facing docs](reader-facing-docs.md) — delivered docs carry no verification evidence; remove earlier runs' evidence on edit

## Current work
- [Project deployment](project-deployment.md) — optional, mutable project setting: none (default), Atoma, or external; local Docker onboarding superseded
- [Property scraping priority](property-scraping-priority.md) — 2026-10-14: xe.gr first, Spitogatos paused; build the product through Atoma runs
- [Spitogatos VPN probe](spitogatos-vpn-probe.md) — 2026-10-14: works only via reverse SOCKS + real Chrome + one human hCaptcha; NordVPN still 403
- [Supervisor mender state](supervisor-mender-state.md) — no mender PR since #20: analyst drops proposedFix; p8 citation pass shipped, cite-only proposal open
- [Jev calibration 2026-10-10](jev-calibration-2026-10-10.md) — threshold readings, effort bar 0.6 shipped, holdout reading ≈10-27
- [Edge compression state](edge-compression-state.md) — 2026-10-14: nginx gzip+brotli live, MCP stays identity, ETag/304 on polled lists

## Machines and hosts
- [Machine setup](machine-setup.md) — the Windows machine: WSL2/Debian, Node 24 at ~/.local/node24, disk-space rule
- [Windows portability state](windows-portability-state.md) — audit verdicts, open defects, report URL
- [Public domain atoma.run](public-domain-atoma-run.md) — VPS 46.225.4.14; atoma.iotanet.net still proxies (no 301)
- [Server dev checkout](server-dev-checkout.md) — ~/dev/atoma on the server's 50 GB volume
- [Deploy pipeline state](deploy-pipeline-state.md) — deploys wait for work; reinstall the activator on host-deploy.sh changes; stale-lease fix
- [OpenClaw host on atoma.run](openclaw-host-atoma-run.md) — ChatGPT subscription via native ~/.codex, gpt-5.6-sol

## Owner decisions and their state
- [Supervisor replay exception](supervisor-replay-exception.md) — supervisor replays inherited web checks of static pages at root acceptance
- [Read-only phases](read-only-phases.md) — outputless root phases are photographed and restored by the host
- [Jev decisions state](jev-decisions-state.md) — Jev decides in every run; ATOMA_JEV=0 is the off switch
- [Project chat acceptance](project-chat-acceptance.md) — the conversation is the one acceptance surface; L3 cost open
- [read_file absence answer](read-file-absence-answer.md) — an absent path/dir is an answer, not an error
- [Compiled skills prod state](compiled-skills-prod-state.md) — 1 script / 30 recipes; forced compilation and browser-for-scripts closed
- [Showcase curation](showcase-curation.md) — opt-in since 2026-10-10; 2 projects left to the owner
- [Viz frame cost measurement](viz-frame-cost-measurement.md) — how to measure GPU frame cost; MSAA decision open

## Measurements with open items
- [Attica Haystack startup](attica-haystack-startup.md) — 2026-10-15: 6m29–6m53 before agents; 1,424 passages re-embedded on one CPU; cache implementation underway, production gain unmeasured
- [First refusals 2026-10-10](first-refusals-2026-10-10.md) — 118/275 first root refusals classified; E3 and false approvals open
- [edit_file manifest fix 2026-10-11](edit-file-manifest-2026-10-11.md) — 171/1198 failures; manifest loop fixed, other categories open
- [Production runs 2026-09-26/27](production-runs-2026-09-26.md) — hard width refusal undecided; MCP/WSL/heredoc gotchas
- [Validator prompt replay](validator-prompt-replay.md) — PR #12 gave no gain; how to replay a verdict offline
- [Run titles state](run-titles-state.md) — short titles live since d1a1d71b; past runs not backfilled

## MCP
- [MCP one surface](mcp-one-surface.md) — one HTTP /mcp, role tiers, bearer tokens; OAuth open
- [MCP two eras](mcp-two-eras.md) — serves 2026-07-28 beside 2025-11-25; health().clients decides when 2025 goes
- [MCP review 2026-10-03](mcp-review-2026-10-03.md) — fixes pushed; owner decisions still open
- [MCP Registry publication](mcp-registry-publication.md) — run.atoma/atoma; how to republish

## Legal and publishing
- [Public repo licensing](public-repo-licensing.md) — AGPL-3.0-only + CLA; skill-catalogue terms open
- [Business entity](business-entity.md) — Greek sole proprietorship; Greek law, copyright = the person
- [README video upload](readme-video-upload.md) — gh api upload to user-attachments
