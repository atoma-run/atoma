# Supervisor — AGENTS.md

`src/supervisor/` owns the three supervisor stages that spend model quota:
the ANALYST (post-mortem verdicts on finished runs), the MENDER (a cited
defect verdict becomes a pull request on `main`) and the ASSAYER (a learned
recipe judged by two ordinary runs per credited task, with and without it).
Stages 2 and 3 of [`docs/supervisor-design.md`](../../docs/supervisor-design.md)
and stage 4 of [the assay record](../../docs/skill-assay-2026-10-15.md);
stage 1, the sentinel, is its own subsystem because it holds no LLM and no
power.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/contracts`](../contracts/AGENTS.md) — the verdict and mend schemas, and the JSON Schema derived from them
- [`src/platform`](../platform/AGENTS.md) — the journal every stage action lands in
- [`src/sentinel`](../sentinel/AGENTS.md) — the bounded trace reader this reuses, and the stage that never spends
- [`src/mcp`](../mcp/AGENTS.md) — the run lease the idle predicate peeks at
- [`src/cli`](../cli/AGENTS.md) — `analyst` and `mender`, two of the hosts
- [`src/viz`](../viz/AGENTS.md) — the gated server that hosts the resident analyst
- [`src/projects`](../projects/AGENTS.md) — the tenant corpus the analyst reads

## Automatic Compute verification

The resident assayer first drains `computeValidation.ts`: new, explicitly eligible
withheld device observations coalesce to one attempt per ended source run. The
primary store owns the queue and atomic ledger admission. No historical backfill.
The same idle/deployment gate, exclusive lease and preemption apply; the child
process group is attached before it can outlive its owner. Interrupted attempts
are not automatically retried. Host policy bounds each attempt to 15 minutes, 1,000,000 billable
tokens and $0.25 API-equivalent consumption. In-flight calls may exceed consumption
stops. The owner removed the rolling daily start ceiling on 2026-10-28; each
eligible source still receives one automatic attempt. Legacy never-started `budget-wait`
rows enter ordinary FIFO admission without operator exceptions; historical
approvals remain audit data. The longer deadline lets execution and full result
review complete, while cost, token, lease, preemption and platform stops remain.

An ordinary hosted run starts from the complete initial state captured by
`run/initialState.ts`, never the device's finished output. Capture streams the
prepared workspace before backend/probe work: hidden files, executable modes,
relative internal links, read-run copies and preserved dependencies included.
The primary product store owns both sealed bytes and immutable data-only launch
context (prior text/landing, project guidance, repository preparation, inputs,
checklist and any continuation plan/prefix). Provider credentials, model pins,
process identities and connector grants are never replayed. External connector
launches remain blocked. Scope, membership, project state, byte integrity and
read-run retention are checked before admission. Legacy seeded runs lacking a
complete capture stay blocked; historical missing bytes are never invented.
Validation restores the same bytes at launch and deepening with a container worker,
the ordinary host-controlled egress proxy and current host models/controller.
The host allowlist and private-address denial remain authoritative; device network
settings and credentials are never inherited. Network-disabled validation was
removed after it prevented clean dependency installation on Attica (2026-10-28).
Continuations use a fresh checkpoint
with the captured plan/prefix and historical-only archives: no source claim,
spend, process, counter or execution credit is restored. The original receipt
remains withheld. Only newly observed hosted work can affect the commons.
Logs cannot establish completion: host trace metadata and index must agree.
Snapshots share checkpoint GC and the run's retention; expiry invalidates captures
containing expired read-run copies. Pending validations hold their source and
references; cleanup handles read-only directories and always releases the lease.
Explicit platform retries use the existing queue, gate, lease, budgets and host
runner. They require a complete retained capture, preserve the prior job metadata
and ledger, and place new logs, traces and workspaces under
`compute-validation/<source>/attempts/<attemptId>/`; legacy source directories are
never rewritten. Durable principal-scoped keys return the same attempt receipt,
including its terminal verdict after subsequent retries. Claim, runner authority
and finish are fenced by attempt id. Compatibility 3 drains older executors
before retry writers activate: those executors cannot fence attempts or preserve
separate retry evidence. It also retains compatibility 2's initial-state GC refs. The ledger retains status, cost
and independent counter/recipe changes.

## Three risk profiles, one boundary between them

- The SENTINEL watches live and holds no LLM. The ANALYST holds an LLM and no
  power beyond a verdict file. The MENDER holds write power over a worktree
  and never reads raw trace prose. Nothing here collapses two of these into
  one process: a resident LLM watcher would be the top injection surface in
  the system holding power (design §"Why not a resident LLM watcher").
- ONE IDLE PREDICATE (`activity.ts`), checked before reserving the shared run slot. It is built from the repository's existing facts — the operator
  index through the sentinel's bounded reader, liveness through
  `isIndexEntryLive`, the MCP lease through `runLeaseOwnerLive` (birth identity, not pid) — and never from a
  parser on the runner's stdout. A torn index read counts as ACTIVE, and so
  does a deployment waiting for the slot (`peekDeploymentPending`): without
  it the mender took the slot back the instant each mend released it, and two
  deployments in a row were refused (2026-09-27). The acquisition refuses
  such a taker too; the predicate is the same fact read before any work.
  Two stages with two predicates is how one of them ends up spending beside a
  batch.
- ONE SCHEMA PER SHAPE, in `src/contracts`: `supervisorVerdict.ts`,
  `supervisorMend.ts`. The JSON Schema a headless session is held to is
  DERIVED from the zod schema by `contracts/jsonSchema.ts`, which throws on
  any zod node it cannot express — so a contract that outgrows the converter
  fails the suite rather than shipping a schema the model was never held to.
  Never hand-write the JSON twin.
- ONE SELECTOR PER STAGE (`session.ts`): `ATOMA_ANALYST_MODEL` and
  `ATOMA_MENDER_MODEL` hold a full `<api|sub>:<vendor>:<model>`
  ([src/contracts](../contracts/AGENTS.md) `modelSelector.ts`), the mender
  borrowing the analyst's WHOLE selector when it has none, and neither has a
  default. The selector names the session: `sub:anthropic` and `api:*` run
  Claude Code (login, or `ANTHROPIC_API_KEY` / `ZAI_API_KEY` scoped to the
  child), `sub:openai` runs Codex. A model id can no longer be paired with the
  other stage's endpoint, because there is no separate endpoint variable; the
  retired `_TRANSPORT` / `_BASE_URL` / `_AUTH_TOKEN` are refused by name. An
  alias resolves to another model next month and the recorded cost stops
  meaning what it said, so aliases are warned about. The credential is scoped
  to the child session's environment and never exported at platform launch,
  which would reroute the runs' own Claude transport.
- COST IS RECORDED FROM WHAT WAS SERVED (`modelUsage`), never from the
  requested id — the same lie `servedModel` prevents in the product's traces.
  A pin absent from what was served is warned about as "not comparable".
- CODEX IS EXPLICIT (`sub:openai:<model>`, likewise MENDER). It requires
  ChatGPT subscription auth and rejects API-key profiles: `api:openai` is
  refused at resolution. Each session gets a fresh auth-only
  profile under the shared Codex HOME lease; rotated credentials are copied
  back atomically after the process/container has been reaped, on errors too.
  Codex reports tokens and the model resolved by thread/start, but no price:
  cost stays null. USD ceilings are Claude-only; both retain wall-clock limits.

## Where each stage runs

- Production hosts the sentinel in the web process. With independent execution,
  the selected executor hosts the resident analyst (`ATOMA_VIZ_ANALYST=1`) and
  assayer, drains their in-flight work, and admits no new background job after
  demotion; the legacy path still hosts them in viz. A SEPARATE `atoma-mender.service` uses a
  dedicated clone. This shared-host arrangement was explicitly selected by the
  operator on 2026-09-06; it replaces the GitHub Actions mender.
- Verdicts and mend records persist under `ATOMA_SUPERVISOR_DIR`, outside
  releases. The mender resumes every unrecorded eligible finding after restart;
  busy findings stay pending, completed or failed attempts require an explicit
  retry. No dispatch credential or auth-secret rotation through GitHub is needed.
- Analyst and mender reserve the existing machine-global run lease, without
  stale recovery, throughout their work and cleanup — reclaiming only a dead
  owner's row that recorded no process group, as a killed one of them leaves
  (nothing to reap; logged as `reclaimed`). Product admission and
  deployment use that same slot, and the two never run together on the 4 GB
  host. Since the owner decision of 2026-09-27 a member's run PREEMPTS the
  resident ANALYST instead of being refused behind it: the coordinator asks
  `yieldForRun`, the session's process group is terminated through its abort
  signal, the lease released, and the analysed run keeps its place and its
  one attempt (`preempted`). Three member starts were refused 409 in one
  production session after every run (2026-09-26). The mender, holding a
  worktree and a push, is never preempted: a run is still refused behind it.
  Known limit: the preemption comes at lease time, before the start's later
  refusals (capacity, a duplicate, a changed connection), so a start refused
  there still costs the analysis its session; it restarts from scratch.
- The mender model and checks stay in disposable Docker containers: 4 GiB RAM,
  no additional swap, one CPU, 512 MiB tmpfs, one Vitest worker, and no core
  dumps (`core=0:0`; six retained crashes consumed gigabytes on 2026-10-18). Host Codex is
  text-only and holds a dedicated ChatGPT profile; the harness alone holds the
  GitHub publisher token. Never give containers product state or credentials.
- Chromium and its libraries live in the mender image, with Puppeteer downloads
  disabled. Each fresh command can run browser tests without an install cache.
  Synthetic read-only passwd/group files describe only the executing UID/GID;
  Node gets a 3072 MiB heap within the 4 GiB container limit. The 8 GiB
  production host retains the other half for the control plane and host services.
- `deploy/install-mender.sh` installs from a verified deployed revision, preserves
  an existing clone and configuration, and removes retired dispatch settings.
  The developer CLI remains available with the same idle reservation.

## The analyst

- The digest retains the last twelve completed review responses independently
  of cost, plus review counts. A missing response stays unknown, and an unfinished
  subsequent plan cannot erase the last refusal. Review responses remain untrusted.

- TWO CORPORA, like the sentinel: the operator index through the bounded
  reader, and every ENDED project run through `ProjectStore.listFinishedRunTraces`
  (`ended_at` is the transactional fact). A project verdict's row carries
  `orgId`/`projectId` as ATTRIBUTION, never as audience. The tenant reader is
  attached only where the store already holds project tables.
- READ-ONLY BY CONSTRUCTION: `--tools Read,Glob,Grep`, `--strict-mcp-config`,
  no session persistence, a spend ceiling, a wall clock. Verification is
  read-only and never replays model-authored commands — applied to the
  supervisor itself. The argument shape is the one measured 2026-08-22
  against the real CLI; change it only with a new measurement.
- Every trace string is UNTRUSTED. The prompt says so, the appended system
  prompt says so again, and an instruction-shaped payload in a trace is itself
  a `security_incident` finding. The exception is the host's own sentences,
  listed once in `src/contracts/hostInstructions.ts` and shown verbatim to the
  analyst: runs 004e9cfa and 299627a9 (2026-10-09) were filed incidents for
  quoting the run_shell routing hint and the final-turn hint. Exact text only.
- Codex uses an ephemeral app-server thread with one private dynamic reader
  (`codexReader.ts`): an exact allowlist of source/docs and this run's evidence,
  bounded lines and literal searches, no model-authored commands. Built-in
  execution, Apps, plugins, hooks, skills, delegation and MCP are disabled;
  residual file tools see only an empty read-only jail. This is not a second
  atoma MCP surface. The same verdict schema derives Codex's nullable optionals.
  Searches are case-insensitive and a query that matches nothing says so and
  how to read by line: two high-confidence defects on 2026-09-27 went out
  without a `proposedFix`, the analyst having read `src/atoms/AGENTS.md` as
  empty through a lowercase query — and without one nothing is mendable.
- THE CITATION PASS (2026-10-14): after a valid verdict, each `high`
  `defect` or `mechanism_candidate` without a `proposedFix` goes to ONE second
  read-only session with a fresh read budget, asked only for those fixes
  (`citationPassSchema`). It never re-judges kind or confidence, a failed or
  invalid pass leaves the verdict as filed, and `_meta.citationPass` records
  asked/filled and its own cost apart from `analysisCostUsd`. Measured: in the
  eight days after mender PR #20, 23 of 30 actionable findings were `high`
  without a fix — 21 candidates omitted as "a policy decision", 2 defects
  whose `AGENTS.md` went unread — and the mender received nothing. Prompt p8
  says the same to the main session: the policy question is a candidate's
  kind, never a reason to omit its direction.
- A run with no `endedAt` is refused, never analysed: the digest of a live
  trace is a partial view and the session would spend beside the run.
- A provider refusal of the ACCOUNT (`api_error_status: 429` in the `claude -p`
  wrapper — the typed field, never the provider's prose) is `quota-refused`,
  not `session-failed`, and it ends the batch: `--once` stops and says how many
  runs it left; watch mode AND the resident host production runs give the
  run back its single attempt and pause `ANALYST_QUOTA_PAUSE_MS`. Measured 2026-09-24: without it a Z.ai five-hour
  limit spawned one session per remaining target, six 429s in seven seconds.
  Only the `claude -p` wrapper carries that typed field: a Codex session
  refused for quota is still `session-failed`, spends the run's attempt and
  does not pause, until its app-server reports a typed status to read.
- The digest carries a mechanical `trajectories` block — one row per Molecule
  execution: ordered element names collapsed, the skill it was handed, whether
  the run credited it — derived by `src/contracts/trajectory.ts`, the same
  quantity the sentinel's `trajectory-drift` row scores. The prompt names it
  as evidence for an `observation` or a `mechanism_candidate` and forbids
  designing a threshold from it; the analyst reads the digest, not the journal.
- New verdicts require an evidence-cited review of planning, delegation,
  execution, validation, recovery and learning, including delivered runs.
  Each stage reports reviewed, insufficient evidence (also budget-limited
  coverage), or not applicable. This is an analyst assessment, not an execution
  attestation. Historical verdicts without coverage remain readable; generation
  requires it through the same contract's stricter schema. Session budgets and
  finding eligibility are unchanged.
  Validation and recovery use the atoms' shared assertion-evidence guidance:
  an approval after a refusal is not itself evidence that the missing distinction
  was tested. Cite the changed assertion and observation; unavailable evidence
  stays insufficient. Source correctness and claimed test coverage are separate.
- Routing reads FINDINGS, never the grade: `mechanism_candidate` → the dated
  backlog (`supervisor/backlog.jsonl`: a design choice for a person),
  `security_incident` → `supervisor/ALERTS.jsonl` plus a console warning,
  `defect` → indexed in `supervisor/defects.jsonl` AND left in the verdict for
  the mender. That index is not a work queue and never re-derives the mender's
  eligibility, which stays in `menderPolicy.ts`; it records the facts that
  decide it, so a defect the mender cannot take is not routed NOWHERE — which
  is what it was before 2026-09-23. `runAssessment` is about this run alone; a
  `sound` run may carry a candidate.
- `defect` vs `mechanism_candidate` is decided by whether the right behaviour
  is ALREADY DECIDED, never by the shape of the remedy. Code that breaks a
  contract the repository already states is a `defect` even when the fix reads
  like a new rule — a refusal, a validation, a guard are ordinary code. A
  `mechanism_candidate` is one whose fix would mean CHOOSING the behaviour
  rather than restoring it. The prompt carries the rule, the worked example and
  the reason under-classifying is not the cautious direction; it was calibrated
  on 2026-09-23 against a backlog that had held 17 candidates and zero defects
  since 2026-09-06, one of them a probe defect fixed in `src/tools/builtin.ts`
  with a regression test the day after it was filed as a candidate
  ([incident](../../records/incidents/progressive-runs-2026-09-21.md)). Omitting a
  `proposedFix` is a decision about the proposal, never a reason to downgrade
  the kind.
- An invalid verdict is kept raw beside the verdicts and journals NOTHING: a
  row about a verdict that does not exist would be a fact about nothing.
- TRIGGER ECONOMICS are settled by measurement (design, P0 results): analysis
  costs about the run it examines, so failed and cancelled runs always, and
  delivered runs at batch end or by sampling. The quiet period is what
  coalesces a burn-in batch to its end.

## The mender

- THE POWER SPLIT IS BETWEEN THE MODEL AND THE HARNESS.
  Executable proposals (model, install, tests and checks) run through
  `menderIsolation.ts` in disposable Linux Docker containers. Build
  `docker/mender.Dockerfile` as `atoma-mender:local` first. Only the worktree
  and sanitized read-only git metadata are mounted; no host HOME, GitHub
  credential or engine socket crosses. Configure an explicit provider token;
  host login files are intentionally unavailable. Container removal precedes
  publication, including after a timeout. Tool allowlists alone are not isolation. The model edits files
  inside an isolated worktree cut at the tip of the base branch and may run
  the repository's own checks there (`--restricted`, `--permission-mode
  dontAsk`, `MENDER_ALLOWED_TOOLS`: `npm`/`npx` verification and read-only
  `git`; no MCP, no network tools). It never runs `git commit`, `git push` or
  `gh`. The harness does, AFTER its own verification. The model's report is
  recorded, never trusted.
- Codex's app-server is text-only, with the same empty jail and disabled
  built-ins as the analyst. Its private worktree_command dynamic tool sends
  model-authored commands to the existing Docker executor, with networking
  disabled and no inference credentials. Docker's default security profiles
  remain intact. Each command is bounded to 120 seconds and the remaining
  session clock; queued commands are cancelled when the session ends and
  active containers are reaped before releasing the worktree or auth lease.
  Command capture is bounded to 1,048,576 UTF-16 units per stream. Diagnostic
  Codex commands retain tails and explicitly report truncation; control
  commands (git and complete JSON results) fail and reap on overflow so a
  partial result cannot pass publication policy. JSONL messages are dispatched
  independently of transcript capture, but a single oversized line also
  terminates and reaps its producer.
  The auth-only temporary Codex HOME stays outside every command container.
  The dedicated local ChatGPT profile owns its refresh lifecycle. The host publisher token needs Contents and Pull requests write only; no Secrets permission. Never share the analyst profile or renew this profile elsewhere.
- THE EXIT CONTRACT IS THE MANUAL BURN-IN LOOP'S, proven mechanically: the
  source change is stashed (untracked files included), the new test files run
  and must FAIL, the stash is restored, and `npm run check:changed` runs on
  the changed files and must PASS — the docs check and typecheck of the whole
  tree, ESLint of the change, modified tests and statically related tests
  (the full suite for deletions or global configuration changes). A test that passes on the unfixed
  code means the mechanism is not established and the attempt is `refused`.
  The FULL `npm run check` runs in CI on the pushed branch and the pull
  request, and the ruleset on `main` requires it before a merge; the host
  cannot run it. Measured 2026-09-28 in the mender container at `0d8998d`:
  the whole-tree type-aware lint aborted at the 1536 MiB heap after 191 s
  (3.5 GiB resident unbounded), so every mend reaching the old full check
  would have been refused
  ([incident](../../records/incidents/mender-never-opened-2026-09-28.md)). The MODEL runs less still: each of its commands
  is bounded (`MENDER_COMMAND_BOUND_MS`, 120 s), so the prompt names the
  checks that fit. Prompt `m2` made a green full check its condition for
  `fixed`.
- The harness consumes `check:changed --json` (`supervisorCheck.ts`): process
  exit and validated step results must agree. Missing, truncated, malformed
  or contradictory reports refuse publication, including from custom check
  commands. Success and failure records retain per-step duration, status and
  bounded diagnostics; the PR summarizes the successful report. Diagnostic
  text never becomes instructions or another model session. Historical records
  without this optional evidence remain readable, never upgraded to JSON proof.
- Before either model session, `menderContext.ts` adds bounded navigation hints
  from the captured base's Git blobs: up to three cited source excerpts,
  lexical relative-import and filename-test candidates, and ancestor contract
  locators. Ten seconds and 14,000 characters bound retrieval. Missing context
  falls back to normal reading; it never changes eligibility or verification.
  No worktree code executes, symlinks are excluded, and source text remains
  untrusted. This is partial navigation, not inferred types or a call graph.
- WHAT MAY BE MENDED (`menderPolicy.ts#eligibleFindings`): a `defect` at or
  above the confidence floor (`high` by default) whose `proposedFix` cites the
  intentional choices it checked — and, since 2026-09-27 (owner decision), a
  `mechanism_candidate` under the same bar. A candidate's remedy is a choice
  nobody has made, so its pull request PROPOSES it: the body says so above the
  finding, the prompt asks for the smallest mechanism against every recorded
  incident, a fact before a gate, and a test for what it must not catch, and
  the choice lands in `reviewerNotes`. The person who merges makes it; there
  is still no auto-merge. Before, seventeen of seventeen findings in three
  weeks were candidates and reached only a backlog nobody drained. Watch mode
  takes candidates only from verdicts analysed since `CANDIDATES_MENDABLE_SINCE`:
  resuming that backlog held the run slot mend after mend and refused a deploy.
