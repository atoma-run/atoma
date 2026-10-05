# Core — AGENTS.md

Depth attempts share the run deadline and accounting. `forkBranch` forwards
attempt identity and the pre-fallback/phase-coverage hooks. Attestations are
read by attempt at root acceptance; optional trace snapshots resolve their
references but are never loaded back as execution proof.

`src/core/` owns the LLM client and its transports, model and tier resolution,
the cost formula, the product store, the ledger, metrics and limits.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/atoms`](../atoms/AGENTS.md) — the call sites
- [`src/run`](../run/AGENTS.md) — provider construction and tier pins
- [`src/viz`](../viz/AGENTS.md) — the consumer of what metrics record

## LLM interaction conventions

- Every call goes through `LlmClient`; never call a provider SDK from atoms.
- A model is always a full selector `<api|sub|own>:<vendor>:<model>`
  (`src/contracts/modelSelector.ts`, the ONLY parser; the third segment keeps
  its colons for Ollama tags). `modelForTier` in `src/core/models.ts` reads the
  three REQUIRED `ATOMA_MODEL_L*` pins — there is no default and no base
  provider since 2026-09-07 — accepts an optional env, and throws
  `ModelSelectorError` naming the variable. `applyTierPins` is how a snapshot
  reaches the default (`process.env`) call sites; a missing pin is deleted on
  the target, not left as leftover ambient state.
- `RoutingLlmClient` maps a selector's TRANSPORT (`transportOf`) to the one
  client built for it and hands the transport the bare model id; it has no
  default client. Record both requested and served model so cost attribution
  follows the actual transport.
- `OpenAiLlmClient` (`api:openai`) is the Responses API with function tools:
  the same loop contract as the Anthropic client, admissible on every tier.
  `sub:openai`/`own:openai` stay on the Codex CLI on all three tiers.
  Tool-bearing requests use `codexToolLoop`: a strict JSON action protocol
  over isolated text completions. Only declared names reach `req.executor`;
  results are observed before model-facing truncation. The loop consumes
  only the first valid action envelope per subprocess response;
  later messages cannot have observed its result and are discarded. The
  child is still drained and reaped so usage, errors and profile leases remain honest.
  Invalid argument JSON returns a failed observation without executing a tool;
  the model may correct it within the same iteration budget. Never repair or
  reinterpret executable arguments on its behalf. The observation names WHY
  (`describeInvalidArguments`: the parser's message, the length, the escaped
  characters around the position, and a raw control character when that is
  what stands there). A file body travels in the envelope's DECLARED
  `content` field, escaped once like `text`, never inside argumentsJson: the
  host places it on a tool whose declared arguments include `content` and
  refuses it on any other tool or when argumentsJson carries it too. That is
  protocol, not repair — runs c4c270f9 and 811782c2 (2026-09-26) lost whole
  file writes to the double encoding, one shipping its page minified onto a
  single line. An empty `content` is an empty file. Extending this protocol to
  `edit_file`'s `old_string`/`new_string` is measured by ledger repairs 3b3efaf3 and
  947a21a2: both spans travel in declared top-level fields too, with the same
  scope and duplicate checks. Empty new_string is deletion; legacy envelopes remain readable.
  Since 2026-10-04 `smoke` (validate_html) and `cmd` (run_shell, record_probe) travel the
  same way (runs 1d42ac2a, 7f7aec0b lost calls to the double escaping), and a field given
  in both places with the SAME value is accepted; only two different values are refused.
  A finite tool budget permits one finalization, which cannot execute tools. Abort and partial
  usage propagate across the complete loop. No Codex-native tools are enabled.
  Every transport's loop marks a text written on that finalization turn `toolBudgetExhausted`;
  the executor carries it onto its `Result`, where a result gate keeps it off every fast path.
  Acceptance evidence: [codex-all-tiers-2026-09-08](../../docs/incidents/codex-all-tiers-2026-09-08.md).
- Since 2026-10-04 a tool-bearing Codex call first runs as ONE `codex app-server`
  thread (`codexAppServerToolLoop.ts`). The declared tools are its dynamic tools;
  each `item/tool/call` reaches `req.executor` only, one at a time, in arrival
  order, and one model response may carry several. The exec loop cost a process
  and a resent transcript per action: run 87e672d7 spent ~13 s per action, 2 % of
  it in tools, and a WSL replay of one task took 23 s here against 72 s. Isolation
  is the exec transport's (disabled features, permission profile, empty jail) in a
  FRESH profile holding a copy of auth.json — app-server has no
  `--ignore-user-config`. The CODEX_HOME lease is held only until the first model
  response (a stale login is refreshed before it): the copy is written back then
  and the lease released, so other lanes and tiers are not queued behind minutes
  of host tools; a later rotation is written back only over what this session
  last wrote. The budget counts MODEL RESPONSES, as the native loops do (Codex
  reports usage once per response), with calls bounded at 12 per allowed
  response: counted in calls, run 96d5c845 spent 40 in two batches of HTTP checks
  and never reached its browser check. Calls of the last allowed response carry
  the exhaustion hint, later calls are refused, eight refusals end the turn for a
  tool-free finalizing turn, and that final is `toolBudgetExhausted`.
  A session that fails before any tool call reached the host falls back to the
  exec loop (nothing ran twice), except on a timeout, rate limit or login failure
  that exec would meet too; after one, the failure is the call's.
  `ATOMA_CODEX_TOOL_TRANSPORT=exec` keeps the exec loop.
  App-server failures use the typed `codexErrorInfo` before the legacy prose
  reducer. Only the fixed failure vocabulary leaves the transport; never persist
  provider messages, additional details or unknown variant values. Context,
  session-budget and policy refusals do not spend an exec fallback. A failure
  after a host tool still cannot replay the request through another transport.
- Effort settings belong on strategy calls only. Validators and prefilters are
  deterministic and cheap.
- A transport cannot outlive its deadline. Keep both per-call abort and outer
  watchdog guards, clean abort listeners in `finally`, and account partial usage
  when a provider exposes it. Tool-loop iteration caps shrink against
  remaining wall clock via `capToolIterations` / `ctx.deadlineAt` (26 s
  floor from the 2026-08-16 fan-in measurement) so one phase cannot
  *plan* more iterations than the run can still pay.
- A Claude CLI tool-budget exhaustion gets one finalization in that query's
  own session, with tools and MCP servers disabled. Both queries' usage is
  retained, including when finalization fails; finalization never recurses.
- Claude CLI and Codex CLI transports run with user tools/config isolated.
  Both capture their supplied environment at construction, including login
  location and model overrides; a separate platform author cannot inherit
  the customer's ambient login or debug model. Claude strips the internal
  tissue-author credential envelope before spawning, as Codex's allowlist does.
  Every Claude query passes `strictMcpConfig` and ENABLE_CLAUDEAI_MCP_SERVERS
  =false: `settingSources: []` does not keep out a subscription login's
  claude.ai connectors, which bypassPermissions would let run untraced. The
  in-process bridge serves element schemas verbatim and passes arguments
  unparsed to the executor, as the api: path does (measured 2026-10-03: the
  zod bridge widened ports to ±2^53 and dropped enums and nested shapes).
  Project `.claude/settings.json` never grants shell permission; personal grants
  belong in ignored local settings. Codex MCP registration is local too. A
  principal Codex transport receives an allowlisted environment snapshot and a
  strict root-deny/workspace-read-only permission profile; provider keys and
  every other principal's profile stay outside the child. Both login and run
  force file-backed auth in that exact `CODEX_HOME`; never allow `auto` to move
  a refresh into the service account's shared keyring. The text-only transport
  explicitly disables Apps, plugins, browser/computer, image, skill and
  delegated-agent capabilities in addition to shell and network access;
  `--strict-config` must fail closed when a Codex upgrade renames one. Every
  Codex child lifetime is serialized by its canonical `CODEX_HOME`; the CLI
  may rotate `auth.json` even when calls are otherwise independent. The shared
  lease is both FIFO in-process and SQLite-backed across processes, and remains
  held through actual child reap after timeout or cancellation.
- Do not confuse interactive Codex with the Codex transport. The transport uses
  explicit safe flags and never inherits the interactive agent's tools.
- Auth checks must match the selected transport without leaking credentials.

## Vendors, the model catalogue and prices

- Eleven vendors, each its OWN transport (`<vendor>-api`, Ollama `ollama`):
  one key, one endpoint. Anthropic and Z.ai speak Messages
  (`AnthropicLlmClient`), OpenAI the Responses API, and Google, xAI, Meta,
  Mistral, Qwen, DeepSeek and Moonshot OpenAI-compatible Chat Completions
  through ONE class, `ChatCompletionsLlmClient`, built once per vendor. What
  a vendor IS — key variable, endpoint, wire, listing URL — is code in
  `providerCatalog.ts`; per-vendor protocol quirks are `CHAT_COMPLETIONS_DIALECTS`
  beside the client, and nowhere else.
- The Chat Completions loop echoes the assistant turn VERBATIM. DeepSeek, Kimi,
  GLM and Qwen thinking models require their `reasoning_content` back inside a
  tool loop, and Gemini 3 its per-call `thought_signature`; a rebuilt message
  drops both and the next round is a 400. Output is
  `max(completion_tokens, total − prompt)` so unreported thinking still bills.
- Which models are offered and what they cost is DATA: `modelCatalog.json`,
  schema `contracts/modelCatalog.ts`, validated at load (an invalid file is a
  boot failure). `DEFAULT_PRICES` is DERIVED from it; there is no second price
  list. A billed model without a price is refused by the schema — an unpriced
  call reads as free and flatters its tier.
- Prices are a HISTORY. A change APPENDS a point with `since` = the day it was
  reviewed; `pricesAt(model, date)` re-prices old usage with the numbers then
  in force through an explicit helper (not a production repricing job). A scheduled
  change is a future point; live prices are captured at process startup, so
  that point takes effect only after restarting on or after its date.
  Retired models keep their entry and prices; they leave the pickers only.
- `npm run models` (`src/cli/models.ts`) is the ONE writer and every write is
  a dry run until `--apply`. `refresh` compares with LiteLLM's public price
  file (native ids, vendor source URL per row) and, with `--live`, each
  vendor's own `/models` listing — both quota-free. It PROPOSES; a person
  applies and commits, and a push to main deploys it. `manualPrice` marks a
  price read from the vendor's page where the reference is wrong: shown beside
  the reference's number at every refresh, never overwritten by it.

## Cost accounting

- Anthropic tool loops keep one rolling cache breakpoint: clear the prior
  marker before marking the latest tool result. Never exceed four breakpoints.
- `estimateCostUsd` is the only cost formula. Anthropic input, cache-read, and
  cache-creation counters are disjoint; never subtract one from another.
- Accounting follows the SERVED model, not the tier pin: transports that
  rewrite the model (codex slug mapping, ollama collapse, claude-cli aliases)
  report `servedModel` on the response, and metrics/recording price
  `servedModel ?? req.model`. The pin stays the routing identity in events.
- Errors keep their paid tokens on EVERY transport: a throw from a tool loop
  carries `partialUsage`, and both observability layers read it — the trace
  and the CSV must never disagree about one call's cost.

## Ledger

- Ledger writes are fail-open for run execution but attributable and ordered.
  A ledger failure cannot take down the product; impossible counter directions
  must be surfaced by `ledger check`.
- The ledger table has TWO writable open paths (`openDb`, the cached
  `openLedgerHandle`) and ONE schema step, `ensureLedgerSchema`. Never add a
  column to one path: `appendLedger` swallows its failure, so the other path
  loses every event silently. Read-only readers never migrate and must read
  an older table shape without inventing values. The skill trust table
  (`skill_meta`, W4) is created in that same step and nowhere else; a
  `SkillRegistry` handed a bare handle only checks for it, and a read-only
  handle on a store without it reads the legacy sidecars.
- Scope is process state, set once per process (`setLedgerScope`) or per
  synchronous operation (`withLedgerScope`), never a parameter threaded into
  the supervise loop. A multi-tenant process uses the latter only; a promise
  inside it is refused because it would outlive the scope.
- `entity` is the display label and `entity_id` the stable key (T4); the
  projection groups by `ledgerEntityKey`. The backfill resolves labels
  against the current store and leaves the rest NULL — never rewrite
  `entity`, never invent an id for a label that no longer resolves.

## Metrics and traces

- `InMemoryMetrics` and `MetricsLlmClient` wrap calls; traces record requested
  model, served model, usage, cost, cache, decisions, and tool actions.
- `RecordingLlmClient` preserves partial and failed attempts. A failure after
  usage is still billable evidence.
- The lifecycle ledger is attributable; registry events distinguish initiator
  from target. Cache hits have their own event kind.

## Proof attestation

- `forkBranch` wraps `ctx.tools` per branch (mirroring how it wraps `ctx.llm`)
  and appends transport-observed observations to ONE run-scoped log shared by
  reference across every fork. Branch identity comes from the wrapper the fork
  created; never from an ambient "current actor", which races the moment two
  lanes run at once.
- `attestingExecutor` UNWRAPS before wrapping (`baseExecutorOf`). A nested fork
  that stacked wrappers would append one call under every ancestor branch, and
  coverage would then find an observation in a branch that never made it.
- The attestation is a CORRECTNESS path and the trace is an OBSERVABILITY one,
  on the same seam: a failed attestation degrades the observation to unattested
  and says so, a failed recording is swallowed. Neither ever fails a tool call.
- The log is memory only. It is not a store, and cross-run proof reuse is out
  of scope by construction.

## Jev decisions

- `src/core/jev.ts` is the ONE Jev (TypeSafe) client and the `JevDecider` built
  on it ([owner decision](../../docs/jev-decisions-2026-09-28.md)). Jev answers
  typed questions and generates no text: it is not a tier model and is never
  routed through `LlmClient`. Routing/validation follow
  [src/atoms](../atoms/AGENTS.md), compilation follows
  [src/skills](../skills/AGENTS.md); a `null` from the decider always means
  "the model decides".
- EVERY run holding the key lets Jev decide, whatever its organisation, unless
  the platform switch `ATOMA_JEV=0` is set (owner decision 2026-09-30):
  `jevEnabled` is the host's test, `jevDeciderFromEnv` the run's. How the key
  reaches a project run is stated in [src/projects](../projects/AGENTS.md).
- It is priced with `estimateCostUsd` on `JEV_PRICES`, recorded on its own
  `jev` event, and kept out of the run's LLM totals. A decision waits at most
  `JEV_DECISION_TIMEOUT_MS`; after `JEV_MAX_FAILURES_PER_RUN` failed calls —
  counted over the run, never reset by a success — a run stops asking.
- `jevAsk` retries a 408, 429 or 5xx ONCE, honouring `retry-after-ms` or
  `retry-after`, and only when the wait still leaves room for an answer before
  the decision's deadline; a request retried into an answer is not a failed
  call. `JEV_MODEL` is the versioned id, never `jev-latest`: the alias moves on
  release, and a threshold is measured on one version.
- `src/core/jevQuestions.ts` holds the questions TypeSafe's documentation
  prescribes — atomic Choices and Nouls, problem flags where TRUE is wrong, a
  middle band left to the model — and EVERY threshold they are read against,
  in one file. The decider asks them since 2026-09-29, at thresholds
  `atoma_jev_calibrate` ([src/mcp](../mcp/AGENTS.md)) measured on the model's
  recorded decisions; the 2026-09-28 questions (`legacy*` in `jev.ts`) stay
  as the baseline every calibration compares with. A question or a threshold
  changes with a measurement, never by feel, and each is written up in the
  decision record with its numbers.
- A root Choice (`scope: root`) is binding: it keeps the existing confidence
  and absolute-fit thresholds even if the caller attributes it to tier 3.
  The weaker L3 child-routing hint is never used to select a root tissue.
  Its bounded repository context and scope are included in the policy key.
- The `compile-skill` questions use the same bounded client, cost accounting
  and trace events. Their 0.2/0.8 band was retained after the 2026-10-01
  production sample: 14 labelled recipes, 3 evaluations each, no observed
  false postponement, and 3 deferrals. Labels are reviewer judgments, not
  executed-script proof; mock tests establish retry/fallback behavior
  ([measurement](../../docs/jev-decisions-2026-09-28.md#compilation-eligibility-owner-decision-2026-10-01)).
- The AUDIT keeps Jev measured once the model no longer sees its approvals:
  `JEV_AUDIT_RATE` of them are also judged by the model validator in the
  background (`createJevAudit`, carried as `RunContext.jevAudit` and forwarded
  by `forkBranch`). The runner awaits the audits still in flight, at most
  `JEV_AUDIT_SETTLE_MS`, before it closes the trace; one that fails or
  outlasts the bound is dropped. Each audit is one model call on the run's
  bill, and it never changes a decision.

## Intentional choices and rejected shortcuts

- Reusing `src/auth/codexAppServer.ts` for tool sessions: refused. It is the
  account client: it answers no server-initiated request and serves personal
  profiles only. The supervisor's session carries mender and analyst policy.

- Jev in `modelCatalog.json`: refused. Its vendor in `MODEL_SELECTOR_VENDORS`
  would make `api:typesafe:*` a routable tier selector that no transport
  serves; its one price stays beside its one client. A first-class evaluator
  would enter the catalogue through a typed evaluation operation.
- The Jev event's `error` field: refused, it is `failure`. The analyst's
  digest reads any event carrying `error` as a RUN error, so a Jev outage
  would have become defect verdicts and mender pull requests against a run
  that did nothing wrong.
- `DEFAULT_LIMITS.maxExecIterations` and its comparison are pinned by tests;
  change semantics only with an explicit migration of the effective budget.
- A runtime price overlay beside `modelCatalog.json` (a host file or env the
  server reads): refused. Two price sources is the drift the catalogue ended;
  auto-deploy already makes a reviewed commit the fastest safe update path.
- Applying the reference's prices or new models automatically: refused. The
  reference is a community aggregator and has been wrong (Qwen cache rates,
  missing cache prices read as "no discount"); which models an organisation
  may pick is a product decision. `refresh` proposes, `--apply` is a person.
- One transport named `openai-compatible` keyed by base URL: refused. The
  router maps a TRANSPORT to one client, so one transport for seven vendors
  would mean one key for seven vendors — a routing error that bills the wrong
  company.
