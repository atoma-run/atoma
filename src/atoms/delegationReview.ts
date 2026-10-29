import { createHash } from 'node:crypto';
import type { DelegationRefusalKind, NegativeVerdict, Plan, SubtaskSpec, Task } from '../core/types.js';
import { PlanParseError } from '../core/errors.js';
import { PARENT_TEST_BLOCKING_DEFECTS, PARENT_TEST_EXECUTION, PARENT_TEST_INTEGRATION_PLACEMENT, PARENT_TEST_RUNNER_SCOPE, PARENT_TEST_SUFFICIENCY, PARENT_TEST_UNSATISFIABLE, delegationReviewEnvelopeSchema, type DelegationReview, type UnsatisfiableSuite } from '../contracts/parentTests.js';
import { applyPlanDeltas, extractJson, parseWith, parseVerdict, planRepairEnvelopeSchema, planSchema, reviewRepairEnabled, type PlanDelta, type ReviewerPlanDelta } from './json.js';
import { parentSuiteParseRefusal, parentSuiteRefusal, readRunCopiesRefusal } from './parentSuiteCheck.js';
import { VALIDATION_SYSTEM_PROMPT } from './verdict.js';

export type { DelegationRefusalKind } from '../core/types.js';

/** The review request's first line; the calibration's historical reader anchors on it. */
export const DELEGATION_REVIEW_HEADER = '== REQUIRED DELEGATION CONTRACT REVIEW ==';

/**
 * The review's half of the browser route (run 7a7af324). The boundary says
 * what a suite cannot run; this says what the review does about it, so a
 * refusal names the route the runtime checks instead of a suite that fails.
 */
const BROWSER_PROOF_REVIEW = 'Review every suite against that boundary: a suite that needs a browser, a DOM or a spawned process cannot run here, so reject it, and never ask a suite for one. Never reject a plan because browser-only behaviour is proven by its browser subtask and the obligation that subtask carries instead of a suite. A subtask whose only proof is browser-only behaviour is other; one that also implements code is vitest for that code. When the task needs browser-only behaviour that no subtask routed to a child holding validate_html proves, ask for that subtask, with the obligation when real user input is involved, never for a suite; a task without a page needs neither. A subtask that runs the project\'s own existing real-browser suites through run_shell or record_probe, as the task asks, already routes the behaviour those suites exercise: never ask that plan for an added validate_html subtask or a dom-interaction obligation for it; result review judges those suites\' setup, interactions and assertions. Behaviour no such suite exercises still needs its browser route.';

const REJECTION_SENTENCE = 'For rejection use the ordinary negative Verdict with actionable reasoning and "unsatisfiableSuites" as defined above ([] when none); no delegationReview classification is required.';

