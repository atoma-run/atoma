import { createHash } from 'node:crypto';
import type { DelegationRefusalKind, NegativeVerdict, Plan, Task } from '../core/types.js';
import { delegationReviewEnvelopeSchema, type DelegationReview } from '../contracts/parentTests.js';
import { parseWith, planSchema } from './json.js';
import { parentSuiteRefusal } from './parentSuiteCheck.js';
import { VALIDATION_SYSTEM_PROMPT } from './verdict.js';

export type { DelegationRefusalKind } from '../core/types.js';

/** The review request's first line; the calibration's historical reader anchors on it. */
export const DELEGATION_REVIEW_HEADER = '== REQUIRED DELEGATION CONTRACT REVIEW ==';

export const DELEGATION_REVIEW_REQUEST = `${DELEGATION_REVIEW_HEADER}
Review the entire current task and this plan before dispatch. This is mandatory even for trusted types.
An approval MUST additionally contain delegationReview:
{"subtasks":[{"index":0,"kind":"vitest|inspection|other","reason":"scope-specific justification"}],"integration":{"kind":"vitest|inspection|other","reason":"justification"},"independentWork":true,"parallelReason":"actual dependencies or independent work"}.
Classify EVERY subtask exactly once using zero-based indices. Classify testable TypeScript application implementation as vitest, even when its tests or interfaces were omitted. Unknown interfaces do not turn implementation into inspection. A task that includes implementation cannot be classified inspection. Other is for non-code deliverables or behavior requiring separate browser/CLI probes; explain the concrete proof. Do not exempt importable application behavior merely because it also has a UI or CLI.
Require plan-level Vitest integration tests when branches implement interacting application modules. Review all suite sources for real application imports, useful assertions, negative cases, faithful interfaces, and no replacement of the subject under test. Trivial assertions or placeholders must be rejected even when a suite exists.
Set independentWork true whenever useful independent work exists in the assigned scope, including work hidden in one broad branch. Reject grouping independent L2 work into one L2 or inventing dependencies to serialize it. Genuine coupling permits sequential work; do not invent branches for a small inseparable change.
An L3 replanAfter:true plan is discovery ONLY: no writes, no implementation deferred to another subtask. The host will replan once after its observations. A promise in prose to obtain review or replan later has NO runtime effect. Reject such a promise when executable contracts are missing. L2 cannot use replanAfter.
An approval without this complete classification is not executable. For rejection use the ordinary negative Verdict with actionable reasoning; no classification is required.`;

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
    'run_shell and start_node_server, or omit its preferredChild.';
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
  if (plan.replanAfter && (!allowDiscovery || plan.subtasks.some(s => s.outputs?.length) ||
      review.subtasks.some(s => s.kind !== 'inspection') || review.integration.kind !== 'inspection')) {
    return delegationRefusal('replanAfter is allowed once at L3 for a read-only inspection-only plan. Remove implementation and writes from discovery.', 'plan');
  }
  const missing = review.subtasks.filter(s => s.kind === 'vitest' && !plan.subtasks[s.index]?.acceptanceTests);
  if (missing.length || (review.integration.kind === 'vitest' && !plan.acceptanceTests)) {
    return delegationRefusal(`Missing parent-owned acceptanceTests on ${[
      ...missing.map(s => `subtask ${s.index} (${s.reason})`),
      ...(review.integration.kind === 'vitest' && !plan.acceptanceTests ? ['plan integration'] : []),
    ].join('; ')}. Supply executable suites before implementation, or request a genuine inspection-only discovery plan at L3.`, 'plan');
  }
  // APIs the runner's integrity guard refuses: the parent's choice, refused before a child is blamed for it.
  const suites = [
    ...plan.subtasks.map((subtask, index) => ({ label: `on subtask ${index}`, suite: subtask.acceptanceTests })),
    { label: 'for the plan integration', suite: plan.acceptanceTests },
  ];
  for (const { label, suite } of suites) {
    const refusal = suite ? parentSuiteRefusal(label, suite.source) : undefined;
    if (refusal) return delegationRefusal(refusal, 'plan');
  }
  const depends = (a: number, b: number): boolean =>
    (plan.subtasks[a]?.dependsOn ?? []).some(i => i < a && (i === b || depends(i, b)));
  const parallelPair = plan.aggregation.mode !== 'sequential' && plan.subtasks.some((_, a) =>
    plan.subtasks.some((_, b) => a < b && !depends(a, b) && !depends(b, a)));
  if (review.independentWork && !parallelPair) {
    return delegationRefusal(`Independent work must have parallel child branches with real dependencies: ${review.parallelReason}`, 'fan-out');
  }
  return undefined;
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
