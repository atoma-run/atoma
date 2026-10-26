# Run — AGENTS.md

`src/run/` owns the single runner: the run setup, provider construction,
workspaces and tool backends.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:

- [`src/core`](../core/AGENTS.md) — transports and model resolution
- [`src/cli`](../cli/AGENTS.md) — the shells and the burn-in harness
- [`src/tools`](../tools/AGENTS.md) — the backends it selects

## Entry points

- `startTask(argv, opts)` is the library entry: it owns provider, sandbox,
  traces, skills, budgets, the watchdog and post-mortems, throws
  `RunnerConfigError` on bad input, resolves lifecycle env against the HOST
  snapshot (a run's own writes never become the next run's "operator intent"),
  applies the same snapshot to `ATOMA_MODEL_L*` via `applyTierPins` so atom
  `modelForTier()` calls agree with the router (a missing pin is deleted, not
  left as leftover ambient state), and returns a `RunHandle {settled, shutdown}`
  that never parks and never exits. `runTask(argv)` is the CLI shell
  that owns process death: exit 2 on config errors, exit 1 on failure,
  park-forever on delivery, SIGINT/SIGTERM → shutdown. Its stdout is an API
  (burn-in parses it) — the handle refactor kept it byte-identical.
  `setup.ts` holds the run's technical setup — workspace and store env names,
  workspace preparation, the canonical child catalog (whose bootstrap also
  refreshes every template-born type, [src/registry](../registry/AGENTS.md)),
  the depth contract — and
  `guidance.ts` the one text on how to phrase a goal. THERE IS NO RUN FAMILY:
  the `TaskProfile` selected by a family id was removed on 2026-10-03, once
  `selectTissue` chose the root from the task and nothing varied between
  profiles. Neither file chooses a tissue or adds task constraints; the one
  library seam is `opts.seedCatalog`, which replaces the seeding step.
- `selectTissue` (`tissueRouting.ts`) selects the root from the task and a
  bounded host-read starting repository (`routingRepository.ts`), after the
  trace and run context exist. Decision makes a binding Choice with the existing
  confidence/fit thresholds; uncertainty, absence or outage uses one bounded
  tier-1 model call. That call may reuse an offered identity or request a new
  capability; only `platform-tissue-author` writes its reusable method, using
  the HOST's `ATOMA_MODEL_L3` and credential snapshot (`tissueAuthor.ts`),
  never the run's pins, keys or personal login. One text-only, high-effort call
  shares the run's recording and budget meter, then `createOrReuse(3)` owns
  allocation. Missing platform configuration refuses creation, not reuse.
  Tools, parameters and delegation discipline remain host-owned. A written
  tissue is registered WITHOUT host tools and `tissueForRun` lends the run's
  back to the executing L3, as Meristem's seeding patch does; kept, they hid
  a project-run tissue from every other run (review 2026-10-09 2.8). The L3,
  and a short run's entry cell and peers, are built on the run's LIVE
  declarations and hand them down to every cell and molecule they build from
  a stored row ([src/registry](../registry/AGENTS.md)).
  Repository excerpts are untrusted context, never persisted agent prompts.
  `tissues.ts` seeds the existing builder as a candidate, not a default route;
  bootstrap recognizes its provenance so a custom Meristem is never replaced.
  See [routing decision and review](../../docs/decisions/tissue-routing-2026-10-02.md).
- The three `ATOMA_MODEL_L*` selectors are REQUIRED and parsed at LAUNCH
  (`tierSelectors`, a `RunnerConfigError` on a missing or malformed pin), AFTER
  `applyTierPins` so a snapshot-only pin is what the run sees and an ambient
  pin omitted from the snapshot is not. Codex selectors (`sub:openai`,
  `own:openai`) support all tiers through the host-side action loop.
  `assertTransportHonoursCredentials` refuses every `sub:`/`own:`
  tier the parent did not authorise whenever a snapshot is supplied.
- IT NOW FIRES ON PROJECT RUNS TOO, and that is the point. It never had:
  `runTask` passes no snapshot and `spawnRun` replaces the child env wholesale,
  so on the ONE path where a payer decision crosses a process boundary the
  coordinator was the sole gate. A tenant run is marked `ATOMA_TENANT_RUN=1` by
  the coordinator, and its own `process.env` IS the supplied snapshot; the
  developer path, which sets no such marker, is untouched.