export const DELEGATION_REVIEW_REQUEST = `${DELEGATION_REVIEW_HEADER}
Review the entire current task and this plan before dispatch. This is mandatory even for trusted types.
YOUR approval verdict MUST additionally contain delegationReview, YOUR OWN classification of the plan:
{"subtasks":[{"index":0,"kind":"vitest|inspection|other","reason":"scope-specific justification"}],"integration":{"kind":"vitest|inspection|other","reason":"justification"},"independentWork":true,"parallelReason":"actual dependencies or independent work"}.
delegationReview is a field of your verdict JSON, never of the plan: the plan has no such field, the planner cannot supply it, and a plan is never refused for lacking it.
Classify EVERY subtask exactly once using zero-based indices. Classify testable TypeScript application implementation as vitest, even when its tests or interfaces were omitted. Unknown interfaces do not turn implementation into inspection. A task that includes implementation cannot be classified inspection. Other is for non-code deliverables or behavior requiring separate browser/CLI probes; explain the concrete proof. Do not exempt importable application behavior merely because it also has a UI or CLI.
${PARENT_TEST_RUNNER_SCOPE}
${PARENT_TEST_EXECUTION}
${BROWSER_PROOF_REVIEW}
Require a Vitest integration suite when branches implement interacting application modules. ${PARENT_TEST_INTEGRATION_PLACEMENT} Never ask a plan whose join subtask carries it for a plan-level copy, and never ask a plan with one implementation subtask for an integration suite or to move its suite: it has no join. Review all suite sources for real application imports, useful assertions, negative cases, faithful interfaces, and no replacement of the subject under test. Trivial assertions or placeholders must be rejected even when a suite exists.
${PARENT_TEST_SUFFICIENCY}
${PARENT_TEST_BLOCKING_DEFECTS} Name any other gap in a suite's coverage in your reasoning; it does not refuse the plan.
${PARENT_TEST_UNSATISFIABLE}
Set independentWork true whenever useful independent work exists in the assigned scope, including work hidden in one broad branch. Reject grouping independent L2 work into one L2 or inventing dependencies to serialize it. Genuine coupling permits sequential work; do not invent branches for a small inseparable change.
An L3 replanAfter:true plan is discovery ONLY: no writes, no implementation deferred to another subtask. The host will replan once after its observations. A promise in prose to obtain review or replan later has NO runtime effect. Reject such a promise when executable contracts are missing. L2 cannot use replanAfter.
An inspection or reproduction subtask must ask for observed state and defects, not require the repaired state while forbidding changes. Reject that contradiction before dispatch and ask for observation now, correction in the implementation phase. Context-only criteria cannot become binding through a child description. An inspection still needs its requested evidence; its approval does not satisfy the final criteria.
An approval without this complete classification is not executable. ${REJECTION_SENTENCE} A refusal lists EVERY blocking defect and every request in this one verdict, not the first one found: the planner answers all of them in one revision. A later round refuses only for a listed defect that still stands or one the revision introduced; a defect that was present and went unlisted goes in your reasoning and does not refuse the plan.`;

/**
 * The review's repair rule (stage A of design M4 at the root, M5 at the
 * cell, behind ATOMA_REVIEW_REPAIR), in place of the rejection sentence. Runs b920faf6 and
 * 1622e44b refused root plans for defects the reviewer could state exactly
 * (a fan-out, a dependency, a binding), each refusal a top-tier replan and a
 * second review. The reviewer repairs those in its approval and writes no
 * suite: what needs suite bytes stays a refusal the planner answers.
 */
const REPAIR_RULE = 'Repair, do not refuse, a structural defect you can state exactly without writing a suite: independent work grouped or serialized (fan-out), a wrong or missing dependsOn, an oversized subtask to split, acceptance criteria bound to the wrong subtask, a missing proof obligation. Approve with "planRepair": {"deltas": [...]} beside delegationReview, which then classifies the plan AFTER your deltas, by its indices. Deltas, each applied to the plan the earlier ones left, at most 6: ' +
  '{"kind":"dependsOn.set","target":i,"dependsOn":[earlier indices]}; {"kind":"aggregation.set","aggregation":{"mode":"sequential|concat|llm-synthesize"}}; {"kind":"criteria.assign","target":i,"criteria":["criterion text"]}; {"kind":"obligation.add","target":i,"obligation":"dom-interaction"}; ' +
  '{"kind":"suite.split","target":i,"into":[{"description":"...","suiteFrom":j or "plan","criteria":[...],"dependsOn":[earlier indices]}, ...]} (2 to 6 parts, each running a suite this plan already carries, copied by the host byte for byte). You never write or edit suite source or an expect( line: a suite that is missing, insufficient or unsatisfiable is a refusal. The host applies your deltas and re-runs its mechanical checks; a repair it cannot accept becomes a refusal the planner hears with your deltas. ' +
  'For rejection use the ordinary negative Verdict with actionable reasoning, "unsatisfiableSuites" as defined above ([] when none) and "refusalKind", one of: "replan-after" (a discovery plan that is not read-only discovery), "unexecutable-proof" (a suite or proof the runtime cannot execute), "missing-interface" (a suite or subtask relying on an interface nothing provides), "coverage" (a missing or insufficient suite, case or browser route), "empty" (no executable work); no delegationReview classification is required.';

/**
 * The review contract as a reviewer reads it: today's text, or with
 * `repairs` (behind ATOMA_REVIEW_REPAIR) the repair rule in place
 * of the rejection sentence. Off, byte-identical to DELEGATION_REVIEW_REQUEST.
 */
