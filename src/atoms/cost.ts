import { z } from 'zod';
import { taskContextLines } from './taskContext.js';
import { fileEffectSchema } from '../contracts/fileEffect.js';
import type { AtomType } from '../registry/atomRegistry.js';
import type {
  GenerationParams,
  JevChoiceDecision,
  JevChoiceRequest,
  PositiveVerdict,
  Result,
  RunContext,
  Task,
  Tier,
} from '../core/types.js';
import { modelForTier } from '../core/models.js';
import { taxonomyForTier } from '../core/taxonomy.js';
import { parseWith } from './json.js';
import { prefilterCacheGet, prefilterCacheKey, prefilterCachePut } from './prefilterCache.js';
import { renderTransportEvidence } from './verdict.js';

/**
 * A child type is "trusted" when it has accumulated enough clean successes to
 * skip the validator LLM call. Any failure resets trust until the counter
 * passes the threshold again.
 *
 * Bumping this raises safety at the cost of paying validator calls longer;
 * lowering it saves money but lets a newer type coast on thinner evidence.
 */
export const TRUST_THRESHOLD_SUCCESSES = 3;

/**
 * Operator overrides for the three lifecycle thresholds, read at CALL time
 * so a single run can be made more (or less) cautious without a rebuild:
 *   ATOMA_TRUST_THRESHOLD   → successes before a TYPE's validators are skipped (3)
 *   ATOMA_PROMOTE_THRESHOLD → credited successes before llm→script compilation (0)
 *   ATOMA_DEMOTE_AFTER      → deterministic failures before demotion (2)
 * Invalid values fall back to the default rather than disabling a safety
 * gate — a typo must never make the system LESS careful. Each knob has a
 * floor: 1 for the two whose zero would switch a gate off, 0 for promotion,
 * whose default IS zero. The constants above remain the documented defaults
 * and the values tests assert against.
 */
function envThreshold(name: string, fallback: number, floor = 1): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= floor ? n : fallback;
}

/** Consecutive successes before a TYPE is trusted. Skills do not read it. */
export function trustThreshold(): number {
  return envThreshold('ATOMA_TRUST_THRESHOLD', TRUST_THRESHOLD_SUCCESSES);
}

/**
 * Credited successes before an llm skill attempts
 * compilation. Zero by default, which means AT LEARN TIME — see
 * TRUST_PROMOTE_THRESHOLD_SUCCESSES. An operator may raise it for one run.
 */
export function promoteThreshold(): number {
  return envThreshold('ATOMA_PROMOTE_THRESHOLD', TRUST_PROMOTE_THRESHOLD_SUCCESSES, 0);
}

/** Consecutive deterministic failures before a script skill is demoted. */
export function demoteAfter(): number {
  return envThreshold('ATOMA_DEMOTE_AFTER', DIRECT_DISPATCH_DEMOTE_AFTER);
}

/**
 * Credited SUCCESSES a `kind: 'llm'` skill needs before the supervisor
 * assesses it with Jev and attempts to PROMOTE it to a deterministic
 * `kind: 'script'` body via one compile call. ZERO since 2026-09-26 (owner
 * decision, docs/compile-at-learn-2026-09-26.md): a recipe that CAN be
 * compiled is compiled the moment it is learned, from the very run it was
 * distilled from, instead of waiting for credit. The compiler either
 * produces a script or refuses with a reason, and the refusal is stamped.
 *
 * The count was never what decided compilability. It started at five,
 * matching the trust level observed on the LoL-SSR run's
 * `scaffold-node-ssr-sqlite-api` skill (5/2 lifetime), and was lowered to
 * three after the 2026-08-07 threshold experiment (batches 14-15, run under
 * ATOMA_PROMOTE_THRESHOLD=3): across every compile attempt of the campaign
 * the success count NEVER changed the compiler's verdict — compilable
 * recipes compiled at their first attempt and irreducible-reasoning recipes
 * were refused with the same rationale at any count. What the count still
 * bought was a match-surface sample: only a recipe that had been matched
 * and credited paid for a compile. At zero, every learned draft is assessed;
 * Jev may postpone the compile and reconsider at its next credited success.
 * The downstream gates — compiler refusal, static scan, generation-stamped
 * anti-thrash, the post-promotion counter RESET, the deliverable gate and
 * the demotion streak — carry the safety, as they already did.
 *
 * Demotion (a failure on the script form) restores the original llm body
 * from the `_fallback.md` sidecar and stamps the failed compiler generation.
 * Historical LLM failures do not veto compilation (owner decision 2026-10-01).
 */
export const TRUST_PROMOTE_THRESHOLD_SUCCESSES = 0;

/**
 * Consecutive DETERMINISTIC dispatch failures (non-zero exit or missing
 * stdout envelope) after which a `kind: script` skill is demoted back to
 * its llm fallback. Deterministic failures deliberately do NOT bump the
 * trust failure counter (they fall back to the validated LLM loop, which
 * usually still delivers), but without this bound a structurally brittle
 * script — one whose extraction logic cannot survive real input variance —
 * fails on EVERY match forever: it never escalates (so `demoteToLlm` on
 * the onFailed path is unreachable) and never improves, and each match
 * pays two wasted tool calls plus the full LLM fallback. Demonstrated by
 * the slugify rehearsal run (2026-07-28): the compiled reverify script
 * amputated quoted CLI arguments, deduped four documented invocations
 * into one bare command, and reported a phantom mismatch — it would have
 * done so on every future CLI README as well. Reset by a deterministic
 * SUCCESS (not by an LLM-loop success, which proves nothing about the
 * script).
 */
