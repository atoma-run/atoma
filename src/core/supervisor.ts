import { executionHistoryIds } from './executionHistory.js';
import { markParentTestsJudged, suiteDisputeWatch, verifyParentTests, withParentTestConsequences } from './parentTests.js';
import { EscalationSignal, PlanParseError, ValidationError, EvidenceReviewError } from './errors.js';
import { planBase, type Atom, type PlanBase, type Supervisor } from './atom.js';
import type {
  NegativeVerdict,
  Result,
  RunContext,
  Task,
  TraceEntry,
  Verdict,
} from './types.js';

export interface SupervisionHooks<C extends Atom> {
  /**
   * Apply a negative verdict's modifications honoring its scope.
   * - 'ephemeral' — mutate the current instance, return same instance
   * - 'patch'     — update the canonical type in the registry, return fresh instance of patched type
   * - 'branch'    — create a new type, return instance of the new type
   */
  applyByScope(child: C, verdict: NegativeVerdict): Promise<C>;

  /**
   * Called once when the supervision loop escalates. Implementations typically
   * synthesize lessons from the trace and create a branched type in the registry.
   *
   * RETURN VALUE CONTRACT:
   *   - `void` / `undefined` — the registry was updated (if at all) and the
   *     loop should proceed straight to the parent-fallback path. This is
   *     the default preserved for supervisors that only want to
   *     record a lesson for future tasks.
   *   - `C` (a fresh child instance of the branched type) — the loop will
   *     INSTALL the replacement, reset its rejection-streak trackers, and
   *     give the branched child ONE complete plan+validate+execute+validate
   *     cycle before falling back to the parent. This lets the anti-
   *     Frankenstein branch (fresh narrow prompt aligned with the current
   *     subtask) actually demonstrate whether it solves the task, instead
   *     of being recorded-but-never-tried. Second escalations still fall
   *     through to the parent fallback — we never re-branch twice.
   */
  branchOnEscalation(
    child: C,
    trace: readonly TraceEntry[],
    reason: string
  ): Promise<C | void>;

  /**
   * Optional: invoked exactly once when the loop exits with an approved result.
   * Use it to bump the child type's success counter in the registry so that
   * trusted types can short-circuit future validator calls.
   *
   * `verdict` is the approving RESULT verdict, threaded through so hooks can
   * read per-verdict signals — today `activeSkillFollowed`, the adherence
   * gate for usage-conditioned skill credit.
   */
  onApproved?(child: C, result: Result, verdict?: Verdict): Promise<void>;

  /**
   * Optional: invoked exactly once at the moment the loop decides to escalate,
   * BEFORE `branchOnEscalation` fires. Use it to bump the child type's failure
   * counter so trust is revoked.
   *
   * `lastResultVerdict` is the most recent RESULT verdict of the failing
   * cycle, when one exists (plan-phase escalations never produced one). It
   * carries the same per-verdict signals as `onApproved`'s verdict — a hook
   * can decline to blame a skill the validator observed being ignored.
   */
  onFailed?(child: C, reason: string, lastResultVerdict?: Verdict): Promise<void>;

  /**
   * Optional: surrounds EVERY execution of this task — the child's, a
   * branched child's, and the parent's own fallback — and returns what the
   * validation then reads. A read-only phase is photographed and restored here
   * (`withinReadOnlyPhase`, src/atoms/dispatch.ts), so its validator judges
   * the workspace as it stands, whatever path wrote to it.
   */
  aroundExecute?(execute: () => Promise<Result>): Promise<Result>;

  /**
   * Optional: a refused result this loop hands up as it is instead of
   * retrying (`src/core/phaseBudget.ts`). Returned results get no approval
   * consequence: no trust, credit or lesson.
   */
  handUpRefused?(child: C, result: Result, verdict: Verdict): Result | undefined;
}

const now = (): string => new Date().toISOString();