export function delegationReviewRequest(repairs: boolean): string {
  return repairs ? DELEGATION_REVIEW_REQUEST.replace(REJECTION_SENTENCE, () => REPAIR_RULE) : DELEGATION_REVIEW_REQUEST;
}

/**
 * The obligations the reviewed task already carries. Dispatch unions them into
 * every subtask (`effectiveObligations`), but a cell's plan does not repeat
 * them and the task context never renders them: told the browser route, the
 * review of that plan would ask it to declare what it inherits. Facts only;
 * '' for a task carrying none, which is every root task.
 */
export function inheritedObligationsNote(task: Task): string {
  const carried = task.proofObligations ?? [];
  if (carried.length === 0) return '';
  const pronoun = carried.length === 1 ? 'it' : 'them';
  return `HOST FACT: this task already carries proofObligations ${JSON.stringify(carried)}; dispatch hands ${pronoun} to every subtask, so this plan need not declare ${pronoun} again.`;
}

/**
 * The review's own earlier refusals of this delegation, oldest first, each with
 * the requests it made. Without them each round judged the new plan from
 * scratch; with the requests withheld from the planner too, runs 7a7af324,
 * aaa6b442 and 63feeb3c (2026-10-16) refused nine plans, three per run, and
 * every run ended with nothing executed. No round count: the last round must
 * judge as strictly as the first.
 */
export function previousRefusalsNote(refusals: readonly string[]): string {
  if (refusals.length === 0) return '';
  const cap = 1200;
  const listed = refusals.map((text, index) => `${index + 1}. ${text.length > cap ? `${text.slice(0, cap)} [truncated]` : text}`).join('\n');
  return `PREVIOUS REFUSALS OF THIS DELEGATION, oldest first; the planner received each with its requests:\n${listed}\nJudge first whether this plan fixes each of them. One that still stands refuses again only when it is a blocking suite defect above or breaks another rule of this review. A defect the revision introduced refuses. Any other gap, including one that was already present and no earlier refusal named, goes in your reasoning and does not refuse the plan.`;
}

/**
 * The suites a refusal names unsatisfiable that the reviewed plan actually
 * carries, once each. An entry citing a subtask without a suite, or a plan
 * without a plan-level suite, is dropped: a missing suite is a request, never
 * an unsatisfiable one, so a coverage refusal cannot be dressed as one.
 */
export function citedUnsatisfiableSuites(plan: Plan, cited: readonly UnsatisfiableSuite[] | null | undefined): UnsatisfiableSuite[] {
  const kept = new Map<string, UnsatisfiableSuite>();
  for (const entry of cited ?? []) {
    const carried = entry.suite === 'plan' ? plan.acceptanceTests : plan.subtasks[entry.suite]?.acceptanceTests;
    if (carried && !kept.has(String(entry.suite))) kept.set(String(entry.suite), entry);
  }
  return [...kept.values()];
}

/** One refusal as the planner and later reviews read it: the reasoning, then what it asked for. */
export function refusalWithRequests(verdict: { reasoning: string; modifications?: { additionalContext?: string } }): string {
  const requested = verdict.modifications?.additionalContext?.trim();
  return requested && requested !== verdict.reasoning.trim() ? `${verdict.reasoning} Requested: ${requested}` : verdict.reasoning;
}

/** The longest routing note a review or a replanning planner reads. */
export const ROUTING_INDEX_NOTE_MAX_CHARS = 1200;

/**
 * Which routed indices belong to which PLANNER subtask, when
 * `routeCrossBucketVerification` split a checkpoint (review 2026-10-16,
 * point 7). The reviewer classifies the dispatched plan's indices, and a
 * rejection citing "subtask 4" goes back to a planner whose own plan has no
 * subtask 4: both read this note. Facts only — no command, no gate. Empty when
 * nothing was split.
 */