export const DIRECT_DISPATCH_DEMOTE_AFTER = 2;

/**
 * Own abort budget for POST-APPROVAL bookkeeping LLM calls (skill
 * distillation in `learnSkillFromRun`, llm→script compilation in
 * `compileSkillToScript`) — deliberately DECOUPLED from the run's
 * deadline signal. By the time these calls fire, the CURRENT CHILD RESULT
 * is approved; aborting its bookkeeping with the shared signal corrupted
 * learning state, and it kept happening — three separate incidents
 * of the run deadline landing mid-compile under the claude-cli
 * transport, the last one leaving a run HUNG with no endedAt after
 * the aborted subprocess (http-ping closer, 2026-08-03). The
 * trade-off is explicit: a run may extend past its deadline while
 * bookkeeping completes. The original 240s ceiling was too permissive:
 * two Codex compile calls produced ZERO tokens and consumed the full 240s;
 * one starved a later sequential phase and made a correct HTTP build miss
 * its 900s run budget. Across all 50 completed post-approval calls in the
 * trace corpus, the slowest successful one took 100.3s. A 120s ceiling
 * preserves every observed success with ~20% headroom while bounding a
 * silent compiler failure at half the old cost.
 *
 * `improveSkillBody`
 * deliberately KEEPS the run signal — it gates an escalation retry,
 * i.e. the deliverable itself.
 */
export const POST_APPROVAL_LLM_TIMEOUT_MS = 120_000;

/**
 * BUDGETS PER CONCERN (P4). A run carries several kinds of work whose
 * abort semantics differ, and sharing one deadline caused three live
 * incidents (a compile killed mid-flight left a run hung with no
 * endedAt). The taxonomy:
 *   - DELIVERABLE work (plans, executions, validations, escalation
 *     retries incl. improveSkillBody) rides ctx.signal — the run
 *     deadline gates the deliverable.
 *   - POST-APPROVAL BOOKKEEPING (distillation, compilation) rides
 *     THIS signal: the current child result is approved, but an outer
 *     sequential plan may still have work. Its independent cap prevents
 *     a silent compiler from consuming the remaining deliverable budget.
 *   - VERIFICATION probes are local fs/network reads that honour
 *     ctx.signal (they gate the deliverable's verdict).
 * Trade-off, explicit: a run may extend past its deadline by at most
 * POST_APPROVAL_LLM_TIMEOUT_MS while bookkeeping completes. A hard
 * process kill still reaps everything — this signal only decouples the
 * SOFT deadline. Always obtain the signal through this helper so the
 * decoupling stays visible and greppable at every call site.
 */
export function postApprovalSignal(): AbortSignal {
  return AbortSignal.timeout(POST_APPROVAL_LLM_TIMEOUT_MS);
}

/**
 * The same decoupling, for the one LLM call a LANDED dispatch still has to
 * make: `llm-synthesize` aggregation over the branches that settled before the
 * run deadline cut their siblings (`dispatchWithAggregation`).
 *
 * It needs its own signal for a mechanical reason, not a policy one: by the
 * time a parallel dispatch lands, `ctx.signal` is ALREADY aborted — that is
 * what landing means — so a synthesis riding it would throw before its first
 * token and take the landing down with it, delivering nothing. The accepted
 * branches would be discarded by the very mechanism added to preserve them.
 *
 * The ceiling is inherited from `POST_APPROVAL_LLM_TIMEOUT_MS` rather than
 * measured separately: the call has the same shape — one tool-less text
 * completion — and the same failure mode, a silent transport consuming the
 * budget and returning nothing. Sequential aggregation needs none of this; it
 * is string assembly and makes no call at all.
 *
 * With a run deadline, synthesis and root acceptance share an absolute 45s
 * finalization window, inside the runner's 60s watchdog grace. Library callers
 * without a deadline retain the post-approval cap. A hard kill still reaps
 * everything.
 */
export function landingSignal(deadlineAt?: number): AbortSignal {
  // All landing stages share this absolute ceiling, below the runner's 60s
  // watchdog grace. Nested synthesis must not buy another full timeout.
  const remaining = deadlineAt === undefined ? POST_APPROVAL_LLM_TIMEOUT_MS : deadlineAt + FINALIZATION_GRACE_MS - Date.now();
  return AbortSignal.timeout(Math.max(1, Math.min(POST_APPROVAL_LLM_TIMEOUT_MS, remaining)));
}

/**
 * THE ONE FINALIZATION WINDOW: how far past the run deadline work ALREADY IN
 * HAND may still be judged, synthesised and recorded. Below the runner's 60s
 * watchdog grace (`WATCHDOG_GRACE_MS`), so a hard kill still reaps everything.
 */
export const FINALIZATION_GRACE_MS = 45_000;

