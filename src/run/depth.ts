import { restorationDamaged } from '../contracts/readOnlyPhase.js';
import { EARLIER_LISTED_INPUT, baselineEstablishedNothing } from '../contracts/inheritedChecks.js';
import type { Atom } from '../core/atom.js';
import { setMaxListeners } from 'node:events';
import type { Plan, Result, RunContext, Task, ToolExecutor } from '../core/types.js';
import type { DeliveryKind } from '../contracts/taskExecution.js';
import { attestingExecutor, createAttestationLog } from '../core/attestation.js';
import { abortedForLanding, finalizationSignal, landingSignal, withinSignal } from '../atoms/cost.js';
import { acceptRootResult, observedDelivery } from '../atoms/rootAcceptance.js';
import { outOfPhaseBudget } from '../core/limits.js';
import type { AcceptanceInfo, DepthMode, PhaseCoverageRecord, ProofFloor, TopologyInfo } from '../contracts/depthRouting.js';
import { checklistPlanningLines, phaseCriteriaOf, type AcceptanceChecklist, type ChecklistSource } from '../contracts/acceptanceChecklist.js';
import { PhaseBoundaryPause } from '../contracts/runCheckpoint.js';
import { DEPENDENCY_LANDING_INPUT } from '../contracts/runLanding.js';
import { parentTestFindings, parentTestRejection, parentTestReviewFinding, parentTestsGrantNothing, parentTestSuperseded, parentTestWorkspaceFinding } from '../core/parentTests.js';

export class DeepeningSignal extends Error {
  constructor() { super('Entry cell exhausted supervision; deepen once.'); this.name = 'DeepeningSignal'; }
}
/**
 * Stamp a refused result so no reader downstream can mistake it for a
 * delivery — the same job `markLanded` does for a deadline landing, and
 * deliberately the same shape.
 *
 * The summary is prefixed because three readers explain a run to a person from
 * prose alone, and one typed field they do not read would leave them saying
 * the run delivered. The two reasons COMPOSE: a result that already landed on
 * its budget keeps its `INCOMPLETE —` prefix and its phase list, and gains
 * this one, because a reader that reports only the phases drops the refusal.
 */
export function markRefused(result: Result, acceptance: Pick<AcceptanceInfo, 'reasoning'>): Result {
  const reasoning = acceptance.reasoning.trim() || 'the root acceptor gave no reason';
  return {
    ...result,
    summary: `REFUSED AT DELIVERY — the run completed its plan and the root acceptor did not accept it: ${reasoning}. Reported so far: ${result.summary}`,
    refusal: reasoning,
  };
}

/**
 * A run WITHOUT root acceptance (no `--depth`) has no judge for the suites
 * nobody below judged — the root's own integration suite, an unvalidated
 * fallback's. Any such suite that did not pass refuses the delivery, with
 * `markRefused`'s shape: there is no reviewer on this path to read a suite
 * that did not run, so it keeps the partial outcome it had before 2026-10-16.
 */
export function refuseUnreviewedParentTests(result: Result): Result {
  const findings = parentTestFindings(result);
  if (findings.reject.length + findings.rejectOnce.length + findings.review.length === 0) return result;
  const reasoning = [parentTestRejection(result), parentTestWorkspaceFinding(result), parentTestReviewFinding(result)]
    .flatMap((finding) => finding ? [finding.reasoning] : [])
    .join(' ')
    .slice(0, 4000);
  const verb = findings.reject.some((observation) => observation.status === 'failed') ? 'failed' : 'did not run';
  return {
    ...result,
    summary: `REFUSED AT DELIVERY — no root acceptance ran and the host-run parent-owned suite ${verb}: ${reasoning}. Reported so far: ${result.summary}`,
    refusal: reasoning,
  };
}

/**
 * The result of a first pass the run budget cut before any phase was
 * accepted: no output, every planned phase unfinished, so the run is
 * `partial` and its workspace seeds the next run (`previousSeedRun`). The
 * summary keeps `markLanded`'s `INCOMPLETE —` head, because readers that
 * explain a run from prose look for it.
 */
/** The run budget's abort, as the runner reads it (`isTimeout`), never another failure. */
function budgetAbort(error: unknown, ctx: RunContext): boolean {
  if (error === ctx.signal.reason) return true;
  return error instanceof Error && ['TimeoutError', 'AbortError', 'RunBudgetExceededError'].includes(error.name);
}