- The refusal reads `ATOMA_SUBSCRIPTION_TIERS`, the list of tiers the PARENT
  authorised for either the host or requesting principal's subscription
  (`l1`, `l2`, `l3`). A `sub:`/`own:` selector on a tier that list does not
  name reached the child another way and throws at launch, before spend. The list only ever NARROWS what is
  permitted: a forged one grants no credential, because the profile path is
  injected only by the coordinator after its host-authority or exact-principal
  check. The same authority applies to Codex L1. See
  [src/projects](../projects/AGENTS.md) for who may arm a tier, and
  `records/designs/subscription-per-tier-design-2026-08-28.md` for why.

## Run host

- A project run's Haystack preparation starts BESIDE the run, never awaited
  before the first model call (2026-10-15): Attica runs 85cc4e83 and f74c140a
  waited 361 and 389 s for a cold corpus while one molecule searched, minutes
  later. Launch-time refusals (configuration, receipt) still come first; a
  runtime preparation failure leaves search `unavailable` and the run going,
  logged as `[atoma retrieval] preparation failed`
  ([amended decision](../../docs/project-retrieval-haystack-only-2026-09-09.md)).

- Project sequential boundaries can record a client question atomically with a
  sealed snapshot, including the initial zero-phase boundary. An unanswered
  question blocks continuation; host-recorded answers travel in the checkpoint,
  never in the permanent project brief. Only the original requester can answer.
  No work is replayed while waiting. A question boundary over a tree the
  snapshot refuses degrades like `afterPhase`: continuation disabled, a warning,
  no question asked, the run goes on (code review 2026-10-09, 1.6).
  [Contract and review](../../docs/client-questions.md).

- Opt-in `--checkpoint` / `--pause-after-phase N` / `--resume ID` implement
  durable sequential continuation in `checkpoint.ts`. Same workspace for CLI,
  original plan/checklist and carried budget; fresh trace and proof log. The
  root delegation approval rides `root` in the plan's own write, bound by digest;
  an older binary reads such a checkpoint as incomplete (one-way, 2026-10-16). Only
  complete approved boundaries are restored. An interrupted phase may restart
  only with a sealed snapshot, settled model spend, no external/commons mutation
  since that boundary, and verified backend shutdown. A pausing boundary (pause
  request, `--pause-after-phase`, phase budget, client question) drains the
  backend BEFORE it seals the snapshot, so shutdown writes (JSON persistence, a
  WAL checkpoint) are part of the sealed tree and never fail `release()`
  (code review 2026-10-09, 1.1). Sealing digests the tree before its store
  transaction and captures it inside: the shared write lock covers one walk,
  not two (2.9). Deep project runs enable it automatically;
  the host binds continuation to the requester/org/project and a new run receipt,
  copies the complete sealed workspace and atomically consumes the source claim.
  A saved root actor that changed (its version moves with a deploy, another
  run's tool set or the successor's own seeding) is refused after that claim,
  so the refusal hands the untouched source back and finishes the successor in
  one transaction (code review 2026-10-09, 1.4).
  Short/parallel/comparison runs keep their ordinary lifecycle. Contract and tests:
  [durable checkpoints](../../docs/decisions/run-checkpoints-2026-10-08.md).

- `src/run/platform.ts` is the ONE definition of where a run may execute:
  `darwin` and `linux`. It is not a preference — the run is a detached process
  GROUP reaped through SIGTERM → grace → SIGKILL, and `npm` must be an
  executable. Windows stays a DEVELOPMENT host — typecheck, lint, docs:check,
  build and the compiled MCP smoke pass there; parts of the TEST SUITE are
  POSIX-shaped on purpose (they drive shells, `chmod`, `tar` and process
  groups, which is what makes them proof). WSL2 with the checkout on ext4 is
  the named way to run, and to run the full suite; the per-platform procedure
  is [`docs/development-setup.md`](../../docs/development-setup.md).
- The refusal is enforced at the LAUNCHER (`spawnRun`), before the spawn, and
  reuses the `--- spawn failed ---` log shape so every caller keeps reading
  outcome `error` with the reason in the log. Doctor reports the same fact as
  a hard failure. Both quote `platform.ts`; neither restates the list.
