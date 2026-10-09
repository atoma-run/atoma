import type { AttestationLog, ProofObligation } from '../contracts/attestation.js';

export type Tier = 1 | 2 | 3;

export interface Task {
  readonly description: string;
  readonly originalTask?: Pick<Task, 'description' | 'inputs' | 'constraints'>;
  readonly executionMode?: import('../contracts/taskExecution.js').ExecutionMode;
  /** Semantic file intent from a recipe prefilter; never a restoration-policy flag. */
  readonly fileEffect?: import('../contracts/fileEffect.js').FileEffect;
  readonly inputs?: Record<string, unknown>;
  readonly constraints?: string[];
  /**
   * Workspace-relative paths this subtask is expected to CREATE or MODIFY,
   * declared structurally by the plan that authored it. When present and
   * non-empty it is AUTHORITATIVE for mutation classification and the
   * deterministic-dispatch target gates; when absent or empty, consumers
   * fall back to the lexical grammar over `description`
   * (`subtaskMutatesFiles` / `subtaskMutationTargetPaths`) — output intent
   * used to travel ONLY as prose and be regex-recovered, which cost one live
   * run per unrecognised phrasing (2026-08-14 review §3.3).
   */
  readonly outputs?: readonly string[];
  /**
   * The ROOT plan declared this phase READ-ONLY: a sequential decomposition
   * of two phases or more gave it no `outputs`, which the planning contract
   * reserves for phases that read and verify ("Omit the key only on read-only
   * phases"). The root plan is the L3's, or a root cell's own (never a
   * prefilter reuse, which dispatches the whole task). Every execution of the
   * phase then runs between a photograph of the workspace and its restoration
   * (`src/contracts/readOnlyPhase.ts`): run 04ea696f's verification phase
   * replaced the page it was asked to verify, and run f793b338's "read-only
   * inspect" subtask overwrote a home page 23 times without reading it.
   */
  readonly readOnly?: true;
  /**
   * Proof obligations DECLARED by the plan that authored this subtask. An
   * obligation no transport-observed attestation covers never rejects the
   * deliverable: it forces validator review and withholds the METHOD-level
   * consequences of approval (atom trust, skill credit, distillation,
   * promotion). Absent means today's behaviour, unchanged.
   *
   * Declared, never sniffed. A mechanical detector over `description` — "the
   * word click implies a DOM obligation" — is the vocabulary-frozen detector
   * class the 2026-08-14 review measured as a primary source of drift.
   */
  readonly proofObligations?: readonly ProofObligation[];
  /** Profile-owned delivery obligations, frozen before routing; never inherited as phase obligations. */
  readonly proofFloor?: import('../contracts/depthRouting.js').ProofFloor;
}

export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Periodic-table identity for built-in atomic capabilities. `name` remains
   * the immutable invocation/wire contract; this is taxonomy metadata only.
   * Optional so third-party tool declarations still load.
   */
  readonly element?: import('../contracts/toolTaxonomy.js').Element;
}

export interface GenerationParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /**
   * Reasoning-depth hint (`output_config: {effort}`) for models that
   * support it (Sonnet 4.6+/5, Opus 4.5+/5 — the client gates via
   * `modelSupportsEffort`; Haiku rejects the param). Plan/strategy call
   * sites pin `'medium'`: those models default to `'high'`, the most
   * expensive setting, and a routing JSON pair does not need it.
   */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * One unit of work a supervisor hands to a child agent. Spelled out as its
 * own shape (rather than reusing `Task`) because a subtask carries a
 * routing hint (`preferredChild`) that has no place at the task-level API.
 * `description` is the "what" the child must accomplish. `inputs` is an
 * optional structured payload passed through the child's Task at
 * supervision time. `preferredChild` is a soft hint — the supervisor's
 * prefilter/create path still gets the final say — meant for planners
 * that already know which catalog entry fits best.
 */
export interface SubtaskSpec {
  readonly description: string;
  readonly executionMode?: import('../contracts/taskExecution.js').ExecutionMode;
  readonly inputs?: Record<string, unknown>;
  readonly preferredChild?: string;
  /** See `Task.outputs` — threaded verbatim onto the child Task. */
  readonly outputs?: readonly string[];
  /**
   * See `Task.proofObligations` — threaded onto the child Task, UNIONED with
   * the parent task's own, so an obligation declared one tier up still
   * reaches the supervisor that watches the tool-bearing child.
   */
  readonly proofObligations?: readonly ProofObligation[];
}

/**
 * How a supervisor combines the N `Result`s produced by its subtasks into
 * the single `Result` it returns to its own supervisor. Three modes:
 *   - `concat`: mechanical aggregation — outputs concatenated into an
 *     array, summaries joined. Cheap (no LLM call), useful when sub-
 *     results are naturally independent artefacts (ex: N research
 *     summaries → 1 brief). Subtasks run in PARALLEL via Promise.all.
 *   - `llm-synthesize`: the supervisor's own model is called with the N
 *     sub-results and `instruction` to produce a final structured
 *     output. Expensive but necessary when the final deliverable is a
 *     COMBINED artefact (ex: L1s produce layout/logic/rendering
 *     fragments → the L2 synthesizer assembles them into `index.html`).
 *     Subtasks run in PARALLEL via Promise.all.
 *   - `sequential`: subtasks run ONE AT A TIME, with each step's summary
 *     threaded into the next step's `inputs.previousStepSummary` and its
 *     declared `outputs` into `inputs.previousStepOutputs`. The final
 *     aggregated result is the LAST step's output (no extra LLM call).
 *     Use when phases share an artefact that EVOLVES across steps
 *     (build-then-extend-then-smoke on the same file). The workspace
 *     filesystem is implicitly shared, so phases mutate the same on-disk
 *     artefact; the threaded summary is narrative state, the threaded
 *     outputs are the structured paths. Skill/promotion gates still
 *     read the CURRENT phase's `outputs` only — prior paths are inputs,
 *     not a lie about what this phase writes.
 */
