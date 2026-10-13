# atoma features

An inventory of what atoma does today, grouped by area. Each item names the
surface it lives on (console, MCP, CLI) and links the guide that explains it.
The [README](README.md) is the introduction; [How atoma works](docs/how-it-works.md)
is the architecture. Items marked **beta**, **opt-in** or **experimental** are
called out where they appear.

Contents: [Runs](#runs) · [Verification](#verification) ·
[Models and payers](#models-and-payers) · [Jev decisions](#jev-decisions) ·
[Learning](#learning-agents-skills-and-trust) · [Projects](#projects) ·
[GitHub](#github) · [Previews](#previews) · [Web console](#web-console) ·
[Integrated assistant](#integrated-assistant) · [MCP](#mcp-server) ·
[Identity and organisations](#identity-and-organisations) ·
[Notifications](#notifications) · [Platform administration](#platform-administration) ·
[Self-review](#a-platform-that-reviews-its-own-runs) ·
[Execution and isolation](#execution-and-isolation) ·
[Operator CLI](#operator-cli) · [Self-hosting](#self-hosting-and-operations)

---

## Runs

- **One goal in, finished work out.** A run turns a natural-language goal into
  software (web apps, HTTP APIs, CLIs), documents, reports, data studies, media
  or a text answer.
- **Three agent tiers.** Planners (L3 *tissues*) break a goal into phases,
  supervisors (L2 *cells*) route and judge each phase, workers (L1 *molecules*)
  are the only agents that call tools (*elements*). Every hand-off uses the same
  plan → judge plan → execute → judge result protocol.
- **L3 first, by default.** Every run, from the CLI, MCP or a project
  launch, starts at L3: a planner chosen for the task decomposes the goal.
  `--depth short` (or `depth: "short"` on a project run) enters at L2 instead,
  and deepens once through L3 if supervision exhausts its retries, keeping its
  deadline, accounting and starting workspace.
- **Task-driven root agent.** The goal and the starting repository choose the
  root planner; a run can build, maintain, analyse or explain a repository
  ([tissue routing](docs/tissue-routing-2026-10-02.md)).
- **Sequential and parallel phases.** Sequential plans thread each phase's
  summary and outputs into the next; orthogonal work fans out in parallel, with
  concatenation or model synthesis as the join.
- **Acceptance criteria approved before launch.** Up to twelve criteria per
  run, from the console, MCP or `--criteria <file>`. A line such as
  `GET /api/items` becomes an HTTP check; other lines are judged by review.
  Criteria are stored immutably before planning. Without them, the run drafts a
  checklist with one call to the cheapest tier
  ([acceptance checklist](docs/acceptance-checklist-2026-09-25.md)).
- **Incomplete runs are kept.** A run cut by its budget or refused at delivery
  after one remediation pass lands as *incomplete* (`partial`): finished phases
  stay, the console explains why it stopped and what to do next, and the next
  run of the project continues from it.
- **Pause and resume.** Deep project runs checkpoint after each validated phase.
  “Pause after the current phase” and “Resume saved work” continue the saved
  plan in a new process with the remaining budget
  ([checkpoints](docs/run-checkpoints-2026-10-08.md)).
- **Client questions mid-run.** A sequential project run can stop at a phase
  boundary on a blocking choice; the requester answers through MCP and resumes
  ([client decisions](docs/client-questions.md)).
- **Comparison reruns.** Rerun a delivered or incomplete run on other models
  with the same goal, criteria and starting workspace, then compare cost, time
  and result side by side. Reruns never publish and never seed a later run.
- **Text results carry forward.** A follow-up run receives the earlier answers
  along its seed lineage, so a question can build on a previous result.
- **Short run titles.** Every ended run is named with a short title.
- **Budgets and watchdog.** Each run has a wall-clock budget, abort signals and
  a watchdog; token and spend ceilings stop further model calls and keep the
  completed phases.

## Verification

- **Evidence, not claims.** Supervisors re-read the files a worker claims,
  load pages, and cross-check the worker's own records. These probes cost no
  tokens, and a hard contradiction removes any trust shortcut.
- **No replay of model-written commands.** Execution tools record commands,
  exit codes and output in a machine-readable probe manifest
  (`.atoma-probes.json`); supervisors read it instead of re-running shell.
- **Browser checks.** `validate_html` loads a page in headless Chrome at the
  viewport widths the goal asks for, reports console errors and drives
  interactions as a person would: clicks, keyboard input, drop-downs, sliders,
  date and colour fields, file uploads and real reloads.
- **Inherited regression checks.** For an existing static page, browser checks
  recorded by earlier runs are replayed before editing and again before
  delivery; the final review separates requested changes from lost behaviour
  ([replay contract](docs/inherited-checks-replay-2026-10-01.md)).
- **Independent delivery review.** A final check judges the result against the
  goal and each acceptance criterion; an approval that finds a criterion unmet
  is refused. The judgements are kept with the run.
- **Read-only phases stay read-only.** Verification phases snapshot the
  workspace and restore anything their tools changed.
- **Escalation.** Repeated rejections revoke the agent's trust, create a
  narrower variant with one clean attempt, and fall back to the supervisor
  doing the work itself, visibly stamped as fallback-produced.

## Models and payers

- **One selector per tier**, of the form `<api|sub|own>:<vendor>:<model>`, for
  workers, supervisors and planners independently.
- **Eleven model sources.** Anthropic, OpenAI, Google DeepMind, xAI, Meta,
  Mistral, Alibaba Qwen, DeepSeek, Moonshot, Z.ai and a self-hosted Ollama.
- **Three ways to pay.** `api:` bills an API key (the organisation's own key or
  the host's); `sub:` uses the host's Claude or ChatGPT subscription; `own:`
  uses the member's own ChatGPT account, or their own Claude Code token
  (**beta**, [decision](docs/personal-claude-beta-2026-10-08.md)).
- **Personal model discovery.** Settings lists the models the member's own
  ChatGPT account actually offers ([guide](docs/personal-model-discovery.md)).
- **Host subscription delegation.** The operator can let named members spend
  the host subscription without making them administrators
  ([contract](docs/subscription-delegation-2026-09-22.md)).
- **Organisation model defaults.** Admins set per-tier defaults and bring their
  own provider keys.
- **Versioned price catalogue.** Offered models and per-token prices live in
  one file with a dated price history; `npm run models -- refresh` reports
  drift and appends changes.
- **Served-model accounting.** Every run records the models it was pinned to
  and the models the provider actually served, with tokens, cache use and cost
  per call under one cost formula.

## Jev decisions

TypeSafe's Jev takes bounded, structured decisions beside the model tiers
([architecture](docs/how-it-works.md#jev-bounded-decisions-beside-the-model-tiers)).

- Chooses the root planner, the worker for a task, and the recipe to apply.
- Approves eligible intermediate plans and results once the mechanical gates
  allow it; final delivery acceptance stays independent of Jev.
- Keeps semantically equivalent recipes and agents out of the catalogue.
- Sets the reasoning effort of a worker's execution.
- Uncertain or unavailable answers fall back to the model; each decision has a
  short deadline and a per-run failure cut-off.
- Decisions, latency and their separate cost appear in the trace and the
  console. A sample of Jev approvals is re-checked by the model in the
  background, and platform admins can calibrate thresholds against recorded
  decisions (`atoma_jev_calibrate`).
- On for every organisation when the host has `TYPESAFE_API_KEY`; `ATOMA_JEV=0`
  turns it off platform-wide. Progressive recipe ranking is **experimental** and
  off by default.

## Learning: agents, skills and trust

- **Persistent agent registry.** Agent types are stored with full version
  history, curated names (molecules, cells, botanical tissues) and trust
  counters. Types can be amended, branched into variants, rolled back or merged.
- **Earned trust.** Agents that keep succeeding skip some model reviews while
  keeping the mechanical checks; one failure revokes the shortcut. Every trust
  change is written to an append-only ledger in the same transaction.
- **Skills.** Verified work is distilled into reusable recipes (`SKILL.md`),
  split into a build half and a verify half, and injected into matching tasks.
- **Compile at learn.** A recipe that is mechanical is compiled into a script
  as soon as it is learned. The script runs on its first match with zero model
  calls, is checked against a strict output envelope and the files it must
  change, and is demoted back to its recipe after two contract failures
  ([decision](docs/compile-at-learn-2026-09-26.md)).
- **Learning after approval.** Lessons are saved only after root approval, and
  outside the delivery path so they do not delay it
  ([approved learning](docs/approved-learning-2026-10-11.md)).
- **One commons.** Every run on an instance, whichever organisation started
  it, reads and earns trust on the same registry and skill catalogue
  ([shared-learning terms](docs/platform-commons-terms.md)).
- **Registry and Skills views** let every member browse the agents and recipes
  their runs use.

## Projects

- **Organisation-scoped projects** holding their run history, workspaces,
  traces and deliverables.
- **Project sections**: conversation, runs, live preview, saved files and the
  latest result, with an overview column showing cost by model tier.
- **Continuation.** A project created in atoma starts each run from the last
  delivered or incomplete workspace; `baseRunId` iterates from a specific saved
  version.
- **Versioned project context.** Project briefs and client-confirmed decisions
  are versioned, attributed and captured per run; model suggestions stay
  proposals until confirmed ([project context](docs/project-context.md)).
- **Client acceptance before publication.** A delivery waits for the client's
  testing and explicit acceptance before anything is pushed to GitHub.
- **Document and code search.** Earlier deliverables, including Markdown, CSV,
  PDF and Office files, are indexed through Haystack; TypeScript/JavaScript
  sources expose symbols and resolved imports. Runs search them with
  `search_project_docs` and cite exact passages; clients use `atoma_run_search`
  ([code retrieval](docs/code-retrieval.md)).
- **Run diffs.** Compare saved file inventories between runs, with collapsible
  split diffs.
- **Run queue.** Project runs are admitted with a configurable host capacity,
  one at a time per organisation.
- **Retention and admission** tooling for hosted instances
  ([maintenance](docs/project-maintenance.md)).
- **Public showcase** (**opt-in** per project). Delivered runs can appear on a
  public home page, classified by delivered file format; projects are hidden by
  default.

## GitHub

- **GitHub App** installation, separate from login
  ([setup](docs/github-app-setup.md)).
- **Import** an existing repository into a project (with explicit import
  exclusions), or **create** a new repository with a chosen visibility.
- **Publication.** A delivered, accepted run is committed on top of the last
  one, with a commit message that explains it; publication is idempotent and
  can be retried.
- **Repository sync.** Changes committed outside atoma are read back before the
  next run, and client edits are protected at publication instead of being
  overwritten. Fork projects can follow their upstream.

## Previews

- **Ephemeral, isolated previews** of delivered web results (static sites and
  Node servers), on a separate domain with short-lived access claims
  ([preview deployment](docs/preview-deployment.md)).
- **In-flight snapshots.** Preview a run while it is still building.
- **Test in terminal.** A delivered CLI opens in a browser terminal with Node,
  bash and a real PTY; import a test file, run commands, restart from the
  delivered bytes ([CLI preview](docs/cli-preview.md)).
- **Egress control.** Preview egress is denied by default; an organisation
  admin can approve hosts a delivered project requests.

## Web console

- **GPU-rendered console** (WebGPU with WebGL fallback), on desktop and mobile,
  with a frozen classic fallback UI.
- **Live run timeline.** Follow agents as they plan, write files, start
  servers and check work; filter to LLM calls to see the agent, model, tokens,
  cache use, duration and cost of each step.
- **File viewer** for delivered files: images, audio, video, PDF, Office
  documents, EPUB, email, diagrams, mind maps, CAD drawings, 3D models, GIS
  data, archives and text.
- **Views.** Projects, Runs, Registry, Skills and Docs for members; Burn-in
  economics for operators; Live runs, Organisations, Journal, Ledger, Sentinel
  and Announcements for platform admins; Settings for everyone signed in.
- **Thirteen interface languages**, appearance themes, reduced-motion support,
  accessible alternatives to canvas views, browser Back/Forward navigation, and
  automatic refresh of idle clients after a deployment.
- **Installable web app** with a service worker.

## Integrated assistant

- **Talk to Atoma** from Projects: describe a new project or a change; the
  assistant reads the saved brief and latest run and prepares a proposal.
- Project creation and run launch each have their own confirmation button.
- Funded by the member's ChatGPT or Claude (**beta**) subscription, the
  organisation's API key, or a configured platform connection; its usage is
  accounted separately from runs ([guide](docs/integrated-assistant.md)).
- **Continue in Claude or another agent** copies a continuation prompt;
  conversations move both ways between atoma and an MCP client.

## MCP server

One HTTP MCP endpoint at `/mcp` ([authorization guide](docs/mcp-oauth.md)).

- **Two protocol revisions** on the same route: 2025-11-25 (sessions, replay,
  subscriptions) and 2026-07-28 (stateless, tasks extension, finished-run
  subscriptions).
- **Sign-in** through OAuth browser consent, including Client ID Metadata
  Documents and dynamic registration, or a bearer API token minted in Settings.
- **Role-tiered catalogue**: each caller sees the tools its role admits.
  - *Viewer*: list projects, runs and GitHub installations; check readiness;
    run status, trace, preview and notifications; list and read delivered
    files; search saved code and documents; compare runs; read project context
    and blocking questions; review a delivery; read what a project's runs
    learned (agents created and credited, prompt patches, skills, acceptance);
    browse the registry and skills.
  - *Member*: create projects; start, pause, resume and cancel runs; answer a
    client question; record project context; accept a delivery and publish it;
    retry a publication; read and share assistant conversations.
  - *Admin*: organisation members, organisation model defaults, showcase
    visibility.
  - *Platform*: operator runs, retrieval benchmarks, skill statistics, review
    and lifecycle (reset, drop, merge), registry rollback and merge, ledger,
    costs, friction, post-mortem verdicts, sentinel and MCP health, the
    platform journal, all organisations, Jev calibration and subscription
    delegates.
- **Long runs as tasks.** A run start survives a client reconnect; re-sending
  the same call re-attaches to the live run.
- **Inline run view** for hosts that support MCP Apps; every client keeps text
  results and file resource links.
- **Goal prompt** (`atoma_goal`) to help draft a goal for the person to approve.
- **Claude Code plugin** installable from this repository's marketplace, with
  a goal-drafting skill and a read-only trace-reader agent
  ([plugin](plugins/atoma/README.md)).
- Listed in the **MCP Registry** as `run.atoma/atoma` ([`server.json`](server.json)).

## Identity and organisations

- **OAuth login** with GitHub, Google or ChatGPT.
- **Organisations.** A first login creates a personal organisation; one-use
  invitations join an existing one. A person can belong to several
  organisations and switch accounts and active organisation.
- **Roles**: viewer, member, admin, owner, plus an instance-wide platform-admin
  flag granted only from the operator CLI.
- **Settings**: MCP access and API tokens (shown once, revocable), personal
  subscriptions, organisation models and keys, platform run limits.

## Notifications

- **Notification tray** behind the header bell.
- **Web push** for run events, asked for during a member's first live run;
  clicking a notification opens its run.
- **Operator announcements**: written once, translated by a model, reviewed in
  every supported language by the admin, then sent to a chosen segment of
  organisations.

## Platform administration

- **Run limits without redeploying.** Default and maximum run budget, token and
  spend ceilings, watchdog grace, per-call CLI ceilings and tool-iteration
  limit, set in Settings or with `npm run settings` and applied to new runs.
- **Audit journal** of attributable control-plane events.
- **Live runs** across every organisation.
- **Organisations and invitations** management.
- **Ledger** view of trust and lifecycle events.

## A platform that reviews its own runs

([supervisor design](docs/supervisor-design.md))

- **Sentinel**: a mechanical, model-free live watch over runs in flight for
  cost overruns and drifting trajectories, hosted by the console server.
- **Analyst**: a read-only post-mortem verdict for each finished run, with
  every finding citing its evidence.
- **Mender**: turns a verdict that names a code defect into an isolated, checked
  change and opens a pull request; a person reviews and merges it. Admins are
  told when the mender refuses its own fix.

## Execution and isolation

- **Workers' tools**: write, edit, read and list files; run a shell command;
  record a verification probe; start a static or Node server; fetch a URL;
  validate a page in a headless browser; search project documents.
- **Sandbox**: path jail with symlink resolution, credential-stripped
  environment, throwaway HOME, process-group cleanup on every exit path, tool
  scope enforcement and output truncation.
- **Containers.** Project runs execute tools in a disposable container with
  only the workspace mounted and no network. Local operator runs opt in with
  `--container`.
- **Egress allowlist** (**opt-in**, `--egress`): per-run private network with a
  default-deny host allowlist. The operator can instead allow every public
  Internet destination (`ATOMA_EGRESS_ALLOWLIST=*`); private, loopback and
  link-local networks stay unreachable.
- **Launcher service**: the only component holding container-engine access,
  behind closed, versioned profiles ([launcher](docs/launcher-service.md)).

Local runs without `--container` do not isolate the shell from the host; see
[the safety model](docs/how-it-works.md#7-the-safety-model--what-is-actually-enforced).

## Operator CLI

| Command | What it does |
| --- | --- |
| `npm run run:build -- "<goal>"` | Run one goal locally (`--container`, `--egress`, `--depth`, `--criteria`, `--pause-after-phase`) |
| `npm run projects` | List projects, create one, run a project goal as a member |
| `npm run auth` | List identities, invite, grant or revoke platform admin |
| `npm run settings` | Read and set platform run limits |
| `npm run models` | List offered models and prices; refresh the catalogue |
| `npm run registry` | List, show, history, rollback, merge agent types; migrate taxonomy |
| `npm run skills` | List, stats, show, reset, drop, merge skills |
| `npm run ledger` | Tail the lifecycle ledger; check its integrity |
| `npm run doctor` | Quota-free readiness checks (`--container`, `--preview`) |
| `npm run sentinel` / `analyst` / `mender` | Run the self-review services once or resident |
| `npm run burnin` / `curriculum` / `benchmark` | Measure runs in batches, propose next tasks, run pre-registered benchmarks |
| `npm run friction` | Report recurring tool failures from stored traces, without model calls |
| `npm run backup -- --dest <mount>` | Dated, pruned off-machine backup of stores, skills, runs and projects |
| `npm run deploy:preflight` | Read-only deploy gate that waits for live runs and previews |
| `npm run i18n` | Check, repair and translate interface catalogues |

## Self-hosting and operations

- **Packaged stack** with web, worker, launcher and preview images
  ([packaged stack](docs/packaged-stack.md)).
- **Automatic deployment** of every green CI run on `main`, guarded by the
  deploy preflight ([deployment](docs/automatic-deployment.md)).
- **Release check**: one command covering docs, types, lint, audit, build,
  compiled MCP and auth smokes, and the test suite.
- **Generated documentation facts**: README figures and the architecture
  diagram are derived from the checkout and checked in CI.
- **Open source** under AGPL-3.0-only, with a commercial licence available
  ([license](LICENSE), [CLA](CLA.md)).