- Do NOT add an override switch. The defect this contract replaces was not the
  platform's limits but SILENCE — a run that died as a bare `spawn npm ENOENT`
  several processes deep, and a cancellation that reported success over
  orphans still running. A flag that starts a run where the kill sequence
  cannot work restores exactly that.
- `readOnlyPhasesFor(workspaceRoot)` (`readOnlyPhase.ts`) is the host half of
  the read-only phase ([src/atoms](../atoms/AGENTS.md)). It reads and writes
  the workspace while the tools' processes still run beside it, so no path is
  trusted between two operations: on Linux every step below the root goes
  through `/proc/self/fd/<directory fd>/<name>` and opens `O_NOFOLLOW`, so a
  directory a container replaced by a link to a host path can neither receive
  restored bytes nor lose files through it; on darwin every ancestor is
  re-checked before each change, which narrows that window without closing
  it. Names are read as bytes. A file is put back as a NEW inode, never
  written through a hard link; a created name holding a photographed file's
  inode is removed only while the photographed name is listed too (otherwise
  it is a case-only rename on a case-insensitive volume, and the file
  itself). Files are compared by their bytes, since a same-size rewrite within
  one kernel tick leaves every stat field as it was, and one modified in the
  last two seconds is read twice so torn bytes are never kept. The root's
  mode comes back first, and a directory's before its contents (through an
  `O_PATH` descriptor when its mode forbids opening it). It restores what it
  photographed first and removes what the phase added second, on a budget
  each, and removes nothing inside a directory it could not list whole; such
  a photograph is partial, and a partial one is always reported. A SQLite
  database — by its header at the photograph or NOW — and its `-wal`/`-shm`/
  `-journal`, and a file a process was writing when the phase started, are
  left as they are and reported: replacing a database under a live
  connection shipped the phase's own rows and lost another process's (review
  2026-09-30).
- A seeded static-page run replays the browser checks it inherited on the
  UNTOUCHED seed as soon as its backend exists (`inheritedChecksFor`,
  [docs/decisions/inherited-checks-replay-2026-10-01.md](../../docs/decisions/inherited-checks-replay-2026-10-01.md)),
  and `gatedExecutor` makes every tool call of the run wait for it; a
  deepening waits for it before sealing the current workspace. `runTools` also strips the
  host-replay argument from every call. The replay's own calls go to the
  backend, read through a getter because a deepening replaces it, on one
  static server per backend. Nothing is staged in the workspace: the first
  design staged a copy there, and its review broke it (a tree the run's own
  processes can still change). Caps: 40 checks, a warm-up call, 10 s a call
  (past it, that check is unrun; the third ends the replay), checks needing
  over 8 s skipped, 60 s for the start (going on while nothing waits for
  it, up to 150 s; `stopped: cap` when that ran out), 90 s per acceptance,
  and a 90 s
  verdict reserve before the deadline. The host's one write: a check whose
  two start replays lost a hook or an element, with no refused request and
  no page error, is marked dead in the run's manifest and replayed last.
  Dead again in a later run, it is removed beside a check of its page that
  passed; passing again, its mark goes. One run never deletes a check, a
  run seeded from a landed one (`PREVIOUS_LANDING_ENV`) marks nothing, and
  a deepening preserves the current manifest in place. The manifest is
  replaced through a new file renamed over it.

- `ATOMA_MCP_CONNECTORS` is read ONCE at launch, refused outside a tenant
  project run or for another project, and deleted from the process
  environment before anything is spawned; `withMcpConnectorBackend` composes
  the two connector elements after retrieval, and the runner disposes the
  connector sessions once at teardown ([src/connectors](../connectors/AGENTS.md)).