- REVIEW BACK-PRESSURE bounds the watch loop: at `--max-open-prs` open mender
  pull requests (`ATOMA_MENDER_MAX_OPEN_PRS`, default 3) no mend starts until
  a person merges or closes one. Each mend holds the one slot for about twenty
  minutes, refusing member runs and deployments; past the rate a person
  merges, its pull requests only queue. Counted once per poll by head branch
  (`mender/`, same repository only — a fork's branch must not hold the gate)
  through the list API, which does not lag like search. GitHub unable to
  answer HOLDS the gate, like a torn index. Explicit commands are not bounded.
- WHAT MAY BE SHIPPED (`checkDiffPolicy`): an allowlist — `src/`, `tests/`,
  `records/incidents/` — at least one test file, at least one source file, at
  most `DEFAULT_MAX_DIFF_LINES` changed lines. Workflows, deploy scripts,
  hooks, dependencies and this subsystem's own code are a person's decision.
  Anything else is `refused`, nothing is pushed, and the worktree is KEPT for
  inspection. Once commands and containers have settled, a retained worktree
  loses only its root `node_modules` install; sources, tests and evidence stay,
  and a dependency symlink is unlinked without following it.
  ONE SCOPE, TWO READERS: the patterns the harness enforces and the sentence the model reads (`MENDABLE_SCOPE`) are built from the same
  lists. Prompt `m2` told the model to record a candidate's choice "in the
  subsystem `AGENTS.md` you changed", which this policy refuses at any depth,
  and the only candidate mended in production was refused the instant its
  session ended (2026-09-27). A candidate's choice goes in `reviewerNotes`;
  the person who merges records it in the subsystem file.
- TRACE TEXT NEVER REACHES THE MODEL. `sanitiseFinding` keeps evidence quotes
  only for refs into the repository source and replaces every other quote
  with `WITHHELD_QUOTE`; the worktree has no `runs/` and no `supervisor/` to
  open. The PR body is built from the same sanitised view.
- A PERSON AUTHORS, THE HARNESS COMMITS. `ATOMA_MENDER_GIT_AUTHOR` names who
  answers for the mender's commits; the `cla` status the ruleset requires
  resolves the AUTHOR to an account, and the default `atoma mender` author is
  nobody's, so its pull requests could never go green. The committer, the
  `Authored-By:` trailer, the `mender/` branch and the pull request still say
  what wrote the change.
- ONE DEFECT, ONE PR. `defectKey` is a normalised hash of where and title and
  rides the commit and the PR body as `Defect-Key:`; a key with an open PR or
  a local `pr-opened` record is `skipped-duplicate`. An approximation,
  documented as one; calibrate it on real verdicts before trusting it.
- The pull request IS the human gate and the existing `main` → CI → deploy
  path IS the redeploy. There is no auto-merge in the code; widening waits
  for a measured count of mends merged without retouch (design, P4).
- EVERY ATTEMPT ENDS IN ONE `MendRecordOutcome`, recorded under
  `supervisor/mender/`, appended to `mender.jsonl`, and journaled for every
  outcome that touched the deployment. The lock (`supervisor/mender.lock`)
  keeps mends serial on one machine; a dead holder is reclaimed.
- A STOP ENDS THE ATTEMPT AT ITS NEXT SAFE POINT (`options.signal`, SIGTERM in
  every mode): the running install, model session, test or check is aborted
  and its container reaped, and the attempt is recorded `interrupted` — the
  one outcome that does not close its finding, which the next start resumes.
  Only a publication already under way (commit, push, pull request) finishes,
  since stopping half-way leaves a branch nobody reviews; the unit's
  `TimeoutStopSec=10min` bounds it. The old three-hour stop invited a SIGKILL
  that left the run slot held by a dead process (2026-09-27). A run still
  never preempts a mend.

## The assayer

- WHAT IT JUDGES: a recipe SURFACE (kind, `when_to_use`, body; `surfaceDigestOf`)
  that has no valid `skill_assays` result, with at least one credited task in the
  trigger corpus (`skill_trigger_samples`, [src/skills](../skills/AGENTS.md));
  newest surfaces first, event recipes never. A revision re-opens the assay;
  `--skill <ns>/<id>` re-judges on demand. A legacy row backed by demonstrably
  invalid execution evidence reopens automatically; missing or corrupt evidence
  does not authorize spending.
- HOW: up to `ASSAY_MAX_CASES` credited tasks, each run TWICE through the
  shared runner (`spawnRun`, `run:build`), on a copy of the catalog holding
  the recipe and a copy without its folder, each run on its own copy of the
  store (one online snapshot, settled to rollback mode, copied per arm), its
  own workspace and its own runs directory, with learning, promotion, event
  skills and the trigger evaluation OFF (`armEnvironment`), and on the
  resident host as `--container --egress` (`isolation`), what a project run
  gets there: an arm executes model-authored commands and never does so on
  the deployment's own filesystem; the CLI's `--container` asks the same.
  Nothing an arm does reaches the commons. The judge is the runner's machine epilogue
  (`parseRunStatsEpilogue`): delivered or not, after the same root acceptance
  every product run gets; "matched" is a runtime `skill` event (`match` or
  `direct`) in the arm's trace, never log text, which the goal is echoed into.
- THE PRE-REGISTERED RULE (`judgeAssay`, pure): cases the `with` arm never
  matched say nothing (`not-reached`); over matched cases more deliveries
  with the recipe is `helpful`, fewer `harmful`, equal `neutral`, costs
  recorded beside; RETIRE only when harmful, two or more matched cases, and
  the recipe delivered on none of them. Retirement is the ONE power: the
  registry's own `drop` (folder, then row and `skill-drop` event). Everything
  else is a record. Do not add a decision without re-registering the rule in
  the record and reviewing it adversarially.
- WHERE: `supervisor/assays/<ns>__<id>__<digest>__<attempt>/assay.json`
  (`contracts/skillAssay.ts`), the arms' logs and traces beside it, scratch
  removed; one `skill_assays` row closes the surface; one `supervisor.assay`
  journal row carries counts, verdict, decision and cost, never a task text.
- UNDER THE SAME GATE AS THE ANALYST: `anyRunActive` before, the machine-global
  lease (`assayer:<id>`, no stale recovery) during; a product run preempts it
  through `yieldBackground` (both residents are asked), the arm's process
  group is killed, an interrupted attempt is preserved and the recipe stays pending.
  An error/cancelled arm or missing trace makes the attempt FAILED, with no
  judgement or closing row; the resident pauses `ASSAYER_FAILURE_PAUSE_MS`.
  Each retry keeps the old attempt. The launcher passes a complete environment
  without project retrieval/authority/output bindings; model pins remain host-owned.
  Shared bounded `assayReaders` expose status, reports and evidence through the
  platform-only VIZ and MCP. Historical invalid verdicts are projected as failures,
  never rewritten. See [recovery](../../records/incidents/assayer-recovery-2026-10-23.md).
- HOSTS: `npm run assayer` (`--once`, `--skill`, `--dry-run`, watch) and the
  resident shell in the viz server (`residentAssayer.ts`), ON BY DEFAULT where
  the server holds the three `ATOMA_MODEL_L*` pins — the owner asked for no
  configuration (2026-10-15) — and off on `ATOMA_VIZ_ASSAYER=0`. A server
  without the pins says so in its banner and runs no assay.
- SPEND: `2 × cases` ordinary runs per recipe, each under `ASSAY_DEFAULT_TIMEOUT_MS`;
  authorised by the owner. A member's run is refused behind an arm as behind
  an analysis, or preempts it; nothing here changes product admission.

## The journal

- Kinds: `supervisor.verdict`, `mender.started`, `mender.declined`,
  `mender.refused`, `mender.pr_opened`, `mender.failed` — severities and push
  audiences forced by the exhaustive maps. `pr_opened`, `refused` and `failed`
  reach a person (platform admins): a review waiting, or a worktree left
  behind. Refusals were silent until 2026-09-28, the three weeks in which no
  mend could pass the harness's check. `skipped-duplicate`, `dry-run` and `interrupted` write no row: nothing
  happened to the deployment.
- Rows are `system`, like the sentinel's, and carry FACTS ONLY (`journal.ts`):
  grade, finding kinds, defect key, branch, PR URL, cost, model served. Never
  a finding's title, a verdict's summary or a mend report's text — those are
  model prose over untrusted material and stay in the git-ignored
  `supervisor/` records, where a reader opens them knowing what they are.
- Both CLIs journal only into a store that ALREADY EXISTS. `PlatformEventLog.open`
  applies DDL, and a supervisor must not bring a control plane into being by
  writing to it. An ungated checkout keeps its file outputs and journals
  nothing, and says so in its banner.

## Intentional choices and rejected shortcuts

- Out of product first, in product now. The analyst was validated as a script
  (P0, 2026-08-22) to settle the verdict format before touching `src/`; the
  mender landed the same way on 2026-09-05 and was moved here the same day,
  because a stage with write power needs the contracts, the journal and the
  typed tests the scripts could not have. Do not re-create a `.mjs` stage.
- `.mjs` command seams, not shell shims. `ATOMA_MENDER_CMD_*` and
  `ATOMA_SUPERVISOR_CMD_CLAUDE` accept a `.mjs` first token that runs under
  the current Node, so the pipeline tests substitute `claude`, `gh` and `npm`
  on every platform; `npm`/`npx` get a shell on Windows because they are
  `.cmd` shims, and nothing else ever does.
- The shared host holds the run lease through cleanup. It never recovers a stale lease that may still have work behind it to make background work proceed; an occupied slot defers the finding. The one row a stage takes over is a gone owner's with nothing left behind (no process group, or one that no longer exists): nothing to reap, and leaving it refused deployments and analyses for 2 h 10 on 2026-09-27.
- The idle gate is a decision, not an inference. `--no-idle-gate` is a flag
  an operator explicitly passes on a dedicated machine, never a default derived from `CI=true`: an
  environment variable that silently disabled a safety gate on a developer's
  machine would be the exact silence the run-host contract exists to end.
- The legacy optional dispatch API remains available for external integrations; the production deployment does not configure it and ships no Mender Actions workflow.
- The assayer runs WHOLE goals through the ordinary runner, not a molecule
  alone: a recipe is picked by a cell's prefilter inside a plan, so the only
  honest "with" arm is one where the plan, the match and root acceptance all
  happen as they do in production. A harness that injected the recipe into
  one molecule would measure a path no run takes. The price is `not-reached`
  cases, which are themselves the finding the trigger evaluation cannot make.
- The assayer never judges the recipe's PROSE and never replays its steps:
  the two arms are two runs, the evidence is what each delivered, and the
  supervisor's read-only rule stands. A judge model over the two deliveries
  was refused: root acceptance already is one, and the same one every run
  gets.
- Prompts are TypeScript constants (`analystPrompt.ts`, `menderPrompt.ts`),
  not Markdown assets: `tsc` ships nothing but `.js`, and a prompt the
  compiled CLI cannot find is a release-path failure typecheck never sees.
