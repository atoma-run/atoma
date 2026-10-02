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
- `superviseLoop` is the only plan → validate → execute → validate protocol.
  L2 and L3 reuse it for children; never duplicate that loop in concrete
  atoms. The L3 root `handle` is plan → execute (no parent). A parallel
  L3 plan whose declared `outputs` collide earns one coached Opus replan
  (`acceptL3RootPlan`); a repeat is honoured, and so is a replan that
  THROWS — the coaching may not turn a racy-but-executable plan into no
  run at all. Both planning prompts demand `outputs` on file-mutating
  subtasks, so the collision channel exists. Do not copy this rule onto
  L2 — child plans already go through FAN-OUT validation. Do not coerce
  an explicit L3 `concat` into `sequential`.
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
- `pendingStrategy` couples `plan()` and `execute()` on the same instance. Never
  call `execute()` without the corresponding plan.
- `fallbackMode` bypasses registry delegation and calls self-plan/self-execute.
- Mutation scopes flow through `applyByScope`; update the union and every hook
  together when adding a scope.
- Per-task child memos prevent immediate reuse loops. Initialize task state,
  mark committed children, and pass exclusions to prefilters.
- Run-scoped integrity flags and memos must retain the same reference across
  every `forkBranch`; add fork-propagation coverage for new optional fields.

## Root delivery acceptance in depth routing
- The depth runner's `rootAcceptance.ts` owns delivery acceptance:
  delegated result gates retain their dispositions, `probe.requiresReview`
  forces review. Explicit profile floors require an executed DOM interaction
  bound to the named, still-unchanged file in the accepted attempt. A profile
  without a floor always receives semantic delivery review at `modelForTier(1)`;
  an empty floor is not automatic approval. The general build profile has no
  universal `index.html` floor: APIs and CLIs are first-class deliverables.
  Covered explicit floors with no other findings retain mechanical acceptance.
  The root changes no phase credits or learning state. The probe receives only `output` and `summary`, as at L3; internal
  plan/verdict/fallback trace quotes are not delivery claims. Phase coverage
  is collected with its original attempt and branch, never reevaluated
  against the root floor. The floor is not inherited by phases. The review
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
  decision (docs/incidents/production-runs-2026-09-27.md). When criteria are shown, the acceptor also
  judges EACH one (`criteria`, kept on the checklist items as `judgement`); a
  USER list is always read, never approved mechanically past, and an approval
  that judges one of its criteria unmet is the acceptor contradicting itself,
  so it refuses with that criterion. A drafted item judged unmet is recorded
  and never fails a run by itself.
- Two more host-read facts sit beside the delivery, neither a verdict. A
  SEEDED run's acceptor reads what happened to the files it started from
  (`startingWorkspace`: removed; rewritten when under half of its starting
  lines survive anywhere in the delivery; moved when they survive in other
  files; changed; unchanged; new — the delivered side reads exactly the
  starting paths, so no cap can report a kept file removed), because run
  902b2c21 (2026-09-27) replaced the
  configurator it was asked to keep with a stand-in computing the criterion's
  number, and nothing it read said so. And the files the criteria NAME
  ("docs/ERRORS.md", or a root Markdown stem such as "README") are read back
  when the ground-truth block does not already show them: run dc45c95b's
  README criterion was judged on the file existing. They show a head and,
  past it, the lines holding the criterion's words; a cut excerpt is silent
  about the rest, and a name that resolves to no file is silent — "saves
  quote.txt" names a download. Both are read only for a validation call.
