# Integrated assistant

Projects → **Talk to Atoma** lets a signed-in member describe a new project or
the next change without installing an external agent. The assistant prepares a
proposal. **Create this project** creates the project; a separate **Approve and
start run** button authorizes spending run quota. Sending a chat message never
executes either action. Subsequent messages supersede the previous proposal.

The conversation shows recorded run status and cost. **Open run** leads to the
existing progress and result reader; the project offers supported previews.
This first surface covers project creation and run launch. Answering blocking
run questions, cancelling, and accepting a delivery still use an external MCP
client connected through Settings. Delivery does not publish: testing and
explicit client acceptance remain required.

## Configuration and cost

Choose the assistant model and account in the conversation before sending a
message. The choice is independent of the three run models. Supported sources:

- Your connected ChatGPT subscription, using the models discovered in your exact
  private Codex profile. The inventory is refreshed before inference.
- Your connected Claude subscription (beta), using the existing personal token
  connection in Settings. The beta's provider-approval limitation still applies.
- Your active organisation's API key, with models from the provider catalogue.
  An organisation admin manages these keys in Settings. The key is sent only to
  that provider's endpoint, never the host's custom gateway.
- The optional Atoma API connection: the host's `ATOMA_ASSISTANT_MODEL` override,
  or its API L1 selector and credential. A host subscription is never offered.

The selected account is shown beside the model. A missing or revoked connection
refuses that message without substituting another model or payer. Choices do
not require a host API key: a connected personal subscription or organisation
API key is sufficient. **Manage connections** opens Settings.

The selection is saved with the conversation. API-equivalent estimates describe
usage, not an additional subscription invoice. The selected subscription's
quota or organisation API account bears the conversation usage; run usage and
run-model settings remain separate.

One message makes at most one model call, with a 45-second inference deadline,
3,000 output-token ceiling and bounded context. The complete local MCP session
is bounded at 75 seconds. The primary product store records requested/served
models, payer, token usage and API-equivalent cost, including partial usage on failure, in
`assistant_calls`. Run costs are not modified. `assistant_daily_usage` admits
at most 100 attempts per principal/organisation per UTC day and stops admitting
platform-funded calls once their recorded spend reaches $2 (an in-flight call may cross
that threshold). Customer-funded usage does not count toward that dollar cap. There is one active request per principal/organisation and
eight across the host. Approval and status reads do not invoke a model.

## Identity, state and execution

The browser uses its existing session on `/api/assistant`. POST requires the
canonical same-origin header and a member role. It cannot select another
principal, organisation, credential, endpoint or arbitrary tool. Model selections
are checked against the connected account and provider catalogue. The
backend connects to the existing `/mcp` over loopback using the official SDK,
with the canonical Host header preserved. A random, server-only bearer lives
for at most 90 seconds and re-resolves the original browser session on every
MCP request. Platform-admin authority is attenuated to member; all reads and
writes stay in the active organisation. No durable API token is minted.

`src/projects/conversations.ts` owns continuity in the primary DB. One private
conversation per principal, organisation and project has a stable UUID, including
before project creation. Creation binds that same conversation to the new
project. Starting a run from a new-project conversation also binds it; if that
project already has a conversation, continue there instead of merging histories.
The account and active organisation must match in both interfaces. Platform
administrators cannot read another principal's chat.

`project_conversations` retains a latest-40 snapshot; `conversation_messages`
retains the full journal. Reads return 10 messages by default (at most 20 and
48,000 serialized message characters), oldest first within the page, with
`nextBefore` for older pages. The previous `assistant_conversations` snapshots
migrate transactionally on startup. Already-trimmed historical messages cannot
be recovered. Model context uses the latest 16 messages, at most 24,000
characters, plus at most 20,000 characters of MCP context. Project discovery
is the latest 20 projects; selecting a project provides its saved brief,
readiness and latest run even outside that page. This is saved Atoma context,
not a claim to inspect live GitHub or local files.

## Moving between Atoma and an external agent

**Atoma → Claude Code (or another MCP client):** choose **Continue in Claude or
another agent** in the conversation, then paste the copied prompt into the
connected agent. It reads `atoma_conversation` with the stable conversationId,
including a draft before its first project or run. For an existing project it
can also read by projectId. Proposals and run receipts are included.

**External agent → Atoma:** share relevant exchanges or a faithful handoff using
`atoma_conversation_update`. Supply the latest `expectedVersion`, a stable UUID
`requestId`, and up to eight messages / 12,000 text characters. The native
conversation refreshes every five seconds while open. Reading and sharing do
not invoke Atoma's model or spend run quota. External clients control which
messages they share: this does not automatically synchronize an entire private
Claude chat or its hidden reasoning. Reported client names are visibly marked
as unverified attribution. Clients cannot write host receipts.

A write may include one proposal for confirmation in either interface; omitting
it preserves the pending proposal, and null explicitly withdraws it. Message
text never constitutes approval. To approve externally, call the EXISTING
`atoma_project_create` or task-enabled `atoma_run_start` with the saved action
unchanged and `conversationApproval` containing conversationId, proposalId,
version, a stable UUID requestId and the person's explicit confirmation. Empty
criteria in a saved run proposal mean no additional checklist. Run overrides
are refused. Both protocol eras use the same service and durable receipt.

Sharing a conversation does not update confirmed project briefs or decisions.
Use the project-context tools with their explicit confirmation for durable
instructions that subsequent runs should inherit.

Only validated structured proposals reach confirmation controls. The browser
confirms the saved proposal's ID and conversation version, never a replacement
action body. A transactional claim prevents concurrent submissions. Duplicate
request receipts do not repeat inference or writes. Starts use MCP tasks and
an idempotency key derived from the persisted proposal ID. A run continues when
the tab closes; reopening reads its saved receipt and status.

A failed or interrupted mutation can have an unknown outcome. Its proposal is
marked uncertain and cannot be blindly executed again; the UI directs the
member to inspect Projects and Runs. Active approvals renew their lock; a crashed request's 90-second lock expires
without deleting its messages or receipt. Subscription replacement and disconnection are refused while an assistant request
holds that principal’s profile, including a login/probe that began before the request.
Model/provider errors never expose
raw provider text. Model prose and MCP context remain untrusted data, rendered
as plain text; no model has an execution tool or publication authority.

Tests exercise the real HTTP MCP path with mocked inference, separate approvals,
duplicate delivery, stale proposals, identity changes, role attenuation,
uncertain actions, cost accounting and the interactive client. No paid call is
needed for these checks.