export interface AggregationSpec {
  readonly mode: 'concat' | 'llm-synthesize' | 'sequential';
  readonly instruction?: string;
}

/**
 * Fan-out plan emitted by L2/L3 supervisors. `subtasks` is ALWAYS at
 * least length 1 — a "single-subtask" plan is the degenerate fan-out
 * case, not a separate shape. This keeps the execute loop uniform:
 * `Promise.all(subtasks.map(run))` trivially collapses to a single
 * child run when N=1.
 */
export interface Plan {
  readonly reasoning: string;
  readonly delivery?: import('../contracts/taskExecution.js').DeliveryKind;
  readonly subtasks: readonly SubtaskSpec[];
  readonly aggregation: AggregationSpec;
  readonly expectedOutput: string;
  /**
   * Single-action hint, used by L1 plans (which describe
   * a single direct action) and for backwards-compat with older
   * `{reasoning, proposedAction, expectedOutput}` shapes. Optional on
   * fan-out plans — the subtasks carry the detail.
   */
  readonly proposedAction?: string;
  readonly toolCalls?: ToolCall[];
  /**
   * Internal provenance marker set when a plan was synthesised by the
   * Haiku prefilter short-circuit in L2/L3.plan (not by the full
   * Sonnet/Opus strategy call). The supervisor's validatePlan treats
   * such plans as already-vetted — see planSchema docs in json.ts and
   * L2Atom.validatePlan for the full rationale. LLMs never set this
   * field; the plan synthesiser in L2/L3 does.
   */
  readonly viaPrefilter?: boolean;
}

export interface Result {
  readonly output: unknown;
  readonly summary: string;
  readonly toolCallResults?: unknown[];
  /** Transport saw record_probe persist a command result, including an expected nonzero exit. */
  readonly recordedCommandProbes?: true;
  /** Transport-observed proof that an injected script skill's scratch body ran. */
  readonly activeScriptSkillExecuted?: boolean;
  readonly trace: TraceEntry[];
  readonly producedBy: { tier: Tier; name: string; viaFallback: boolean };
  /**
   * Machine-checkable witnesses extracted from the payload at production
   * time (see src/contracts/witness.ts). VERIFICATION-FIRST principle: a
   * result carrying witnesses is structurally stronger evidence than one
   * carrying narrative alone — validators and projections read this typed
   * field instead of re-parsing `output`. Optional because fallback paths
   * and library producers may not populate it; absence means "no
   * machine-checkable evidence", never "verified".
   */
  readonly evidence?: readonly import('../contracts/witness.js').Witness[];
  /**
   * Descriptions of the plan phases this result does NOT cover, because the
   * run deadline landed the dispatch before they ran (`dispatchWithAggregation`).
   * Present and non-empty means the result is honest but INCOMPLETE: the work
   * it reports was accepted, and the named phases never happened.
   *
   * It exists so that "landed early" cannot be mistaken for "delivered". The
   * 2026-09-21 production runs discarded three completed phases each rather
   * than report them, and the post-mortem credited the system for recording
   * `failed` instead of falsely delivering — correctly, because there was no
   * way to say the third thing. This field is that third thing. Absence means
   * every planned phase ran, never "unknown".
   *
   * It is no longer the ONLY route to `partial`: see `refusal` below, and
   * `landedResult()` in `src/run/runner.ts` for the one derivation both feed.
   */
  readonly unfinishedPhases?: readonly string[];
  /**
   * What a FALLBACK executor's own calls proved of its task's declared
   * obligations, computed by the host from the attestation log
   * (`proveFallback`, src/atoms/fallbackProof.ts), never by a model. A
   * molecule's coverage is its supervisor's to compute; a fallback has none
   * in its own loop, so the coverage rides its result, through every
   * aggregate, to the tier that judges it. An uncovered entry withholds that
   * tier's credit, as `PositiveVerdict.proofUncovered` does.
   */
  readonly proofCoverage?: readonly {
    readonly obligation: import('../contracts/attestation.js').ProofObligation;
    readonly covered: boolean;
    readonly reason: string;
    readonly eventIds: readonly string[];
  }[];
  /**
   * Set by `withinReadOnlyPhase`, never by a model, when a READ-ONLY phase's
   * execution changed files the runtime then put back
   * (`src/contracts/readOnlyPhase.ts`). `summary` is what its executor wrote,
   * beneath the runtime's `[READ-ONLY PHASE RESTORED …]` line: the gates that
   * read a banner at the head of a summary read it there. Its presence
   * withholds the method-level credit an approval would give, as
   * `PositiveVerdict.proofUncovered` does.
   */
  readonly readOnlyRestoration?: import('../contracts/readOnlyPhase.js').ResultRestoration;
  /**
   * Why ROOT DELIVERY ACCEPTANCE refused this result, when it did.
   *
   * A refused run completed every phase it planned — `unfinishedPhases` is
   * empty BY CONSTRUCTION — and was then judged not to have proven what it
   * claimed. Until 2026-09-24 that threw out of `runDepthTask`, the runner
   * recorded `failed`, and `previousSeedRun` skipped the run on its status
   * filter, so a workspace full of real work seeded nothing. Measured on
   * production run `6ab0ae3b`: thirty minutes and 0.42 USD, nothing kept.
   *
   * THE TWO REASONS COMPOSE. A run can land on its budget AND be refused —
   * the deadline stops it mid-plan, and the root then judges what it did
   * report. Both fields are then set, and every reader that explains a run to
   * a person must say both; reporting only the phases silently drops the
   * refusal, which is the customer-visible half.
   *
   * A result carrying this is NOT a delivery and never publishes: the run is
   * `partial`, and `partial` is excluded from publication at three gates.
   * It does seed the next run, deliberately — the work is real, and the
   * refusal travels with it so the next run knows what was unproven.
   */
  readonly refusal?: string;
  /**
   * Set by the executor whose OWN tool loop wrote this result on the forced
   * finalization turn after its iteration budget ran out
   * (`LlmCompletionResponse.toolBudgetExhausted`), never by a model and never
   * copied by an aggregate. The `tool-budget-exhausted` result gate turns it
   * into a review finding, so no trust or Jev fast path approves such a
   * result unread: production run dfa20873 (2026-10-03) trust-approved and
   * credited a molecule whose loop the deadline had cut to three iterations,
   * whose output read {"status":"incomplete"}, on a phase its cell had just
   * rejected three times for the same missing evidence.
   */
  readonly toolBudgetExhausted?: true;
}

