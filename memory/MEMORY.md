# Memory index

## How to work
- [Push to prod authorized](push-to-prod-authorized.md) — I push to main (= prod) myself after verifying, fetch+rebase first; watch CI + deploy
- [Prod SSH authorized](prod-ssh-authorized.md) — ssh mgf@atoma.run + sudo for diagnosis; ask before restarting Docker/services
- [Shared Claude session limit](shared-claude-session-limit.md) — my subagents and own:anthropic Atoma runs share one limit; a 66-agent workflow killed run 492b3334 (2026-10-16)
- [Verification discipline](verification-speed.md) — 2026-10-20: thorough checks before pushing; follow all relevant CI, desktop packaging and deploy jobs to completion; fix failures
- [No cooling-off](no-cooling-off.md) — fix incidents in-session, but adversarially review every gate/prompt rule/parser salvage first
- [Beta rules not fixed](beta-rules-not-fixed.md) — 2026-10-16: I decide owner-level design choices myself; documented rules and AGENTS.md can change if evidence says so
- [Shared checkout staging](shared-checkout-staging.md) — never stage from a status listing; never reset --hard/stash/pull --rebase the shared tree; push only when origin/main..HEAD is mine (2026-10-16)
- [Worktree junction hazard](worktree-junction-hazard.md) — remove node_modules junctions before `git worktree remove --force`
- [Reader-facing docs](reader-facing-docs.md) — delivered docs carry no verification evidence; remove earlier runs' evidence on edit

## Current work
- [Explicit app and terminal previews](preview-app-terminal-2026-10-21.md) — fixes automatic shell fallback and strict executor classification; Attica device reconnection exposed second defect; CI/deploy and production retest pending
- [Atoma Compute implementation](atoma-compute-state.md) — 2026-10-18: Electron companion in 13 languages built/tested on Mac ARM, Intel and Windows; code deployed (61ea0fc9), unsigned test installers ready
- [Crystal caustic state](crystal-caustic-state.md) — 2026-10-17: facing + caustic fixes committed locally (50c15882, dfa4c921), not pushed; strokes invisible, 3 options to test
- [Parent-tests review fixes state](parent-tests-review-fixes-state.md) — deployed; 10-17: outside-copy absent paths, suite regex check, review host facts (532d6e35), dispute count (21b0e5ce)
- [Left-aside items state](left-aside-items-state.md) — 2026-10-18: all 5 items shipped, 6 commits owe an adversarial review (RO mount first)
- [Suite module reach](suite-module-reach.md) — 2026-10-17: host fact names written modules no suite reaches; gate passed; stop rule to apply
- [Suite dispute measurement](suite-dispute-measurement.md) — pre-registered: ≥20 disputes, ≥50% wrong suites before any line or routing
- [Read runs](read-runs.md) — 10-17: atoma_run_start readRunIds copies other runs to .atoma-runs/node_modules/<id>/; host compares criteria-named files
- [Account plan screen](account-plan-screen.md) — Your plan screen; org plan set by operator `auth set-plan` (2026-10-16); Pro/Team drop the Atoma mark
- [Project deployment](project-deployment.md) — optional, mutable project setting: none (default), Atoma, or external; hosted address = model-chosen label, admin rename → permanent 308 (2026-10-15)
- [Attica run delegation](attica-run-delegation.md) — 2026-10-15: I draft and start Attica runs myself and fix Atoma defects found
- [Property scraping priority](property-scraping-priority.md) — 2026-10-14: xe.gr first, Spitogatos paused; build the product through Atoma runs
- [Spitogatos VPN probe](spitogatos-vpn-probe.md) — 2026-10-14: works only via reverse SOCKS + real Chrome + one human hCaptcha; NordVPN still 403
- [Supervisor mender state](supervisor-mender-state.md) — no mender PR since #20: analyst drops proposedFix; p8 citation pass shipped, cite-only proposal open
- [Decision calibration 2026-10-10](jev-calibration-2026-10-10.md) — threshold readings, effort bar 0.6 shipped, holdout reading ≈10-27
- [Edge compression state](edge-compression-state.md) — 2026-10-14: nginx gzip+brotli live, MCP stays identity, ETag/304 on polled lists

- [Directory submission state](directory-submission-state.md) — 2026-10-16: legal pages + domain route live; owner owes reviewer account, OpenAI verification, token, demo, legal review

## Machines and hosts
- [Machine setup](machine-setup.md) — the Windows machine: WSL2/Debian, Node 24 at ~/.local/node24, disk-space rule
- [Windows portability state](windows-portability-state.md) — audit verdicts, open defects, report URL
- [Public domain atoma.run](public-domain-atoma-run.md) — VPS 46.225.4.14; atoma.iotanet.net still proxies (no 301)
- [Server dev checkout](server-dev-checkout.md) — ~/dev/atoma on the server's 50 GB volume
- [Deploy pipeline state](deploy-pipeline-state.md) — compatible releases use independent executors; verify root activator/bootstrap and active sockets; legacy/incompatible releases drain; read the deployed REVISION, not workflow HEAD
- [OpenClaw host on atoma.run](openclaw-host-atoma-run.md) — ChatGPT subscription via native ~/.codex, gpt-5.6-sol

## Owner decisions and their state
- [Parent-owned tests](parent-owned-tests.md) — L3 reviews L2-authored L1 tests; independent L2 branches must run in parallel
- [TypeScript applications](typescript-applications.md) — 2026-10-16: all JS-runtime apps, including existing ones, use strict TypeScript; migrate only Attica now
- [Supervisor replay exception](supervisor-replay-exception.md) — supervisor replays inherited web checks of static pages at root acceptance
- [Read-only phases](read-only-phases.md) — outputless root phases are photographed and restored by the host
- [Decision state](jev-decisions-state.md) — Decision decides in every run; ATOMA_JEV=0 is the off switch
- [Decision naming](decision-naming.md) — 2026-10-15: readers see "Decision" (TypeSafe Jev); code/env/MCP/traces keep `jev`
- [Project chat acceptance](project-chat-acceptance.md) — the conversation is the one acceptance surface; L3 cost open
- [read_file absence answer](read-file-absence-answer.md) — an absent path/dir is an answer, not an error
- [Skill eval quota ok](skill-eval-quota-ok.md) — 2026-10-15: trigger eval + assayer (execution comparison) shipped; check prod banner for the assayer
- [Compiled skills prod state](compiled-skills-prod-state.md) — 1 script / 30 recipes; forced compilation and browser-for-scripts closed
- [Showcase curation](showcase-curation.md) — opt-in since 2026-10-10; 2 projects left to the owner
- [Viz frame cost measurement](viz-frame-cost-measurement.md) — how to measure GPU frame cost; MSAA decision open

## Measurements with open items
- [Attica Haystack startup](attica-haystack-startup.md) — 2026-10-15: 6m29–6m53 before agents; 1,424 passages re-embedded on one CPU; cache implementation underway, production gain unmeasured
- [First refusals 2026-10-10](first-refusals-2026-10-10.md) — 118/275 first root refusals classified; E3 and false approvals open
- [edit_file manifest fix 2026-10-11](edit-file-manifest-2026-10-11.md) — 171/1198 failures; manifest loop fixed, other categories open
- [Production runs 2026-09-26/27](production-runs-2026-09-26.md) — hard width refusal undecided; MCP/WSL/heredoc gotchas
- [Delegation review replay](delegation-review-replay.md) — replay recorded root reviews offline via Codex on the Mac; 2026-10-16 measurements
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