export function routingIndexNote(plan: Plan): string {
  const parts = new Map<number, { index: number; role: string }[]>();
  plan.subtasks.forEach((subtask, index) => {
    if (!subtask.routedFrom) return;
    const group = parts.get(subtask.routedFrom.index) ?? [];
    group.push({ index, role: subtask.routedFrom.role });
    parts.set(subtask.routedFrom.index, group);
  });
  if (parts.size === 0) return '';
  const head = 'HOST CAPABILITY ROUTING: ';
  const tail = '; the order between the parts of one checkpoint is host ordering, not planner serialization. ' +
    'Review indices refer to this routed plan. To keep a checkpoint whole, give it a cell holding validate_html, ' +
    'run_shell and start_node_server, or omit its preferredChild. A split checkpoint\'s acceptance criteria bind only a part ' +
    'routed to a cell holding validate_html, run_shell and start_node_server; other parts hear them as context, and root ' +
    'acceptance judges every one.';
  const mappings = [...parts.entries()].map(([planner, group]) => {
    const indices = group.map((part) => part.index);
    const listed = indices.length === 2 ? `${indices[0]} and ${indices[1]}` : indices.join(', ');
    return `subtasks ${listed} are the host's browser then exact-shell verification of planner subtask ${planner}, routed to capable cells`;
  });
  const budget = ROUTING_INDEX_NOTE_MAX_CHARS - head.length - tail.length - 40;
  const kept: string[] = [];
  let used = 0;
  for (const mapping of mappings) {
    if (used + mapping.length + 2 > budget) break;
    kept.push(mapping);
    used += mapping.length + 2;
  }
  const omitted = mappings.length - kept.length;
  return `${head}${kept.join('; ')}${omitted > 0 ? `; ${omitted} more split checkpoint(s) not listed` : ''}${tail}`;
}

/**
 * A refusal that asks the PLAN for the reviewer's own `delegationReview`
 * object is the reviewer misreading its contract, never a plan defect: the
 * plan schema has no such field, so the planner can never answer it. Run
 * f41efe87 (2026-10-24) refused five root plans this way, each refusal fed
 * back as a "previous refusal" that entrenched the misreading, and the run
 * failed with nothing executed. The word is our own fixed identifier, not
 * natural vocabulary, and a false positive costs one re-review on the
 * validation model, never an approval.
 */
const DELEGATION_REVIEW_MISREAD_RE =
  /delegationReview[\s\S]{0,160}?\b(?:absent|missing|omit\w*|lack\w*|without|not\s+(?:present|provided|supplied|included|contain\w*|include\w*))\b|\b(?:absent|missing|omit\w*|lack\w*|without)\b[\s\S]{0,160}?delegationReview/i;

export function misreadDelegationReview(verdict: { approved: boolean; reasoning: string; modifications?: { additionalContext?: string } }): boolean {
  if (verdict.approved) return false;
  return DELEGATION_REVIEW_MISREAD_RE.test(`${verdict.reasoning}\n${verdict.modifications?.additionalContext ?? ''}`);
}

export function delegationRefusal(reason: string, kind: DelegationRefusalKind): NegativeVerdict {
  return { approved: false, reasoning: reason, scope: 'ephemeral', modifications: { additionalContext: reason }, delegationRefusal: kind };
}

/** The classification an approval carries, or a `reviewer` refusal when it carries none. */
export function parseDelegationReview(response: string): DelegationReview | NegativeVerdict {
  try { return parseWith(delegationReviewEnvelopeSchema, response).delegationReview; }
  catch { return delegationRefusal('Delegation review is incomplete: classify every subtask, integration and parallelism before execution.', 'reviewer'); }
}

/**
 * Semantic classification is fallible; missing bytes/indices cannot be waived by approved:true.
 * Behind ATOMA_REVIEW_REPAIR a refusal is the plan's, with or without its `refusalKind`, and an
 * approval's `planRepair` is enforced on the plan it makes.
 */