export type MutationScope = 'ephemeral' | 'branch' | 'patch';

export interface AtomModifications {
  systemPromptAppend?: string;
  systemPromptReplace?: string;
  /**
   * Overwrite the agent type's short human-readable description. Useful when a
   * validator realises that a branched/patched agent's *purpose* has drifted
   * from its original template (e.g. a "platformer builder" description on a
   * type whose system prompt now targets Minesweeper). The description is
   * what the prefilter sees when choosing a catalog entry, so keeping it in
   * sync with the actual system prompt matters for routing accuracy.
   */
  descriptionReplace?: string;
  addTools?: Tool[];
  removeTools?: string[];
  params?: Partial<GenerationParams>;
  additionalContext?: string;
}

export type PositiveVerdict = {
  approved: true;
  reasoning: string;
  /**
   * Usage-conditioned skill credit (adherence gate). Set by the RESULT
   * validator ONLY when the run was driven by an injected skill: `true`
   * when the child demonstrably followed the recipe, `false` when it
   * visibly ignored it and solved the task another way. `undefined`
   * means "unknown" (no skill active, validator omitted it, or the
   * trust fast-path skipped the LLM) and preserves the default —
   * skill counters only stop moving on an EXPLICIT `false`. Orthogonal
   * to `approved`: adherence routes credit, it never gates approval.
   */
  activeSkillFollowed?: boolean;
  /**
   * Proof coverage, set by the supervisor — never by a model. `true` means
   * the task declared a proof obligation that no transport-observed
   * attestation covers. Like `activeSkillFollowed`, it is orthogonal to
   * `approved`: approving a RESULT is a judgment about an ARTIFACT, while
   * atom trust, skill credit, distillation and promotion are claims about a
   * METHOD, and only the second needs machine-observed proof. So this
   * withholds the method-level consequences and leaves the verdict alone.
   *
   * Carried ON THE VERDICT rather than on the atom instance because parallel
   * lanes share one supervisor instance: per-instance state would race
   * across concurrent subtasks.
   */
  proofUncovered?: boolean;
  /**
   * Set by the supervisor — never by a model — when Jev, not the model
   * validator, approved (docs/jev-decisions-2026-09-28.md). It withholds ONE
   * consequence: distilling a NEW recipe from the run. Compile-at-learn makes a
   * learned script dispatchable from its first match, platform-wide, its
   * results judged by Jev first, so a recipe must come from a run a model
   * validated, or Jev would be approving its own lesson. Trust
   * and the credit of a recipe that drove the run are not withheld.
   */
  viaJev?: true;
  /** One judgement per acceptance criterion, when the prompt listed criteria. */
  criteria?: readonly CriterionJudgement[];
  /** One judgement per inherited check root acceptance listed (src/contracts/inheritedChecks.ts). */
  inherited?: readonly import('../contracts/inheritedChecks.js').InheritedJudgement[];
};
/** A validator's judgement of ONE acceptance criterion, by its checklist id. */
export interface CriterionJudgement {
  readonly id: string;
  readonly met: boolean;
  readonly reason?: string;
}
export type NegativeVerdict = {
  approved: false;
  reasoning: string;
  modifications: AtomModifications;
  scope: MutationScope;
  branchName?: string;
  /** See PositiveVerdict.activeSkillFollowed — same semantics on rejections. */
  activeSkillFollowed?: boolean;
  /** See PositiveVerdict.criteria. */
  criteria?: readonly CriterionJudgement[];
  /** See PositiveVerdict.inherited. */
  inherited?: readonly import('../contracts/inheritedChecks.js').InheritedJudgement[];
};
export type Verdict = PositiveVerdict | NegativeVerdict;