/**
 * How many consecutive rejections with the SAME normalized reasoning we
 * tolerate before short-circuiting to escalation. Rationale: if the validator
 * keeps emitting the identical gripe and the child keeps regenerating
 * structurally similar output, no new information is being produced —
 * continuing just burns budget. Empirically three strikes is a good balance
 * between resilience to transient LLM wiggle and wasted spend: earlier runs
 * saw five consecutive identical rejects eating ~$0.05-0.10 and ~20s.
 */
export const MAX_SAME_REASON_REJECTS = 3;

/**
 * Policy-marker detector: some validator failure modes shift the *specific*
 * complaint across rejections but stay anchored on the same meta-policy
 * (e.g. "VISIBLE-DELIVERABLES enumeration is incomplete" where the exact
 * missing item rotates between attempts). The verbatim-equality tracker
 * can't catch that because each reasoning string is literally different.
 * We separately flag when the same policy marker appears in
 * MAX_SAME_MARKER_REJECTS consecutive rejections.
 *
 * Keep the marker list tight and conservative: false positives here cause
 * premature escalation on legitimate, progressing fix loops. Each token
 * must be a phrase the validator prompt itself uses as a category label,
 * not a generic word that could coincidentally recur.
 *
 * `ground-truth` family added after the LoL-SSR run: the validator kept
 * rejecting RESULTs with rotating specifics ("no fetch_url body shown",
 * "no LISTENING_ON_PORT echoed", "no schema confirmation") all anchored
 * on the same meta-complaint "you didn't show me the evidence". The
 * verbatim tracker missed it and budget burned waiting for the verbatim
 * 3-streak that never came; meanwhile the skill-update path (which only
 * fires on escalation) never got to learn that the L1 needs to print a
 * GROUND-TRUTH block in its summary.
 */
/**
 * Each entry is a CATEGORY: detectPolicyMarker returns the `id` whenever
 * ANY of its synonyms appears in the reasoning. This lets rotating
 * phrasings of the same meta-complaint ("no ground-truth evidence" vs
 * "provides no evidence" vs "no evidence shown") count toward the SAME
 * streak in `makeMarkerTracker`. Without the canonical-id grouping, three
 * rejections phrased differently but anchored on the same theme would
 * each split into singleton streaks and never trip the threshold.
 */
export const POLICY_MARKERS: readonly { id: string; synonyms: readonly string[] }[] = [
  {
    id: 'visible-deliverables',
    synonyms: ['visible-deliverables', 'visible deliverables'],
  },
  {
    id: 'ground-truth-evidence',
    synonyms: [
      'ground-truth evidence',
      'ground truth evidence',
      'no ground-truth',
      'no ground truth',
      'no evidence',
      'provides no evidence',
    ],
  },
];
export const MAX_SAME_MARKER_REJECTS = 3;
/**
 * Tool-free report corrections per execution before a report-only refusal
 * takes the ordinary ladder. Each is one cheap call that executes nothing;
 * the ladder's retry re-executes, and failing the phase instead failed the run.
 */
export const MAX_REPORT_CORRECTIONS = 2;

/**
 * Plan reviews that failed AS THE REVIEWER (`delegationRefusal: 'reviewer'`)
 * one supervise cycle tolerates before the parent takes over. Each one is
 * already two failed reviews of one plan (the validation model, then tier 2),
 * so two are four failed reviews over two plans; a third would buy another
 * replan and tier-2 review with no new evidence. They spend no plan
 * iteration: under the default budget of three, three faults used to escalate,
 * record a trust failure against the child and branch its type for the
 * reviewer's failure (third review 2026-10-16).
 */
export const MAX_PLAN_REVIEW_FAULTS = 2;

/**
 * Normalize a verdict's reasoning for repeat-detection comparisons:
 * lowercase, strip punctuation, collapse whitespace. Exported so tests and
 * tooling can assert the normalization the supervisor actually applies.
 */
export function normalizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return the first known policy marker that appears in `reason`, or null
 * if none do. Markers are matched against the lowercased + punctuation-
 * stripped form so casing / surrounding punctuation don't affect the hit.
 */