- A LANDED result carries `LANDED_RESULT_GUIDANCE` to that validator, and
  nothing else does. A landed run stopped before it could prove the floor, so
  `floorCoverage` is uncovered BY CONSTRUCTION and the verdict is always a
  validation call — never the mechanical path. Until 2026-09-24 the judge was
  told nothing about landings while the prompt's only statement on
  incompleteness was a rejection ("a visually-incomplete artefact is a failed
  deliverable"), so an honest landing's fate rested on model prose alone. The
  wording follows the analyst's on purpose: one definition of a landing, served
  to both judges. A phase supervisor never receives it — landing is a property
  of the whole run.
- THE ACCEPTANCE CHECKLIST ([design](../../docs/acceptance-checklist-2026-09-25.md))
  is drafted once per depth-routed run by `draftAcceptanceChecklist`
  (cheapest tier, role `draft-checklist`, actor `run-checklist`), reaches the
  root planner through `inputs.acceptanceChecklist`, and is covered at the
  root from attempt-scoped host `http` observations taken BEFORE the root's
  own probe. It informs the validation call and decides nothing: a
  model-drafted list may only add what the acceptor looks for. Rendered only
  when it holds an http item; a landed result is told NOT OBSERVED is
  expected for its unfinished phases.
- A USER-APPROVED list ([contract](../../docs/acceptance-contract-2026-09-14.md#built-the-user-approved-list-2026-09-25))
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
  ([owner decision](../../docs/jev-decisions-2026-09-28.md)): after a prefilter
  cache miss its pick is a high-confidence reuse and `none_of_these` an
  escalate, never cached; and it may APPROVE a plan or result only where a
  fast path is admissible (no gate finding, proof covered, probe not requiring
  review), through `jevApproval`, which hands it the model validator's own
  transport-observed evidence lines (`renderTransportEvidence`), never the
  child's declared probes. A no, an unsure answer or a silence is the model's
  decision, as before. Root delivery acceptance is never Jev's.
- THE JEV AUDIT: every `jevApproval` call site hands it `audit`, the very model
  verdict it runs without Jev (one `modelVerdict` function per validation, so
  the audit cannot drift from the real verdict). A `ctx.jevAudit.rate` share of
  Jev's approvals defers it, under the `jev-audit` role, off the run's path. It
  decides NOTHING — Jev's approval stands whatever the model says — and its
  role keeps it out of every reader that counts validations.
- The Jev calibration (`jevCalibration.ts`) reads prefilter and validation
  prompts back out of traces, so the LAYOUT of what `prefilterStrategy` and
  `llmVerdict` send is a contract with it: `tests/jev-calibration.test.ts`
  renders with the production code and parses the result, and a prompt change
  keeps it passing or changes the parser with it.
- Atom trust fast paths require the configured consecutive approved-result
  threshold (default 3), read through `trustThreshold()`; historical failures do
  not permanently disqualify a type. Script dispatch retains its separate
  zero-failure rule; recipe compilation follows the skills contract. Invalid or non-positive threshold values
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
- Strategy calls use `STRATEGY_MAX_TOKENS` and medium effort. The cap includes
  adaptive thinking. Defaults in `planSchema` protect against truncation;
  omitted L3 aggregation defaults to `sequential`.
- Prompt-cache thresholds are load-bearing. Keep the validation prompt above
  the cheapest model's minimum and confirm `cache_read` on multi-call runs.

## Aggregation and dispatch shape

- Delegation preserves original task inputs/constraints and preceding phase results.
  Declared reasoning mode disables tools/skills through descendants and fallbacks;
  only its observed-action gate is skipped. [Contract and review](../../docs/incidents/text-delivery-2026-10-02.md).

- `llm-synthesize` merges text without tools; file assembly requires an L1 phase.
- Aggregation is behavioral: `concat` and `llm-synthesize` dispatch orthogonal
  subtasks in parallel; `sequential` dispatches shared-artifact phases in order
  and threads `previousStepSummary` plus declared `outputs` as
  `inputs.previousStepOutputs`. Do not merge prior writes into the next
  phase's `outputs` — skill/promotion gates read the current phase only.
  Do not parallelize coupled filesystem work.
- A plan carries ONE aggregation mode, so fan-out + join has no direct spelling
  at a single tier: L3 emits ONE phase per orthogonal GROUP and the L2 that
  receives it fans the group out. One L3 phase per orthogonal artefact
  serialises work that shares no file — see
  [parallel fan-in 2026-08-16](../../docs/incidents/parallel-fanin-2026-08-16.md).
- A phase of a SEQUENTIAL root plan the PLANNER wrote with two phases or more
  (counted before `routeCrossBucketVerification` splits one) that declares no
  `outputs` is READ-ONLY (`Task.readOnly`) — the tissue's plan, or a root
  cell's own (a fork carries `currentBranchId`; a prefilter reuse is one
  dispatch of the whole task). A one-phase plan is the whole task, and
  parallel phases share the workspace at the same moment, so neither is
  marked. Runs 04ea696f (2026-09-30: a verification phase replaced the page it
  verified, and that page shipped) and f793b338 (2026-09-27: an inspect
  subtask overwrote a home page 23 times).
- Every execution of a read-only phase — the child's, a branch's, the
  parent's fallback, a compiled script's — runs between a host photograph of
  the workspace and its restoration (`withinReadOnlyPhase` through
  `SupervisionHooks.aroundExecute`, once, where the phase starts; host half in
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
  `dispatchWithAggregation` returns `{results, unfinished}`: sequential refuses
  to OPEN a phase under `MIN_PHASE_LANDING_MS` of remaining wall clock and keeps
  the earlier phases when a phase that was opened is aborted, and parallel keeps
  the branches that settled when the deadline cut their siblings. A dispatch
  that completed NO phase still throws, and a rejection that is not the deadline
  keeps its meaning whatever else settled — `ctx.signal` is the deadline and
  nothing else, since cancellation reaches a run as process teardown. `markLanded`
  stamps the aggregate (`Result.unfinishedPhases`, unioned with what a nested
  landing reported) and the runner turns that into the `partial` outcome. Never
  infer a landing from the summary text: `markLanded` prefixes it, but it then
  continues into model-authored prose. Measured twice on 2026-09-21:
  [progressive runs](../../docs/incidents/progressive-runs-2026-09-21.md).
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

- L1 plans express intent in prose; actual tool calls happen during execute.
  Do not encourage large literal `toolCalls` payloads in plans.
- Tool scopes are bucket-specific and enforced twice: prompts/plans must name
  only declared tools, and the executor rejects undeclared tool use.
- Match verification to the artefact: browser UI uses static server plus
  browser validation; HTTP APIs use node server plus fetch; CLI/files use shell
  execution plus read-back. Do not force every artefact through HTML tooling.
- Recorded probes support cross-checking but do not make non-zero exits errors.
  Only explicit `match:false` or unequal expected/actual values are mechanical
  contradictions.
- Ground-truth reporting must quote observed tool bytes. Narrative self-report
  alone is not evidence.
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
  from the same attempt and branch, not proof of unchanged current state.
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
  The latest 8 browser lines are always shown; execution lines share the rest.
- ROOT ACCEPTANCE REPLAYS THE BROWSER CHECKS EARLIER RUNS RECORDED, the one
  exception to "supervisors never replay" (owner decision 2026-10-01,
  [docs/inherited-checks-replay-2026-10-01.md](../../docs/inherited-checks-replay-2026-10-01.md)).
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
  A replay that left kept checks unrun says so in the block and forces the
  review.
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
  ([incident](../../docs/incidents/verification-replay-2026-09-15.md)).
- Keep `VALIDATION_SYSTEM_PROMPT` explicit that L1 plans should contain concrete
  tool-oriented proposed actions while L2/L3 must delegate.

## Mechanical result gates

- Mechanical RESULT gates live in ONE declarative table
  (`src/atoms/resultGates.ts`) with an explicit disposition per gate:
  result-declared failures reject outright; disk-evidence gates reject ONCE per
  task (`ctx.mechanicalResultRejections`, fork-shared) and hand byte-identical
  repeats to the LLM; prose-triggered gates never reject — they override the
  trust fast-path and attach a `MECHANICAL GATE FINDINGS` block to the full
  verdict. Workspace reads are cached per validation cycle. A new incident adds
  a table row with a stated disposition, never a new inline `if`.
- The same table applies envelope and explicit validation failures to L2
  results at L3 before trust (`appliesToDelegatedResult`). Leaf action, disk
  and proof checks stay at L2; delegated results are not leaf executions.

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
  on parse failure; never guess a structure.
- Nested Markdown fences can hide evidence. Keep fence-aware extraction and its
  adversarial tests.

## Intentional choices and rejected shortcuts

Read the archived sections before changing something that merely looks odd.

- L3 construction is async because it may resolve the latest Opus model alias;
  L2 construction has no equivalent lookup and may remain synchronous.
- Context injection appends and is composed later; do not mutate base prompts.
- `Atom.toolNames()` is public while tool objects remain protected by design.
- Capability bucket order is semantic; HTTP precedes web when signatures overlap.
- Planning and validation prompts match children on CAPABILITY (tool
  signature plus workflow shape), never on task domain, and validator-authored
  `descriptionReplace` passes through `resolveCreationDescription`. The earlier
  domain-match rule could only spawn identical clones once descriptions became
  capability labels; the theme travels in the subtask description.
- The full-stack canonical pairs Node-server and browser tools without a static
  server. It precedes HTTP in bucket selection; HTTP-only and static-web
  canonicals retain their narrower scopes and identities.
- Do not restore the L3 skeletal prefilter shortcut. Decomposition quality was
  worth the one top-tier strategy call.
- Do not add semantic prefilter caching. It removes exactness directly below an
  unvalidated fast path.
- Jev on that unvalidated fast path, and a Jev approval without the earned
  counter the trust fast path needs: taken by the OWNER on 2026-09-28, against
  both rules above, knowing a wrong pick costs about 60 decisions' savings.
  Every decision is a `jev` event. A Jev-only approval (`viaJev`) distils no
  new recipe: compile-at-learn would make it a validator-free script. A skill
  pick Jev hands to the model reaches it without the recipes Jev read as
  contradicting the task on files: offered one, the model injected a
  verify-only recipe into a build phase (run 0a989a58, one of the two such
  deferrals measured), and when nothing left fits Jev escalates itself.
- Do not introduce plan templating until a typed instantiation/validation layer
  exists; free-form substitution is another unvalidated router.
- A read-only phase is RESTORED when it ends, never refused its writes. The
  refusal was built and reviewed first (2026-09-30): a verifier that found a
  real defect was coached by the internal-validation gate to fix what the
  fence refused, spent its retries and a branch, and the cell's fallback,
  which the fence did not reach, rewrote the page anyway; a shell, a compiled
  script and a recipe's scratch file each passed it. Restoring covers every
  writer and leaves supervision as it is. What it costs: a fix such a phase
  makes is undone, so the defect is left to a phase with outputs or to root
  acceptance — the validator rule says so, and never rejects a read-only phase
  to have it fixed where changes are undone. A mutating phase whose plan
  forgot its outputs is undone too; none was, among the 36 root phases of
  the deep runs and the short runs' root-cell plans measured on 2026-09-30,
  and a restoration names every file it lost. Do not tell a read-only
  molecule to change nothing: obeyed, it reported a failure the gate then
  coached it to fix, three identical rejections deep (review 2026-09-30).
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