/**
 * The finalization bound for a result that EXISTS — landed or complete
 * (2026-09-25 review, 1.2). Until 2026-09-26 only a landed result got it: a
 * COMPLETE result whose root acceptance straddled the deadline was thrown
 * away as `failed`, while the same timing on a landed one was kept as
 * `partial` — more work, worse outcome. Absolute: deadline + grace, never a
 * fresh per-call timeout, so a result arriving ten minutes early is judged
 * on the whole remaining clock. `undefined` without a deadline (library
 * callers), where the caller's own signal is the only bound.
 */
export function finalizationSignal(deadlineAt?: number): AbortSignal | undefined {
  if (deadlineAt === undefined) return undefined;
  return AbortSignal.timeout(Math.max(1, deadlineAt + FINALIZATION_GRACE_MS - Date.now()));
}

/**
 * Did the run reach one of its two BUDGETS — as opposed to an explicit
 * cancellation or a deepening, which are interruptions and never a landing?
 *
 *   - the RUN DEADLINE: the runner's `AbortSignal.timeout`, whose reason is a
 *     `TimeoutError` DOMException (an `Error` on Node 24);
 *   - a PLATFORM CEILING on tokens or spend (`src/core/runBudget.ts`): the
 *     runner aborts the same signal with a `RunBudgetExceededError`. It lands
 *     exactly as the deadline does — the phases already accepted are kept and
 *     the run is `partial`, so the next run of the project continues from them
 *     (owner decision 2026-09-30: reaching a ceiling must lose neither the work
 *     nor what it cost). No landing step spends past it: once a ceiling fires
 *     the run's client refuses every new call, so a synthesis falls back to
 *     the sub-results as they are and root acceptance ends refused-and-kept.
 *
 * Both always come with `deadlineAt`. Without one there is no run budget: a
 * library caller's own `AbortSignal.timeout` is that caller asking to stop, so
 * it is honoured as a cancellation, never a licence to finalize unbounded
 * (2026-09-25 adversarial review). The reason is matched by NAME: this module
 * does not import the runner's budget code, and the name is the contract.
 */
export function abortedForLanding(ctx: { readonly signal?: AbortSignal; readonly deadlineAt?: number }): boolean {
  if (ctx.deadlineAt === undefined || !ctx.signal?.aborted) return false;
  const reason: unknown = ctx.signal.reason;
  return reason instanceof Error && (reason.name === 'TimeoutError' || reason.name === 'RunBudgetExceededError');
}

/**
 * Settle `work` or reject when `signal` aborts, whichever comes first: the
 * finalization ceiling must also bound a collaborator (a transport) that
 * ignores abort.
 */
export async function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted', { cause: signal.reason }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Cap on output tokens for supervisor-tier strategy/plan calls (L2.plan /
 * L3.plan on non-fallback path). The response is a JSON pair [strategy, plan]
 * + a list of subtasks with descriptions. Sized to fit a 3-5 phase PHASED
 * plan from Opus with detailed phase descriptions; before phasing landed a
 * 1500-token cap was enough but multi-phase plans on stack tasks (SSR app
 * with SQLite + external API + UI) blew past it and produced truncated
 * `expectedOutput` fields that crashed the planSchema parse.
 * `expectedOutput` and `aggregation` are now also defaulted in planSchema
 * (defence in depth) — but the right place to fix it is at the source.
 *
 * 8000, not the historical 3000: Opus 5 / Sonnet 5 run ADAPTIVE THINKING
 * by default and `max_tokens` caps thinking + response TOGETHER — a
 * 3000 cap can be consumed entirely by thinking before a single plan
 * token is emitted. This is a CAP, not a target: you only pay for what
 * the model actually generates, and the plan call sites pin
 * `effort: 'medium'` which keeps thinking volume modest.
 *
 * Fallback / self-exec calls still use the atom's configured maxTokens
 * because they may produce actual content, not routing JSON.
 */
export const STRATEGY_MAX_TOKENS = 8000;

export function shouldTrustType(type: AtomType): boolean {
  return type.consecutiveSuccesses >= trustThreshold();
}

/**
 * Gates the deterministic dispatch of `kind: 'script'` skills in
 * `L2.runSubtask`: a trusted script runs via write_file + run_shell with no
 * L1 plan/execute, and its result is then validated like a molecule's, less
 * the type's trust fast path (`validateScriptDispatch`) — free when Jev
 * approves, one validation call otherwise.
 *
 * A script is trusted from its first match unless a failure is on record
 * (owner decision 2026-09-26, docs/compile-at-learn-2026-09-26.md). Until
 * then a freshly compiled script — its counters reset by promotion — had to
 * earn `trustThreshold()` clean runs through the validated LLM loop first.
 * What stands in for those runs is the envelope contract, the before/after
 * deliverable gate, the anti-redispatch memo, the deterministic-failure
 * demotion streak back to the script's fallback recipe, and — since
 * 2026-10-06 — the validation of every result it returns. Until that date
 * none of them judged CONTENT, and a replay that ignored what its phase asked
 * was delivered twice (docs/script-dispatch-validation-2026-10-06.md).
 *
 * THE FALLBACK IS PART OF TRUST. A script without a non-empty `_fallback.md`
 * — a hand-authored one; every compiled script gets one from
 * `promoteToScript` — can never be demoted, so it is never trusted and runs
 * through the validated L1 loop instead. skills/AGENTS.md stated that
 * refusal long before it was enforced: the three clean runs this gate used
 * to demand were what kept such a script from running unwatched.
 */