export function enforceDelegationReview(plan: Plan, response: string, allowDiscovery: boolean): NegativeVerdict | undefined {
  if (reviewRepairEnabled()) {
    let verdict: ReturnType<typeof parseVerdict> | undefined;
    try { verdict = parseVerdict(response); } catch { verdict = undefined; }
    if (verdict && !verdict.approved) {
      return { ...delegationRefusal(verdict.reasoning, 'plan'), ...(verdict.refusalKind ? { refusalKind: verdict.refusalKind } : {}) };
    }
  }
  const review = parseDelegationReview(response);
  if ('approved' in review) return review;
  const repair = reviewRepairEnabled() ? reviewedPlanRepair(plan, response) : undefined;
  if (repair && 'approved' in repair) return repair;
  return enforceRepairedDelegationReview(plan, repair, review, allowDiscovery);
}

/**
 * The mechanical half over the plan a repair made, when there is one: a
 * fan-out or dependency the reviewer repaired does not refuse. A refusal of
 * the repaired plan names the deltas, since the planner never saw that plan.
 */
export function enforceRepairedDelegationReview(plan: Plan, repair: { deltas: readonly unknown[]; plan: Plan } | undefined,
  review: DelegationReview, allowDiscovery: boolean): NegativeVerdict | undefined {
  const refusal = enforceParsedDelegationReview(repair?.plan ?? plan, review, allowDiscovery);
  if (!refusal || !repair || refusal.delegationRefusal === 'reviewer') return refusal;
  return delegationRefusal(`${refusal.reasoning} ${repairNote(repair.deltas)}`, refusal.delegationRefusal ?? 'plan');
}

/** The reviewer's deltas as a refusal of the plan they made quotes them, bounded. */
export function repairNote(deltas: readonly unknown[]): string {
  const text = JSON.stringify(deltas);
  return `(Found on the plan after the review's planRepair ${text.length > 1200 ? `${text.slice(0, 1200)} [truncated]` : text}.)`;
}

function safeExtract(response: string): unknown {
  try { return extractJson(response); } catch { return undefined; }
}

/**
 * The reviewer's stage-A repair of the plan it approves (design M4, behind
 * ATOMA_REVIEW_REPAIR): `undefined` when the approval carries none; else the
 * deltas and the reviewed plan they make, through `applyPlanDeltas` (a whole
 * plan by `planSchema` and the authored bound). A split part runs the suite
 * it names by `suiteFrom`, copied byte for byte: the reviewer writes none.
 * Host routing marks stay on the subtasks they marked. A repair that does
 * not parse (a `suite.replace` among them), names a suite the plan does not
 * carry, splits a host-routed part or does not apply is the REVIEWER's fault,
 * like an approval without its classification: the same plan is reviewed again.
 */
export function reviewedPlanRepair(plan: Plan, response: string): { deltas: ReviewerPlanDelta[]; plan: Plan } | NegativeVerdict | undefined {
  const raw = safeExtract(response);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('planRepair' in raw)) return undefined;
  const parsed = planRepairEnvelopeSchema.safeParse(raw);
  const invalid = (why: string): NegativeVerdict =>
    delegationRefusal(`Delegation review's planRepair is not a repair the host can apply: ${why.slice(0, 400)}`, 'reviewer');
  if (!parsed.success) return invalid(parsed.error.message);
  const deltas = parsed.data.planRepair?.deltas;
  if (!deltas) return undefined;
  const suiteOf = (from: number | 'plan') => from === 'plan' ? plan.acceptanceTests : plan.subtasks[from]?.acceptanceTests;
  // Where each subtask of the plan being amended came from, delta after delta; a split part comes from none.
  let origin: (number | undefined)[] = plan.subtasks.map((_, index) => index);
  const planned: PlanDelta[] = [];
  for (const delta of deltas) {
    if (delta.kind !== 'suite.split') {
      planned.push(delta);
      continue;
    }
    const at = origin[delta.target];
    if (at !== undefined && plan.subtasks[at]?.routedFrom) return invalid(`subtask ${delta.target} is a host-routed verification part; it cannot be split`);
    const into = [];
    for (const { suiteFrom, ...part } of delta.into) {
      const suite = suiteOf(suiteFrom);
      if (!suite) return invalid(`a part of subtask ${delta.target}'s split names suite ${String(suiteFrom)}, which this plan does not carry`);
      into.push({ ...part, acceptanceTests: suite });
    }
    planned.push({ kind: 'suite.split', target: delta.target, into });
    origin = [...origin.slice(0, delta.target), ...delta.into.map(() => undefined), ...origin.slice(delta.target + 1)];
  }
  let amended: Plan;
  try {
    amended = applyPlanDeltas(plan, planned);
  } catch (error) {
    if (!(error instanceof PlanParseError)) throw error;
    return invalid(error.message);
  }
  const subtasks = amended.subtasks.map((subtask, index): SubtaskSpec => {
    const at = origin[index];
    const routedFrom = at === undefined ? undefined : plan.subtasks[at]?.routedFrom;
    return routedFrom ? { ...subtask, routedFrom } : subtask;
  });
  return { deltas, plan: { ...plan, ...amended, subtasks } };
}