export function landedBeforeAnyPhase(actor: Pick<Atom, 'name' | 'tier'>, phases: readonly string[]): Result {
  return {
    output: null,
    summary:
      `INCOMPLETE — the run budget ended before any of its ${phases.length} planned phase(s) completed with an accepted result: ` +
      `${phases.join(' | ')}. Nothing was accepted; the workspace keeps what those phases wrote, unverified.`,
    trace: [],
    producedBy: { tier: actor.tier, name: actor.name, viaFallback: false },
    unfinishedPhases: [...phases],
  };
}

/**
 * How many extra root passes one RUN may open: after a refusal, or after an
 * approved dependency landing whose dependents never started.
 *
 * ONE. The refusal names what went unverified, so the second pass is aimed;
 * a third would be the same conversation with no new information, and every
 * pass is a full supervise loop against the tenant's wall clock. Measured
 * 2026-09-23: the same goal refused twice named FEWER gaps the second time
 * once the plan was told to verify, so the loop converges — which is the
 * argument for one more pass and equally the argument against many. An
 * approved dependency landing spends the same pass (G1, 2026-10-16): its
 * typed facts name the phases that never started, which aims it as well.
 */
export const MAX_ROOT_REMEDIATIONS = 1;

/**
 * Whether the one criterion judged unmet is ALL the refusal holds. A refusal
 * may also carry a gate finding, a probe contradiction, an unproven floor
 * item, or another criterion no observation covered or no width laid out;
 * scoped to the criterion alone, the pass would leave those standing and the
 * second acceptance would refuse again, landing a partial the broad pass
 * might have delivered. Any of them keeps the broad pass.
 */
function soleRefusalReason(acceptance: AcceptanceInfo, criterionId: string): boolean {
  if (acceptance.gates.length > 0 || acceptance.probe.contradiction) return false;
  if ((acceptance.inheritedChecks?.items.length ?? 0) > 0 || (acceptance.inheritedChecks?.notReplayed ?? 0) > 0 || acceptance.inheritedChecks?.stopped ||
    acceptance.inheritedChecks?.baselineStopped) return false;
  const inherited = acceptance.inheritedChecks;
  if (inherited && baselineEstablishedNothing({ selected: inherited.selected ?? 0, kept: inherited.kept ?? 0 })) return false;
  if (acceptance.floorCoverage.some((item) => item.status === 'uncovered')) return false;
  return !(acceptance.checklist ?? []).some((item) => item.id !== criterionId && (
    item.status === 'uncovered' || (item.layouts ?? []).some((layout) => layout.status !== 'passed')
  ));
}

/**
 * The refused task, restated with the acceptor's own reasons attached.
 *
 * The reasons ride in `inputs`, never appended to `description`: the
 * description is what the plan and the skill matcher key on, and rewriting it
 * would make a remediated run look like a different task to everything
 * downstream. It is the same shape sequential dispatch already uses to thread
 * a previous step's summary into the next one.
 *
 * ROOT ACCEPTANCE PROSE IS MODEL-AUTHORED. It reaches a planner as data about
 * this run, exactly as a validator's rejection already does, and nothing here
 * executes it.
 */
function inheritedChecksInput(acceptance: AcceptanceInfo): Record<string, unknown> {
  // Only what the acceptor judged NOT asked for: an unjudged item may be a
  // rebuild the task asked for, and a remediation told to restore it would
  // undo the request (review 2026-10-01).
  const items = (acceptance.inheritedChecks?.items ?? []).filter((item) => item.asked === false);
  return items.length === 0 ? {} : {
    [EARLIER_LISTED_INPUT]: items.map(({ id, file, summary, checks }) => ({ id, file, summary, checks })),
  };
}

/** The input a remediation pass reads when its earlier pass was a dependency landing. */
export { DEPENDENCY_LANDING_INPUT };

/**
 * What a dependency landing tells its remediation pass, from typed fields
 * only (review 2026-10-16, group B): the phases a failed phase held back and
 * the suites that did not pass. The gate that refused it says nothing of
 * either, so without this the pass heard a fixed sentence and no facts.
 *
 * The instruction depends on the verdict, never names it (G1): a refused
 * landing repairs its failed phase first; an approved one was judged to stand
 * on its own evidence, so it completes what never started and re-runs a
 * listed check rather than rebuilding kept work. The next judge must not be
 * anchored on its own earlier approval, so no verdict field rides along. An
 * approved landing may list no check at all — a producer that itself landed
 * blocks with no failing observation — and then says nothing of checks.
 */