export function shouldTrustSkill(skill: {
  readonly failures: number;
  readonly fallbackBody?: string | undefined;
}): boolean {
  return skill.failures === 0 && (skill.fallbackBody ?? '').trim().length > 0;
}

/** Synthetic verdict returned by the trust fast-path in place of an LLM call. */
export function trustedApproval(type: AtomType): PositiveVerdict {
  return {
    approved: true,
    reasoning: `trust fast-path: ${type.name} has ${type.consecutiveSuccesses} consecutive successes (${type.successes} successes / ${type.failures} failures in history)`,
  };
}

/**
 * THE APPROVAL HALF OF VALIDATION, TAKEN BY JEV (docs/jev-decisions-2026-09-28.md).
 *
 * Asked ONLY where a fast path is already admissible — after the mechanical
 * gates, with no gate finding, no uncovered proof obligation and a
 * ground-truth probe that requires no review — which is the trust fast path's
 * eligibility without its earned counter. Jev can only APPROVE: anything else
 * returns `null` and the caller runs the model validator, which approves or
 * writes the remediation a refusal needs. An approval here is an ordinary
 * approval: it credits atom trust and skills like the trust fast path does.
 *
 * `audit` is the model verdict the caller would have run without Jev. A
 * `ctx.jevAudit.rate` share of Jev's approvals hands it to `ctx.jevAudit.defer`,
 * so the model judges them too, off the run's path and under the `jev-audit`
 * role: Jev's approval stands whatever the model says, and the trace keeps how
 * often the model would have refused.
 */
export async function jevApproval(args: {
  readonly ctx: RunContext;
  readonly subject: 'PLAN' | 'RESULT';
  readonly supervisorName: string;
  readonly supervisorTier: Tier;
  readonly child: { readonly name: string; readonly tier: Tier; toolNames(): string[] };
  readonly task: Task;
  readonly payload: unknown;
  readonly evidence?: Result['evidence'];
  readonly groundTruthBlock?: string;
  readonly criteria?: import('../core/types.js').JevApprovalRequest['criteria'];
  readonly audit?: () => Promise<unknown>;
}): Promise<PositiveVerdict | null> {
  if (!args.ctx.jev) return null;
  // The model validator's own evidence lines: transport-observed witnesses
  // only, budgeted the same way, so Jev never reads the child's declared
  // probes as observations.
  const rendered = args.subject === 'RESULT' && args.evidence ? renderTransportEvidence(args.evidence) : undefined;
  const evidence =
    rendered && rendered.lines.length + rendered.omitted > 0
      ? [...(rendered.omitted > 0 ? [`${rendered.omitted} earlier observations omitted`] : []), ...rendered.lines]
      : undefined;
  let decision;
  try {
    decision = await args.ctx.jev.approve({
      subject: args.subject,
      task: {
        description: args.task.description,
        ...(args.task.constraints?.length ? { constraints: args.task.constraints } : {}),
      },
      context: taskContextLines(args.task),
      child: { name: args.child.name, tier: args.child.tier, tools: args.task.executionMode === 'reasoning' ? [] : args.child.toolNames() },
      payload: args.payload,
      ...(args.criteria ? { criteria: args.criteria } : {}),
      ...(args.task.proofObligations ? { obligations: args.task.proofObligations } : {}),
      ...(evidence ? { evidence } : {}),
      ...(args.groundTruthBlock ? { groundTruth: args.groundTruthBlock } : {}),
      actorName: args.supervisorName,
      actorTier: args.supervisorTier,
      signal: args.ctx.signal,
    });
  } catch {
    return null;
  }
  if (!decision?.approved) return null;
  const auditing = args.ctx.jevAudit;
  if (auditing && args.audit && Math.random() < auditing.rate) auditing.defer(args.audit);
  return {
    approved: true,
    reasoning: `jev fast-path: ${args.child.name}'s ${args.subject} judged acceptable (decision score=${decision.probability.toFixed(2)})`,
    viaJev: true,
  };
}

/**
 * One shared system prompt for all prefilter calls — constant across tiers and
 * tasks so prompt caching short-circuits the input bill. This is the cheapest
 * atom doing the cheapest decision: "is there a clear catalog match?"
 *
 * Note on stability: this string is a cache key for Haiku. Trimming it below
 * the 4096-token threshold silently disables caching (see AGENTS.md). When
 * adding rules here, prefer appending terse lines over rewriting — the total
 * mass preserves cache hits across runs.
 */