export function detectPolicyMarker(reason: string): string | null {
  const normalized = normalizeReason(reason);
  for (const category of POLICY_MARKERS) {
    for (const synonym of category.synonyms) {
      const target = normalizeReason(synonym);
      if (target.length > 0 && normalized.includes(target)) return category.id;
    }
  }
  return null;
}

/**
 * Small bounded tracker: holds the last `window` normalized reasoning keys
 * and reports when the most recent entry has been repeated `window` times in
 * a row. Used to detect "the validator is stuck on the same complaint".
 */
function makeRepeatTracker(window: number): {
  push: (reasoning: string) => { repeated: boolean; streakKey: string | null };
  reset: () => void;
} {
  const buf: string[] = [];
  return {
    push(reasoning: string): { repeated: boolean; streakKey: string | null } {
      const key = normalizeReason(reasoning);
      buf.push(key);
      if (buf.length > window) buf.shift();
      if (buf.length === window && buf.every((k) => k === key && k.length > 0)) {
        return { repeated: true, streakKey: key };
      }
      return { repeated: false, streakKey: null };
    },
    reset(): void {
      buf.length = 0;
    },
  };
}

/**
 * Bounded marker tracker: like `makeRepeatTracker` but fires when the same
 * POLICY MARKER appears in `window` consecutive rejections — even when the
 * surrounding prose differs. This catches the "drifting nit" failure mode
 * where the validator keeps escalating the same category of complaint
 * without the child ever getting to execute. `push` returns `null` on
 * rejections with no detectable marker (they don't extend nor reset any
 * running streak — only a reset() call clears it).
 */
function makeMarkerTracker(window: number): {
  push: (reasoning: string) => { repeated: boolean; marker: string | null };
  reset: () => void;
} {
  const buf: string[] = [];
  return {
    push(reasoning: string): { repeated: boolean; marker: string | null } {
      const marker = detectPolicyMarker(reasoning);
      if (marker === null) return { repeated: false, marker: null };
      buf.push(marker);
      if (buf.length > window) buf.shift();
      if (buf.length === window && buf.every((m) => m === marker)) {
        return { repeated: true, marker };
      }
      return { repeated: false, marker: null };
    },
    reset(): void {
      buf.length = 0;
    },
  };
}