export interface TraceEntry {
  kind:
    | 'plan'
    | 'verdict-plan'
    | 'execute'
    | 'verdict-result'
    | 'applied-modifications'
    | 'repeat-rejection'
    | 'escalated'
    | 'branch-retry';
  ts: string;
  atom: string;
  payload: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface Limits {
  readonly maxPlanIterations: number;
  readonly maxExecIterations: number;
}

export interface LlmCompletionRequest {
  model: string;
  systemPrompt: string;
  userContent: string;
  /**
   * Stamped at the call site. The recorder stores this verbatim. Absent →
   * `unknown`. Prompt text is not a fallback classifier.
   */
  role?: import('../contracts/llmTrace.js').LlmCallRole;
  /** Caller identity when known — same shape the viz already stores. */
  actor?: { name: string; tier: Tier };
  child?: { name: string; tier: Tier };
  subject?: 'PLAN' | 'RESULT';
  /**
   * Typed injects folded into `systemPrompt`. The recorder cites these on
   * the llm event; they are the join between injectContext and complete().
   */
  context?: readonly import('../contracts/llmTrace.js').ContextBlock[];
  tools?: Tool[];
  params?: GenerationParams;
  cacheSystem?: boolean;
  cacheTools?: boolean;
  /**
   * If provided, the LLM client will run a tool-use loop: any `tool_use`
   * blocks returned by the model are executed locally via this executor and
   * their results are sent back to the model until it returns a final text
   * response. Without it the client returns the first response as-is.
   */
  executor?: ToolExecutor;
  /**
   * Abort signal forwarded to the underlying transport. The Anthropic SDK
   * honours this on each HTTP round-trip, so a global run-deadline (usually
   * `RunContext.signal`) can actually cancel long-running completions and
   * tool-loop iterations. Atom call sites thread `ctx.signal` here.
   */
  signal?: AbortSignal;
  /**
   * Upper bound on tool-use iterations for this single call. Each iteration
   * is one round-trip to the model; when the model replies with `tool_use`
   * we execute the tools, send the results back, and loop again. Tasks with
   * long convergence patterns (e.g. a build-app L1 that iterates on a
   * validate_html → fix → re-validate cycle) need more budget than a
   * one-shot reasoning call. When the budget is exhausted the client does
   * a final tools-disabled round-trip to force a text response rather than
   * throwing. Defaults to 24 if omitted.
   */
  maxToolIterations?: number;
  /**
   * Observer callback invoked for every tool invocation inside the tool-use
   * loop, once per tool_use block. Fires AFTER the tool has run (success or
   * failure) so the callback sees the observed result. Used by
   * `RecordingLlmClient` to emit `VizToolEvent`s into the trace — the recorder
   * is the only known caller today, but the hook is kept general so e.g.
   * metrics or audit decorators can plug in later. Must not throw; errors
   * from this callback are swallowed so observability never breaks execution.
   */
  onToolInvocation?: (info: ToolInvocationInfo) => void;
  /**
   * Optional fan-out lane identifier echoed back on trace events emitted
   * for this completion (the LLM event itself AND any tool events from
   * its tool-use loop). Callers usually copy this from
   * `RunContext.currentBranchId` — see L2/L3 runSubtask. Not the same
   * thing as the completion's own id; multiple completions within the
   * same branch share this value.
   */
  branchId?: string;
}

export interface ToolInvocationInfo {
  /** Tool name exactly as declared on the molecule. */
  name: string;
  /** JSON-serialisable args the model sent to the tool. */
  args: Record<string, unknown>;
  /** Raw return value from the tool executor, if the call succeeded. */
  result?: unknown;
  /** Error message, if the tool threw. Mutually exclusive with `result`. */
  error?: string;
  /** Wall time from executor start to callback invocation. */
  durationMs: number;
  /** Wall-clock timestamp at which the tool call STARTED (`Date.now()`). */
  startedAt: number;
}

export interface LlmCompletionResponse {
  text: string;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  /**
   * The model the transport ACTUALLY invoked, when it differs from the
   * requested `req.model` (bare slug/alias, no provider prefix). Three
   * transports silently rewrite the pin — resolveCodexModel maps
   * `claude-opus-5` → `gpt-5.6-sol`, Ollama collapses Anthropic pins onto
   * its configured defaultModel, claude-cli maps pins onto haiku/sonnet/
   * opus aliases — so pricing on the pin billed GPT tokens at Claude rates
   * (review 2026-08-14 §1.13). Observability layers price with
   * `servedModel ?? req.model`; AnthropicLlmClient serves `req.model`
   * verbatim and may omit the field.
   */
  servedModel?: string;
  /**
   * Set by a tool loop, never by a model, when its iteration budget ran out
   * and `text` came from the forced tools-disabled finalization turn
   * (`BUDGET_EXHAUSTED_HINT`). The executor that ran the loop carries it onto
   * `Result.toolBudgetExhausted`.
   */
  toolBudgetExhausted?: true;
}

export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
  /**
   * Whether `params.effort` reaches the provider for `model`, read off the
   * same gate `complete` applies. Decorators forward it; absent means no. A
   * decision whose answer the transport would drop is then not asked.
   */
  honoursEffort?(model: string): boolean;
}

/**
 * Executes a declared tool by name. Implementations are usually backed by an
 * in-memory map populated at app startup (the registry stores only the
 * serializable declaration — name/description/schema — so executors live
 * outside the DB).
 */
export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  has(name: string): boolean;
}

/**
 * Observability hook fired whenever a supervisor short-circuits validation
 * via the trust fast-path (`shouldTrustType` / `trustedApproval`). Such
 * decisions skip the LLM call entirely and therefore don't appear in the
 * trace as `kind: 'llm'` events — but they ARE real supervision decisions
 * that the visualiser should show, otherwise the lane for a trusted agent
 * looks suspiciously empty ("zero L2 calls" puzzles users reasonably). The
 * hook is optional to keep core decoupled from the viz layer.
 */