export const PREFILTER_SYSTEM_PROMPT = [
  'You pre-filter catalog lookups for a three-tier LLM orchestrator.',
  'Given a task and a catalog of child agent types, pick ONE that clearly fits,',
  'or declare that no clear match exists.',
  'You do NOT design new types, you do NOT call tools, you do NOT produce plans.',
  'Bias strongly toward escalation when in doubt — escalation to the supervisor',
  'is cheap relative to selecting a wrong type and burning a full supervision cycle.',
  '',
  'HARD RULE on single-candidate catalogs:',
  '  A catalog with only ONE candidate is NOT a reason to pick it. The',
  '  candidate must CLEARLY share the task\'s structural capability (e.g. the',
  '  task needs an HTTP server builder, the candidate\'s description explicitly',
  '  names HTTP server building). If the single candidate\'s description names',
  '  a different structural capability than the task requires (HTML rendering',
  '  vs HTTP API, file scribe vs validation loop, etc.), escalate. Never',
  '  force-match just because the catalog is small.',
  '',
  'L1-affinity rule (applies to L2/L3 catalogs):',
  '  A catalog entry may include a "REACHABLE L1 CHILDREN" block listing',
  '  the lower-tier molecules that entry can dispatch to. When present, those',
  '  children\'s capabilities count for the MATCH decision — an L2 whose own',
  '  description names a narrow bucket (e.g. "HTTP server orchestrator") can',
  '  STILL be a valid "reuse" pick if its REACHABLE L1 CHILDREN cover the',
  '  task\'s needs (e.g. a file-scribe L1 child matches a README/JSON-writing',
  '  task, even though the parent L2 is HTTP-flavoured). Do NOT escalate on',
  '  "L2 description too narrow" when the children fill the gap.',
  '',
  'Tool rule (molecule catalogs):',
  '  An entry may end with a "tools:" line: the ONLY tools that candidate',
  '  can call. They are necessary, not sufficient: a pick must have tools for',
  '  EVERY action the task needs AND share its workflow shape, as above.',
  '  Among candidates that qualify, prefer the one with the fewest tools the',
  '  task does not use. When none qualifies, escalate so the supervisor can',
  '  split the task. What they do: start_static_server serves files as they',
  '  are; start_node_server boots a Node script, never a static page; only',
  '  run_shell deletes or moves files; any write_file records checks in the',
  '  probe manifest.',
  '',
  'Confidence self-check:',
  '  When you choose "reuse", label your OWN confidence in the fit:',
  '    - "high" — candidate description and task share the SAME structural',
  '      capability (tool signature + workflow shape). The candidate can',
  '      plausibly execute this task end-to-end without domain reprogramming.',
  '    - "low"  — you picked it because it was the closest available, but',
  '      the fit is approximate (different domain, missing capability, or',
  '      genuine doubt). The caller will treat "low" AS escalate — so if',
  '      you would label it "low" anyway, prefer emitting "escalate" directly.',
  '  Missing confidence is treated as "low" (conservative default).',
  '',
  'Decomposability hint (reuse only):',
  '  The default caller behaviour on "reuse" is to hand the ENTIRE task to',
  '  the chosen child as a single subtask (skipping the full supervisor',
  '  plan call). That is correct for atomic tasks AND for composite tasks',
  '  whose artefacts are mutually coupled.',
  '  Set "decomposable": false (or omit) when ANY of:',
  '    - the task is a single artefact (one file, one page, one service).',
  '    - the artefacts share imports or references: e.g. a test file',
  '      imports the library under test, a package.json "scripts.test"',
  '      points at the test file, a README documents the exported API.',
  '      These are STRUCTURALLY COUPLED — building them in parallel on',
  '      separate L1 instances forces each instance to guess the same',
  '      API surface, risks divergence, and typically produces less',
  '      code than a single sequential L1 that writes all files in one',
  '      tool-loop. Rule of thumb: if the artefacts are part of ONE',
  '      coherent project deliverable (library + tests + docs, server',
  '      + client code that imports it, config + code that reads it),',
  '      they are COUPLED → decomposable=false.',
  '  Set "decomposable": true ONLY when the artefacts are GENUINELY',
  '  ORTHOGONAL — no shared types, no cross-references, no depends-on.',
  '  Example decomposable:true cases: "build three unrelated puzzle',
  '  games in three index.html files", "scrape three separate websites',
  '  and save each dataset to its own JSON". Be CONSERVATIVE — default',
  '  is false, and the caller will still decompose via its full Sonnet/',
  '  Opus plan call when true independence is present in the task shape.',
  '',
  'Respond with ONE JSON object, no prose, no markdown, starting with "{":',
  '  {"kind": "reuse", "target": "<exact catalog name>", "confidence": "high"|"low", "decomposable": true|false, "reasoning": "<one short sentence>"}',
  'OR',
  '  {"kind": "escalate", "reasoning": "<one short sentence>"}',
].join('\n');

/**
 * Dedicated system prompt for the SKILL prefilter (L2.matchSkill). Constant
 * for the same prompt-caching reason as PREFILTER_SYSTEM_PROMPT.
 *
 * Why not reuse PREFILTER_SYSTEM_PROMPT: that prompt is written for ATOM
 * catalogs and carries a HARD RULE against single-candidate force-matching
 * (an atom mismatch burns a full supervision cycle). For skills the economics
 * are inverted — a young skill library usually has exactly ONE recipe, and
 * that recipe exists precisely because a task like this one succeeded before.
 * Under the atom prompt, Haiku escalated on single-skill catalogs, the run
 * lost the injection, and the "learn" branch then paid a Sonnet call to
 * distill a skill that already existed (deduped only after the money was
 * spent). The L1-affinity and decomposable clauses are likewise meaningless
 * for skills, so they're gone here. The confidence self-check stays: the
 * low→escalate guard in `prefilterStrategy` applies uniformly to both prompts.
 */
