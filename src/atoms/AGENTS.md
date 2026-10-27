# Atoms — AGENTS.md

`src/atoms/` owns the supervision protocol: planning, the prefilter, trust,
validation, ground truth, and the mechanical result gates.

Read [`AGENTS.md`](../../AGENTS.md) first: it holds the cross-cutting rules.
Everything below is stated once, here, and is not repeated at the root.

Neighbours:
- [`src/core`](../core/AGENTS.md) — transports, models and cost accounting
- [`src/tools`](../tools/AGENTS.md) — the elements L1 invokes
- [`src/skills`](../skills/AGENTS.md) — the recipes injected into planning
- [`src/registry`](../registry/AGENTS.md) — atom identity and trust storage

## Supervision protocol
- A typed report-only refusal of a molecule permits one bounded tool-free correction, retaining host annotations, witnesses and suite outcomes. It receives a full model review, never trust/Decision approval. A result refused AGAIN as report-only gets a second correction, starting from the corrected report (`MAX_REPORT_CORRECTIONS`, 2); after that the refusal takes the ordinary ladder. Until 2026-10-24 it threw instead, and the error crossed the cell's dispatch, the tissue and the depth runner: a run with no judged pass failed and lost its work over a report twice judged merely mistranscribed, which costs more than the one re-execution the ladder's retry may spend. A cut correction reply is asked once more under a doubled cap, an unreadable one goes through the same tool-free serialization repair as an execution reply (`reformatPayload`): at most two calls per correction, since the ladder's retry replayed a demonstrated mutant/restoration pair over one formatting slip. One the molecule still could not give (a second slip, a transport failure, a report past the input bound, a deadline too near) takes the ordinary ladder too; real execution defects retain the normal ladder.
- ONE LADDER PER ROOT PHASE (owner decision 2026-10-10, judge what exists): a
  tissue that refuses a root phase whose cell's ladder ended in its last-resort
  fallback — for the phase or any subtask, or in a mutualized peer's
  (`spentLadder`, written by superviseLoop's fallback return, carried by
  `withSpentLadder`, relayed by `relayPeerLadder`) — does not re-run it when
  root acceptance will judge the run (`ctx.rootAcceptance`); `handUpRefused`
  hands the whole phase up marked (`phaseBudgetSpent`) and `phase-budget-spent`
  forces root review. Run bad74240 ran a spent ladder twice; a per-phase
  counter starved multi-subtask phases, a spent rung does not; without a root
  judge the tissue retries. `isOwnFallback` is the one provenance predicate.
- `superviseLoop` is the only child plan → validate → execute → validate loop.
  Root L3 plans also get mandatory tool-free contract review on `modelForTier(2)`
  (own cap and effort, src/core; a refusal costs a top-tier replan); a reviewer
  fault (unfinished, unparseable, unclassified, or asking the PLAN for its own `delegationReview`, `misreadDelegationReview`: run f41efe87 refused five root plans so and executed nothing) re-reviews the same plan on the
  validation model. Any verdict reply that did not parse first gets ONE tool-free reformat turn (`verdict-repair` role, `reformatVerdict`); a RESULT verdict still unparseable is a `result-review-fault`, judged again up to `MAX_PLAN_REVIEW_FAULTS`, then a blameless escalation: thrown, one stray `,"` ended run 9a2f8487 whole (2026-10-24). L2 plans under a parent suite get the same check there; their
  reviewer fault re-reviews once on tier 2; a second one returns a `reviewer`
  refusal that `superviseLoop` neither coaches, counts nor charges to the plan
  budget: it asks again, and after `MAX_PLAN_REVIEW_FAULTS` (2) the parent takes
  over. Such an escalation, or a plan budget spent on unparseable replies with
  nothing judged, records no failure and branches no type (`blameless`).
  Missing classified suites or parallel branches block dispatch even beside
  approved:true. Five root attempts (a plan parse failure counts); no unreviewed
  fallback. L3 `replanAfter:true` is read-only discovery, once, then the host
  replans; never a checkpoint prefix. Parallel discovery shares one photograph, restored after every branch settles.
  Output-collision coaching runs first; its fail-open result is still reviewed. Never coerce concat to sequential.
- Escalation branches a type and toggles parent fallback in a `try/finally`.
  Persist capability prompts only; task text, seed instructions and diagnostics
  belong to the current instance. Validator diagnostics are fallible evidence.
  Rows persisted before that rule lose their task lines and diagnosis block
  at every build bootstrap (`promptRepair.ts`; capability text appended since
  is kept): run f793b338 (2026-09-27) handed a read-only inspection to a
  molecule whose stored prompt still named another run's page, and it wrote
  that page over the live site twenty times. A `registry rollback` to such a
  version is undone by the next run; the wholesale operator repair is
  `scripts/repair-atom-prompts.mjs`.
  Fallback uses an explicit direct-executor system role, not the delegator role.
- `pendingStrategy` couples `plan()` and `execute()` on the same instance. Never call `execute()` without the corresponding plan.
- A resumed root restores its saved plan, strategy and digest-bound approval (re-enforced
  mechanically, not re-judged); answers or a refused legacy plan replan only the suffix.
  Root-only checkpoints never enter forks; dispatch skips the prefix before selecting or crediting.
- `fallbackMode` bypasses registry delegation and calls self-plan/self-execute.
- Mutation scopes flow through `applyByScope`; update the union and every hook
  together when adding a scope.
- A molecule's next execution of the SAME task (keyed by description) opens
  with `== YOUR PREVIOUS ATTEMPT AT THIS TASK ==` (`attemptDigest.ts`): what
  the transport observed — files changed and read, servers, HTTP method, path
  and status, validate_html, recent commands and bounded observed results — and its own report,
  labelled not evidence. L2's patch and branch replacements `inheritAttempt`.
  Run 87e672d7 (2026-10-04) spent its retry's first 90 s re-reading what the
  rejected attempt had just read. Planning also reads it: eight recent commands / 8,000 encoded characters and 16,000 encoded characters of inspection observations. Read-only retries retain only attempts consisting exclusively of read_file/list_files; any other tool discards that memory across restoration. Runtime boundaries discard it. Historical results grant no freshness, approval or tool credit; omissions establish neither absence nor coverage.
- Per-task child memos prevent immediate reuse loops. Initialize task state,
  mark committed children, and pass exclusions to prefilters.
- Run-scoped integrity flags and memos must retain the same reference across
  every `forkBranch`; add fork-propagation coverage for new optional fields.