function dependencyLandingInput(result: Result | undefined, approved: boolean): Record<string, unknown> {
  const blocked = result?.blockedPhases ?? [];
  if (blocked.length === 0) return {};
  const observations = result?.parentTests ?? [];
  const checks = observations
    .filter((observation, index) => observation.status !== 'passed' && !parentTestSuperseded(observations, index))
    .slice(0, 8)
    .map((observation) => ({
      status: observation.status,
      ...(observation.cause ? { cause: observation.cause } : {}),
      ...(observation.suite ? { requirement: observation.suite.requirement } : {}),
      details: observation.details.slice(0, 2000),
    }));
  const instruction = !approved
    ? 'These phases were not started because a phase they depend on failed its typed checks. Repair that phase against its ' +
      'parent-owned suite, then complete the phases that never started. Do not edit or bypass the suites.'
    : checks.length > 0
      ? 'These phases were not started because a phase they depend on did not complete with passing checks (listed in checks). ' +
        'Complete the phases that never started; where a listed check concerns work this run kept, re-run it rather than ' +
        'rebuilding that work. Do not edit or bypass the suites.'
      : 'These phases were not started because a phase they depend on did not complete. Complete the phases that never ' +
        'started without rebuilding the work this run kept. Do not edit or bypass the suites.';
  return {
    [DEPENDENCY_LANDING_INPUT]: {
      notStarted: blocked.slice(0, 16).map((entry) => entry.slice(0, 500)),
      checks,
      instruction,
    },
  };
}

/**
 * The task of the run's one extra root pass, after a refusal or after an
 * approved dependency landing (G1, 2026-10-16).
 *
 * After an APPROVAL there is no refusal to answer and no scope: the pass
 * reads only the landing's typed facts, and keeps every criterion, because a
 * landed approval's criterion judgements are never checked against coverage
 * (`consistentWithCriteria` returns early on a landing) and filtering on them
 * could strip the criteria of exactly the phases that never started.
 */
export function remediationTask(task: Task, acceptance: AcceptanceInfo, result?: Result): Task {
  const landing = dependencyLandingInput(result, acceptance.approved);
  const refused = !acceptance.approved;
  // A single criterion rejected by the root is a narrow, structured finding.
  // Show that fact to the planner so it can repair the claim without treating
  // the original goal as a fresh build. Do not infer scope from free-form
  // acceptance prose: for zero or several failures, the old broad recovery is
  // safer than guessing which artifact may be changed. A refused DEPENDENCY
  // landing never gets one (G1): "keep the deliverables, re-run the checks"
  // contradicts "complete the phases that never started", and the evidence
  // for the scope (cc922a60, ed84d7be) came from complete deliveries.
  const unmet = acceptance.checklist?.filter((item) => item.judgement?.met === false) ?? [];
  const focusedScope = refused && Object.keys(landing).length === 0 && unmet.length === 1 && soleRefusalReason(acceptance, unmet[0]!.id) ? {
    rootRemediationScope: {
      mode: 'single-criterion',
      criterion: {
        id: unmet[0]!.id,
        behaviour: unmet[0]!.behaviour,
        ...(unmet[0]!.judgement?.reason ? { reason: unmet[0]!.judgement.reason } : {}),
      },
      metCriteria: (acceptance.checklist ?? []).filter((item) => item.judgement?.met === true).map((item) => item.id),
      // A fact, never a restriction: the acceptor's verdict may name another
      // reason in prose, so the pass is told to answer the refusal in full.
      instruction: 'This is the one criterion the acceptor judged unmet. Keep the deliverables behind the criteria it judged met (metCriteria) instead of rebuilding them, and answer the whole refusal in rootAcceptanceRefusal, then re-run the checks it concerns.',
    },
  } : {};
  // The listing is the LATEST acceptance's: an earlier pass's never rides on.
  // So is a dependency landing's: it describes the latest pass, never an earlier one.
  const { [EARLIER_LISTED_INPUT]: _stale, [DEPENDENCY_LANDING_INPUT]: _staleLanding, ...inputs } = task.inputs ?? {};
  // A criterion the acceptor judged met keeps its evidence (metCriteria):
  // the phases of a refused pass's follow-up hear only the ones it did not.
  const met = refused ? new Set((acceptance.checklist ?? []).filter((item) => item.judgement?.met === true).map((item) => item.id)) : new Set<string>();
  const { criteria: allCriteria, ...rest } = task;
  const criteria = allCriteria?.filter((item) => !met.has(item.id)) ?? [];
  return {
    ...rest,
    ...(criteria.length > 0 ? { criteria } : {}),
    inputs: {
      ...inputs,
      ...(refused ? { rootAcceptanceRefusal: acceptance.reasoning } : {}),
      rootAcceptanceAttempt: (Number(task.inputs?.['rootAcceptanceAttempt'] ?? 0) || 0) + 1,
      ...focusedScope,
      // Checks earlier runs recorded that held when this run began and fail
      // on its delivery, minus the ones the acceptor said the task asked to
      // change (docs/decisions/inherited-checks-replay-2026-10-01.md).
      ...inheritedChecksInput(acceptance),
      ...landing,
    },
  };
}

