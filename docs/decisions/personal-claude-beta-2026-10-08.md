# Personal Claude Code connection, in beta — owner decision 2026-10-08

## Decision

A member may connect their own Claude subscription to Atoma and spend it on
any tier through `own:anthropic:<alias>`, WITHOUT the third-party approval
Anthropic's Agent SDK terms ask of a product that routes `claude.ai`
subscription credentials. The owner's words: it is a beta, and the approval
is not a precondition for offering it. The card in Settings carries a
"Beta" badge; the documentation states the boundary rather than hiding it.

Until this date the Claude card was a server-owned disabled capability
(`provider-approval-required`), by design (`docs/automatic-deployment.md`,
`src/auth/AGENTS.md`). That reason code is gone from the contract.

## Shape

- No device flow and no emulated OAuth client. The member runs
  `claude setup-token` on a machine where Claude Code is signed in with their
  subscription and pastes the printed long-lived token into Settings. The
  provider's own CLI remains the only thing that ever logs in.
- The token is refused by spelling before any subprocess sees it
  (`claudeSubscriptionTokenSchema`: `sk-ant-oat<nn>-…`), then probed with
  `claude auth status --json` and the token in the environment. The probe is
  local — it proves the CLI is installed and reads the token as its OAuth
  bearer — and spends nothing. A revoked token surfaces as the CLI's refusal
  at the next run's first call, exactly as for the host's login.
- Storage follows the Codex profile contract: SQLite holds the receipt
  (`auth_principal_subscriptions`, provider `claude`), the token lives `0600`
  as `atoma-oauth-token` under `ATOMA_ACCOUNT_PROFILES_ROOT/<principal>/claude/<uuid>/`,
  and that directory is also the run's `CLAUDE_CONFIG_DIR`, so Claude Code's
  state stays in the generation instead of the service account's home.
- At launch the coordinator resolves the exact generation, refuses a run that
  mixes `sub:anthropic` and `own:anthropic` (one token per Claude Code
  process), and places `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` in
  the child's allowlisted environment. `subscriptionTransportEnv` keeps both:
  they are not `ANTHROPIC_*` variables and they ARE the payer.
- Connecting into an unconfigured account arms `own:anthropic:haiku`,
  `sonnet`, `opus` on L1, L2, L3 (`armStarterClaudePins`), under the same
  into-emptiness rule as the ChatGPT starter. Disconnecting deletes the
  receipt first, then the generation, and clears every `own:anthropic:` pin.
- Connect and disconnect are refused while that member has a run in flight:
  its child already holds the token in its environment and its config dir on
  disk.

## What this does not change

- The host's Claude login (`sub:anthropic`), its delegation, and the Codex
  paths are untouched.
- A run is a run: trust and skills are still platform-wide.
- Nothing here verifies the subscription upstream or reads account details;
  no email, plan or token ever reaches the store, the API or the journal.