## Root delivery acceptance in depth routing
- The depth runner's `rootAcceptance.ts` owns delivery acceptance:
  delegated result gates retain their dispositions, `probe.requiresReview`
  forces review. Explicit proof floors require an executed DOM interaction
  bound to the named, still-unchanged file in the accepted attempt. A run
  without a floor always receives semantic review; a recorded root text plan uses
  `modelForTier(2)`, others `modelForTier(1)`. Text always receives review. A complete pass whose root plan declared no delivery (the prefilter's) is `observedDelivery`: text when no attested write, edit or shell call, never a blind file review; the depth runner records it in the declared manifest (code review 2026-10-09, 1.2). The contract has no
  universal `index.html` floor: APIs and CLIs are first-class deliverables.
  File deliveries with covered floors and no findings retain mechanical acceptance.
  Text review derives a bounded L2 reference blinded to the current answer, plan and remediation (`textReview.ts`). An accurate report that required work could not be performed supplies none of it (run 9e134e49 delivered such a report); an observed failure is a result.
  A root plan's declared TEXT delivery is stamped on the root task (`withPlannedDelivery`) and handed only to the tasks whose output is that text (`delegatedDelivery`: last sequential phase, every concat part, never a child declaring `outputs`). Executors read `TEXT_DELIVERY_GUIDANCE` (answer in `output` as Markdown, evidence after the marker in the summary); planners and validators read `TEXT_DELIVERY_CONTEXT` (judge it wherever placed, never persist its shape). Runtime text only. Free-text URL extraction is loopback-only, so a cited link is never probed. [Design and review](../../docs/decisions/text-delivery-answer-2026-10-13.md).
  One extra tool-free call per text acceptance; no effort override, automatic vote or proof credit.
  The reviewer judges the whole task; references remain fallible model text. [Review](../../docs/decisions/text-review-and-history-2026-10-03.md).
  The root changes no phase credits; a pass's new skill lessons wait for its approval and a refusal drops them (owner decision 2026-10-09, run fc2a68cf); an approved dependency landing's lessons follow the last verdict on that work (G1): held, then saved with the extra pass's when it is approved (a tie per rank goes to the later pass, otherwise the longer feedback; a task lesson is kept once per owner, child and task), saved alone when that pass ends with no verdict, dropped when it is refused; after it, the runner commits the lessons in the run's one enqueue for separate processing ([lifetime](../../docs/decisions/approved-learning-2026-10-11.md)); library/serial paths retain `saveLessons`. The probe receives only `output` and `summary`, as at L3; internal plan/verdict/fallback trace quotes are not delivery claims. Phase coverage is collected with its original attempt and branch, never reevaluated against the root floor. The floor is not inherited by phases. The review
  reads one mechanical line naming the sizes the attempt's pages were laid
  out at (`observedLayoutsBlock`): run 134d916a was accepted on "no overflow
  at 375 and 1280 pixels" with every check at 800x600. That line alone did
  not hold: runs a939374e and 7389feee (2026-09-27) were approved on "no
  horizontal scroll at 375 px" at 800x600 again, the second after its own
  refusal had named the gap, and in both no molecule had laid a page out at
  a named width. So a screen width a CRITERION names (`namedLayoutWidths`:
  "at 375 px wide", "a 375-pixel phone", "viewport width of 1280 px") is
  shown item by item as LAID OUT or NOT LAID OUT, and reaches the planner
  and every browser molecule as an instruction to lay the page out there.
  It is a fact beside the judgement and overrides none: a detector that
  refused on its own reading would fail as a wrong gate, which the declared
  obligations below forbid. Making an unlaid width a hard refusal is an owner
  decision (records/incidents/production-runs-2026-09-27.md). When criteria are shown, the acceptor also
  judges EACH one (`criteria`, kept on the checklist items as `judgement`); a
  USER list is always read, never approved mechanically past, and an approval
  that judges one of its criteria unmet is the acceptor contradicting itself,
  so it refuses with that criterion. A drafted item judged unmet is recorded
  and never fails a run by itself.
- A completed FILE delivery reviewed against a USER list also
  passes `reviewAcceptanceCriteria`: concurrent batches of at most two items,
  on the cheapest tier, with host evidence but no result report or global
  verdict. Those judgments replace the global call's checklist judgments;
  any unmet item or refused batch prevents delivery. Unresolved refused disagreements stay unjudged for remediation. Invalid, truncated,
  missing, duplicate or unexplained judgments mean an incomplete review,
  never approval or a claimed implementation defect. Transport cancellation
  still propagates. Drafted lists, text and landings keep their existing paths.
  A holistic refusal also receives this inventory, so remediation hears all
  criterion gaps together; a focused approval cannot override that refusal.
  When all focused items pass but the global verdict explicitly judged a
  criterion unmet, with no inherited-check finding to preserve, one tool-free L1 reread resolves the disagreement against
  the same evidence. Its complete checklist replaces the disputed judgments
  and its verdict retains unrelated defects; an incomplete or failed reread preserves the refusal, and cancellation
  propagates. No vote, repeated tools, or automatic override. See
  [Reading Log counterexamples](../../records/incidents/reading-log-review-2026-10-11.md).
  Run 715ffc74 otherwise spent its one repair on an expiry example before
  learning that schema and successful-receipt tests were missing. This adds
  at most six tool-free calls for twelve user criteria, no tool replay or phase credit. The incident and adversarial
  controls are in `benchmark/criteria-review-2026-10-05/`; earlier aggregate
  approvals stayed unreliable even after a larger-model replay.
- The root also reads an attempt-scoped inventory of executed browser inputs,
  excluding restored/stale observations. Clicks, select assignments and forced
  focus do not prove a keyboard-only journey (run ce89c84a, 2026-10-04).
  `KEYBOARD_EVIDENCE_GUIDANCE` reaches browser molecules (including old stored
  prompts), fallback executors and validators: judge each requested modality,
  natural reachability separately from key response, and asserted outcomes.
  Counts never grant coverage or reject. Shell tests remain separate evidence;
  no keyboard requirement is invented. Bounded replay evidence and countercases:
  `benchmark/keyboard-evidence-2026-10-05/` (small exploratory sample).
- Two more host-read facts sit beside the delivery, neither a verdict. A
  SEEDED run's acceptor reads what happened to the files it started from
  (`startingWorkspace`: removed; rewritten when under half of its starting
  lines survive anywhere in the delivery; moved when they survive in other
  files; changed; unchanged; new — the delivered side reads exactly the
  starting paths, so no cap can report a kept file removed), because run
  902b2c21 (2026-09-27) replaced the configurator it was asked to keep with a stand-in computing the criterion's
  number, and nothing it read said so. And the files the criteria NAME
  ("docs/ERRORS.md", or a root Markdown stem such as "README") are read back
  when the ground-truth block does not already show them: run dc45c95b's
  README criterion was judged on the file existing. They show a head and,
  past it, the lines holding the criterion's words; a cut excerpt is silent
  about the rest, and a name that resolves to no file is silent — "saves
  quote.txt" names a download. Both are read only for a validation call.
  Superseded reads also get bounded current excerpts; unknown stays unknown, old bytes stay out. [Contract and review](../../docs/decisions/stale-file-evidence-2026-10-03.md).
- A run given READ RUNS (`readRuns`, host-owned like `previousRunResults`)
  reads, at every root acceptance and in both reviews, one host line per copy
  (bytes and mode against its manifest, a change put back told by its ctime,
  added names a separate fact) and one per workspace path the criteria name
  that a read run saved, compared on the host with the saved entry, never
  through `read_file`. The criteria read-back never reads a copy, and a parent
  suite naming `.atoma-runs` is refused by the zero-token precheck: the runner's
  snapshot leaves the copies out. Facts, never verdicts ([decision](../../docs/decisions/read-runs-2026-10-17.md)).
- A BUDGET landing carries `LANDED_RESULT_GUIDANCE` to that validator; a
  DEPENDENCY landing (`blockedPhases`) carries `DEPENDENCY_LANDING_GUIDANCE`
  and is never approved mechanically; a result that is both carries both. A
  budget landing is usually a validation call (its floor is usually uncovered),
  but a covered floor with no finding still approves it mechanically. Until
  2026-09-24 the judge was told nothing about landings and decided on model
  prose alone. The wording follows the analyst's on purpose: one definition of
  a landing, served to both judges. A phase supervisor never receives it —
  landing is a property of the whole run.
  [Dependency landing](../../docs/decisions/parent-owned-tests-2026-10-16.md).
- THE ACCEPTANCE CHECKLIST ([design](../../docs/decisions/acceptance-checklist-2026-09-25.md))
  is drafted once per depth-routed run by `draftAcceptanceChecklist`
  (cheapest tier, role `draft-checklist`, actor `run-checklist`), reaches the
  root planner through `inputs.acceptanceChecklist`, and is covered at the
  root from attempt-scoped host `http` observations (plus standing ones, src/contracts) taken BEFORE the root's
  own probe. It informs the validation call and decides nothing: a
  model-drafted list may only add what the acceptor looks for. Rendered only
  when it holds an http item; a landed result is told NOT OBSERVED is
  expected for its unfinished phases.
- A USER-APPROVED list ([contract](../../docs/decisions/acceptance-contract-2026-09-14.md#built-the-user-approved-list-2026-09-25))
  replaces the draft: no drafting call, `checklistOrigin: {source: 'user',
  digest}` held by `runDepthTask` and passed to every `acceptRootResult`,
  never re-read from `task.inputs`. It always renders, review items included,
  under a header saying the user approved it; it still decides nothing.

## Planning, prefilter, and trust

Read this section before changing any LLM call site here; the cost rules are
load-bearing.

- L2/L3 planning runs `prefilterStrategy` first. Only a high-confidence reuse
  can shortcut L2; low/omitted confidence becomes `escalate`. L3 always performs
  its strategy call because top-tier decomposition is the product.
- L2 may synthesize a one-subtask plan only for high-confidence,
  non-decomposable reuse. Coupled outputs are sequential, not falsely parallel.
- Enrich the L3 prefilter catalog with reachable L1 capabilities; a narrow L2
  may still be the correct router through its children. The cell's prefilter
  and planner list each molecule's tools (`withToolLine`, run ff102525).
- Prefilter caching is exact only. The key includes every decision input and
  error outcomes are not cached. Its measured ceiling is 1.7%; do not tune cap
  or expiry, and never introduce fuzzy/embedding matching without first adding
  validation above the prefilter fast path.
- `viaPrefilter` is internal and omitted from `planSchema`; an LLM must not be
  able to spoof validator bypass.
- JEV DECIDES FIRST when `ctx.jev` is present
  ([owner decision](../../docs/decisions/jev-decisions-2026-09-28.md)): after a prefilter
  cache miss its pick is a high-confidence reuse and `none_of_these` an
  escalate, never cached; and it may APPROVE a plan or result only where a
  fast path is admissible (no gate finding, proof covered, probe not requiring
  review), through `jevApproval`, which hands it the model validator's own
  transport-observed evidence lines (`renderTransportEvidence`), never the
  child's declared probes. A no, an unsure answer or a silence is the model's
  decision, as before. Root delivery acceptance is never Decision's.
- THE JEV AUDIT: every `jevApproval` call site hands it `audit`, the very model
  verdict it runs without Decision (one `modelVerdict` function per validation, so
  the audit cannot drift from the real verdict). The subject's audit rate
  defers it, under the `jev-audit` role, off the run's path. It
  decides NOTHING — Decision's approval stands whatever the model says — and its
  role keeps it out of every reader that counts validations.
- The Decision calibration (`jevCalibration.ts`) reads prefilter and validation prompts back out of
  traces: their LAYOUT is a contract with it (`tests/jev-calibration.test.ts`); `TASK_CONTEXT_HEADER`
  separates multiline task text from runtime guidance (historical traces lack it). A recipe's opening
  steps come from the deferring `jev` event's `details`. Calls stamped `jevExcluded` (delegation
  reviews, parent-suite results: Decision takes none) are counted apart and never asked; a trace
  without `jevExclusionStamps` predates the stamp and is read by structure, whatever its date.
- Atom trust fast paths require the configured consecutive approved-result
  threshold (default 3), read through `trustThreshold()`; historical failures do
  not permanently disqualify a type. Script dispatch retains its separate
  zero-failure rule, and a script's result never takes its molecule's trust
  fast path: `validateResult(…, { scriptDispatch })` runs gates, probe, Decision and
  model on it (owner decision 2026-10-06, [src/skills](../skills/AGENTS.md));
  recipe compilation follows the skills contract. Invalid or non-positive threshold values
  fall back to the default. Result approval still runs the zero-token ground-truth
  probe first. Contradictions and malformed manifests force review; heuristics
  never reject alone.
- `VALIDATION_SYSTEM_PROMPT`, `PREFILTER_SYSTEM_PROMPT`, and
  `SKILL_PREFILTER_SYSTEM_PROMPT` are shared constants. Do not inline per-call
  system prompts and destroy caching.
- Keep remediation feedback bounded (`REMEDIATION_FEEDBACK_MAX_CHARS`) and
  actionable; diagnosis leads so head truncation remains useful.
- Validation parameters stay deterministic and bounded. Raise token caps only
  after observing real truncation.
- Normal L2/L3 plan and validation calls never receive tools/executors. Their
  last-resort tool-bearing self-execution must use `modelForTier(1)` while
  retaining supervisor provenance.
- Plan calls (L2/L3) use `STRATEGY_MAX_TOKENS` (16,384 since 2026-10-16: plans
  carry whole suites, escaped code is ~3.3 chars/token, and a cut reply is
  refused) and medium effort; one cap for every plan call, since nothing before
  the call says whether the reply carries suites. Plan reviews keep their own
  UNMEASURED `PLAN_REVIEW_MAX_TOKENS` (8000): the root review and a child-plan
  review's second attempt. Measurement and cost:
  [plan size](../../docs/decisions/parent-owned-tests-2026-10-16.md#plan-size). A molecule's execute
  effort is Decision's (`L1Atom.executionEffort`, [src/core](../core/AGENTS.md#decision)),
  and a type's own effort pin wins over it. The cap includes
  adaptive thinking. Defaults in `planSchema` protect against truncation;
  omitted L3 aggregation defaults to `sequential`.
- Prompt-cache thresholds are load-bearing. Keep the validation prompt above
  the cheapest model's minimum and confirm `cache_read` on multi-call runs.

## Aggregation and dispatch shape

- Delegation preserves original task inputs/constraints and preceding phase results.
  Tool planning/execution and L2/L3 fallback use the same `taskContextLines`
  as validation; typed `originalTask` wins over its input mirror. The WHOLE
  root checklist stays out of phase validation; the molecule planner retains its
  checklist context for whole-task shortcuts. A phase carries only the criteria
  its plan assigned it (`Task.criteria`, subtask `criteria` ids), rendered word
  for word to its planner, executor and validators: a user criterion is that
  phase's requirement, a drafted one adds nothing. An id no subtask names is
  CONTEXT for the last sequential phase only; a script dispatch is judged
  without criteria. 60 of 118 first root refusals named a clause no
  phase had seen ([measurement](../../records/incidents/first-refusals-2026-10-10.md)).
  Current constraints reach execution; host discovery renders once and children cannot replace it.
  Sequential handover also carries bounded transport observations from completed
  phases, with event IDs, omission counts and a separate file-change inventory.
  These are historical context for reporting and validation, never new proof
  credit. Nested handovers preserve enclosing observations with labelled bounds.
  Run 2311d446's report made 53 tool calls searching a manifest for browser
  observations that only the runtime trace held.
  Declared reasoning mode disables tools/skills through descendants and fallbacks; only its observed-action gate
  is skipped, and the plan parse drops it on a subtask declaring outputs or proof obligations (review 2026-10-09 2.6). [Contract and review](../../records/incidents/text-delivery-2026-10-02.md).
  Runtime planning keeps the current phase's scope and scales reusable workflows to the task, without a phase-count gate ([review](../../records/incidents/planning-scope-2026-10-03.md)).
  Validation retains that host-owned scope too: original facts remain binding, but tests assigned to a forthcoming phase are not
  current-phase prerequisites; a delegated parent's own text rides as host-owned `inputs.enclosingPhase` (verbatim, never a keyword filter;
  a child's copy is dropped) and a delegated task's `outputs` as guidance, never a gate (run a4dcf853: a cell demanded join work). Current
  defects/checks and final root acceptance stay strict. A child cannot defer its own requirements. Paired replay: `benchmark/reservation-transactions-2026-10-05/`.
- `llm-synthesize` reads exact task criteria and bounded host tool/suite observations beside fallible branch reports; it grants no proof credit.
  File assembly requires an L1 phase. [Attica evidence losses](../../records/incidents/attica-recipe-evidence-2026-10-20.md).
- Aggregation is behavioral: `concat` and `llm-synthesize` dispatch orthogonal
  subtasks in parallel; `sequential` dispatches shared-artifact phases in order
  and threads `previousStepSummary` plus declared `outputs` as
  `inputs.previousStepOutputs`. Do not merge prior writes into the next
  phase's `outputs` — skill/promotion gates read the current phase only. Do not parallelize coupled filesystem work.
- Independent work MUST fan out, including multiple L2 branches at L3: a branch starts once its
  `dependsOn` producers (earlier indices) settle; joins name producers, coupled writers declare
  dependencies; no wave barrier, no prose inference. A producer with a typed failure is KEPT and its
  dependents land unstarted (`blockedPhases`); behind one that landed on the budget alone they are
  unfinished, never blocked (`landedOnBudget`); a throw still fails the dispatch. Routing splits only
  output-less checkpoints, remapping `dependsOn` ([why](../../records/reviews/parent-tests-review-fixes-2026-10-16.md)).
  It keeps a server-backed browser+command checkpoint whole on a superset full-stack cell and splits it
  otherwise; the criteria bind at most the split part whose cell holds both capabilities; the shell part drops obligations.
  This DAG answers [2026-08-16](../../records/incidents/parallel-fanin-2026-08-16.md), where per-artefact phases
  serialised independent work, though fan-out was not always cheaper; no live run has exercised it yet.
- A phase of a SEQUENTIAL root plan the PLANNER wrote with two phases or more
  (counted before `routeCrossBucketVerification` splits one) that declares no
  `outputs` is READ-ONLY (`Task.readOnly`) — the tissue's plan, or a root
  cell's own (a fork carries `currentBranchId`; a prefilter reuse is one
  dispatch of the whole task). A one-phase plan is the whole task, and
  parallel phases, host-split parts included, share the workspace at the
  same moment, so neither is marked. Runs 04ea696f (2026-09-30: a verification phase replaced the page it
  verified, and that page shipped) and f793b338 (2026-09-27: an inspect
  subtask overwrote a home page 23 times).
- Every execution of a read-only phase — the child's, a branch's, the
  parent's fallback, a compiled script's — runs between a host photograph of
  the workspace and its restoration (`withinReadOnlyPhase` through
  `SupervisionHooks.aroundExecute`, once, where the phase starts; both begin
  and end are awaited across the private workspace boundary; implementation in
  [src/run](../run/AGENTS.md)). The mark itself inherits: every task below
  the phase is `readOnly` too, so its validators read `READ_ONLY_TASK_LINE`, a
  failed final validation is a review finding (`read-only-validation-failed`)
  rather than a coached rejection, and no recipe or event skill is distilled
  from it. When the execution changed something, its result starts with
  `[READ-ONLY PHASE RESTORED …` and carries `Result.readOnlyRestoration`,
  beneath which the banner gates read; whenever the disk was put back, the
  Node servers the execution started are stopped. A restoration is DAMAGE
  when the phase owned a path it put back (`executionOwns`: its element
  writes named it, a server it started runs it, a shell or probe command
  names it, or it was a compiled script): then its attestations count for no
  root acceptance, its probe manifest goes back with the rest, and trust,
  skill credit and promotion are withheld as `proofUncovered` withholds them —
  below a tissue's phase, where the restoration comes after the approval, a
  molecule's own attested element writes decide. A side effect of verifying
  — a server rewriting its data file — is put back and reported, and only a
  browser observation whose document digest no longer matches is set aside.
  `.atoma-scratch/`, snapshot-skipped names and SQLite databases stay. The
  root acceptor reads every read-only phase of the attempt, one that changed
  nothing included, and never approves past them mechanically: no read-only
  phase can fix the defect it finds.
- REACHING THE RUN DEADLINE LANDS A DISPATCH; it does not discard it.
  `dispatchWithAggregation` returns `{results, unfinished, blocked}`: sequential refuses
  to OPEN a phase under `MIN_PHASE_LANDING_MS` of remaining wall clock and keeps
  the earlier phases when a phase that was opened is aborted, and parallel keeps
  the branches that settled when the deadline cut their siblings. A dispatch
  that completed NO phase still throws (the run's first pass then lands, src/run), and a rejection that is not the deadline
  keeps its meaning whatever else settled — `ctx.signal` is the deadline and
  nothing else, since cancellation reaches a run as process teardown. `markLanded`
  stamps the aggregate (`Result.unfinishedPhases`, unioned from below; held-back
  dependents also in `blockedPhases`), and the runner makes it `partial`. Never
  infer a landing from the summary text: `markLanded` prefixes it, but it then
  continues into model-authored prose. Measured twice on 2026-09-21:
  [progressive runs](../../records/incidents/progressive-runs-2026-09-21.md).
- `llm-synthesize` aggregation on a LANDED parallel dispatch rides
  `landingSignal(ctx.deadlineAt)`, not `ctx.signal` — which is already aborted by then, so the
  synthesis would throw before its first token and discard the branches the
  landing exists to preserve. Synthesis and root acceptance share the absolute
  deadline + 45s ceiling, inside the runner watchdog's 60s grace. A library
  context without a deadline retains the post-approval cap. A synthesis that
  cannot finish — failed while landing, or cut by the deadline over complete
  sub-results — KEEPS them, landed (`synthesizeOrKeep`), and names what
  happened in the unfinished step; cancellation and deepening rethrow.
  Sequential aggregation makes no call and needs none. A `TimeoutError` is
  the run deadline only beside a `ctx.deadlineAt` (`abortedForLanding`):
  without one it is a library caller's own timeout, honoured as a
  cancellation, never a window to finalize in. A platform token/spend
  ceiling (`RunBudgetExceededError`) lands exactly as the deadline does and
  spends nothing more: the run's client refuses every call after it
  (owner decision 2026-09-30, [src/platform](../platform/AGENTS.md)).

## Verification and ground truth

- [Parent-owned tests](../../docs/decisions/parent-owned-tests-2026-10-16.md): L3
  assigns L2 suites and reviews L2-authored L1 suites before execution; unchanged
  approved plans reuse review, revisions require it. The loop and compiled dispatch
  run the fixed harness before validation/credit, fallbacks included; the plan-level suite,
  or the suite on its sink join, checks integration (`PARENT_TEST_INTEGRATION_PLACEMENT`).
  `core/parentTests.ts` alone maps typed status/cause to reject, reject-once or
  review, never credit. Observations go up typed, reach validators only as a host
  block, judged once; green needs semantic review. The delegation review's mechanical
  half owns the suite API and parse checks (`parentSuiteCheck.ts`): what the runner refuses
  is refused in the parent's plan, not blamed on a child. [Review](../../records/reviews/parent-owned-tests-2026-10-16.md), [fixes](../../records/reviews/parent-tests-review-fixes-2026-10-16.md).
  Before any review, reviewed root plans (replans included) and cell plans get the zero-token
  suite precheck (`planSuitePrecheck`), every finding in one refusal. A source the runner's
  parser refuses (`parentSuiteParseRefusal`: TypeScript's parse less the strict-mode lexical
  errors oxc accepts, such as `0777`, plus a misplaced `await` or `return`; run 7d071257 wrote
  `\\n` per line break) and an invalid regex literal refuse every time: no test of that module
  can run. An escaped backslash before a class letter (`suiteRegexPrecheck`, run 2e6bdcfc) and
  a test-file import refuse once per planner, then reach the review as host facts
  (reject-once-then-honour). The review reads `parentSuiteFacts.ts`'s HOST FACTS (where each
  import resolves; `parentSuiteSources.ts` follows relative dependencies within six
  observation-only source reads, direct imports first) and `parentSuiteReach.ts`'s line on
  written modules no suite imports, names or calls into, withheld on any open walk or bound.
  Observation-only reads withhold overwrite permission. A refused root's latest bounded facts
  reach its next planner, parse retries included, as untrusted feedback; omissions establish
  nothing. No carry-over to another task. [Protocol](../../docs/decisions/parent-owned-tests-2026-10-16.md).
- A SUITE DISPUTE (`taskSuiteDispute`, measured only): the task's own suite failed with one failing set on 3+ runs over 2+
  `subjectDigest`s, looked for where the loop escalates. Counted once per suite per attempt (`suiteDisputes`), logged and recorded in the
  trace for a [pre-registered](../../benchmark/suite-dispute-2026-10-17/PREREGISTRATION.md) classification; no routing, no text a run's models read ([decision](../../docs/decisions/parent-owned-tests-2026-10-16.md#a-suite-that-fails-the-same-way-on-every-implementation-measured-only)).

- One text states what a parent suite can run and how browser-only behaviour is proven
  (`PARENT_TEST_RUNNER_SCOPE`: a `validate_html` subtask, with the `dom-interaction` obligation for
  real input), and one what makes a suite sufficient (`PARENT_TEST_SUFFICIENCY`: real module import,
  exact values with a negative case, able to fail on what the task or its criteria name, nothing
  more), with `PARENT_TEST_BLOCKING_DEFECTS` the defects that refuse in every round. Planners and
  the delegation review read the same texts. Since 2026-10-26 they say that a plan with ONE implementation subtask has no join and needs no integration suite, that a suite asserts what the task states and nothing it leaves open (no retry cap for a page that retries by itself), and that an L1 plan is never refused for its PARENT's suite, one naming a suite/task contradiction for the parent included (run 51c4e71d: 18 of 36 plan reviews refused on those three readings). Each root refusal reaches the planner with its requests
  (`additionalContext`), and the review reads its earlier refusals: one that still stands refuses
  again only as a blocking defect or another rule's breach; a refusal lists EVERY blocking defect at
  once (b920faf6: eight replans of one cell, one new gap each); since 2026-10-23 the cell review
  reads its own history and after `MAX_CELL_PLAN_REFUSALS` merits refusals the next clean plan
  executes (00fc7063), unless the refusal cites typed `unsatisfiableSuites`
  (`PARENT_TEST_UNSATISFIABLE`: a suite of the plan no correct implementation passes, 40c20c5d); the
  plan budget's ladder then decides. A suite the tissue assigned cannot be cited and stays bounded.
  Rejected options, run stats: the `MAX_CELL_PLAN_REFUSALS` comment.

- All JavaScript-runtime applications use strict TypeScript, including existing projects, browser/server
  logic and maintained tests created or changed by the requested implementation.
  Existing-app migration/skeleton adaptation cover the repair and necessary dependencies; explicit wider work still applies. Inspection, verification-only and reporting phases do not migrate.
  `APPLICATION_TYPESCRIPT_GUIDANCE` in `taskContext.ts` is the runtime rule shared by tool-mode planners,
  executors and reviewers, including old stored types and fallbacks; reasoning tasks hold no tools and skip it.
  Final review requires observed `check` (typecheck, lint, tests) and `build` success and effective
  configuration/source coverage; transpilation or a script name is not proof. Compilation goes to a shell
  molecule before browser verification, without widening static-web tools. Generated JavaScript, vendor
  assets and necessary tooling glue remain valid. No extension-based rejection or supervisor command replay.
  [Decision and review](../../docs/decisions/typescript-applications-2026-10-16.md).
  Apps also adopt the [versioned application skeleton](../../docs/decisions/application-skeleton-2026-10-16.md):
  ESLint/typescript-eslint, Vitest, Vite for browser assets, and uniform scripts.
  Example tests prove the skeleton only; product behavior still needs evidence.

- Browser executors and reviewers share `WEB_DELIVERY_GUIDANCE`: user-entered
  plain text stays data in DOM attributes too, and documented launch modes must
  work. Served module success proves nothing about direct file opening. These
  are behavioral review instructions, not an HTML/source-pattern gate; intentional
  rich HTML and a documented required static server remain valid choices.
- L1 plans express intent in prose; actual tool calls happen during execute.
  Do not encourage large literal `toolCalls` payloads in plans.
- Tool scopes are bucket-specific and enforced twice: prompts/plans must name
  only declared tools, and the executor rejects undeclared tool use. A test renders the L1 request over every tool subset: the generic contract's manifest section names only the recorders held (`groundTruthEvidenceLines`), the plan prompt names validate_html only to a holder (Sucrose planned "through record_probe" from its stored prompt, run f91cdb19, 2026-10-26).
- Match verification to the artefact: browser UI uses static server plus
  browser validation; HTTP APIs use node server plus fetch; CLI/files use shell
  execution plus read-back. Do not force every artefact through HTML tooling.
- Recorded probes support cross-checking; non-zero exits alone are not errors. Only explicit `match:false` or unequal expected/actual values are mechanical contradictions.
- Reporting gaps first use recorded results and actual assertions (`VERIFICATION_REUSE_GUIDANCE`). Missing execution/coverage, disputed behavior, changed inputs/environment or unknown freshness require verification; final-source acceptance still applies. Root remediation retains same-attempt host execution history (including discarded-branch outcomes) and bounded file changes in both reviews; commands remain historical, browser carry-over requires unchanged bytes. No replay or automatic credit. [Incident and controls](../../memory/root-remediation-command-evidence.md).
- Ground-truth reporting must quote observed tool bytes. Narrative self-report
  alone is not evidence.
- Stateful checks establish their preconditions from observed state and successful
  transitions, never probe labels or earlier coaching. Shared runtime guidance
  reaches executors and validators; the latter also read the reminder beside
  transport evidence. No new gate or call. Run ce89c84a's failed fifth creation
  made its purported sixth the fifth; replay limits and countercases are in
  `benchmark/stateful-evidence-2026-10-05/summary.json`.
  A newly authored assertion does not invent a product requirement: trace its
  expected value to the user or supported contract before modifying code.
  Fix unspecified test conventions rather than correct behavior; keep explicit
  requirements and genuine regressions. Reports account for earlier-phase edits.
  Required test coverage is judged from setup, actions, assertions and their
  observed execution, never test names or passing totals. Compound criteria
  retain every required part; criterion reasons identify concrete evidence or
  missing proof. Shared assertion guidance reaches existing molecules and
  validators without a mechanical coverage classifier. Run 22af997d
  approved conflicting-duplicate coverage absent from the test body; archived
  evidence and replay: `benchmark/stock-reconcile-2026-10-05/`.
  An assertion proves a distinction only when the contract-relevant alternative
  changes its checked observation. Source may establish implementation order, including completion before a serialized follow-up request; discarding stale input is processing, not a requirement to render it;
  commutative final outputs cannot establish it. Explicit executed distinguishing
  tests still require both the assertion and execution. Review all visible gaps
  together without importing new obligations from earlier validator coaching.
  No mutation execution or extra model call is authorised. Invoice counterexample
  and paired replay: `benchmark/evidence-discrimination-2026-10-05/`.
  Phase file read-back shares 24,000 source characters, root acceptance 96,000
  (one call per pass, a refusal costs a replan; three first refusals judged a
  page cut past 24,000; 48,000 until Attica runs 85cc4e83 and f74c140a, whose
  five executed suites, 41,953 characters, were refused four times as titles
  only). Root acceptance also reads the test scripts its attempt's shell
  commands NAMED (`commandTestScripts`, at most eight, command lines only,
  never a note or glob): those runs executed tests/attica-durability.test.js,
  which no criterion named and no truncated read referenced, so the acceptor
  saw its passing names and never its assertions. The sixteen reads take the
  criteria's names, then those scripts, then refreshed test scripts, then
  the other refreshed files: the attempt's reading order had put late tests
  past the cap. Selection only — no credit, no approval. Across at most sixteen files: unused shares from small files go to larger files; a batch that fits
  stays complete. Complete test scripts, smallest first, may borrow their missing
  bytes from truncated non-test files, each retaining at least half its initial
  fair share; complete small files stay whole. This avoids dropping a whole suite when test sizes cross half
  the budget. The total stays fixed, without execution credit or approval.
  Longer files retain bounded heads and, past them, the BLOCK
  each line naming a criterion word (a number of three digits or more is one: run 51c4e71d's 404 and 503 cases, 2026-10-26) opens (its deeper-indented lines and closer,
  a quarter of the block budget at most, never overlapping the head; "test" and
  "spec" never match): four first refusals saw a test title without its
  assertions. Small files a TEST script names in a string literal follow it,
  inside the same read cap, labelled as referenced, never as loaded (run
  cb53b09d's unshown fixtures).
  The probe manifest has its own schema/observation reader and does not consume
  a refresh slot unless a criterion explicitly names it. Run b873c5a2 lost
  assertion bodies when that growing internal record pushed the batch over budget.
  Selecting keyword lines alone had preserved test names but cut their bodies.
  Phase ground truth refreshes superseded or host-marked truncated reads referenced by the result in
  the current attempt, through the same bounded reader as root acceptance.
  Unchanged files need their full assertions too (run 4c1a1e8c); read-back
  selection never depends on the molecule making a gratuitous edit.
  Root skips a refresh only when the latest known read is host-marked complete
  AND survives that judge's transport-evidence selection. Old records without
  a truncation fact stay unknown. Earlier incomplete reads must not consume
  the source budget again after a complete read is visible (resolver run
  0a4a3e55). Sixteen is an I/O cap; the source-character budget is unchanged.
  Decision and the model receive the same current bytes, never new execution credit;
  unavailable content stays unknown. Reservation run 8d819d66 repeated coverage
  refusals while only a 400-character head survived beside retired reads.
- Inputs that only EXERCISE the artefact go under `.atoma-scratch/`, which
  publication and the preview already exclude with every `.atoma-*` path; the
  molecule reads the rule in its runtime execution prompt, so branches whose
  stored prompts predate it hear it too (run 80d1af73 published five probe
  inputs into a customer's repository).
- A rule the acceptor enforces is taught to every molecule it binds. The
  README port refusal (`DURABLE_HTTP_PORT_LITERAL_RE`) applies to any
  loopback server, so the static-web molecule carries
  `STATIC_PORTABLE_DOC_GUIDANCE` beside the HTTP molecules' guidance: it was
  never told, and wrote its measured URL into the README in two production
  runs (cc922a60, 5a5f1e27), the second after being handed the first refusal.
  The file scribe, the project-docs molecule and the generic L1 template carry
  `SCRIBE_PORTABLE_DOC_GUIDANCE`: documentation phases go to either molecule,
  their inputs carry the previous phase's URL, and run 8606cf38 copied it into
  the README.
- A delivered document is for its reader (`READER_FACING_DOC_GUIDANCE`, owner
  decision 2026-09-30): what a verification observed — measured values, smoke
  and probe results, digests, line numbers, source quotes — goes in the
  result's summary, never in a README or doc, unless the task asks that
  document to record it. A task that writes or updates a document (never a
  page, code or data file) removes what an earlier check left in it, even
  where it still holds; "preserve unrelated content" does not cover that
  record, and a document or section that exists to record results keeps its
  entries (owner decision 2026-10-01: runs 1ed071e3 and 9854553c kept such
  sections, then false). The rule is RUNTIME text, read by
  every molecule with a file-writing tool when it plans and executes, and by
  the fallback executors: stored prompts of molecules created before it,
  trusted ones included, never carried it. No stored prompt and no planner
  carries a copy. An example output a molecule adds is copied from a tool
  result of the run, never composed (run dadeea78 worked one out and it was
  approved); only the molecule's text says so, and no validator checks it. The validator prompt's own section says the removal is
  correct for a plan or a result, and the project-docs prompt says its
  "cite … source digests and line spans" goes in the result.
- A file that exists is never written again whole (`EXISTING_FILE_RULE`):
  it is edited, even where a stored prompt or a recipe step says
  write_file, and restoring a behaviour is an edit. The exceptions, each
  after a read: the subtask says to replace, rebuild or redesign the file as
  a whole, keeping what it does not ask to change, or the molecule puts back
  what its own checks changed. Like the reader-facing rule it is RUNTIME
  text, for every molecule with edit_file and for the fallback executors,
  and the recipe blocks carry the same lines. Run 495c20ef's trusted web
  molecule, in a correction phase with no recipe, wrote a restored page
  again whole.
- Source is written for a reader (`READABLE_SOURCE_RULE`, 2026-10-15): one
  statement per line, the file's indentation or two to four spaces, never a
  function or test body on one line, kept even where the repository's files
  are already dense, with untouched lines left as they are and minified or
  generated assets exempt. RUNTIME text like the two rules above, for every
  molecule that writes or edits files, the fallback executors, the proof turn
  and the recipe limits. The model matches the style it finds: the Attica
  repository's first file was dense and three runs on 2026-10-15 wrote every
  function and test on one line, while the same model wrote the habit
  tracker's server normally. Dense source is what edit_file pays for, 27 of
  310 calls there, a leading space recalled where none exists and spans that
  repeat ([measurement](../../records/incidents/edit-file-failures-2026-10-15.md)).
  Prompt text, not a gate: a density detector would refuse a vendored
  minified asset or a data file, and the measured failures recover in one
  retry each.
- A control the page lacks, needed only to test a behaviour (a text field to
  prove a shortcut is ignored there), never goes into the page. One call,
  after the page's other checks pass, proves it: real interactions set up
  the state, and the smoke creates the control inline off-screen, focuses
  and keys it, checks focus and state, and removes it, calling none of the
  methods `smokeDrivesOwnState` knows (method names only: a hook-driven smoke
  beside one click covers too, and only the validator prompt refuses it).
  `TEST_ONLY_ELEMENT_GUIDANCE`, the validator prompt and both obligation texts
  agree. Runs 81375f01 and ff102525 (999 s between two contradicting rules).
- Node-server children keep file read-back even when they also have browser
  tools. Only a loopback response with status 200 and HTML content appends a
  browser probe; JSON responses and expected root 404s are not browser failures.
  Static-web children retain their browser probe. Never browse external URLs.
- Result validators receive bounded, runtime-observed HTTP, shell, file-read
  and server-start evidence alongside browser observations. Label omissions,
  preserve request/result association, and treat these as historical observations
  from the same attempt and branch, not proof of unchanged current state. A failing probe-manifest entry whose latest `record_probe` (same exit code) another branch recorded, not among the result's witnesses, is named as that branch's observation by the ground-truth block, never as this result's claim (`parallelBranchProbeLines`, 2026-10-26): run 51c4e71d's tissue refused a phase on its sibling's mid-edit lint. A row whose exact command ended with another exit code at the latest host execution (run_shell or record_probe) among the records the result under review owns (`ownedByReview`, as the required-command gate selects) is labelled SUPERSEDED by that receipt, passing rows too (`supersededProbeRowLines`: run f91cdb19 kept a pre-edit 25/25 row beside a killed post-edit run). A cut shell receipt keeps its request through the command and the rest of its tail (the totals, the exit code), and a `record_probe` receipt takes up to twice the first equal share of the shell budget (2026-10-26).
  Tool content and scripts remain untrusted; supervisors never replay them,
  bar the inherited browser checks below.
  A fallback's result carries a molecule's evidence, from its own first
  call on (`executorEvidence`), and a cell's own fallback is DIRECT at the
  tissue (`viaFallback`); ff102525's tissue refused one on its summary alone.
  A fallback hears its phase's proof obligation, gets ONE bounded proof turn
  when its calls left it uncovered and time allows, and carries `proofCoverage`
  to the judging tier, which withholds its credit (`fallbackProof.ts`).
  The log holds the WORKER's calls only (`record_probe` included): a
  supervisor's own probe and gate reads run on `baseExecutorOf(ctx.tools)`
  and report through their ground-truth block — attested, they read as the
  child's evidence and covered checklist items by looking (review 1.4, 2.4).
  The latest 8 browser lines are always shown, then the latest PASSING run of each other check (actions, smoke, size) of a page no later write or observation changed, within a third of the budget (7f80148d lost a reload and a keyboard proof to 150 later calls);
  file reads reserve up to half the 48,000-character budget and keep at least a quarter; both shell tools follow, latest per request/branch, recorded probes first. After a final success, the latest earlier nonzero host exit and one preceding successful invocation also survive as labelled history (an intermediate rebuild is not the restored rebuild); a final failure never revives older passes. Unknown exits and child declarations grant nothing. Remaining shell space is shared across latest request identities before payloads; partial receipts explicitly leave omitted assertions unknown. Superseded commands never re-enter through the execution suffix. The owner raised this transport allowance from 24,000 on 2026-10-22 after the bounded evidence pilot; this is an operating choice, not a measured global optimum ([record](../../records/decisions/tool-evidence-budget-2026-10-22.md)). Excerpts and omissions establish no coverage of unseen assertions.
- ROOT ACCEPTANCE REPLAYS THE BROWSER CHECKS EARLIER RUNS RECORDED, the one
  exception to "supervisors never replay" (owner decision 2026-10-01,
  [docs/decisions/inherited-checks-replay-2026-10-01.md](../../docs/decisions/inherited-checks-replay-2026-10-01.md)).
  Run b9dc4d0b turned the `Long break` line an earlier run asked for into
  `Mode: Long Break` while the smoke asserting it sat in its inherited
  manifest. The host replays a seeded static page's web entries twice before
  any molecule's first tool call (`src/run/inheritedChecks.ts`); the ones that
  passed both times are replayed on the delivery, and one failing twice for
  one cause is LISTED. A listed check forces review, the acceptor judges each
  `asked`, and an approval judging one unasked is refused as one judging a
  user criterion unmet is; only items judged unasked reach the remediation.
  The acceptance after that remediation fails CLOSED. depth.ts hands it
  the refused pass's record (`previousAcceptance`), and every item listed
  there and not judged asked for counts. Unless its replay re-ran every
  kept check, its approval is refused and the run lands (run 5dff35b0
  approved and published a page its first acceptance had refused, after a
  second replay that the deadline stopped before its first check).
  A replay that left kept checks unrun says so in the block and forces review.
  The replays use `validate_html`'s host mode on the base executor: never
  attested, they cover no checklist item or floor and earn no credit. A check
  is judged by its smoke verdict, never by console noise. What a file STARTING
  WORKSPACE calls REWRITTEN lost is one item, but a changed value never is.
- Quoted-span checks walk summaries before noisy payloads, ignore diff `OLD:`
  and headers, and treat truncated excerpts as silent rather than refuting.
- Already-satisfied idempotent work is compliant when current ground truth proves
  the requested end state; do not demand meaningless rewrites.
- The L1's own browser proof is a LEDGER, not a last-call bit
  (`src/atoms/validationLedger.ts`, 2026-09-15). Evidence is bound to the
  document `validate_html` observed, under the same asymmetric doctrine as
  proof coverage: a pre-flight refusal observed nothing and never retires a
  standing observation (nor establishes one alone); the last EXECUTED
  observation decides, so `ok:false` after `ok:true` still fails; a
  successful write to the OBSERVED document after its last ok observation
  retires it (`stale`), a write elsewhere does not; an unbound observation
  cannot be shown stale. The `[INTERNAL VALIDATION FAILED` banner fires on
  `failed`, `refused-only` and `stale`, never on `standing`. Measured
  2026-09-14: the last-call bit fired on a refusal over three standing
  observations of an unchanged document and the run replayed its entire
  verification twice before the deadline
  ([incident](../../records/incidents/verification-replay-2026-09-15.md)).
- Keep `VALIDATION_SYSTEM_PROMPT` explicit that L1 plans should contain concrete
  tool-oriented proposed actions while L2/L3 must delegate.
  Direct plans carry the parser's `subtasks`/`aggregation` wrapper; validation
  names it as host normalization, never a reason to replan. Phase criteria
  distinguish planned checks, static evidence and executed behavior. Focused
  review excludes prior landing diagnoses and judges each criterion separately.

## Mechanical result gates

- Mechanical RESULT gates live in ONE declarative table
  (`src/atoms/resultGates.ts`) with an explicit disposition per gate:
  result-declared failures reject outright; disk-evidence gates reject ONCE per
  task (`ctx.mechanicalResultRejections`, fork-shared) and hand byte-identical
  repeats to the LLM (a gate whose cause is the same wherever it surfaces also coaches each cause once per attempt, `onceKeys`: the no-result suite gate rejects only a new task with a new cause, since run 51c4e71d rejected one socket link five times, 2026-10-26); prose-triggered gates never reject — they override the
  trust fast-path and attach a `MECHANICAL GATE FINDINGS` block to the full
  verdict. Workspace reads are cached per validation cycle. A new incident adds
  a table row with a stated disposition, never a new inline `if`. `required-command-manifest` judges a child without `record_probe` by the exact command's latest host receipt in its own branch, never the manifest it cannot write; its coaching names no tool, a holder's names record_probe (2026-10-26).
- The same table applies envelope and explicit validation failures to L2 results at L3 before trust
  (`appliesToDelegatedResult`); a reporting one (`read-only-validation-failed`, `tool-budget-exhausted`, `unvalidated-fallback` for the cell's own fallback) takes
  L3's trust and Decision paths away as at L2 (run dfa20873). Leaf action, disk and proof checks stay at L2.
- `declared-unverified` reads a molecule's own summary admitting its checks did
  not run (`DECLARED_UNVERIFIED_RE`) and forces review, at the cell over that
  molecule only: the summary travels up into every aggregate, and a tier above
  would re-review an admission already judged (run d162ee31; review 2026-10-10).
  Standing evidence of an unchanged document still counts.

## Declared proof obligations

- An obligation is DECLARED by the plan (`subtaskSpecSchema.proofObligations`,
  threaded onto `Task`), never sniffed from the description. A lexical detector
  over phase prose is the vocabulary-frozen detector class the 2026-08-14
  review measured; the planning prompt carries the rule instead
  (`PROOF_OBLIGATION_GUIDANCE`). An unknown value is DROPPED, so the failure
  direction is "no gate", never "wrong gate".
- Obligations INHERIT: `effectiveObligations` unions the subtask's own with the
  parent task's, so an obligation declared at L3 still reaches the L2 that
  supervises the tool-bearing child.
- `checkProofCoverage` is read-only and costs zero LLM calls. It never rejects.
  An uncovered obligation (a) disqualifies the trust fast path, (b) attaches
  the machine-observed facts to the full verdict, and (c) sets
  `PositiveVerdict.proofUncovered`, which withholds atom trust, skill credit,
  distillation and promotion in `onApproved`. Approval is a judgment about an
  ARTIFACT; those consequences are claims about a METHOD.
- The flag rides on the VERDICT, not on the supervisor instance: parallel lanes
  share one L2, so per-instance state would race across concurrent subtasks.
- Coverage is asymmetric on purpose. An observation with no document binding
  still covers; one whose document digest MOVED does not. A digest over a
  guessed file set produces false staleness, and a silently withheld credit is
  the failure mode this contract exists to remove.
- Withholding is honoured at L2, the tier that supervises tool-bearing
  children, and at L3 only for what a cell's own fallback proved
  (`Result.proofCoverage`); a molecule's coverage is never read twice.

## Model output parsing

- All model-output JSON parsing lives in `src/atoms/json.ts`. Preserve raw text
  on parse failure; never guess a structure. After tool work, one tool-free
  formatting turn may repair it (24,000 chars, 60s, with 60s run time left).
  Preserve witnesses, validation, raw failures and fence-aware tests; never replay tools for formatting.
- An unparseable L1 plan or L2/L3 plan pair (a truncation repair counts for pairs) is asked
  again within the plan budget, then escalates (`plan-unparseable`, 12bdcf19); the root spends an
  attempt. Pairs salvage raw control chars only; L1 keeps parseWith's repair. Never blames trust:
  a budget spent with no plan or result judged hands the task to the parent unbranched.
- `PlanParseError` is typed (`syntax`, `unbalanced`, `truncated`, `schema`, `suite-size`; the trace
  records it as `cause`) and owns `feedback()`; only JSON-syntax kinds get escaping advice. A new
  suite over `PARENT_TEST_AUTHORED_SOURCE_MAX_CHARS` (12,000) is refused by `parsePlanPair`, clean
  or salvaged, after both schemas accept; restore readers keep the schema's 32,000. Each suite is a
  self-contained file: never advise shared setup across suites.
- Feedback uses `Atom.plan`'s third argument, never task constraints (prefilter-keyed and inherited). The root retains all refusals/requests, the latest parse message and bounded host facts.
- Customer-device evidence cannot credit or penalize shared trust, revise/learn recipes/prompts or promote/demote recipes. L2/L3 and direct dispatch require independent hosted validation; withheld success, failure and recipe revision observations are journaled without changing counters or bodies. Matching and local recovery remain available.
Large identical original/current input copies are rendered once; conflicting values and all acceptance constraints remain. Versioned executable corpora replace repeated prose examples, never criteria.
## Intentional choices and rejected shortcuts
- L1 returns bounded prior same-request probe outputs, including customer-device replies: attempt-local reporting evidence, never replay input or coverage approval. Every requested invocation executes; latest failures remain failures. Do not repeat a mutant/restoration merely to create a separately named manifest entry.
- A new gate for a plan naming an unheld recorder: refused (2026-10-26). The template stopped teaching it; the zero-cost pre-check stays the net. Auto-recording `run_shell`, hand-writing the manifest and adding `record_probe` to the HTTP/full-stack scopes (2026-08-12) stay refused; the last is an owner decision awaiting a measurement.
- Sampled delegation-review votes (2026-10-17): a majority of three approves a
  defect the review misses two times in three more often (0.74), unanimity
  refuses sound plans into a failed run, and samples share one misreading.
  Host facts on the suites replaced them.
- Approved method hooks collect version-bound prompt lessons for all three ranks; root refusal discards them. Fixed author/reviewer prompts, bounded evidence and preservation rules: [prompt consolidation](../../docs/decisions/prompt-consolidation-2026-10-12.md).

Read the archived sections before changing something that merely looks odd.

- Plan size (G4, 2026-10-16): the suite bound is per suite, never a plan total;
  a soft 8,000-character target in prompts and review, with a 12,000 hard
  refusal 50% above it so a reviewer's request does not become a parser
  refusal; between the two, size is a HOST FACT, never a refusal (1622e44b). No adaptive plan cap (a cut is the common case, so cap-then-raise
  wastes a reply); no non-streaming cap above the SDK's 21,333; parse feedback
  never reaches the prefilter.

- L3 construction is async because it may resolve the latest Opus model alias;
  L2 construction has no equivalent lookup and may remain synchronous.
- Context injection appends and is composed later; do not mutate base prompts.
- `Atom.toolNames()` is public while tool objects remain protected by design.
- Capability bucket order is semantic; HTTP precedes web when signatures overlap.
- Planning and validation prompts match children on CAPABILITY (tool
  signature plus workflow shape), never on task domain, and validator-authored
  `descriptionReplace` passes through `resolveCreationDescription`. The earlier
  domain-match rule could only spawn identical clones once descriptions became
  capability labels; the theme travels in the subtask description. Since
  2026-10-10 a known signature keeps its canonical label, a seed NARROWS its parent's
  tools (`scopeTools`), every instance or seed built from a stored row takes the run's live declarations (`liveTools`), and template-born types go through `createOrRefresh` ([src/registry](../registry/AGENTS.md)).
- The full-stack canonical pairs Node-server and browser tools without a static
  server. It precedes HTTP in bucket selection; HTTP-only and static-web
  canonicals retain their narrower scopes and identities.
- Do not restore the L3 skeletal prefilter shortcut. Decomposition quality was
  worth the one top-tier strategy call.
- Do not add semantic prefilter caching. It removes exactness directly below an
  unvalidated fast path.
- Decision on that unvalidated fast path, and a Decision approval without the earned
  counter the trust fast path needs: taken by the OWNER on 2026-09-28, against
  both rules above, knowing a wrong pick costs about 60 decisions' savings.
  Every decision is a `jev` event. A Decision-only approval (`viaJev`) distils no
  new recipe: compile-at-learn would make it a validator-free script. A skill
  pick Decision hands to the model reaches it without the recipes Decision read as
  contradicting the task on files: offered one, the model injected a
  verify-only recipe into a build phase (run 0a989a58, one of the two such
  deferrals measured), and when nothing left fits Decision escalates itself. A
  model reuse of a recipe Decision read below `recipeOffer` (src/core) becomes no
  recipe: 24 of the model's 42 credited picks were misroutes, 19 under 0.5.
- Do not introduce plan templating until a typed instantiation/validation layer
  exists; free-form substitution is another unvalidated router.
- A spent ladder is a STAMP written where a ladder ends, never derived (G3, review
  2026-10-16). Refused: deriving it from `viaFallback` (`selfExecute` stamps it on a
  null-strategy or in-flight peer path that walked no ladder); counting fallbacks or one more
  tissue retry (the refused counter); re-dispatching only the subtasks that did not fall back
  (a fragment); attributing the tissue's refusal to one part (prose); `ladderSpent` reading
  `cell.peers` (a peer never used for this phase); rewriting a mutualized `producedBy` (false
  provenance); a hand-up without root acceptance (delivered unread). The `[A, C]` reach lands
  by analogy, with a pre-registered count:
  [record](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#follow-up-spent-ladders-that-are-not-recognised).
- Suite disputes route nothing and reach no model until measured (2026-10-17). Refused: a "SUITE DISPUTE" line in
  the hand-up and the root's refusal (it reached every call of the next pass as an invitation to contest a suite
  the weak signal often wrongly suspects), `workspaceDigest` as the version (every probe record moved it), and a
  challenge field the child fills in (run 2e6bdcfc's child tried to game its suite instead).
- Split verification (G5, 2026-10-16,
  [record](../../records/reviews/parent-tests-review-fixes-2026-10-16.md#follow-up-split-verification-parts-land-on-the-right-cell-and-own-their-criteria)).
  Do not bind a split checkpoint's criteria to a part whose cell cannot prove both browser
  and command evidence: a README phase judged on a keyboard criterion loops (first-refusals
  2026-10-10). Ownership goes by cell type, never by criterion wording or `check.kind` (an
  http criterion bound to the static split's fetch_url cell would push it to write a Node
  server). Browser holders follow `browserHolderFor`, at L3 and at the L2 redirect, never
  "first validate_html by ordinal" (notes-app 2026-09-07). A whole reroute names both proofs
  in one host line (guestbook, 31st iteration).
- A read-only phase is RESTORED when it ends, never refused its writes. The refusal was built
  and reviewed first (2026-09-30): a verifier that found a real defect was coached by the
  internal-validation gate to fix what the fence refused, spent its retries and a branch, and
  the cell's fallback, which the fence did not reach, rewrote the page anyway; a shell, a
  compiled script and a recipe's scratch file each passed it. Restoring covers every writer
  and leaves supervision as it is. Cost: a fix such a phase makes is undone, so the defect is
  left to a phase with outputs or to root acceptance (the validator rule says so, and never
  rejects a read-only phase to have it fixed where changes are undone). A mutating phase whose
  plan forgot its outputs is undone too; none was, among the 36 root phases of the deep runs
  and the short runs' root-cell plans measured on 2026-09-30, and a restoration names every
  file it lost. Do not tell a read-only molecule to change nothing: obeyed, it reported a
  failure the gate then coached it to fix, three identical rejections deep (review 2026-09-30).
- An unparseable suite refuses every time, never once-then-honour like a regex backslash (a
  heuristic). Rejected: a regex for a literal `\n`; Vite's parser (native binding, not on the host).
- `salvageResultEnvelope` reads a malformed summary STRUCTURALLY — everything
  between `"summary":"` and the closing `"}` — only when the envelope is the
  whole response with `output` first and every bare quote of the summary
  belongs to JSON it pasted, and it competes only with a repair, never with a
  payload that parsed as written. Taking the last `"}` on trust fused a key
  after the summary, a second envelope or a cut paste into the result in 685
  of 20,000 fuzzed envelopes that the old path read correctly (review
  2026-09-30). Do not widen it to prose quotes, prose-wrapped or summary-first
  envelopes on inference: none was observed. `salvageNestedSummary` reads a
  summary written inside `output` one brace short (run 3cbef119), checking
  names in the source; the well-formed nested shape stays refused.