export interface TrustFastPathInfo {
  supervisorName: string;
  supervisorTier: Tier;
  childName: string;
  childTier: Tier;
  subject: 'PLAN' | 'RESULT';
  successes: number;
  failures: number;
  /** Reasoning text synthesised by `trustedApproval` (echoed verbatim). */
  reasoning: string;
  /** Fan-out lane id — set by `forkBranch` when the trust check happens inside a subtask. */
  branchId?: string;
}

/**
 * A routing decision served from the prefilter DECISION CACHE instead of
 * an LLM call. Recorded because the alternative is invisibility: a cache
 * hit produces no llm event at all, so a run that routed for free reads
 * as a run that mysteriously made fewer Haiku calls. Same reasoning as
 * `TrustFastPathInfo` — the cheapest paths must be the ones you can SEE,
 * otherwise the cost story is unverifiable.
 */
export interface CacheHitInfo {
  /** Which decision was replayed — 'reuse <target>' or 'escalate'. */
  outcome: string;
  /** Verbatim reasoning of the cached decision. */
  reasoning: string;
  /** Model the ORIGINAL decision was made with (the call we skipped). */
  model: string;
  /** Caller attribution, when the prefilter received one. */
  actorName?: string;
  actorTier?: Tier;
  /** Fan-out lane id, echoed from the branch-scoped context. */
  branchId?: string;
}

/**
 * JEV DECISIONS (docs/jev-decisions-2026-09-28.md, owner decision 2026-09-28):
 * a typed decision model TAKES the bounded choices it can take — the prefilter's
 * pick, and the approval half of plan and result validation. It never writes
 * text, so a refusal still goes to the model validator, which writes the
 * remediation. Every answer is recorded; `null` from either method means "Jev
 * did not answer", and the caller then decides exactly as it did before.
 */
export interface JevChoiceRequest {
  /** 'agent' for the L2/L3 child catalog, 'recipe' for the skill catalog. */
  readonly question: 'agent' | 'recipe';
  readonly task: {
    readonly description: string;
    readonly constraints?: readonly string[];
    /** Bounded, host-read context for root routing; never a source of instructions. */
    readonly repository?: import('../contracts/tissueRouting.js').RoutingRepository;
  };
  /** Root selection makes a binding choice, even when attributed to tier 3. */
  readonly scope?: 'root';
  /**
   * The catalog AFTER exclusions — exactly what the prefilter model would see,
   * plus an optional `detail` only the documented questions read: the opening
   * of a recipe's body, as TypeSafe's skill-suggestion cookbook re-reads its
   * shortlist with it.
   */
  readonly candidates: readonly { readonly name: string; readonly description: string; readonly detail?: string }[];
  readonly actorName?: string;
  readonly actorTier?: Tier;
  /** Fan-out lane id — stamped by `forkBranch`, like every other observer. */
  readonly branchId?: string;
  readonly signal?: AbortSignal;
}

export interface JevChoiceDecision {
  /** A candidate name, or `null` for "none of them" — the prefilter's escalate. */
  readonly target: string | null;
  readonly confidence: number;
  /** Jev's reading of whether the task asks for several independent deliverables. */
  readonly decomposable: boolean;
  /** Existing task_changes_files answer, when decisive; no additional question. */
  readonly fileEffect?: import('../contracts/fileEffect.js').FileEffect;
}

/**
 * Jev hands the pick to the model, which is not offered these candidates: the
 * recipes whose file changes Jev read as contradicting the task's.
 */
export interface JevChoiceDeferral {
  readonly withhold: readonly string[];
  /**
   * Recipes the model is shown but may not reuse: Jev read them below the
   * offer floor (`recipeOffer`). A model pick among them becomes no recipe.
   */
  readonly refuse?: readonly string[];
}

export interface JevApprovalRequest {
  readonly subject: 'PLAN' | 'RESULT';
  readonly task: { readonly description: string; readonly constraints?: readonly string[] };
  /** Original facts and prior work, distinct from requirements of the current phase. */
  readonly context?: readonly string[];
  /** Explicitly scoped to this child task; never inherit the root checklist from Task.inputs. */
  readonly criteria?: readonly import('../contracts/acceptanceChecklist.js').ChecklistItem[];
  /** Existing plan-declared obligations of THIS phase, not the root proof floor. */
  readonly obligations?: Task['proofObligations'];
  readonly child: { readonly name: string; readonly tier: Tier; readonly tools: readonly string[] };
  /** The plan, or the result's `{output, summary}`. */
  readonly payload: unknown;
  /**
   * The transport-observed evidence lines exactly as the model validator reads
   * them (`renderTransportEvidence`) — never the child's own declared probes.
   */
  readonly evidence?: readonly string[];
  /** The host's ground-truth block, when there is one. */
  readonly groundTruth?: string;
  readonly actorName?: string;
  readonly actorTier?: Tier;
  readonly branchId?: string;
  readonly signal?: AbortSignal;
}

export interface JevApprovalDecision {
  readonly approved: boolean;
  /** Minimum requirement confidence / inverse flag score; NOT P(all requirements met). */
  readonly probability: number;
}

/** A freshly distilled recipe, before it is saved, and the recipes it could duplicate. */
export interface JevTwinRequest {
  /** 'task' for a distilled task recipe, 'event' for a recovery recipe. */
  readonly kind: 'task' | 'event';
  readonly draft: {
    readonly id: string;
    readonly description: string;
    readonly whenToUse: string;
    readonly body: string;
  };
  /** The recipes the draft would compete with — the visible catalog, or the namespace's event recipes. */
  readonly existing: readonly { readonly id: string; readonly description: string; readonly whenToUse: string; readonly body?: string }[];
  readonly actorName?: string;
  readonly actorTier?: Tier;
  readonly branchId?: string;
  readonly signal?: AbortSignal;
}

