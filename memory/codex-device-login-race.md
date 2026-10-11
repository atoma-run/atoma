---
name: codex-device-login-race
description: "Personal Codex/ChatGPT connection fails on prod with \"Connection failed / session no longer valid\" — Codex ≤0.154 sends account/login/completed BEFORE reloading its auth cache, Atoma's immediate account/read sees account:null (diagnosed 2026-09-15, fix landed in the working tree 2026-09-15, uncommitted at the time of writing)"
metadata:
  node_type: memory
  type: project
  originSessionId: 0a928f8b-c2f4-4835-a36c-27011b0a2ed7
  modified: 2026-09-15T13:22:34.938Z
---

Diagnosed 2026-09-15 on atoma.run: the Settings → Personal subscriptions →
Codex device-code login ends in state `error` + reason `authentication-required`
although auth.openai.com shows "Signed in to Codex".

**Root cause (provider ordering, every released Codex 0.146–0.154.0):**
`send_chatgpt_login_completion_notifications` in
`codex-rs/app-server/src/request_processors/account_processor.rs` sends
`account/login/completed{success:true}` and only THEN calls
`auth_manager.reload()`. `account/read` answers from `auth_cached()` (memory),
so Atoma's `handleNotification` in `src/auth/subscriptionProfiles.ts`, which
calls `account/read{refreshToken:false}` right after the notification, can get
`{account:null}` → `failAttempt('authentication-required')` and deletes the
freshly written profile. Codex `main` / 0.155 alphas reorder this (reload,
then verify, then notify) — not released as of 2026-09-15.

**Evidence:** WSL Debian probes with Codex 0.154.0 (installed 2026-09-15 via
`npm i -g @openai/codex` into `~/.local/node24`): `account/read` shape is
`{account:{type:'chatgpt',email,planType},requiresOpenaiAuth:true}`; the real
`AccountSubscriptionService.status(verify)` path works on Linux (8–13 s per
check, app-server cold start each time; first-ever run hit a 30 s timeout).
Directory/auth.json checks (0700/0600, nlink 1) pass with Codex-created files.
The vitest harness writes auth.json BEFORE `completed` and answers
`account/read` instantly, so it encodes the optimistic ordering and hides the bug.

**How to apply:** fixed in `readSettledAccount` (settle window `DEFAULT_LOGIN_ACCOUNT_SETTLE_MS`, woken by `account/updated`; two POSIX-only regressions in tests/account-subscriptions.test.ts). Original plan: after `completed(success)`, wait for
`account/updated` or retry `account/read` (bounded) before declaring
`authentication-required`; log a non-sensitive reason on that silent failure
path. Secondary risk: `DEFAULT_REQUEST_TIMEOUT_MS` 15 s vs ~8 s+ app-server
`initialize` on the 4 GiB VPS. SSH to the VPS is blocked for the agent by the
auto-mode classifier; the deploy user is `atoma-deploy` (forced command).
See [[public-domain-atoma-run]] and [[machine-setup]].