/**
 * The mechanical half of the review, at zero tokens: the host checks that every
 * classified requirement has executable bytes, that no suite uses an API the
 * runner's integrity guard refuses (`parentSuiteCheck.ts`), and that
 * independent work fans out. A resumed root re-runs it over a recorded approval instead of asking a
 * model again.
 */
export function enforceParsedDelegationReview(plan: Plan, review: DelegationReview, allowDiscovery: boolean): NegativeVerdict | undefined {
  const indices = review.subtasks.map(s => s.index);
  if (indices.length !== plan.subtasks.length || new Set(indices).size !== indices.length ||
      indices.some(i => i >= plan.subtasks.length)) {
    return delegationRefusal('Delegation review must classify every subtask exactly once using its zero-based index.', 'reviewer');
  }
  // Every plan finding in ONE refusal, so the planner hears them in one round (2026-10-17); fan-out stays its own kind.
  const findings: string[] = [];
  if (plan.replanAfter && (!allowDiscovery || plan.subtasks.some(s => s.outputs?.length) ||
      review.subtasks.some(s => s.kind !== 'inspection') || review.integration.kind !== 'inspection')) {
    findings.push('replanAfter is allowed once at L3 for a read-only inspection-only plan. Remove implementation and writes from discovery.');
  }
  const missing = review.subtasks.filter(s => s.kind === 'vitest' && !plan.subtasks[s.index]?.acceptanceTests);
  const depends = (a: number, b: number): boolean =>
    (plan.subtasks[a]?.dependsOn ?? []).some(i => i < a && (i === b || depends(i, b)));
  // "When branches implement interacting application modules": one tested
  // branch interacts with no other, and its own suite is the integration
  // (run 760fef4c's c3379f8c was refused for want of a second copy of it).
  // A join subtask's suite is the integration too (run 40c20c5d).
  const tested = review.subtasks.filter(s => s.kind === 'vitest').map(s => s.index);
  const integration = review.integration.kind === 'vitest' && !plan.acceptanceTests && tested.length >= 2 &&
    !joinCarriesIntegration(plan, tested, depends);
  if (missing.length || integration) {
    findings.push(`Missing parent-owned acceptanceTests on ${[
      ...missing.map(s => `subtask ${s.index} (${s.reason})`),
      ...(integration ? ['plan integration (plan-level, or on a join subtask that is the plan\'s last, declares outputs and comes after every other subtask)'] : []),
    ].join('; ')}. Supply executable suites before implementation, or request a genuine inspection-only discovery plan at L3.`);
  }
  // A source that does not parse, APIs the runner's integrity guard refuses, and
  // the read-run copies its snapshot leaves out: the parent's choice, refused
  // before a child is blamed for it, also when a resumed run reuses an approval.
  for (const { label, source } of planSuites(plan)) {
    const parse = source ? parentSuiteParseRefusal(label, source) : undefined;
    if (parse) findings.push(parse);
    const refusal = source ? parentSuiteRefusal(label, source) : undefined;
    if (refusal) findings.push(refusal);
    const copies = source ? readRunCopiesRefusal(label, source) : undefined;
    if (copies) findings.push(copies);
  }
  const parallelPair = plan.aggregation.mode !== 'sequential' && plan.subtasks.some((_, a) =>
    plan.subtasks.some((_, b) => a < b && !depends(a, b) && !depends(b, a)));
  if (findings.length) return delegationRefusal(findings.join(' '), 'plan');
  // Kept apart: on a resumed run a fan-out refusal ends the plan, and a plan
  // refusal asking to fan out would contradict its sequential precheck.
  if (review.independentWork && !parallelPair) {
    return delegationRefusal(`Independent work must have parallel child branches with real dependencies: ${review.parallelReason}`, 'fan-out');
  }
  return undefined;
}