// "Only documents or only verifies": runs 9854553c and fa8b6ce3 (2026-09-30)
// matched a recipe that builds a word-frequency CLI to a README update, and
// its "write_file … README" step had the README rewritten whole, dropping the
// examples three earlier runs had asked for.
export const SKILL_PREFILTER_SYSTEM_PROMPT = [
  'You match a subtask against a catalog of learned skills — reusable how-to',
  'recipes attached to the worker atom that will execute the task.',
  'Pick the ONE skill whose recipe would genuinely guide this task, or declare',
  'that none fits.',
  'You do NOT design new skills, you do NOT call tools, you do NOT produce plans.',
  '',
  'What a match means: the matched skill body is INJECTED into the worker\'s',
  'system prompt as an active recipe. A fitting recipe saves the worker from',
  're-deriving a known workflow; a WRONG recipe actively misleads it.',
  '"escalate" simply means the worker runs unguided — safe, but wasteful when',
  'a fitting recipe exists.',
  '',
  'Single-candidate catalogs are NORMAL here: a young skill library often has',
  'exactly one recipe, and that recipe usually exists BECAUSE a task like this',
  'one succeeded before. "Only one candidate" is NOT a reason to escalate —',
  'judge the fit on its own merits, exactly as you would among ten candidates.',
  '',
  'Match on WORKFLOW SHAPE, not on surface domain words:',
  '  - "reuse" when the recipe\'s steps (files to write, tools to run, checks',
  '    to perform) transfer to this task even if the topic differs — a recipe',
  '    learned on a movie API applies to a book API.',
  '  - "escalate" when the recipe\'s workflow is structurally different — it',
  '    scaffolds an HTTP server but the task writes a static page; it seeds a',
  '    database but the task scrapes a website; it BUILDS an artefact (writes',
  '    or rewrites its code) but the task only documents or only verifies one',
  '    that already exists.',
  '',
  'Confidence self-check:',
  '  When you choose "reuse", label your OWN confidence in the fit:',
  '    - "high" — the recipe\'s workflow clearly covers this task end-to-end',
  '      or nearly so.',
  '    - "low"  — closest available, but the fit is approximate. The caller',
  '      treats "low" AS escalate — if you would label "low" anyway, prefer',
  '      emitting "escalate" directly.',
  '  Missing confidence is treated as "low" (conservative default).',
  '',
  'Respond with ONE JSON object, no prose, no markdown, starting with "{":',
  '  {"kind": "reuse", "target": "<exact skill id>", "confidence": "high"|"low", "fileEffect": "read-only"|"mutating", "reasoning": "<one short sentence>"}',
  'For every reuse, classify what the TASK requires: fileEffect is read-only',
  'for inspection or replay of existing checks, mutating for creating or changing',
  'code, pages, documents or data. Interpret negation and quoted text semantically.',
  'Scratch files used only to execute a check are not a requested file change.',
  'OR',
  '  {"kind": "escalate", "reasoning": "<one short sentence>"}',
].join('\n');

const PREFILTER_PARAMS: GenerationParams = { temperature: 0, maxTokens: 256 };

export const prefilterResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reuse'),
    target: z.string(),
    // Haiku labels its own certainty in the fit. Missing / anything
    // non-"high" is normalised to "low" at the parse boundary so the
    // caller can treat "low" as an escalate (the HARD RULE on single-
    // candidate catalogs plus the confidence self-check in the prompt
    // push Haiku to produce this label, but we want the parser to be
    // tolerant of older / smaller models that may drop it).
    confidence: z.enum(['high', 'low']).optional(),
    // Hint from Haiku: does the task enumerate multiple orthogonal
    // artefacts that warrant decomposition at the supervisor tier, or
    // can the chosen child handle it end-to-end as a single subtask?
    // Omitted / false keeps the existing short-circuit behaviour (one
    // subtask, skip the full supervisor plan call). True makes the
    // caller fall through to the full Sonnet/Opus plan, with Haiku's
    // reuse target preserved as a routing hint. Default is false (most
    // single-artefact tasks).
    decomposable: z.boolean().optional(),
    fileEffect: fileEffectSchema.optional().catch(undefined),
    reasoning: z.string(),
  }),
  z.object({ kind: z.literal('escalate'), reasoning: z.string() }),
]);

export type PrefilterOutcome = z.infer<typeof prefilterResponseSchema>;

export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  /**
   * Jev only: the opening of a recipe's body. The model prefilter's prompt and
   * its cache key are built from `name` and `description` alone.
   */
  readonly detail?: string;
}

/**
 * Per-task anti-loop memo: tracks which child agents this supervisor has
 * already delegated to during the current task, and auto-clears when the task
 * boundary changes. Shared by L2 and L3 so their prefilter can't re-pick a
 * failing child across supervise-loop iterations.
 */
export class TaskChildrenMemo {
  private tried = new Set<string>();
  private lastTask: string | null = null;

  /** Call at the top of `plan()`. Clears memo if the task description changed. */
  beginTask(description: string): void {
    if (this.lastTask !== description) {
      this.tried.clear();
      this.lastTask = description;
    }
  }

  /** Record a child we're about to hand work to. */
  mark(name: string): void {
    this.tried.add(name);
  }