export async function superviseLoop<C extends Atom>(
  parent: Atom & Supervisor<C>,
  child: C,
  task: Task,
  ctx: RunContext,
  hooks: SupervisionHooks<C>
): Promise<Result> {
  const trace: TraceEntry[] = [];
  const history = new Set<string>();
  const withHistory = (result: Result): Result => ({ ...result,
    ...((history.size || result.historicalEvidenceIds?.length) ? {
      historicalEvidenceIds: [...new Set([...history, ...(result.historicalEvidenceIds ?? [])])],
    } : {}),
  });
  let current: C = child;
  // Measurement only: a suite failing the same way on several versions of the
  // workspace is counted, logged and recorded for the trace; no model reads it
  // and it changes no step of this loop (src/core/parentTests.ts).
  const disputes = suiteDisputeWatch(task, ctx, { name: parent.name, tier: parent.tier });
  const run = async (execute: () => Promise<Result>): Promise<Result> =>
    disputes.observe(await verifyParentTests(task, await (hooks.aroundExecute ? hooks.aroundExecute(execute) : execute()), ctx));
  // One-shot branch retry: when a branchOnEscalation hook returns a fresh
  // child instance, we run ONE more full supervise cycle with it (resetting
  // the iteration counters and rejection-streak trackers) before giving up
  // to the parent fallback. Second escalation falls through.
  let hasTriedBranch = false;
  // Unlike planIter, task progress (execution), not a planner type branch,
  // resets this streak.
  let plansWithoutExecution = 0;
  // Tissue → cell supervision only. Reuse the configured plan allowance and
  // reserve one substantive review for the replacement; molecule retries keep
  // their existing budgets. Root L3 plans have their own bounded review loop.
  const maxPlansWithoutExecution = parent.tier === 3
    ? ctx.limits.maxPlanIterations + 1
    : Number.POSITIVE_INFINITY;

  // The outer loop exists purely to reset the per-cycle state
  // (counters + trackers) when a branch-retry happens. In the common case
  // it runs exactly once.
  outer: while (true) {
    let planIter = 0;
    let execIter = 0;
    // Most recent RESULT verdict of THIS cycle, handed to onFailed on
    // escalation. Declared per outer-iteration on purpose: a branch-retry
    // installs a fresh child (with its own re-injected skill), so verdicts
    // about the previous child must not leak into the new cycle's blame.
    let lastResultVerdict: Verdict | undefined;
    // Judgements of THIS child in this cycle: a plan refused on its merits or
    // a result verdict. An escalation with none (only unparseable replies and
    // reviewer faults) is nobody's verdict on the child, so it records no
    // failure and branches no type; the parent takes over directly.
    let judgements = 0;
    let reviewFaults = 0;
    let resultReviewFaults = 0;
    // Separate trackers for plan-rejects and result-rejects: "same gripe three
    // times in a row on the plan" and "same gripe three times in a row on the
    // result" are independent stuck-conditions and should each escalate.
    const planRepeat = makeRepeatTracker(MAX_SAME_REASON_REJECTS);
    const resultRepeat = makeRepeatTracker(MAX_SAME_REASON_REJECTS);
    // Parallel trackers keyed on POLICY MARKERS (e.g. "VISIBLE-DELIVERABLES"):
    // catches the "drifting nit" failure mode where the validator keeps
    // escalating the same category of complaint with different specifics —
    // the verbatim `planRepeat` can't see those as repeats because the
    // reasoning strings literally differ.
    const planMarker = makeMarkerTracker(MAX_SAME_MARKER_REJECTS);
    const resultMarker = makeMarkerTracker(MAX_SAME_MARKER_REJECTS);
    // What the last refused plan REPLY was refused for, on the planner-feedback
    // channel (`Atom.plan`): never in `task.constraints`, so the prefilter,
    // its cache key, review and execution all keep the request as asked.
    let planFeedback: string[] = [];
    // The plan the reviewer last REFUSED, on the same channel: kept through an
    // unparseable reply (the planner may still build on it), dropped once a
    // plan is approved. Captured where the refusal is judged, never at the
    // reset after a parsed plan; the planner reads it only behind
    // ATOMA_REVIEW_REPAIR (src/atoms).
    let refusedPlan: PlanBase | undefined;

    try {
      while (true) {
        if (plansWithoutExecution >= maxPlansWithoutExecution) {
          throw new EscalationSignal('plan');
        }
        if (planIter >= ctx.limits.maxPlanIterations) {
          throw new EscalationSignal('plan');
        }
        planIter++;

        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');

        let plan;
        try {
          plan = refusedPlan
            ? await current.plan(task, ctx, planFeedback, { base: refusedPlan })
            : await current.plan(task, ctx, planFeedback);
        } catch (error) {
          // An unparseable plan reply is asked again within the plan budget,
          // which escalates when it runs out: with no other judgement in the
          // cycle, without blame or branch (below). Rethrown, it ended run 12bdcf19
          // (2026-10-15) over one reply with unescaped quotes in a string;
          // escalating at once would blame the child's trust and its recipe
          // and branch a type for one formatting slip. The raw reply stays
          // in the llm event; the parser's message is kept here. A refused
          // REPLY (PlanParseError) tells the next call why; any other
          // ValidationError (an L1's plan) is asked again as before.
          if ((!(error instanceof ValidationError) && !(error instanceof EvidenceReviewError)) || ctx.signal.aborted) throw error;
          ctx.logger.warn(`[${current.name}] plan reply unparseable; asking again (${error.message.slice(0, 200)})`);
          const cause = error instanceof PlanParseError ? error.kind : undefined;
          trace.push({ kind: 'plan-unparseable', ts: now(), atom: current.name,
            payload: { ...(cause ? { cause } : {}), error: error.message } });
          if (error instanceof PlanParseError) planFeedback = [error.feedback()];
          continue;
        }
        planFeedback = [];
        trace.push({ kind: 'plan', ts: now(), atom: current.name, payload: plan });

        const v1 = await parent.validatePlan(current, plan, task, ctx);
        if (!v1.approved) ctx.recordRunStat?.('plan-refusal');

        if (!v1.approved && v1.delegationRefusal === 'reviewer') {
          // The REVIEWER failed (unfinished, unparseable or unclassified,
          // twice: the tissue already re-reviewed once on tier 2). It is no
          // judgement of the plan: nothing is coached, no repeat streak counts
          // it, no plan iteration is spent, and it is traced apart from
          // `verdict-plan`, which the branch diagnostic and the fallback read
          // as validator feedback. Thrown, one flaky reviewer ended the whole
          // run; counted on the plan budget, three faults blamed and branched
          // the child (follow-up and third review, 2026-10-16).
          planIter--;
          reviewFaults++;
          ctx.logger.warn(`[${current.name}] plan review failed as the reviewer's (${reviewFaults}/${MAX_PLAN_REVIEW_FAULTS}) (${(v1.reasoning ?? '').slice(0, 200)})`);
          trace.push({ kind: 'plan-review-fault', ts: now(), atom: parent.name, payload: { reasoning: v1.reasoning, faults: reviewFaults } });
          if (reviewFaults >= MAX_PLAN_REVIEW_FAULTS) throw new EscalationSignal('review');
          continue;
        }
        plansWithoutExecution++;
        trace.push({ kind: 'verdict-plan', ts: now(), atom: parent.name, payload: v1 });
        if (!v1.approved) {
          judgements++;
          const hit = planRepeat.push(v1.reasoning ?? '');
          if (hit.repeated) {
            trace.push({
              kind: 'repeat-rejection',
              ts: now(),
              atom: parent.name,
              payload: {
                phase: 'plan',
                streakKey: hit.streakKey,
                window: MAX_SAME_REASON_REJECTS,
              },
            });
            throw new EscalationSignal('repeat');
          }
          const markerHit = planMarker.push(v1.reasoning ?? '');
          if (markerHit.repeated) {
            trace.push({
              kind: 'repeat-rejection',
              ts: now(),
              atom: parent.name,
              payload: {
                phase: 'plan',
                markerKey: markerHit.marker,
                window: MAX_SAME_MARKER_REJECTS,
              },
            });
            throw new EscalationSignal('repeat');
          }
          refusedPlan = planBase(plan);
          current = await hooks.applyByScope(current, v1);
          trace.push({
            kind: 'applied-modifications',
            ts: now(),
            atom: current.name,
            payload: { phase: 'plan', scope: v1.scope },
          });
          continue;
        }
        // Plan approved → reset the plan streaks; a fresh rejection cycle
        // should not inherit old identical-reasoning history.
        planRepeat.reset();
        planMarker.reset();
        refusedPlan = undefined;

        if (execIter >= ctx.limits.maxExecIterations) {
          throw new EscalationSignal('exec');
        }
        execIter++;

        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');

        plansWithoutExecution = 0;
        let result = withHistory(await run(() => current.execute(task, plan, ctx)));
        trace.push({ kind: 'execute', ts: now(), atom: current.name, payload: result });

        // A real L2/L3 applies the parent-test mapping in its result gates,
        // before any I/O or model call; this is the same mapping again for any
        // other Supervisor, so an approval past a failed suite is overruled and
        // one past a suite that did not run earns no credit.
        // A result verdict that did not parse, after the validator's own
        // reformat turn, is the REVIEWER's failure: judged again, up to the
        // plan-review budget, then a blameless escalation. Thrown, one stray
        // character in a verdict ended run 9a2f8487 whole (2026-10-24).
        const judge = async (judged: Result): Promise<Verdict> => {
          for (;;) {
            try {
              return withParentTestConsequences(judged, await parent.validateResult(current, judged, task, ctx), ctx.logger);
            } catch (error) {
              if ((!(error instanceof ValidationError) && !(error instanceof EvidenceReviewError)) || ctx.signal.aborted) throw error;
              resultReviewFaults++;
              ctx.logger.warn(`[${current.name}] result review failed as the reviewer's (${resultReviewFaults}/${MAX_PLAN_REVIEW_FAULTS}) (${error.message.slice(0, 200)})`);
              trace.push({ kind: 'result-review-fault', ts: now(), atom: parent.name, payload: { error: error.message, faults: resultReviewFaults } });
              if (resultReviewFaults >= MAX_PLAN_REVIEW_FAULTS) throw new EscalationSignal('review');
            }
          }
        };
        let v2 = await judge(result);
        // The refusal below is recorded once: here when a correction is
        // attempted, on the common path otherwise.
        let refusalRecorded = false;
        let corrections = 0;
        while (!v2.approved && v2.reportCorrection && v2.scope === 'ephemeral' && current.tier === 1 &&
          corrections < MAX_REPORT_CORRECTIONS) {
          ctx.recordRunStat?.('result-refusal');
          trace.push({ kind: 'verdict-result', ts: now(), atom: parent.name, payload: v2 });
          refusalRecorded = true;
          const corrected = await current.correctReport(task, result, v2, ctx);
          if (!corrected) {
            // A correction the molecule could not give — a cut or unparseable
            // reply twice, a report past the input bound, a deadline too near —
            // is not a judged defect and no reason to fail the phase: the refusal
            // takes the ordinary ladder below, where the retry re-executes as
            // every refusal did before the correction path existed. Failing
            // here ended a phase over one formatting slip of a tool-free turn.
            ctx.logger.warn(`[${current.name}] report-only correction unavailable; the refusal takes the ordinary ladder`);
            break;
          }
          corrections++;
          result = withHistory({ ...corrected, reportCorrected: true });
          trace.push({ kind: 'execute', ts: now(), atom: current.name, payload: { ...result, reportCorrection: true } });
          // No execution wrapper or suite replay: only the report changed. All
          // original host witnesses and suite outcomes still constrain this verdict.
          v2 = await judge(result);
          refusalRecorded = false;
        }
        if (!v2.approved && v2.reportCorrection && corrections >= MAX_REPORT_CORRECTIONS) {
          // Still judged a transcription defect after every correction. Until
          // 2026-10-24 this threw: the error crossed the cell's dispatch, the
          // tissue and the depth runner, and a run with no judged pass FAILED
          // and lost its work over a report twice judged merely mistranscribed.
          // One re-execution is the cheaper outcome; the retry reads the exact
          // correction and its own attempt digest, and never gains fast paths.
          ctx.logger.warn(`[${current.name}] report-only correction refused ${corrections} time(s); the refusal takes the ordinary ladder`);
        }
        if (!refusalRecorded) {
          if (!v2.approved) ctx.recordRunStat?.('result-refusal');
          trace.push({
            kind: 'verdict-result',
            ts: now(),
            atom: parent.name,
            payload: v2,
          });
        }
        lastResultVerdict = v2;

        if (v2.approved) {
          if (hooks.onApproved) await hooks.onApproved(current, result, v2);
          // Judged here, once: the tier above sees them as context only.
          return { ...markParentTestsJudged(result), trace };
        }

        for (const id of executionHistoryIds(ctx, result)) history.add(id);
        judgements++;
        const handedUp = hooks.handUpRefused?.(current, result, v2);
        if (handedUp) return { ...handedUp, trace };

        const hit = resultRepeat.push(v2.reasoning ?? '');
        if (hit.repeated) {
          trace.push({
            kind: 'repeat-rejection',
            ts: now(),
            atom: parent.name,
            payload: {
              phase: 'result',
              streakKey: hit.streakKey,
              window: MAX_SAME_REASON_REJECTS,
            },
          });
          throw new EscalationSignal('repeat');
        }
        const markerHitR = resultMarker.push(v2.reasoning ?? '');
        if (markerHitR.repeated) {
          trace.push({
            kind: 'repeat-rejection',
            ts: now(),
            atom: parent.name,
            payload: {
              phase: 'result',
              markerKey: markerHitR.marker,
              window: MAX_SAME_MARKER_REJECTS,
            },
          });
          throw new EscalationSignal('repeat');
        }

        current = await hooks.applyByScope(current, v2);
        trace.push({
          kind: 'applied-modifications',
          ts: now(),
          atom: current.name,
          payload: { phase: 'result', scope: v2.scope },
        });
      }
    } catch (e) {
      if (!(e instanceof EscalationSignal)) throw e;

      // Not the child's failure: the reviewer stopped the loop, or nothing
      // judged the child (every reply it gave was unparseable). Its type
      // keeps its trust and no branch is created or coached; the parent
      // takes over (third review 2026-10-16).
      const blameless = e.phase === 'review' || (e.phase === 'plan' && judgements === 0);
      trace.push({
        kind: 'escalated',
        ts: now(),
        atom: parent.name,
        payload: { phase: e.phase, failingChild: current.name, ...(blameless ? { blameless: true } : {}) },
      });
      ctx.recordRunStat?.('escalation');
      disputes.escalated({ phase: e.phase, failingChild: current.name });

      if (hooks.onFailed && !blameless) {
        await hooks.onFailed(current, `escalation-${e.phase}`, lastResultVerdict);
      }
      const replacement = blameless ? undefined : await hooks.branchOnEscalation(
        current,
        trace,
        `escalation-${e.phase}`
      );

      if (replacement && !hasTriedBranch) {
        // Give the branched child ONE clean cycle before falling back to
        // the parent. The branch was created precisely to address the
        // failure mode that just escalated — it deserves to prove whether
        // the fresh prompt actually solves the task. Counters and streak
        // trackers reset naturally by re-entering the outer loop.
        hasTriedBranch = true;
        trace.push({
          kind: 'branch-retry',
          ts: now(),
          atom: replacement.name,
          payload: {
            from: current.name,
            reason: `escalation-${e.phase}`,
          },
        });
        current = replacement;
        continue outer;
      }

      ctx.beforeFallback?.(parent);
      parent.injectContext({
        source: 'fallback-trace',
        text: renderTraceForContext(trace, current.name),
      });
      parent.setFallbackMode(true);
      try {
        const plan = await parent.plan(task, ctx);
        trace.push({ kind: 'plan', ts: now(), atom: parent.name, payload: plan });

        const result = withHistory(await run(() => parent.execute(task, plan, ctx)));
        trace.push({
          kind: 'execute',
          ts: now(),
          atom: parent.name,
          payload: result,
        });

        return {
          ...result,
          trace,
          producedBy: { ...result.producedBy, viaFallback: true },
          // THE ONE WRITER of a fresh stamp: only here has a ladder provably
          // ended in its last resort (src/core/phaseBudget.ts).
          spentLadder: { by: parent.name, on: [task.description] },
        };
      } finally {
        parent.setFallbackMode(false);
      }
    }
  }
}

export function renderTraceForContext(trace: readonly TraceEntry[], failedChild: string): string {
  const lines: string[] = [
    `The atom "${failedChild}" could not satisfy the supervision protocol after repeated iterations.`,
    `Here is the trace of what was attempted:`,
  ];
  for (const e of trace) {
    lines.push(`- [${e.ts}] ${e.atom} ${e.kind}: ${safeJson(e.payload)}`);
  }
  lines.push(
    `You are now taking over the task directly. Use the lessons above to avoid the same pitfalls.`
  );
  return lines.join('\n');
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(v);
  }
}
