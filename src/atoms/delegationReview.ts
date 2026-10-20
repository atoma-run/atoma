import { createHash } from 'node:crypto';
import type { DelegationRefusalKind, NegativeVerdict, Plan, Task } from '../core/types.js';
import { PARENT_TEST_BLOCKING_DEFECTS, PARENT_TEST_RUNNER_SCOPE, PARENT_TEST_SUFFICIENCY, delegationReviewEnvelopeSchema, type DelegationReview } from '../contracts/parentTests.js';
import { parseWith, planSchema } from './json.js';
import { parentSuiteRefusal, readRunCopiesRefusal } from './parentSuiteCheck.js';
import { VALIDATION_SYSTEM_PROMPT } from './verdict.js';

export type { DelegationRefusalKind } from '../core/types.js';

/** The review request's first line; the calibration's historical reader anchors on it. */
export const DELEGATION_REVIEW_HEADER = '== REQUIRED DELEGATION CONTRACT REVIEW ==';

/**
 * The review's half of the browser route (run 7a7af324). The boundary says
 * what a suite cannot run; this says what the review does about it, so a
 * refusal names the route the runtime checks instead of a suite that fails.
 */
const BROWSER_PROOF_REVIEW = 'Review every suite against that boundary: a suite that needs a browser, a DOM or a spawned process cannot run here, so reject it, and never ask a suite for one. Never reject a plan because browser-only behaviour is proven by its browser subtask and the obligation that subtask carries instead of a suite. A subtask whose only proof is browser-only behaviour is other; one that also implements code is vitest for that code. When the task needs browser-only behaviour that no subtask routed to a child holding validate_html proves, ask for that subtask, with the obligation when real user input is involved, never for a suite; a task without a page needs neither.';

export const DELEGATION_REVIEW_REQUEST = `${DELEGATION_REVIEW_HEADER}
Review the entire current task and this plan before dispatch. This is mandatory even for trusted types.
An approval MUST additionally contain delegationReview:
{"subtasks":[{"index":0,"kind":"vitest|inspection|other","reason":"scope-specific justification"}],"integration":{"kind":"vitest|inspection|other","reason":"justification"},"independentWork":true,"parallelReason":"actual dependencies or independent work"}.
Classify EVERY subtask exactly once using zero-based indices. Classify testable TypeScript application implementation as vitest, even when its tests or interfaces were omitted. Unknown interfaces do not turn implementation into inspection. A task that includes implementation cannot be classified inspection. Other is for non-code deliverables or behavior requiring separate browser/CLI probes; explain the concrete proof. Do not exempt importable application behavior merely because it also has a UI or CLI.
${PARENT_TEST_RUNNER_SCOPE}
${BROWSER_PROOF_REVIEW}
Require plan-level Vitest integration tests when branches implement interacting application modules. Review all suite sources for real application imports, useful assertions, negative cases, faithful interfaces, and no replacement of the subject under test. Trivial assertions or placeholders must be rejected even when a suite exists.
${PARENT_TEST_SUFFICIENCY}
${PARENT_TEST_BLOCKING_DEFECTS} Name any other gap in a suite's coverage in your reasoning; it does not refuse the plan.
Set independentWork true whenever useful independent work exists in the assigned scope, including work hidden in one broad branch. Reject grouping independent L2 work into one L2 or inventing dependencies to serialize it. Genuine coupling permits sequential work; do not invent branches for a small inseparable change.
An L3 replanAfter:true plan is discovery ONLY: no writes, no implementation deferred to another subtask. The host will replan once after its observations. A promise in prose to obtain review or replan later has NO runtime effect. Reject such a promise when executable contracts are missing. L2 cannot use replanAfter.
An inspection or reproduction subtask must ask for observed state and defects, not require the repaired state while forbidding changes. Reject that contradiction before dispatch and ask for observation now, correction in the implementation phase. Context-only criteria cannot become binding through a child description. An inspection still needs its requested evidence; its approval does not satisfy the final criteria.
An approval without this complete classification is not executable. For rejection use the ordinary negative Verdict with actionable reasoning; no classification is required.`;

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
  return `PREVIOUS REFUSALS OF THIS DELEGATION, oldest first; the planner received each with its requests:\n${listed}\nJudge first whether this plan fixes each of them. One that still stands refuses again only when it is a blocking suite defect above or breaks another rule of this review. Any other gap, including one no earlier refusal named, goes in your reasoning and does not refuse the plan.`;
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

export function delegationRefusal(reason: string, kind: DelegationRefusalKind): NegativeVerdict {
  return { approved: false, reasoning: reason, scope: 'ephemeral', modifications: { additionalContext: reason }, delegationRefusal: kind };
}

/** The classification an approval carries, or a `reviewer` refusal when it carries none. */
export function parseDelegationReview(response: string): DelegationReview | NegativeVerdict {
  try { return parseWith(delegationReviewEnvelopeSchema, response).delegationReview; }
  catch { return delegationRefusal('Delegation review is incomplete: classify every subtask, integration and parallelism before execution.', 'reviewer'); }
}

/** Semantic classification is fallible; missing bytes/indices cannot be waived by approved:true. */
export function enforceDelegationReview(plan: Plan, response: string, allowDiscovery: boolean): NegativeVerdict | undefined {
  const review = parseDelegationReview(response);
  return 'approved' in review ? review : enforceParsedDelegationReview(plan, review, allowDiscovery);
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
  // "When branches implement interacting application modules": one tested
  // branch interacts with no other, and its own suite is the integration
  // (run 760fef4c's c3379f8c was refused for want of a second copy of it).
  const integration = review.integration.kind === 'vitest' && !plan.acceptanceTests &&
    review.subtasks.filter(s => s.kind === 'vitest').length >= 2;
  if (missing.length || integration) {
    findings.push(`Missing parent-owned acceptanceTests on ${[
      ...missing.map(s => `subtask ${s.index} (${s.reason})`),
      ...(integration ? ['plan integration'] : []),
    ].join('; ')}. Supply executable suites before implementation, or request a genuine inspection-only discovery plan at L3.`);
  }
  // APIs the runner's integrity guard refuses, and the read-run copies its
  // snapshot leaves out: the parent's choice, refused before a child is blamed for it.
  for (const { label, source } of planSuites(plan)) {
    const refusal = source ? parentSuiteRefusal(label, source) : undefined;
    if (refusal) findings.push(refusal);
    const copies = source ? readRunCopiesRefusal(label, source) : undefined;
    if (copies) findings.push(copies);
  }
  const depends = (a: number, b: number): boolean =>
    (plan.subtasks[a]?.dependsOn ?? []).some(i => i < a && (i === b || depends(i, b)));
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
    DELEGATION_REVIEW_REQUEST, sha256(VALIDATION_SYSTEM_PROMPT), args.model, args.from, plan,
    ...task, { name: args.actor.name, atomId: args.actor.atomId ?? null, version: args.actor.version },
  ]));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