/**
 * Whether the plan's join subtask carries its integration suite
 * (`PARENT_TEST_INTEGRATION_PLACEMENT`). The join is the plan's SINK: every
 * other subtask comes before it, so it is the last index (`dependsOn` names
 * earlier indices only). Its suite runs when it returns (`superviseLoop`) on
 * the workspace a plan-level suite would read after an aggregation that
 * writes nothing. Every subtask, outputs declared or not: one without them is
 * read-only (photographed and restored) only in a sequential plan of two
 * phases or more at the root or in a root cell's own plan, and anywhere else
 * — a parallel plan, a cell under a tissue — it can write beside or after the
 * join, where only a plan-level suite would see it (review 2026-10-25). The
 * join declares outputs: as a sequential root phase without them it would be
 * read-only, and the fixes its suite asks for would be put back. Two tested
 * branches at least come before it: a chain's last tested branch keeps its
 * own contract. Order is `dependsOn` in a parallel plan and the index in a
 * sequential one, the order dispatch runs them in; a resumed root's plan is
 * sequential, so the suffix it re-enforces is read by index.
 */
function joinCarriesIntegration(plan: Plan, tested: readonly number[], depends: (a: number, b: number) => boolean): boolean {
  const last = plan.subtasks.length - 1;
  const join = plan.subtasks[last];
  if (!join?.acceptanceTests || !join.outputs?.length) return false;
  if (tested.filter(i => i !== last).length < 2) return false;
  return plan.aggregation.mode === 'sequential' || plan.subtasks.every((_, i) => i === last || depends(last, i));
}

/**
 * Every suite a plan carries, labelled as refusals name them. `from` skips
 * completed phases and numbers the rest from zero, as the review and the
 * replanning planner both see them.
 */
export function planSuites(plan: Plan, from = 0): Array<{ label: string; source: string | undefined; cwd: string }> {
  return [
    ...plan.subtasks.slice(from).map((subtask, index) => ({ label: `on subtask ${index}`, source: subtask.acceptanceTests?.source,
      cwd: subtask.acceptanceTests?.cwd ?? '.' })),
    { label: 'for the plan integration', source: plan.acceptanceTests?.source, cwd: plan.acceptanceTests?.cwd ?? '.' },
  ];
}

/** What of a task the root review judged; one helper so the fresh and resumed sides cannot drift. */
export function delegationReviewTaskKey(task: Task): unknown[] {
  return [task.inputs ?? null, task.description, task.criteria ?? null, task.constraints ?? null];
}

/**
 * Binds a recorded root approval to everything that decided it: the review
 * contract and system prompt, the reviewing model, the reviewed slice of the
 * exact plan, the task, and the root actor's identity. A change to any of
 * them makes a resumed run review again.
 */
export function approvalDigest(args: {
  plan: Plan; from: number; task: Task; actor: { name: string; atomId?: string; version: number | null }; model: string;
}): string {
  // The plan as a checkpoint restores it: JSON, then the plan schema. The live
  // plan carries host-only keys and key orders that a restored one does not.
  const plan: unknown = planSchema.parse(JSON.parse(JSON.stringify(args.plan)));
  const task = JSON.parse(JSON.stringify(delegationReviewTaskKey(args.task))) as unknown[];
  return sha256(JSON.stringify([
    delegationReviewRequest(reviewRepairEnabled()), sha256(VALIDATION_SYSTEM_PROMPT), args.model, args.from, plan,
    ...task, { name: args.actor.name, atomId: args.actor.atomId ?? null, version: args.actor.version },
  ]));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
