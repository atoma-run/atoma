# Directory submission: Claude and OpenAI, 2026-10-16

What to enter in the two plugin directories for the Atoma plugin
(`plugins/atoma`) and the hosted MCP server (`https://atoma.run/mcp`), and what
is still the operator's to do. Texts are ready to paste; limits noted are the
portals' own.

Sources read on 2026-10-16:
[Claude: submit a plugin](https://claude.com/docs/plugins/submit),
[plugin pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist),
[submit a connector](https://claude.com/docs/connectors/building/submission),
[connector review criteria](https://claude.com/docs/connectors/building/review-criteria),
[OpenAI: submit plugins](https://developers.openai.com/plugins/deploy/submission),
[submit a Claude plugin to OpenAI](https://developers.openai.com/plugins/guides/submit-claude-plugin),
[OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth).

## Readiness

| Requirement | State |
|---|---|
| `claude plugin validate ./plugins/atoma` | passes |
| README ≥ 40 words, licence declared, no hooks or local commands | yes (`license: AGPL-3.0-only`) |
| README discloses what the plugin sends and where | yes, "What the plugin sends, and where" |
| Remote MCP over HTTPS, no headers in `.mcp.json` | yes |
| Every tool has a `title` and `readOnlyHint` / `destructiveHint` | yes (`src/mcp/tools.ts` presets) |
| OAuth 2.1 with PKCE S256, dynamic client registration, client ID metadata documents | yes (`/.well-known/oauth-authorization-server`) |
| Privacy policy, terms, support pages | live: `/privacy`, `/terms`, `/support` |
| Codex manifest: `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL`; `shortDescription` ≤ 30 | yes |
| OpenAI domain verification at `/.well-known/openai-apps-challenge` | route ready; serves `ATOMA_OPENAI_APPS_CHALLENGE` once the host sets it |
| OIDC UserInfo with `email_verified` | not needed: OpenAI requires it only for Enterprise workspace domain restrictions |

## Operator actions

1. **Reviewer account.** Both directories need credentials for a populated
   account; OpenAI's must not require MFA. Production signs in with GitHub
   only, so create a dedicated GitHub account for reviewers, invite it into an
   organisation (`npm run auth -- invite --org <org-id> --role org:member --ttl-hours 720`),
   and seed that organisation with a project and a few delivered runs. Give its
   runs a model configuration, or a reviewer's run will refuse to start.
2. **OpenAI organisation.** Identity verification (individual or business) and
   the Apps Management write permission on the owning organisation.
3. **Domain token.** Copy the token the OpenAI portal issues into
   `ATOMA_OPENAI_APPS_CHALLENGE` in the host's environment, restart the
   service, and check `curl https://atoma.run/.well-known/openai-apps-challenge`.
4. **Demo recording** for OpenAI: sign-in through the client, listing projects,
   drafting a goal, starting a run, reading its status and files.
5. **Legal text review** before submitting: the model-provider list, the
   18-year minimum, the one-month answer to data requests, and deletion handled
   by email (no self-service deletion route exists).

## Claude: plugin bundle

Portal: [claude.ai/directory/manage](https://claude.ai/directory/manage) →
Submit new → Plugin bundle. The connected GitHub account must be able to push
to `atoma-run/atoma`.

- **Repository:** `atoma-run/atoma`
- **Plugin path:** `plugins/atoma`
- **Branch:** `main`
- **Listing details:** read from `plugin.json` and the plugin README.
- **Data handling:**
  - Reads or stores personal data: the plugin itself stores nothing; through
    its declared connector it sends to atoma.run what the person asks the
    tools to send (goals, criteria, answers), processed under
    https://atoma.run/privacy.
  - Sends data to services other than its declared connectors: no.
  - Retention: per the atoma.run privacy policy (run traces and workspaces
    eligible for deletion 90 days after the run ends).
  - Intended for people under 18: no.
- **New versions:** GitHub push webhook. `plugin.json`'s version follows
  `package.json` (pinned by `tests/claude-plugin.test.ts`), so raise it with
  every release.

## Claude: MCP connector

Portal: Submit new → MCP connector. Anthropic asks for the server as a
connector too when a plugin points at it, so the two listings can be paired.

- **Connection:** `https://atoma.run/mcp` (one URL for every user).
- **Server name (≤ 100):** `Atoma`
- **One-liner (≤ 200):**
  > Start, follow and review Atoma runs: AI agents plan, build and check software and other deliverables, with every step, file and cost on record.
- **Description (≤ 2,000):**
  > Atoma turns a request into finished, checked work. You describe the outcome you want; Atoma plans it, has AI agents carry it out in isolated workspaces, checks the result against the acceptance criteria, and delivers it, with the full record of every step, file and cost.
  >
  > This connector brings Atoma into Claude. Ask Claude to list your projects and their latest runs, help you draft a goal and acceptance criteria, start or continue a run, follow it while it works, answer a question a run asks you, and read what it delivered: its status, files, cost and trace. When a run fails or stops incomplete, Claude can read its evidence and explain why. Once you have reviewed a delivery, you can accept it, and Atoma publishes it to your GitHub repository.
  >
  > Reading is safe to run freely. Starting a run, answering a question, accepting a delivery and other changes are separate tools that Claude asks you to confirm. Starting a run uses your Atoma quota. The tools you see follow your role in your organisation: viewers read, members run, admins also choose the organisation's models.
  >
  > Sign in with your Atoma account in the browser; Claude never sees a password. Atoma is in beta and free of charge during the beta.
- **Categories:** Developer tools; Productivity.
- **Documentation URL:** https://atoma.run/support
- **Privacy policy URL:** https://atoma.run/privacy
- **Support contact:** mgf@iotanet.net
- **Icon:** `plugins/atoma/assets/atoma.svg` (512 × 512, square).
- **Slug:** `atoma` (permanent once published).
- **Use cases:** follow and investigate runs; draft a goal and start or continue
  a project run; review and accept a delivery.
- **Before connecting:** an Atoma account (sign in at https://atoma.run with
  GitHub), membership of an organisation, and for starting runs a model
  configuration for that organisation.
- **Reads or writes:** both.
- **Company:** Matthieu Foillard (sole proprietor, Greece), https://atoma.run;
  primary contact mgf@iotanet.net.
- **Authentication:** OAuth with dynamic client registration (client ID
  metadata documents also supported).
- **Data handling:** first-party API (Atoma's own); no personal health data, no
  sponsored content.
- **Test & launch:** the reviewer account from operator action 1, with these
  steps: add the connector, sign in with the provided GitHub account, approve
  access for the organisation, then ask "Show my Atoma projects and their
  latest runs" and "Why did the latest run of <seeded project> stop?". State
  that every tool was exercised as a custom connector first.

## OpenAI: plugin with MCP

Portal: [platform.openai.com/plugins](https://platform.openai.com/plugins) →
Upload new or existing plugin, With MCP. Submit the endpoint directly; a Claude
listing does not transfer. The Claude Code agent `trace-reader` is not carried
over; the `runs` skill already covers trace reading through the MCP tools.

- **Package:** ZIP of `plugins/atoma` (it carries `.codex-plugin/plugin.json`);
  no credentials inside.
- **Listing:** `displayName` Atoma; `shortDescription` "Build and follow Atoma
  runs"; `longDescription`, category, logos and starter prompts from the
  manifest.
- **MCP:** `https://atoma.run/mcp`, OAuth with DCR or CIMD.
- **Positive test cases:**

| # | Prompt | `tools_triggered` | Expected behaviour |
|---|---|---|---|
| 1 | Show my Atoma projects and their latest runs. | `atoma_projects_list`, `atoma_project_runs` | Lists the organisation's projects with each latest run's status; changes nothing. |
| 2 | Why did the latest run of my project stop? | `atoma_project_runs`, `atoma_run_status`, `atoma_run_trace` | Names the step where the run stopped and the recorded reason, citing trace events; changes nothing. |
| 3 | Show me the files the latest run delivered, then open the README. | `atoma_run_artifacts`, `atoma_run_file` | Lists delivered files with sizes, then shows the README's text. |
| 4 | Help me write a goal for my project: add a dark mode toggle that keeps the user's choice. | `atoma_project_context`, `atoma_project_readiness` | Proposes a goal and acceptance criteria and asks for approval; starts no run. |
| 5 | Start that run with the goal we agreed on. | `atoma_run_start` | Asks for confirmation, then starts the run and reports its status. |

- **Negative test cases:**

| # | Prompt | Why the plugin should not act |
|---|---|---|
| 1 | What is the weather in Athens today? | Unrelated to Atoma projects or runs. |
| 2 | Write a Python function that reverses a string. | A direct coding answer; nothing asks for an Atoma run. |
| 3 | Translate this paragraph into French. | Unrelated to Atoma; no project, run or delivery is involved. |

- **Review details:** the reviewer account from operator action 1 (GitHub
  sign-in without MFA), and the demo recording.
- **Release notes:** "First public release of the Atoma plugin: the hosted
  Atoma MCP server and a skill to draft goals, start and follow runs, and read
  their results, costs and traces."
