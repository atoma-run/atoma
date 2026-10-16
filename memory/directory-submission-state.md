---
name: directory-submission-state
description: 2026-10-16 state of listing the Atoma plugin and MCP in the Claude and OpenAI directories; what is shipped and what the owner still has to do
metadata:
  type: project
---

Goal (owner, 2026-10-16): visibility by listing the Atoma plugin
(`plugins/atoma`) and the MCP (`https://atoma.run/mcp`) in Anthropic's
directory (claude.ai/directory/manage: one Plugin bundle and one MCP connector
submission) and OpenAI's (platform.openai.com/plugins, With MCP).

Shipped and live: `/privacy`, `/terms`, `/support` (src/viz/legalPages.ts,
atoma.run origin only), legal links on the arrival gate, Codex manifest
support/privacy/terms URLs, plugin README disclosure section, and the OpenAI
domain-token route `/.well-known/openai-apps-challenge`, which serves the
`ATOMA_OPENAI_APPS_CHALLENGE` host env (404 until set). Paste-ready texts and
test cases: records/releases/directory-submission-2026-10-16.md.

**Why:** the directories need legal URLs, tool annotations, OAuth (DCR/CIMD
already supported) and reviewer credentials. OpenAI's UserInfo /
email_verified rule applies only to Enterprise domain restrictions, so it is
not a blocker.

**How to apply:** before submitting, the owner still has to:
- create a reviewer GitHub account without MFA and a seeded organisation for it;
- complete OpenAI identity verification;
- set the domain token on the host;
- record a demo video;
- review the legal texts I wrote (provider list, the 18+ age limit, one-month
  answers to requests, deletion by email).

Related: [[mcp-registry-publication]], [[business-entity]].