/**
 * The root task with the run's acceptance checklist in its `inputs` — the
 * channel `rootAcceptanceRefusal` uses, never the description, which planning
 * and skill matching key on. The note says what the list is for, because
 * planners receive `inputs` as raw JSON with no other guidance.
 */
export function withAcceptanceChecklist(task: Task, checklist: AcceptanceChecklist, source: ChecklistSource = 'drafted', standing = false): Task {
  if (checklist.length === 0) return task;
  return {
    ...task,
    // The typed channel phases read (Task.criteria): the planner assigns ids
    // to subtasks and each phase hears only its own, word for word.
    criteria: phaseCriteriaOf(checklist, source),
    inputs: {
      ...(task.inputs ?? {}),
      acceptanceChecklist: {
        note: source === 'user'
          ? 'Approved by the user before launch: the root acceptor will judge the delivery against each criterion. ' +
            'Plan work that satisfies every one and exercises every HTTP item with fetch_url against the server ' +
            'this run starts.' + (standing
            ? ' Requests an earlier run of this project recorded against the server entry the delivery runs count ' +
              'while that server code is unchanged; editing the server entry or a module it imports by a literal ' +
              'relative path voids them all. A module loaded through a computed path is not tracked: after editing ' +
              'one, exercise its HTTP items again.'
            : '')
          : 'Drafted from the goal: the root acceptor will look for evidence of each behaviour. Plan work that ' +
            'exercises every HTTP item with fetch_url against the server this run starts; it adds no requirement ' +
            'the goal did not state.',
        items: checklistPlanningLines(checklist),
      },
    },
  };
}

export type Lesson = { readonly learn: (signal?: AbortSignal) => Promise<void>; readonly owner: string | undefined;
  readonly lesson?: import('../contracts/skillLearning.js').ApprovedLesson };

/**
 * Run under the approved pass's finalization signal; each lesson logs its own
 * failure. One owner's lessons run in order (they write the same skill
 * namespace) and owners run side by side: a delivery waited for every
 * molecule's recipe one after another (2026-10-10 timing analysis). Lessons
 * with no owner run last, in order, as before.
 */
export async function saveLessons(lessons: readonly Lesson[], signal: AbortSignal, ctx: RunContext): Promise<void> {
  const queues = new Map<string, Lesson[]>();
  for (const lesson of lessons) if (lesson.owner !== undefined) queues.set(lesson.owner, [...(queues.get(lesson.owner) ?? []), lesson]);
  const run = async (queue: readonly Lesson[]) => {
    for (const [index, lesson] of queue.entries()) {
      if (signal.aborted) {
        discardLessons(queue.slice(index), ctx, 'the finalization window closed first');
        return;
      }
      await lesson.learn(signal);
    }
  };
  await Promise.all([...queues.values()].map(run));
  await run(lessons.filter((lesson) => lesson.owner === undefined));
}

function discardLessons(lessons: readonly unknown[], ctx: RunContext, why: string): void {
  if (lessons.length === 0) return;
  for (let i = 0; i < lessons.length; i += 1) ctx.recordRunStat?.('discarded-lesson');
  ctx.logger.warn(`[root] ${lessons.length} skill lesson(s) not saved: ${why}`);
}

/**
 * Whether this run can still pay for its one extra root pass: the same test
 * for a refusal and for an approved dependency landing. `outOfPhaseBudget` is
 * the floor landing already uses, measured for opening ONE phase
 * (2026-09-21); a root pass costs more — replan, delegation review, a phase,
 * acceptance — and inherits that floor unmeasured. `unjudgedRemediations`
 * counts every pass it let through that then ended without a verdict.
 */
function passLeft(ctx: RunContext, remediations: number): boolean {
  return !ctx.signal.aborted && remediations < MAX_ROOT_REMEDIATIONS && !outOfPhaseBudget(ctx.deadlineAt);
}

/**
 * The NAME of what ended a pass, for typed fields the next run's planner and
 * the customer read. The message stays in the trace: it may carry anything.
 */
function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
}

/**
 * The APPROVED earlier pass, when the follow-up opened for its blocked phases
 * was cut or failed before any verdict (G1). Nothing judged the follow-up, so
 * a typed refusal would be false; but it may have written over the approved
 * work, so a follow-up that recorded a root plan adds its phases as
 * unfinished, unverified — what `landedBeforeAnyPhase` does for a first pass.
 * One cut before its root plan ran no phase and only gains the note.
 */