- `ATOMA_READ_RUNS` names the coordinator's read-run index, read once, removed
  from the environment and refused outside the tenant run, organisation and
  project it was written for; every manifest is re-hashed. After the seed copy,
  at launch, each entry is copied through
  `readManifestArtifact` to `.atoma-runs/node_modules/<runId>/<path>` as a new
  file with its saved mode (0755 for `100755`, else 0644; directories 0755),
  and the identity (device, inode, ctime, mode) of every copied file and
  directory, `.atoma-runs/node_modules` included, is kept; a continuation
  keeps its sealed copies and takes their identities after the restore, and
  one sealed with a copy at `.atoma-runs/<runId>` alone (before 2026-10-17) is
  a `RunnerConfigError`, its source handed back. A deepening checks those identities
  before sealing, retains the copies in place, and captures their identities again
  after the replacement backend mounts them. A mismatch refuses replacement.
  Root acceptance reads
  `ctx.readRunCopies` and `ctx.compareReadRunFiles` (the criteria texts). The
  worker mounts `.atoma-runs` read-only from its first start: before each
  backend `ensureReadRunMountPoint` (a real directory, created empty if a
  continuation lost it), and the identities are taken once the backend
  exists, before any tool call (Docker Desktop moves the source's ctime)
  ([decision](../../docs/decisions/read-runs-2026-10-17.md)).

## Workspace control boundary

- `WorkspaceRuntime` is the private async capability for routing evidence,
  delivery comparisons, read-run identities, inherited manifest operations and
  read-only guards. The runner awaits it; synchronous library contexts remain
  supported. `localWorkspaceRuntime` owns the existing filesystem algorithms.
- `workspaceService` serves the same operations over a versioned, bounded
  protocol in a separate process. It is never a model-facing tool or part of
  the element worker. `workspaceProcess` exercises that boundary locally;
  `startTask` accepts a trusted `workspaceRuntime` injection whose caller owns
  teardown. Preparation, bound-source seeding, read-run copies and deepening
  execute in that service. `createToolBackend` is the matching internal seam;
  connector and budget wrappers still belong to the host. Source provisioning and
  artifact transfers use this private channel; device admission, project
  continuation identity and coordinator finalization still need integration.
- Source imports select only a launcher-bound seed or referenced run id, never a
  path. Existing sources cannot be replaced; preparation/restoration freezes
  imports. The launcher must keep sources outside every tool mount.
- Artifact exports reuse the publication inventory, path jail and stable reads;
  private spools contain no excluded dependency or secret-like paths. The host
  receiver rejects unlisted entries and revalidates every byte before renaming
  its private staging tree. This does not approve a delivery: the coordinator
  must confirm process exit first and commit its existing delivery transaction
  only after transfer success. It must retain pending finalization on disconnect.
- Photographs and read-run inode identities stay in the workspace service.
  Restore acknowledgements are never replayed after a transport failure.
  The shipped bundle is `dist/workspace-service/service.mjs`, built from
  compiled output; `docker/workspace.Dockerfile` packages that bundle alone.
- Checkpoint imports buffer at most one bounded file. Unfinished imports have
  no snapshot row. Transfer reservations protect bytes against concurrent
  pruning for 30 minutes; attachment verifies the claimed checkpoint/owner,
  digest and reservation inside the boundary transaction. Network waits never
  hold that transaction. Expired reservations and orphaned bytes are pruned.
- Sequential checkpoints can seal through the workspace capability after
  process drain. Stable bytes are spooled privately on the execution host,
  streamed in bounded chunks and attached atomically; release verifies the
  execution-host digest without reading the host workspace path.
- Restoration uses the same `CheckpointWorkspaceWriter` for stored rows and
  transferred entries. Entries go into a private sibling directory, links are
  created last, and the existing target is archived only after digest validation.
  The runner awaits `SequentialCheckpoint.ready` before starting a backend.
  Stored exports finish each bounded SQL query before awaiting the transport.
- A service volume contains `current` plus archives; tools receive only the
  `current` volume subpath. Never try to rename a Docker mount point itself.
  Snapshot spools have a separate control volume. EOF/termination cleans up
  incomplete imports; crash-orphan reconciliation belongs to device admission.

## Platform run limits

- The runner reads the instance's run limits from the product store at launch
  (`platformLimitsFor`), REFUSES a wall-clock budget above the platform
  ceiling with a `RunnerConfigError`, arms the watchdog grace from them, and
  composes the token/spend/tool-iteration ceilings around the LLM client. The
  whole contract — precedence, the refuse-never-clamp rule, why the abort is
  not a throw — is stated once in [`src/platform`](../platform/AGENTS.md).
- `makeBaseClient` and `buildReferencedProviders` take the limits the same way
  they take a credential snapshot: PASSED IN, never read from a store here.
  An absent `limits` means the transport's own default and env var, which is
  what every caller outside a run gets.

## Provider construction

- Provider construction has one switch per TRANSPORT: `makeTransportClient`
  in `src/run/providers.ts`, reached through `buildTierClients`, which builds
  only the transports the three selectors name (`transportOf`) — consumed by
  runner, curriculum and the viz announcement translator. There is no base
  client and no `ATOMA_LLM`. A `providerEnv` snapshot must also drive the
  three `ATOMA_MODEL_L*` pins (`applyTierPins`); do not re-read `process.env`
  for pins the router already resolved from the snapshot.

## Run accounting

- Root-approved lessons are committed before delivery and processed outside its
  trace and deadline by `learningWorker.ts`. The worker has no tool backend,
  uses the shared lifecycle/provider/metrics code and the source run's remaining
  spend allowance, and writes a separate receipt and trace. A separate process
  group survives the run launcher's reap. Serial measurements can explicitly
  retain inline learning with `ATOMA_DEFER_LEARNING=0`.
  [Lifetime, recovery and review](../../docs/decisions/approved-learning-2026-10-11.md).

- New ordinary runs default to deep supervision through the selected tissue.
  `--depth short` explicitly retains direct L2 entry and selects an L3 only
  when it deepens. A project
  run passes it from its own `depth` (since 2026-09-27; a rerun keeps its
  origin's): before, only the CLI could ask for L3 from the start. Baseline
  and REGISTERED COMPARISON ARMS (`--comparison`) retain their existing
  protocol — and that flag exists because the rule read `--seed` until
  2026-09-23. Two unrelated populations pass `--seed`: a campaign arm seeds to
  hold its protocol fixed, a PROJECT run seeds to continue its own corpus. So
  every project run after a project's first silently lost `runDepthTask`, and
  with it root delivery acceptance, the ground-truth probe, the delivery proof
  floor and the attestation log. `resolveSupervisionDepth` is the one decision,
  exported and tested like `resolveSkillPromotion` beside it; the depth design
  had already settled the intent ("CLI, MCP and project launches all inherit
  it"). Depth routing keeps model pins and
  one run deadline, cost ledger and trace. Its depth contract freezes the delivery
  `proofFloor` before routing, without adding it to phase `proofObligations`.
  The depth contract uses an empty floor and semantic root review,
  rather than demanding `index.html` from every API and CLI.
  Deep enters through L3; short plans and executes
  through the canonical L2, including its peers. Every result goes through
  the same root acceptance; a refusal is handed BACK ONCE
  (`MAX_ROOT_REMEDIATIONS`) and LANDS on the second — it does not fail. The run
  keeps its workspace, records `partial`, seeds the next run of a project
  created in atoma (an imported project restarts from its default branch), and
  never publishes; measured on production run `6ab0ae3b`, which spent thirty minutes
  and 0.42 USD writing real files and recorded `failed`, so `previousSeedRun`
  skipped it on its status filter and every byte was lost. Root remediation also receives bounded same-pass host command/change observations through previousPhaseObservations (8,000 characters); no model report, fresh credit or automatic replay. The refusal
  rides in the task's `inputs` as `rootAcceptanceRefusal` — never appended to
  the description, which planning and skill matching key on — and the pass
  runs in the SAME attempt and workspace, so the attestations already earned
  still cover their deliverables (`rootProofCoverage` re-reads each file and
  compares its digest, so a proof lives exactly as long as the bytes it was
  made against). The budget is one extra pass per RUN, not per attempt: a
  deepening is already this run's second chance at a structural failure.
  A pass the wall clock cannot pay for (`outOfPhaseBudget`) is not opened.
  A pass after a pass that WROTE files (write_file/edit_file) is judged,
  recorded and published as files whatever its own plan declares
  (`filesDelivered`, 2026-10-26; a shell command alone keeps text open): run
  51c4e71d's read-only remediation declared text, the last recorded root plan
  fixed the manifest's kind, and the delivered files could be neither
  reviewed by criterion, previewed nor published.
  Measured 2026-09-23: with one pass only, a goal naming nine verifiable
  behaviours was refused twice while a goal naming six was delivered, and the
  refusals named exactly which behaviours had never been probed.
- AN APPROVED DEPENDENCY LANDING SPENDS THE SAME PASS (G1, 2026-10-16): an
  approved result whose `blockedPhases` never started, with no phase the
  budget cut, in a deep attempt with the pass and the clock left, opens it
  with `rootDependencyLanding` as its input — no refusal, no scope, every
  criterion. Short attempts never do: a deepening during the pass would
  replace the approved attempt. Counted apart (`landingRemediations`), so
  `rootRemediations` still means "sent back by the final review". The 60 s
  floor was measured for one phase, not a root pass; `unjudgedRemediations`
  counts extra passes that then ended with no verdict, which is how a root
  floor gets sized ([decision](../../docs/decisions/parent-owned-tests-2026-10-16.md)).
- A REFUSAL THAT IS ONE CRITERION IS SCOPED TO IT (owner decision 2026-09-28,
  the mender's first pull request): when the acceptor judged exactly one
  criterion unmet and the refusal holds nothing else — no gate finding, no
  probe contradiction, no unproven floor item, no other criterion uncovered
  or unjudged, or with a width not laid out — the pass also receives
  `rootRemediationScope`: that criterion and its reason, the criteria judged
  met, and the instruction to keep their deliverables and answer the WHOLE
  refusal. A fact, never a restriction: the verdict may name another reason
  in prose, which "fix only this" would have told the pass to ignore. Measured: runs `cc922a60` and `ed84d7be` were
  each refused for one narrow claim (a README URL, two leftover files) and
  their pass rebuilt the whole task, the first replacing a working page.
  Anything else keeps the broad pass: a scope that left a second reason
  standing would be refused again and land a partial. Free-form refusal
  prose is never parsed for a scope, and a refused DEPENDENCY landing never
  gets one (G1): "keep the deliverables" contradicts "complete the phases
  that never started". A refused pass's remediation phases carry only
  the criteria the acceptor did NOT judge met (`Task.criteria`, src/atoms);
  none judged leaves the whole list, all met leaves none.
- WORK IN HAND IS FINALIZED, landed or complete: its root acceptance runs to
  the absolute deadline + 45s (`finalizationSignal`), explicit cancellation
  and deepening still abort, and expiry keeps the work as a refused partial —
  never an approval, never another pass. EVERY EXIT AFTER A JUDGED PASS
  LANDS ON IT (review 1.2b, widened by G1): an extra pass the deadline cuts,
  or one that fails on its own, returns the earlier pass's result — refused
  with the error's class name appended, or approved with the follow-up's
  planned phases added as unfinished and unverified — and a failing
  acceptance of the extra pass keeps that pass's work refused. Deepening and
  explicit cancellation still end the attempt; a cancellation during the
  extra pass forfeits the seed, since teardown records `cancelled`.
  A FIRST pass the run budget cuts before any phase is accepted lands too once
  its root plan exists (`landedBeforeAnyPhase`): every planned phase
  unfinished, judged like any work in hand, and its workspace seeds the next run. On the
  thirty-minute production ceiling a phase too large for one run otherwise
  failed every time, each relaunch starting from nothing (run dfa20873,
  2026-10-03, closed its first phase only through a false trust approval).
  Cut before its root plan, cancelled, or failing on its own, a pass still fails.
- Only the first short attempt may deepen, at the existing supervision
  fallback moment after its branch retry. Cancel and drain all branches,
  confirm tool processes have exited, seal the current workspace through the
  existing bounded checkpoint export, then construct a new backend over the SAME
  files and dependencies and run the original task through L3. A changed digest,
  read-run identity, provenance or unconfirmed drain refuses replacement without
  deleting the work. The continuation input labels all retained work unverified. Deep fallbacks remain
  allowed. Gains already earned stay in this run; old attestations cannot
  cover the new attempt. Mechanical plan/result one-shot memos reset per
  attempt and stay fork-shared within it. Lifecycle settings are resolved
  once at launch and stay identical in both attempts; `--depth` does not
  override them. Both local and container backends confirm teardown before
  replacement; container removal is confirmed by the engine before egress
  teardown. An unavailable engine or remaining worker prevents replacement.
- Design and remaining measurement protocol:
  [depth experiment](../../records/experiments/depth-routing-experiment-2026-09-13.md).
- `seedWorkspace` is the ONE seed copy at launch. Deepening never re-reads a seed
  that may have expired, or overwrites work with its starting version. The copy
  filters the inherited probe manifest ([src/contracts](../contracts/AGENTS.md)),
  leaves out the seed's read-run copies (`.atoma-runs`), top-level
  `.atoma-scratch`, and installed `node_modules` at any depth (reinstalled by
  the next run; never remove them from a sealed checkpoint restore),
  and keeps other links as written (`verbatimSymlinks`): a rewritten absolute
  `node_modules/.bin` link is an escaping link to the checkpoint, which then
  disabled pause, questions and resume for every seeded Node project. What
  the publication inventory omits as byte-less (`byteLessWorkspaceEntry`: a
  dangling link, a socket, a FIFO) is never seeded, for the same reason.
- WHO REINSTALLS: the executor, told the roots (2026-10-26). `packageRootsOf`
  reads the seed SOURCE on this host, Compute included (sorted entries, only
  package.json and lockfile names; no `node_modules`, dot-directory, omitted
  build tree or link; depth 4, 2,000 directories, 20 roots, a 512-character
  path, `complete` false when cut; a lockfile-less member of a root's
  package.json `workspaces`, or of its `pnpm-workspace.yaml` `packages` when
  pnpm owns it, is left to that root; no `packages` key, an empty one or
  negations only means no member, as pnpm 10 installs it),
  and the receipt `inputs.workspacePreparation`
  ([src/contracts](../contracts/workspacePreparation.ts)) lists them; a resume
  merges `preserved-unverified` into the saved one. Never derived from the
  routing inventory: its 160-entry cut, in read order, dropped `browser/` in
  run 2f2643d5. Every reader gets the fact, launch-time and not a plan
  requirement; only an atom DECLARING run_shell gets the instruction
  (`hasShell`, src/atoms/taskContext.ts): one guarded run_shell command at
  the maximum `timeoutMs`, root first, frozen to each lockfile, skipping a
  tree whose install completed (`node_modules/.package-lock.json`, which npm
  writes last: a tree killed at the timeout is reinstalled; `npm ci` deletes
  a present tree, and a parallel sibling may have installed it); a nested
  root without a lockfile (a template), or under a `fixtures`, `fixture`,
  `__fixtures__` or `testdata` directory even with one, stays out of that
  chain, installed only when a command needs it; a pnpm, yarn or bun root, or
  a lockfile-less root whose `pnpm-workspace.yaml` declares members or whose
  manifest uses `workspace:`/`catalog:` (`workspace: 'pnpm'`), is installed by its
  manager (through corepack: the worker has no pnpm), never by npm's marker; the no-rewrite rule binds these preparation installs, never a task
  that changes a dependency; never evidence.
- `ATOMA_ACCEPTANCE_SPEC` is read and re-digested at LAUNCH
  (`readAcceptanceSpec`): unreadable, or present on a run that is not
  depth-routed, is a `RunnerConfigError` before any model call. Present, it
  replaces `draftAcceptanceChecklist` for the whole run, both attempts.

- A run has THREE success-side outcomes, not two. `partial` is a run that ended
  with real work and did NOT deliver, for either of TWO typed reasons, and they
  COMPOSE: `Result.unfinishedPhases` (the deadline landed the dispatch before
  some phases ran, or a phase failed its typed checks and its dependents were
  never started — `blockedPhases`) and `Result.refusal` (root delivery
  acceptance did not accept the result). `isLanded` in
  [src/contracts/runLanding.ts](../contracts/runLanding.ts) is the ONE
  derivation — the runner, the viz client and the supervisor digest each read a
  different type carrying the same two fields, and were three unlinked copies
  of one expression until 2026-09-24. Typed fields, never the summary text,
  which continues into model-authored prose. Every reader that explains a run
  to a person reports BOTH reasons (`landingReasons`): a run cut short and then
  refused would otherwise show only its phases, dropping the half that says the
  work was judged. The
  trace records it, `machineRunStats` reports it, and `runTask` treats it like a
  delivery for process purposes: exit 0 and park, because there IS something to
  look at. A landed run is not a failure and must not be scripted as one.
- The runner's `ATOMA_RUN_STATS` JSON epilogue is the burn-in accounting
  contract. `parseRunLog` keeps text parsing only for interrupted legacy runs;
  never add global regexes over model-authored prose. Epilogue serialization
  bounds landing explanations to the shared schema limits and marks truncation;
  full descriptions remain in the trace. An unrelated finalization error must
  not be relabeled timeout merely because the run signal has expired.

## Intentional choices and rejected shortcuts

- Approved learning includes at most one prompt candidate per rank, on the saved L2 author and L1 reviewer models/payers. [Contract](../../docs/decisions/prompt-consolidation-2026-10-12.md).

- Read-only (0444) read-run copies: reverted (2026-10-17). `cp` gives a new
  file its source's bits, so every file restored from a copy was read-only
  (`edit_file` failed EACCES, the next seed kept 0444) and a saved script lost
  its executable bit while its sha256 matched; the mode never stopped the
  workspace's owner's shell. The write tools refuse a copy, and the worker
  mounts the copies read-only instead (the kernel stops its shell).

- A host-owned dependency install (a tools-owned frozen install in the
  worker before the first branch) is DEFERRED, not refused (2026-10-26): it
  needs a worker rollout, runs install scripts for the project and network on
  every seeded run. Pre-registered: over at least 5 seeded Node runs on
  Compute 0.4.141 or later, more than 1 executor whose first command needing
  a listed root runs before that root is installed, or any concurrent-install
  collision between branches, builds it. A collision is counted from receipt
  TIMING: two install commands from different branches whose run_shell
  receipts overlap in time, never from failure text. A failure-text hint
  (`Cannot find module`) is the vocabulary-frozen detector class: rejected.
  Until then a sibling still installing is a known residual race (the marker
  is absent while it runs); a lock inside the model-run command is refused,
  since a SIGKILL at the timeout leaves it held for every later sibling.

- Replaying from the last checkpoint after an interrupted phase is refused:
  external effects and phase credits are not rolled back with files. Persist
  `running` before dispatch, require `ready` for resume, and never rehydrate
  historical attestations as current proof.

- A run family, profile or `family` field (runner argument, MCP input, project
  column, CLI flag, UI picker): removed on 2026-10-03 and not to be
  re-proposed. The root agent IS the family, and `selectTissue` chooses it
  from the task; a second selector beside it can only disagree with it. A new
  kind of work is a new tissue in the platform registry, not a new setup. The
  `build` in `run:build`, `build-app` and `ATOMA_BUILD_*` is a legacy name
  that the burn-in harness and the production hosts spawn by literal path.
- An override switch for the run host: refused, and stated above at length.
  The defect this contract replaces was SILENCE, not the platform's limits.
- A base client, or one `ATOMA_LLM` selector: gone. Provider construction has
  one switch per TRANSPORT (`makeTransportClient`), and the three
  `ATOMA_MODEL_L*` pins are REQUIRED and parsed at launch. A missing pin is a
  `RunnerConfigError`, never a silent default — a run that quietly picks a
  model spends the operator's quota on a decision nobody made.
- Re-reading `process.env` for pins the router already resolved from the
  snapshot: refused. A run's own writes must never become the next run's
  "operator intent".
- Treating a landed run as a failure: refused. `partial` is a THIRD
  success-side outcome, and `runTask` exits 0 and parks on it exactly as on a
  delivery, because there IS something to look at. Scripts that branch on
  "not delivered" are reading the wrong field; the typed
  `Result.unfinishedPhases` is what separates the two.
- Raising the run budget as the answer to a truncated run: refused as the
  MAIN answer. A bigger budget only moves the cliff; landing is what recovers
  the spend. The 30 → 60 minute raise of 2026-09-22 shipped as the smaller
  half of that change, beside moving preparation off the tenant's clock.
- Reading `--seed` as "this run is a measurement arm": refused since
  2026-09-23, and it is the reason `--comparison` exists. A seed says where
  the workspace came from, never why. Measured on run `e743b47d`, delivered
  and published to a tenant repository with `probes: []`.
- Global regexes over the runner's stdout: refused. `ATOMA_RUN_STATS` is the
  accounting contract and `parseRunLog` keeps text parsing only for
  interrupted legacy runs. A regex over model-authored prose is a parser whose
  input nobody controls.