export interface JevTwinDecision {
  /** The existing recipe the draft duplicates, or `null` when it is new. */
  readonly twinOf: string | null;
  readonly confidence: number;
}

/** The exact request the compiler will receive, without historical trust counters. */
export interface JevCompilationRequest {
  readonly skillId: string;
  readonly prompt: string;
  readonly allowLoopbackNetwork: boolean;
  readonly actorName?: string;
  readonly actorTier?: Tier;
  readonly branchId?: string;
  readonly signal?: AbortSignal;
}

export interface JevCompilationDecision {
  /** False postpones this attempt only; it must never become a persisted refusal. */
  readonly compilable: boolean;
  readonly obstacles: readonly string[];
}

/** One molecule execution about to start, whose reasoning effort Jev may set. */
export interface JevEffortRequest {
  readonly task: { readonly description: string; readonly constraints?: readonly string[] };
  /** The molecule's approved plan: what the execution is about to do. */
  readonly plan: unknown;
  /** Tool names the execution may call; empty for a reasoning task. */
  readonly tools: readonly string[];
  /** The same task's previous attempt was refused: a `low` reading is not applied. */
  readonly retry: boolean;
  readonly actorName?: string;
  readonly actorTier?: Tier;
  readonly branchId?: string;
  readonly signal?: AbortSignal;
}

export interface JevEffortDecision {
  readonly effort: NonNullable<GenerationParams['effort']>;
}

export interface JevDecider {
  /** Exact policy/question/input identity for guarded model fallback caching. Absent disables its reuse. */
  choiceCacheKey?(request: JevChoiceRequest): string;
  /** `null`: the model decides, as without Jev; a deferral also names what it is not offered. */
  choose(request: JevChoiceRequest): Promise<JevChoiceDecision | JevChoiceDeferral | null>;
  approve(request: JevApprovalRequest): Promise<JevApprovalDecision | null>;
  /**
   * Whether a draft recipe is a SEMANTIC TWIN of an existing one — the failure
   * the exact-id guard cannot see. A twin is not saved; `null` saves as before.
   */
  twin(request: JevTwinRequest): Promise<JevTwinDecision | null>;
  /** Optional for custom deciders; absent/null leaves the decision to the compiler. */
  compilable?(request: JevCompilationRequest): Promise<JevCompilationDecision | null>;
  /** Optional for custom deciders; absent/null keeps the execution's effort as it was. */
  effort?(request: JevEffortRequest): Promise<JevEffortDecision | null>;
}

/** One recorded Jev evaluation. The trace event is `VizJevEvent`. */
export interface JevDecisionInfo {
  /** HTTP attempts, including retries; zero for a locally skipped decision. */
  requestCount?: number;
  readonly coverage?: { readonly compared: number; readonly total: number; readonly complete: boolean };
  readonly role: 'prefilter' | 'validate-plan' | 'validate-result' | 'learn-skill' | 'learn-event-skill' | 'compile-skill' | 'execute-effort';
  /** `<vendor>:<model>` as requested. */
  readonly evaluator: string;
  /** The model the service reports having served, when it says. */
  readonly servedModel?: string;
  /** TypeSafe's `x-typesafe-request-id` for this call: what its support asks for. */
  readonly requestId?: string;
  /** Prefilter candidates, recipes compared for twins, or the compilation candidate. */
  readonly candidates?: readonly string[];
  /**
   * What Jev answered: a choice with its distribution, yes-probabilities by
   * question, and a twin check's pairwise scores by recipe id.
   */
  readonly answer?: {
    readonly choice?: string;
    readonly confidence?: number;
    readonly probabilities?: Readonly<Record<string, number>>;
    readonly yes?: Readonly<Record<string, number>>;
    readonly scores?: Readonly<Record<string, number>>;
    readonly distributions?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  };
  /** What Atoma did with it: 'reuse <t>', 'escalate', 'approved', 'deferred to the model'. */
  readonly outcome: string;
  /** A skill pick handed to the model: the recipes it was not offered (`JevChoiceDeferral`). */
  readonly withheld?: readonly string[];
  /**
   * Why there is no answer: 'timeout: …', 'aborted: …', 'skipped: …', an HTTP
   * status. Named `failure`, never `error`: trace readers (the analyst's digest)
   * read an event's `error` as a RUN error, and a Jev outage is not one — the
   * model took the decision instead.
   */
  readonly failure?: string;
  readonly durationMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Priced with `estimateCostUsd` on Jev's own price; outside the run's LLM totals. */
  readonly costUsd: number;
  readonly actorName?: string;
  readonly actorTier?: Tier;
  readonly childName?: string;
  readonly branchId?: string;
}

/**
 * Skill-pipeline event surfaced to the trace recorder. Mirrors the shape of
 * `VizSkillEvent` minus the storage-layer fields (id/ts/kind), so call sites
 * in L2Atom.ts emit a typed payload rather than reaching into the viz module
 * directly. The recorder fills in id + ts and tags `kind: 'skill'`.
 *
 * `op` semantics — see VizSkillEvent in src/viz/trace.ts for the canonical
 * documentation. Kept in sync because the union here is the source of truth
 * for what L2 may emit.
 */