function followUpLanded(prior: Result, phases: readonly string[], why: string): Result {
  const note = phases.length > 0
    ? ` The follow-up pass opened for the phases not started ${why} before it completed; the workspace keeps what it wrote, unverified.`
    : ` The follow-up pass opened for the phases not started ${why} before its plan existed; no phase of it ran.`;
  return {
    ...prior,
    ...(phases.length > 0 ? { unfinishedPhases: [...(prior.unfinishedPhases ?? []), ...phases] } : {}),
    summary: `${prior.summary}${note}`,
  };
}

/**
 * The run's ONE commitment of approved lessons: `skill_learning_jobs.run_id`
 * is the primary key, so a second enqueue in one run would throw. The current
 * pass's lessons come first and lessons held from an approved earlier pass
 * after them, so the stable per-tier sort keeps the later pass's lesson on a
 * tie and otherwise the one with more feedback. A task lesson is kept once
 * per (owner, child, task): a molecule that ran the same subtask in both
 * passes would otherwise pay for two learner calls.
 */
async function persistApprovedLessons(lessons: Lesson[], signal: AbortSignal, ctx: RunContext): Promise<void> {
  // At most one opportunity per rank per run. Prefer recovered failures;
  // do not pay for several amendments to the same soon-stale version.
  for (const tier of [1, 2, 3] as const) {
    const candidates = lessons.filter(entry => entry.lesson?.kind === 'atom' && entry.lesson.tier === tier);
    candidates.sort((a, b) => (b.lesson?.kind === 'atom' ? b.lesson.feedback.length : 0) - (a.lesson?.kind === 'atom' ? a.lesson.feedback.length : 0));
    for (const entry of candidates.slice(1)) lessons.splice(lessons.indexOf(entry), 1);
  }
  const seen = new Set<string>();
  for (const entry of [...lessons]) {
    if (entry.lesson?.kind !== 'task') continue;
    const key = JSON.stringify([entry.lesson.owner, entry.lesson.childName, entry.lesson.task]);
    if (seen.has(key)) lessons.splice(lessons.indexOf(entry), 1);
    else seen.add(key);
  }
  if (ctx.enqueueApprovedLessons && lessons.every(entry => entry.lesson)) {
    try { ctx.enqueueApprovedLessons(lessons.map(entry => entry.lesson!)); }
    catch (error) { discardLessons(lessons, ctx, `could not persist approved lessons: ${String(error)}`); }
    lessons.length = 0;
  } else await saveLessons(lessons.splice(0), signal, ctx);
}

