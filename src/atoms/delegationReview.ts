import { createHash } from 'node:crypto';
import type { DelegationRefusalKind, NegativeVerdict, Plan, Task } from '../core/types.js';
import { delegationReviewEnvelopeSchema, type DelegationReview } from '../contracts/parentTests.js';
import { parseWith, planSchema } from './json.js';
import { VALIDATION_SYSTEM_PROMPT } from './verdict.js';

export type { DelegationRefusalKind } from '../core/types.js';

export const DELEGATION_REVIEW_REQUEST = `== REQUIRED DELEGATION CONTRACT REVIEW ==
Review the entire current task and this plan before dispatch. This is mandatory even for trusted types.
An approval MUST additionally contain delegationReview:
{"subtasks":[{"index":0,"kind":"vitest|inspection|other","reason":"scope-specific justification"}],"integration":{"kind":"vitest|inspection|other","reason":"justification"},"independentWork":true,"parallelReason":"actual dependencies or independent work"}.
Classify EVERY subtask exactly once using zero-based indices. Classify testable TypeScript application implementation as vitest, even when its tests or interfaces were omitted. Unknown interfaces do not turn implementation into inspection. A task that includes implementation cannot be classified inspection. Other is for non-code deliverables or behavior requiring separate browser/CLI probes; explain the concrete proof. Do not exempt importable application behavior merely because it also has a UI or CLI.
Require plan-level Vitest integration tests when branches implement interacting application modules. Review all suite sources for real application imports, useful assertions, negative cases, faithful interfaces, and no replacement of the subject under test. Trivial assertions or placeholders must be rejected even when a suite exists.
Set independentWork true whenever useful independent work exists in the assigned scope, including work hidden in one broad branch. Reject grouping independent L2 work into one L2 or inventing dependencies to serialize it. Genuine coupling permits sequential work; do not invent branches for a small inseparable change.
An L3 replanAfter:true plan is discovery ONLY: no writes, no implementation deferred to another subtask. The host will replan once after its observations. A promise in prose to obtain review or replan later has NO runtime effect. Reject such a promise when executable contracts are missing. L2 cannot use replanAfter.
An approval without this complete classification is not executable. For rejection use the ordinary negative Verdict with actionable reasoning; no classification is required.`;

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
 * classified requirement has executable bytes and that independent work fans
 * out. A resumed root re-runs it over a recorded approval instead of asking a
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