export interface SkillEventInfo {
  op:
    | 'match'
    | 'inject'
    | 'learn'
    | 'update'
    | 'success'
    | 'failure'
    | 'promote'
    | 'demote'
    | 'direct'
    | 'quarantine'
    | 'credit-withheld'
    | 'set-aside';
  /**
   * DISPLAY name of the molecule that owns the skill — what the viz renders
   * and what an operator reads.
   *
   * Kept a name deliberately. Skill namespaces are keyed by atom id (T4), and
   * feeding the key here turned every Skills-tab header, timeline meta line
   * and search hit into a UUID. `l1AtomId` beside it carries the identity for
   * anything that needs to look the molecule back up.
   */
  l1Name: string;
  /** Identity of that molecule, for anything that must look it back up. */
  l1AtomId: string;
  /**
   * DISPLAY name of the molecule that RAN the recipe, when that is not the
   * one that owns it. Under the platform catalog a donor match is ordinary —
   * Ammonia's recipe executes inside CarbonDioxide — and the pair above is
   * the OWNER, because that is the namespace the body, the counters and
   * `/api/skills/:ns/:id` live under. Omitted when owner and executor are the
   * same atom, so a reader is told about a donor and nothing else.
   */
  executorName?: string;
  /** Identity of that executing molecule, on the same terms as `l1AtomId`. */
  executorAtomId?: string;
  skillId: string;
  actorName: string;
  actorTier: Tier;
  /** Match reasoning, validator diagnosis, body excerpt — free-form. */
  reasoning?: string;
  /** Fan-out lane id — set by `forkBranch` when the event happens inside a subtask. */
  branchId?: string;
}

export interface BranchEventInfo {
  readonly op: 'start' | 'end';
  readonly branchId: string;
  readonly parentBranchId?: string;
  readonly index: number;
  readonly total: number;
  readonly aggregationMode: AggregationSpec['mode'];
  readonly label: string;
  readonly actorName: string;
  readonly actorTier: Tier;
}

/**
 * Skill lessons a run distils wait here for the root's verdict (owner decision
 * 2026-10-09): run fc2a68cf learned a recipe from a phase whose checker root
 * acceptance then refused for an uncaught ZeroDivisionError. A lesson receives
 * the signal it must run under, or none to keep its own.
 */
export interface DeferredLearning {
  defer(learn: (signal?: AbortSignal) => Promise<void>): void;
}