/** The existing atom protocol executes each attempt; this owns only their lifetime. */
export async function runDepthTask(args: {
  mode: DepthMode; task: Task; ctx: RunContext; floor: ProofFloor;
  createExecutor: (mode: DepthMode) => { actor: Atom; handle: (task: Task, ctx: RunContext) => Promise<Result> }
    | Promise<{ actor: Atom; handle: (task: Task, ctx: RunContext) => Promise<Result> }>;
  restart: () => Promise<ToolExecutor>;
  onTopology: (info: TopologyInfo) => void;
  onAcceptance: (info: AcceptanceInfo) => void;
  onApproved?: (actor: Atom, task: Task, result: Result, ctx: RunContext, feedback: readonly string[], approval: string) => void;
  /** Drafted once by the caller, before the attempt loop; a deepening keeps it. */
  checklist?: AcceptanceChecklist;
  /**
   * Set when `checklist` is the USER's approved list. It is held HERE, by the
   * host, and handed to every root acceptance: never re-read from
   * `task.inputs`, which the planners see and remediation re-spreads.
   */
  checklistOrigin?: { readonly source: ChecklistSource; readonly digest?: string };
}): Promise<Result> {
  const { ctx } = args;
  const task = withAcceptanceChecklist(args.task, args.checklist ?? [], args.checklistOrigin?.source,
    (args.ctx.standingHttpEvidence?.length ?? 0) > 0);
  const attestations = (ctx.attestations ??= createAttestationLog());
  const phaseCoverage: PhaseCoverageRecord[] = [];
  let tools = ctx.tools;
  // BOUNDED PER RUN, not per attempt. A deepening is already this run's second
  // chance at a structural failure; a remediation is its second chance at an
  // unfinished verification. Counting them separately would let one run spend
  // four full supervise loops against the tenant's wall clock, so the budget
  // is one extra pass for the whole run, wherever it falls and whatever the
  // verdict that opened it: a refusal, or an approved dependency landing (G1).
  let remediations = 0;
  for (const attempt of [1, 2]) {
    ctx.signal.throwIfAborted();
    const mode = attempt === 1 ? args.mode : 'deep';
    args.onTopology({ at: attempt === 1 ? 'entry' : 'deepening', mode,
      reason: attempt === 1 ? 'arm' : 'fallback-moment', attempt });
    const { actor, handle } = await args.createExecutor(mode);
    const cancellation = new AbortController();
    const attemptSignal = AbortSignal.any([ctx.signal, cancellation.signal]);
    setMaxListeners(0, attemptSignal);
    const deepen = new DeepeningSignal();
    let requested = false;
    const attemptCtx: RunContext = {
      ...ctx, attempt, attestations,
      signal: attemptSignal,
      // A fresh workspace gets fresh coaching; forks within this attempt
      // share these same sets through supervisor replans and branch retries.
      mechanicalPlanRejections: new Set(), mechanicalResultRejections: new Set(),
      dispatchedScriptSignatures: new Map(),
      ...(tools ? { tools: attestingExecutor(tools, attestations, undefined,
        (message) => ctx.logger.warn(message), attempt)! } : {}),
      recordPhaseCoverage: (record) => { phaseCoverage.push(record); ctx.recordPhaseCoverage?.(record); },
      beforeFallback: (parent) => {
        // A mutualized peer is still the entry supervisor in the short
        // topology. Its fallback must deepen just like the selected cell's.
        if (mode === 'short' && parent.tier === 2) {
          requested = true;
          cancellation.abort(deepen);
          throw deepen;
        }
      },
    };
    try {
      // REMEDIATION LIVES INSIDE THE ATTEMPT, and that is the whole design.
      // The workspace is not archived and `attempt` does not move, so the
      // attestations the first pass earned still cover their deliverables —
      // `rootProofCoverage` re-reads each file and compares its digest, so a
      // proof survives exactly as long as the bytes it was made against. A new
      // attempt, as deepening uses, would discard all of it, which is right
      // when the workspace is replaced and wrong when it is being completed.
      let currentTask = task;
      // The EARLIER pass of this attempt, refused or an approved dependency
      // landing (G1). Every exit after a judged pass that is not deliberate
      // lands on it instead of taking it down (2026-09-25 review, 1.2b): the
      // dispatch of a pass that accepted nothing throws, and until 2026-09-26
      // that discarded a complete first result as `failed`; until G1 a
      // follow-up that failed on its own still did (6ab0ae3b's loss again).
      let prior: { readonly result: Result; readonly acceptance: AcceptanceInfo } | null = null;
      // An approved earlier pass's lessons, HELD until the follow-up's verdict:
      // they follow the last verdict on the work they came from. Saved with
      // the follow-up's when it is approved, or alone when it ends with no
      // verdict (the approval is then the last word on that work); dropped
      // when the follow-up is refused, because that refusal judged a
      // workspace holding the earlier pass's work (run fc2a68cf's rule).
      const held: Lesson[] = [];
      try {
        for (;;) {
          // ONE PASS'S LESSONS wait for the root's verdict on that pass: saved
          // when it approves, dropped on every other way out (owner decision
          // 2026-10-09; run fc2a68cf learned from a phase the root then refused).
          const lessons: Lesson[] = [];
          let lessonsSaved = false;
          try {
            let result: Result;
            let delivery: DeliveryKind | undefined;
            let rootPlan: Plan | undefined;
            let rootPhases: readonly string[] = [];
            const passCtx: RunContext = { ...attemptCtx, deferredLearning: { defer: (learn, owner, lesson) => { lessons.push({ learn, owner, ...(lesson ? { lesson } : {}) }); } },
              recordRootPlan: (plan) => {
                rootPlan = plan;
                delivery = plan.delivery;
                rootPhases = plan.subtasks.map((subtask) => subtask.description);
                attemptCtx.recordRootPlan?.(plan);
              } };
            try {
              result = await handle(currentTask, passCtx);
            } catch (error) {
              if (error instanceof PhaseBoundaryPause) throw error;
              // Deepening and explicit cancellation keep their meaning; the run
              // budget and a pass's own failure do not take a judged pass down.
              const deliberate = cancellation.signal.aborted || (ctx.signal.aborted && !abortedForLanding(ctx));
              if (prior && !deliberate) {
                ctx.recordRunStat?.('unjudged-remediation');
                const why = abortedForLanding(ctx) ? 'was cut by the run deadline' : `failed (${errorName(error)})`;
                ctx.logger.warn(`[root] the extra root pass ${why}; the run lands on the pass before it`);
                if (!prior.acceptance.approved) {
                  const reasoning = prior.acceptance.reasoning.trim() || 'the root acceptor gave no reason';
                  return markRefused(prior.result, { reasoning: `${reasoning} — the remediation pass ${why} before it completed` });
                }
                await persistApprovedLessons(held.splice(0), finalizationSignal(ctx.deadlineAt) ?? landingSignal(), ctx);
                return followUpLanded(prior.result, rootPhases, why);
              }
              // THE FIRST PASS, cut by the run budget before any of its phases was
              // accepted, still wrote real work: it lands with every phase it
              // planned unfinished, so the next run of the project starts from
              // those files instead of from nothing. On a thirty-minute ceiling a
              // phase too large to close in one run otherwise failed every time,
              // each relaunch starting over (production run dfa20873, 2026-10-03,
              // closed its first phase only through a false trust approval). A
              // pass cut before its root plan existed has run no phase and fails.
              // Only the budget's own abort lands: a genuine failure a parallel
              // dispatch rethrew after the deadline cut a sibling keeps its meaning.
              // The landing is then JUDGED like any work in hand, so what it broke
              // in a seed (an inherited check) is recorded before it seeds a run.
              if (!prior && rootPhases.length > 0 && !cancellation.signal.aborted && abortedForLanding(ctx) && budgetAbort(error, ctx)) {
                result = landedBeforeAnyPhase(actor, rootPhases);
              } else {
                throw error;
              }
            }
            // Once delivery review/remediation begins the phase boundary is consumed.
            ctx.rootCheckpoint?.finalizing();
            // WORK IN HAND leaves the execution clock for the finalization window,
            // landed or complete (2026-09-25 review, 1.2a): a complete result whose
            // root acceptance straddled the deadline used to be thrown away while a
            // landed one was kept. Deepening and explicit cancellation still abort.
            cancellation.signal.throwIfAborted();
            const landed = Boolean(result.unfinishedPhases?.length);
            if (!abortedForLanding(ctx)) attemptCtx.signal.throwIfAborted();
            const explicitCancellation = new AbortController();
            const forwardCancellation = () => {
              if (!abortedForLanding(ctx)) explicitCancellation.abort(ctx.signal.reason);
            };
            ctx.signal.addEventListener('abort', forwardCancellation, { once: true });
            // Deadline + grace, absolute. Without a run deadline a BUDGET landing keeps
            // the post-approval cap and a complete one only its cancellations; a
            // pure dependency landing happened with the clock running, so it is
            // judged like a complete result (review 2026-10-16, group B).
            const budgetLanded = (result.unfinishedPhases?.length ?? 0) > (result.blockedPhases?.length ?? 0);
            const bound = finalizationSignal(ctx.deadlineAt) ?? (budgetLanded ? landingSignal() : undefined);
            const acceptanceCtx: RunContext = { ...attemptCtx,
              signal: AbortSignal.any([...(bound ? [bound] : []), cancellation.signal, explicitCancellation.signal]),
            };
            // A COMPLETE pass whose root plan declared no delivery (the cell's
            // prefilter shortcut builds its plan in code) is judged as what the
            // pass did, and the declared manifest records it: undeclared read as
            // files, so a text answer went to the report-blind criteria review and
            // publication read it as an empty file delivery (code review
            // 2026-10-09, 1.2). A landing keeps its own protocol.
            const judged = rootPlan && !delivery && !landed ? observedDelivery(attemptCtx) : delivery;
            if (rootPlan && judged !== delivery) attemptCtx.recordRootPlan?.({ ...rootPlan, delivery: judged });
            let acceptance: AcceptanceInfo;
            try {
              acceptance = await withinSignal(acceptRootResult({ actor, task: currentTask, result, ctx: acceptanceCtx,
                ...(judged ? { delivery: judged } : {}),
                floor: args.floor, phaseCoverage, ...(args.checklist ? { checklist: args.checklist } : {}),
                ...(args.checklistOrigin ? { checklistOrigin: args.checklistOrigin } : {}),
                // The earlier pass's own record, refused or approved: a
                // follow-up's acceptance must re-check what that one listed
                // (run 5dff35b0).
                ...(prior ? { previousAcceptance: prior.acceptance,
                  previousEvidence: prior.result.evidence } : {}) }), acceptanceCtx.signal);
              acceptanceCtx.signal.throwIfAborted();
            } catch (error) {
              cancellation.signal.throwIfAborted();
              explicitCancellation.signal.throwIfAborted();
              // A real error before the deadline is still an error — on a first
              // pass. A follow-up's work is kept, never delivered (G1): the run
              // has a judged pass and must not fail over the second judgement.
              // Once the clock is involved — the window closed, or the run
              // deadline passed — the work in hand is kept, never delivered, and
              // no new pass is opened.
              const clock = acceptanceCtx.signal.aborted || abortedForLanding(ctx);
              if (!clock && !prior) throw error;
              if (prior) ctx.recordRunStat?.('unjudged-remediation');
              return markRefused(result, { reasoning: clock
                ? 'Root acceptance could not finish within the landing budget'
                : `root acceptance of the follow-up pass did not finish (${errorName(error)})` });
            } finally {
              ctx.signal.removeEventListener('abort', forwardCancellation);
            }
            args.onAcceptance(acceptance);
            if (acceptance.approved) {
              // A suite nobody below judged that did not pass proved nothing of
              // the method: the delivery may stand on other evidence, its lesson does not.
              const unverifiedSuite = parentTestsGrantNothing(result, 'unjudged');
              if (unverifiedSuite) ctx.logger.warn('[root] distillation withheld: a parent-owned suite did not run');
              if (!acceptance.floorCoverage.some(item => item.status === 'uncovered') && !unverifiedSuite &&
                !(passCtx.readOnlyPhases?.restorations() ?? []).some(item => item.attempt === (passCtx.attempt ?? 1) && restorationDamaged(item))) {
                args.onApproved?.(actor, currentTask, result, passCtx, prior && !prior.acceptance.approved ? [prior.acceptance.reasoning] : [], acceptance.reasoning);
              }
              // AN APPROVED DEPENDENCY LANDING with a pass left opens it (G1,
              // 2026-10-16, reversing group B's choice (b)): its dependents never
              // started while the clock still ran, and ending `partial` forfeited
              // the budget that could run them. Only a PURE dependency landing —
              // a phase the budget cut means the clock is the binding limit — and
              // only in deep mode: a short attempt that deepened during the
              // follow-up would archive the approved workspace (`restart`).
              if ((result.blockedPhases?.length ?? 0) > 0 && !budgetLanded && mode === 'deep' && passLeft(ctx, remediations)) {
                remediations += 1;
                prior = { result, acceptance };
                held.push(...lessons.splice(0));
                lessonsSaved = true;
                ctx.recordRunStat?.('landing-remediation');
                ctx.logger.warn(
                  `[root] dependency landing approved with ${result.blockedPhases!.length} phase(s) not started; one more pass to run them (${remediations}/${MAX_ROOT_REMEDIATIONS})`
                );
                currentTask = remediationTask(currentTask, acceptance, result);
                continue;
              }
              lessonsSaved = true;
              await persistApprovedLessons([...lessons.splice(0), ...held.splice(0)], acceptanceCtx.signal, ctx);
              return result;
            }
            // A refusal LANDS when there is no pass left to spend, or when the
            // wall clock cannot pay for one. `outOfPhaseBudget` is the floor
            // landing already uses: opening work the deadline will truncate
            // buys nothing, and here it would also cost the refusal's own diagnosis.
            //
            // It used to throw. The run then recorded `failed`, and every byte the
            // molecule had written seeded nothing, because `previousSeedRun` skips
            // a failed run on its status filter — thirty minutes and 0.42 USD of
            // real work discarded on production run `6ab0ae3b`.
            if (!passLeft(ctx, remediations)) return markRefused(result, acceptance);
            remediations += 1;
            prior = { result, acceptance };
            ctx.recordRunStat?.('root-remediation');
            ctx.logger.warn(
              `[root] delivery refused; one more pass with the acceptor's reasons (${remediations}/${MAX_ROOT_REMEDIATIONS})`
            );
            currentTask = remediationTask(currentTask, acceptance, result);
          } finally {
            if (!lessonsSaved) discardLessons(lessons.splice(0), ctx, 'the root did not approve this pass');
          }
        }
      } finally {
        discardLessons(held.splice(0), ctx, 'the pass after an approved dependency landing was not approved');
      }
    } catch (error) {
      if (error instanceof PhaseBoundaryPause) throw error;
      ctx.signal.throwIfAborted();
      if (!requested || mode !== 'short') throw error;
      // Parallel dispatch drains cancelled siblings before the handle rejects.
      // The backend must reap processes before it archives and replaces the workspace.
      tools = await args.restart();
      ctx.recordRunStat?.('deepening');
    }
  }
  throw new Error('Depth attempt limit reached');
}