  /** Names to exclude from prefilter catalogs this cycle. */
  excluded(): ReadonlySet<string> {
    return this.tried;
  }
}

/**
 * Ask Haiku whether any catalog entry clearly matches the task.
 *
 * Returns `null` if the catalog is empty (prefilter is pointless). On any
 * error — LLM failure, bad JSON, unknown target — returns an escalate outcome
 * so the caller falls back to the full supervisor call.
 */
export async function prefilterStrategy(args: {
  ctx: RunContext;
  task: Task;
  catalog: CatalogEntry[];
  /**
   * Names already tried and failed during the current supervision cycle.
   * They are filtered out of the catalog before the LLM sees it, so the
   * prefilter cannot loop on a child that just proved itself incapable.
   * If the filtered catalog is empty, we return an escalate outcome so the
   * caller falls back to the full supervisor plan (which can create a new
   * type or mutualize).
   */
  exclude?: ReadonlySet<string>;
  model?: string;
  /**
   * System prompt override. Defaults to PREFILTER_SYSTEM_PROMPT (atom
   * catalogs). The skill prefilter passes SKILL_PREFILTER_SYSTEM_PROMPT —
   * same machinery, same schema, same confidence guard, but without the
   * atom-specific single-candidate HARD RULE that made Haiku escalate on
   * one-skill catalogs. Any override must be a CONSTANT string (prompt
   * caching keys on it).
   */
  systemPrompt?: string;
  /**
   * Optional caller attribution. When provided we prepend a short
   * `You are <rank> "<name>" (tier <N>) ...` preamble to the userContent so
   * the run trace can attribute this prefilter call to the L2 or L3 that
   * issued it. Without this, prefilter events show up as ownerless in the
   * decomposition report (the shared system prompt intentionally stays
   * constant to preserve prompt caching, so the preamble is the only
   * place where per-caller context can live).
   */
  actor?: { name: string; tier: Tier };
}): Promise<PrefilterOutcome | null> {
  if (args.catalog.length === 0) return null;

  const filtered = args.exclude
    ? args.catalog.filter((c) => !args.exclude!.has(c.name))
    : args.catalog;
  if (filtered.length === 0) {
    return {
      kind: 'escalate',
      reasoning: `all catalog entries already tried and failed: ${args.catalog
        .map((c) => c.name)
        .join(', ')}`,
    };
  }
  const model = args.model ?? modelForTier(1);
  const systemPrompt = args.systemPrompt ?? PREFILTER_SYSTEM_PROMPT;
  const jevRequest: JevChoiceRequest = {
    question: systemPrompt === SKILL_PREFILTER_SYSTEM_PROMPT ? 'recipe' : 'agent',
    task: { description: args.task.description, ...(args.task.constraints ? { constraints: args.task.constraints } : {}) },
    candidates: filtered,
    ...(args.actor ? { actorName: args.actor.name, actorTier: args.actor.tier } : {}),
    signal: args.ctx.signal,
  };
  const policy = args.ctx.jev?.choiceCacheKey?.(jevRequest);
  // An outage or an unknown custom decider may not populate a guarded cache.
  let cacheWritable = !args.ctx.jev;
  /** What the model is shown for a catalog, and the cache key of its answer. */
  const modelInputs = (offered: readonly CatalogEntry[]) => {
    const catalogLines = offered.map((c) => `  - ${c.name}: ${c.description}`);
    const userContent = [
      args.actor
        ? `You are ${taxonomyForTier(args.actor.tier).rank} "${args.actor.name}" (tier ${args.actor.tier}) running a prefilter catalog lookup.`
        : '',
      args.actor ? `` : '',
      `Task: ${args.task.description}`,
      args.task.constraints?.length
        ? `Constraints:\n${args.task.constraints.map((c) => `- ${c}`).join('\n')}`
        : '',
      args.exclude && args.exclude.size > 0
        ? `Already tried and failed THIS task (do NOT pick these): ${[...args.exclude].join(', ')}`
        : '',
      ``,
      `Catalog:`,
      catalogLines.join('\n'),
    ]
      .filter((l) => typeof l === 'string')
      .join('\n');
    // Decision cache (FrugalGPT completion-cache analog): temperature-0 +
    // constant prompt makes the decision a pure function of these inputs, so
    // a repeat pair is served from disk — zero tokens, and under claude-cli
    // zero subprocess spawn. The key hashes every decision input (NOT the
    // actor preamble, which is trace attribution); see prefilterCache.ts for
    // the expiry/eviction bounds. Only PARSED outcomes are cached — the
    // error-path escalate below never is.
    const cacheKey = prefilterCacheKey({
      systemPrompt,
      model,
      taskDescription: args.task.description,
      ...(args.task.constraints ? { constraints: args.task.constraints } : {}),
      excluded: args.exclude ? [...args.exclude] : [],
      catalogLines,
      ...(policy ? { policy } : {}),
    });
    return { names: new Set(offered.map((c) => c.name)), userContent, cacheKey };
  };
  const whole = modelInputs(filtered);
  const filteredNames = whole.names;
  const served = (cached: PrefilterOutcome): PrefilterOutcome => {
    const outcome = cached.kind === 'reuse' ? `reuse ${cached.target}` : 'escalate';
    args.ctx.logger.debug(`[prefilter] decision served from cache (${outcome})`);
    // Observer: a cache hit replaces an LLM call, so without an event of
    // its own the timeline just shows one fewer call and the run looks
    // cheaper for no visible reason.
    // branchId is stamped by forkBranch's wrapper, not read here — same
    // contract as recordTrust / recordSkill.
    args.ctx.recordCacheHit?.({
      outcome,
      reasoning: cached.reasoning,
      model,
      ...(args.actor ? { actorName: args.actor.name, actorTier: args.actor.tier } : {}),
    });
    return cached;
  };
  const cached = !args.ctx.jev ? prefilterCacheGet(whole.cacheKey) : null;
  if (cached) return served(cached);

  // JEV DECIDES FIRST (docs/jev-decisions-2026-09-28.md, owner decision
  // 2026-09-28). Its pick is taken as a high-confidence reuse and its "none of
  // them" as an escalate; the mechanical guards the callers apply afterwards
  // (the L2 browser redirect, exclusions) still apply. It is never cached —
  // the cache holds model decisions only — and when Jev does not answer, the
  // model decides below exactly as it always has — save the recipes Jev
  // withholds because their file changes contradict the task's: the model is
  // not offered those (JevChoiceDeferral).
  let jev: JevChoiceDecision | null = null;
  let withheld: ReadonlySet<string> = new Set();
  if (args.ctx.jev) {
    try {
      const answer = await args.ctx.jev.choose(jevRequest);
      cacheWritable = !!policy && !!answer && 'withhold' in answer;
      if (answer && 'withhold' in answer) withheld = new Set(answer.withhold);
      else jev = answer;
    } catch {
      jev = null;
    }
    // The same membership check the model's answer gets below: a decider is an
    // interface, and a pick outside the filtered catalog is never taken.
    if (jev && jev.target !== null && !filteredNames.has(jev.target)) jev = null;
  }
  if (jev) {
    const confidence = jev.confidence.toFixed(2);
    return jev.target === null
      ? { kind: 'escalate', reasoning: `jev: no candidate clearly fits (confidence ${confidence})` }
      : {
          kind: 'reuse',
          target: jev.target,
          confidence: 'high',
          decomposable: jev.decomposable,
          ...(jev.fileEffect ? { fileEffect: jev.fileEffect } : {}),
          reasoning: `jev picked ${jev.target} (confidence ${confidence})`,
        };
  }

  const offered = filtered.filter((c) => !withheld.has(c.name));
  if (offered.length === 0) {
    return { kind: 'escalate', reasoning: `jev: every recipe contradicts the task on files (${[...withheld].join(', ')})` };
  }
  const { names: offeredNames, userContent, cacheKey } = offered.length === filtered.length ? whole : modelInputs(offered);
  // Jev's live exclusions are an input, not a property of the full catalog.
  // Reconsult it before reusing a model decision over the resulting catalog.
  if (args.ctx.jev && cacheWritable) {
    const narrowed = prefilterCacheGet(cacheKey);
    if (narrowed) return served(narrowed);
  }

  try {
    const resp = await args.ctx.llm.complete({
      model,
      systemPrompt,
      userContent,
      params: PREFILTER_PARAMS,
      signal: args.ctx.signal,
      role: 'prefilter',
      ...(args.actor ? { actor: args.actor } : {}),
    });
    const outcome = parseWith(prefilterResponseSchema, resp.text);
    // The three parsed-outcome returns below all cache: each is a
    // deterministic function of the model's parsed answer, so serving it
    // again for identical inputs is exactly what the live call would do.
    if (outcome.kind === 'reuse' && !offeredNames.has(outcome.target)) {
      const rewritten: PrefilterOutcome = {
        kind: 'escalate',
        reasoning: `prefilter returned unknown or excluded target "${outcome.target}"`,
      };
      if (cacheWritable) prefilterCachePut(cacheKey, rewritten);
      return rewritten;
    }
    // Force-match guard: if Haiku self-labels the fit as "low" (or omits
    // the field, normalised to low), treat it as an escalate. This
    // closes the hole where a single-candidate catalog tempted Haiku to
    // pick an approximate match (observed in production: Methane L2
    // picked Hydrogen L1 for a Node/REST task because Hydrogen was the
    // only L1 on record, even though its description named HTML-centric
    // validate_html as its capability). The prompt tells Haiku to emit
    // "escalate" directly when it would have labelled "low" anyway — the
    // guard here catches the cases where it still tries to squeeze a
    // reuse through.
    if (outcome.kind === 'reuse' && outcome.confidence !== 'high') {
      const rewritten: PrefilterOutcome = {
        kind: 'escalate',
        reasoning: `prefilter low-confidence reuse of "${outcome.target}" (${outcome.reasoning}) — treated as escalate`,
      };
      if (cacheWritable) prefilterCachePut(cacheKey, rewritten);
      return rewritten;
    }
    if (cacheWritable) prefilterCachePut(cacheKey, outcome);
    return outcome;
  } catch (err) {
    // Error-path escalate: NEVER cached — an LLM hiccup must not become a
    // week of "escalate" answers for this input.
    return {
      kind: 'escalate',
      reasoning: `prefilter failed: ${(err as Error).message}`,
    };
  }
}