export interface RunContext {
  /** Root-only durable phase boundary; deliberately absent from child forks. */
  readonly rootCheckpoint?: import('../contracts/runCheckpoint.js').RootPhaseCheckpoint;
  /** Present only for the opt-in depth experiment. Forward unchanged across forks. */
  readonly attempt?: number;
  readonly beforeFallback?: (parent: { readonly name: string; readonly tier: Tier }) => void;
  readonly recordPhaseCoverage?: (record: import('../contracts/depthRouting.js').PhaseCoverageRecord) => void;
  /** Set where a root acceptance judges the run (depth routing); shared by every fork. */
  readonly deferredLearning?: DeferredLearning;
  readonly logger: Logger;
  /**
   * Run-scoped memo of deterministic-dispatch outputs: skill id → the
   * summaries its dispatches already returned during THIS run. Lazily
   * initialised by L2.runSubtask; deliberately on the CONTEXT because it
   * must survive supervisor replans, which build fresh L2/L1 instances
   * (epoch-5 run 5: a content-rejected dispatch was re-produced
   * byte-identically six times across replans — no instance-level state
   * could have seen it). Mutable by design.
   */
  dispatchedScriptSignatures?: Map<string, string[]>;
  /**
   * Run-scoped memo of mechanical plan one-shots. Two writers, same Set:
   * L2.validatePlan keys `(tool, task)` for the undeclared-tool pre-check
   * (a byte-identical repeat used to trip the 3-strike tracker — guest-
   * counter retry, $2.03 vs $0.40 siblings — after which the LLM
   * validator takes over); `acceptL3RootPlan` keys
   * `l3-parallel-declared-outputs` for a colliding parallel root plan
   * (no parent validator; a repeat is honoured). Lazily initialised;
   * forks share the reference (`forkBranch`). The depth pilot creates a
   * fresh memo for each attempt, alongside its fresh workspace.
   */
  mechanicalPlanRejections?: Set<string>;
  /**
   * Run-scoped memo of (gate, task) pairs already MECHANICALLY rejected by a
   * `reject-once` RESULT gate (resultGates.ts). Same rationale as the plan
   * memo above: the first offense earns one coached mechanical rejection,
   * and a byte-identical repeat is handed to the LLM validator with the
   * facts attached instead of tripping the repeat-rejection tracker.
   * Shared across forks by `forkBranch` (replans build fresh instances),
   * but reset between depth-pilot attempts like the plan memo.
   */
  mechanicalResultRejections?: Set<string>;
  readonly signal: AbortSignal;
  /**
   * Absolute timestamp (ms) the run signal will abort. Optional so library
   * and test contexts stay backward-compatible. When set, tool-loop
   * iteration caps shrink against the remaining wall clock
   * (`capToolIterations`) so one phase cannot plan more iterations than
   * the run can still pay. Forks must forward the same value.
   */
  readonly deadlineAt?: number;
  readonly llm: LlmClient;
  readonly limits: Limits;
  /** Optional: tool executor used by molecules when the LLM emits tool_use blocks. */
  readonly tools?: ToolExecutor;
  /**
   * Run-scoped, append-only log of TRANSPORT-OBSERVED tool observations
   * (`src/core/attestation.ts`). Mutable and lazily initialised like the
   * memos above, and shared BY REFERENCE across every fork: the coverage
   * check reads a phase's branch, so a branch-scoped copy would silently
   * narrow to "whatever this fork happened to see". `forkBranch` wraps
   * `tools` per branch to write into it.
   *
   * Memory only. Nothing here outlives the run, which is why it is not a
   * store and why cross-run proof reuse is out of scope.
   */
  attestations?: AttestationLog;
  /**
   * Product-run integrity gate: when true, a production L1 Result that carries
   * an observed-action list but no successful action is mechanically rejected
   * before trust/LLM validation. Optional keeps direct library and test
   * producers backward-compatible.
   */
  readonly requireObservedToolAction?: boolean;
  /**
   * Optional trust-fast-path observer. When set, L2/L3 validators call this
   * instead of silently returning `trustedApproval` — the recorder can then
   * emit a `VizTrustEvent` so the UI lane still shows the decision.
   */
  readonly recordTrust?: (info: TrustFastPathInfo) => void;
  /**
   * Optional skill-pipeline observer. When set, L2 surfaces match /
   * inject / learn / update / success / failure events here so the viz
   * recorder can render a Skills lane next to the LLM/tool/registry
   * lanes. Same pattern as `recordTrust` — observer only, no effect on
   * runtime behaviour when undefined.
   */
  readonly recordSkill?: (info: SkillEventInfo) => void;
  /**
   * Machine run-counter observer. Unlike console text, these signals cannot
   * be forged by task output or validator prose; the runner folds them into
   * the `ATOMA_RUN_STATS` epilogue consumed by burn-in.
   */
  readonly recordRunStat?: (
    signal: import('../contracts/runStats.js').RunStatSignal
  ) => void;
  /**
   * The files a SEEDED run started from, read by the host before any model
   * work, and a reader of the workspace as it stands now. Root acceptance
   * compares the two (`src/contracts/startingWorkspace.ts`); absent for a run
   * that started from an empty workspace.
   */
  readonly startingWorkspace?: {
    readonly start: import('../contracts/startingWorkspace.js').StartingSnapshot;
    readonly now: () => import('../contracts/startingWorkspace.js').DeliveredSnapshot;
  };
  /**
   * The host's photograph and restore of READ-ONLY phases (`Task.readOnly`,
   * `src/run/readOnlyPhase.ts`), bound to the host path the tools write to.
   * Absent in library and test contexts: a phase marked read-only then runs
   * like any other. Forwarded by `forkBranch`; its restorations are the run's.
   */
  readonly readOnlyPhases?: import('../contracts/readOnlyPhase.js').ReadOnlyPhases;
  /**
   * The host's replay of the browser checks earlier runs recorded, for a
   * seeded static-page run (`src/run/inheritedChecks.ts`,
   * docs/inherited-checks-replay-2026-10-01.md). Root acceptance compares the
   * delivered page against the checks that held when the run began. Absent
   * for every other run.
   */
  readonly inheritedChecks?: import('../contracts/inheritedChecks.js').InheritedChecksRuntime;
  /**
   * HTTP observations the host recorded in the seed lineage's traces, with the
   * server code digest each was made against (`src/contracts/standingHttpEvidence.ts`).
   * Root acceptance counts one while that digest is unchanged. Absent unseeded.
   */
  readonly standingHttpEvidence?: readonly import('../contracts/standingHttpEvidence.js').StandingHttpObservation[];
  /**
   * Optional prefilter-cache observer — see `CacheHitInfo`. Same
   * observer-only contract as `recordTrust` / `recordSkill`: absent, the
   * cache still serves, it just leaves no trace.
   */
  readonly recordCacheHit?: (info: CacheHitInfo) => void;
  /**
   * Optional Jev decider — see `JevDecider`. Absent, every decision it could
   * take is taken exactly as before; present, it takes the prefilter's pick,
   * the approval half of validation and a molecule execution's effort, and
   * the model takes whatever it declines.
   */
  readonly jev?: JevDecider;
  /**
   * The Jev audit (docs/jev-decisions-2026-09-28.md): a `rate` share of Jev's
   * plan approvals (and `resultRate ?? rate` of result approvals) is also
   * judged by the model validator, off the run's path, so
   * how often the model would refuse what Jev approves stays measured once
   * the model no longer sees those decisions. It decides nothing: Jev's
   * approval stands. `defer` hands the audit to the runner, which awaits what
   * is still pending, bounded, before it closes the trace. Absent, no audit.
   */
  readonly jevAudit?: {
    readonly rate: number;
    /** Absent retains a library caller's shared sampling rate. */
    readonly resultRate?: number;
    readonly defer: (work: () => Promise<unknown>) => void;
  };
  /** Exact subtask lifecycle metadata for timeline fork/join rendering. */
  readonly recordBranch?: (info: BranchEventInfo) => void;
  /**
   * Receives the accepted L3 root plan as structured control-plane data.
   * Project publication uses it to persist declared output paths without
   * reparsing model-authored trace prose. It is observer-only.
   */
  readonly recordRootPlan?: (plan: Plan) => void;
  /**
   * Timeline lane identifier (uuid) of the subtask currently executing.
   * Set by L2/L3 for parallel and sequential dispatch alike — each subtask
   * gets its own shallow-cloned ctx with a unique id, so
   * every event recorded downstream (LLM call, tool invocation, trust
   * fast-path) carries that id. The viz uses it to group events into
   * per-subtask phases/branches rather than collapsing them into one
   * confused timeline. `recordBranch` says whether the lane is sequential
   * or parallel. Absent (undefined) at the trunk level.
   */
  readonly currentBranchId?: string;
}
