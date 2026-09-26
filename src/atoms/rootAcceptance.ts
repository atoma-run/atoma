import { createHash } from 'node:crypto';
import { baseExecutorOf } from '../core/attestation.js';
import type { Atom } from '../core/atom.js';
import type { CriterionJudgement, Result, RunContext, Task } from '../core/types.js';
import { modelForTier } from '../core/models.js';
import { establishesDomInteraction } from '../contracts/attestation.js';
import type { AcceptanceInfo, PhaseCoverageRecord, ProofFloor } from '../contracts/depthRouting.js';
import { buildResultGateEnv, renderResultGateFindings, runResultGates } from './resultGates.js';
import { checkGroundTruth } from './groundTruth.js';
import { llmVerdict } from './verdict.js';
import { LANDED_RESULT_GUIDANCE } from './prompts.js';
import {
  coverAcceptanceChecklist,
  renderChecklistCoverage,
  type AcceptanceChecklist,
  type ChecklistCoverage,
  type ChecklistSource,
} from '../contracts/acceptanceChecklist.js';

/**
 * Cover the checklist from the attempt's HTTP observations, taken BEFORE the
 * acceptor's own ground-truth probe runs: that probe fetches through the same
 * attesting executor, and the root must not cover a behaviour by looking.
 */
function checklistCoverage(ctx: RunContext, checklist: AcceptanceChecklist): ChecklistCoverage[] {
  const observations = (ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? []).flatMap((record) =>
    record.observation.kind === 'execution' && record.observation.http
      ? [{ eventId: record.eventId, http: record.observation.http }]
      : []);
  return coverAcceptanceChecklist(checklist, observations);
}

/**
 * The sizes THIS attempt's browser observations were laid out at, per
 * document: a mechanical fact beside the criteria, never a verdict. Each
 * observation line already carries its viewport; one line naming them all is
 * what lets the acceptor set "at 375 and 1280 pixels wide" against
 * "800x600" — production run 134d916a (2026-09-26) was accepted on overflow
 * checks that were only ever laid out at 800x600. No criterion text is
 * parsed: the acceptor compares.
 */
export function observedLayoutsBlock(ctx: RunContext): string {
  const layouts = new Map<string, Set<string>>();
  for (const record of ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? []) {
    if (record.observation.kind !== 'browser') continue;
    const document = record.observation.document?.path ?? '(page not bound to a workspace file)';
    const size = record.observation.viewport ? `${record.observation.viewport.width}x${record.observation.viewport.height}` : 'an unrecorded size';
    layouts.set(document, (layouts.get(document) ?? new Set()).add(size));
  }
  if (layouts.size === 0) return '';
  return 'BROWSER LAYOUTS OBSERVED IN THIS ATTEMPT (mechanical, from the attested observations): ' +
    [...layouts].map(([document, sizes]) => `${document} at ${[...sizes].join(', ')}`).join('; ') +
    '. validate_html laid pages out at no other size in this attempt.';
}

/** Root proof is stricter than phase proof: no binding or unreadable bytes never cover. */
export async function rootProofCoverage(ctx: RunContext, floor: ProofFloor): Promise<AcceptanceInfo['floorCoverage']> {
  const records = ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? [];
  const reads = new Map<string, Promise<string | undefined>>();
  const digest = (path: string): Promise<string | undefined> => {
    if (!reads.has(path)) reads.set(path, (async () => {
      try {
        if (!ctx.tools?.has('read_file')) return undefined;
        const read: unknown = await baseExecutorOf(ctx.tools).execute('read_file', { path });
        const content = typeof read === 'string' ? read : read && typeof read === 'object' &&
          'content' in read && typeof read.content === 'string' ? read.content : undefined;
        return content === undefined ? undefined : createHash('sha256').update(content).digest('hex');
      } catch { return undefined; }
    })());
    return reads.get(path)!;
  };
  return Promise.all(floor.map(async ({ obligation, deliverable }) => {
    const current = await digest(deliverable);
    const matches = records.filter((record) => record.observation.kind === 'browser' && establishesDomInteraction(record) &&
      record.observation.document?.path === deliverable && current !== undefined &&
      record.observation.document.sha256 === current);
    return { kind: obligation, deliverable, status: matches.length ? 'covered' : 'uncovered',
      observationRefs: matches.map((record) => record.eventId) };
  }));
}

/**
 * ONE JUDGEMENT PER CRITERION. The acceptor used to answer one prose verdict
 * for a whole list, so a person who approved seven criteria could not tell
 * which the delivery was judged to meet (2026-09-26). The judgements ride
 * the checklist items; they are the model's word beside the mechanical
 * status, never in place of it.
 */
export const CRITERIA_JUDGEMENT_REQUEST =
  'ALSO emit "criteria" in your verdict JSON: one entry per item above, ' +
  '[{"id": "c1", "met": true|false, "reason": "<at most 15 words>"}], judged on the evidence.';

function judgeCoverage(
  coverage: readonly ChecklistCoverage[],
  judgements: readonly CriterionJudgement[] | undefined
): ChecklistCoverage[] {
  const byId = new Map((judgements ?? []).map((judgement) => [judgement.id, judgement]));
  return coverage.map((item) => {
    const judgement = byId.get(item.id);
    return judgement ? { ...item, judgement: { met: judgement.met, ...(judgement.reason ? { reason: judgement.reason.slice(0, 400) } : {}) } } : item;
  });
}

/**
 * An approval that judges one of the USER's criteria unmet contradicts
 * itself; it is the acceptor's own statement, so the delivery is refused
 * with that criterion as the reason. A drafted item never makes a run fail
 * this way: the drafted list "adds nothing the goal did not ask for".
 */
function consistentWithCriteria(
  verdict: { readonly approved: boolean; readonly reasoning?: string },
  judged: readonly ChecklistCoverage[],
  source: ChecklistSource,
  landed: boolean
): { readonly approved: boolean; readonly reasoning?: string } {
  // A LANDED result stopped before some phases ran: their criteria are unmet
  // by construction, and the landing contract keeps that work as a partial.
  // The judgements are recorded; they never turn a landing into a refusal.
  if (!verdict.approved || source !== 'user' || landed) return verdict;
  const unmet = judged.filter((item) => item.judgement?.met === false);
  if (unmet.length === 0) return verdict;
  return {
    approved: false,
    reasoning: `Approved criteria judged NOT met: ${unmet.map((item) => `${item.id} ${item.behaviour}${item.judgement?.reason ? ` (${item.judgement.reason})` : ''}`).join('; ')}` +
      (verdict.reasoning ? ` — the acceptor's own verdict read: ${verdict.reasoning}` : ''),
  };
}

/** A delivery verdict only: no registry, learning hook, or remediation lives here. */
export async function acceptRootResult(args: {
  actor: Atom; task: Task; result: Result; ctx: RunContext; floor: ProofFloor;
  phaseCoverage: readonly PhaseCoverageRecord[];
  checklist?: AcceptanceChecklist;
  /** A `user` list is the host-held approved one; its digest rides the acceptance record. */
  checklistOrigin?: { readonly source: ChecklistSource; readonly digest?: string };
}): Promise<AcceptanceInfo> {
  const { actor, task, result, ctx, floor } = args;
  const checklist = args.checklist ?? [];
  const source = args.checklistOrigin?.source ?? 'drafted';
  const coverage = checklistCoverage(ctx, checklist);
  const checklistBlock = renderChecklistCoverage(checklist, coverage,
    { landed: Boolean(result.unfinishedPhases?.length), source });
  const layoutsBlock = observedLayoutsBlock(ctx);
  const gates = await runResultGates(buildResultGateEnv({ task, result, ctx,
    childName: actor.name, childToolNames: actor.toolNames() }), ctx.mechanicalResultRejections, 'delegated');
  const probe = await checkGroundTruth({ ctx, subject: 'RESULT',
    payload: { output: result.output, summary: result.summary }, child: actor,
    ...(result.evidence ? { evidence: result.evidence } : {}) });
  const floorCoverage = await rootProofCoverage(ctx, floor);
  // Criteria the user approved are READ, whatever the floor says: a covered
  // floor with no finding used to approve mechanically past them.
  const userCriteria = source === 'user' && coverage.length > 0;
  const review = floor.length === 0 || gates.reviewFindings.length > 0 || probe.requiresReview ||
    floorCoverage.some((item) => item.status === 'uncovered') || userCriteria;
  const judgementsAsked = checklistBlock !== '';
  const raw = gates.rejection
    ? { approved: false, reasoning: gates.rejection.reasoning }
    : review ? await llmVerdict({
      ctx, model: modelForTier(1), supervisorName: 'run-root', supervisorTier: 3,
      subject: 'RESULT', child: actor, task,
      payload: { output: result.output, summary: result.summary, producedBy: result.producedBy },
      ...(result.evidence ? { evidence: result.evidence } : {}),
      groundTruthBlock: probe.block,
      mechanicalFindingsBlock: renderResultGateFindings(gates.reviewFindings),
      proofCoverageBlock: 'ROOT DELIVERY PROOF (no effect on phase credits):\n' + JSON.stringify(floorCoverage) +
        (checklistBlock ? `\n\n${checklistBlock}\n${CRITERIA_JUDGEMENT_REQUEST}` : '') + (layoutsBlock ? `\n\n${layoutsBlock}` : ''),
      // A landed run always reaches here through a validation call, because it
      // stopped before it could prove the floor. Saying what a landing IS costs
      // one block and decides whether the phases it did complete survive.
      ...(result.unfinishedPhases?.length ? { landingBlock: LANDED_RESULT_GUIDANCE } : {}),
    }) : { approved: true, reasoning: 'No mechanical finding requires review.' };
  const judged = judgementsAsked && 'criteria' in raw ? judgeCoverage(coverage, raw.criteria) : coverage;
  const verdict = consistentWithCriteria(raw, judged, source, Boolean(result.unfinishedPhases?.length));
  const produced = result.producedBy;
  return {
    attempt: ctx.attempt ?? 1, approved: verdict.approved, reasoning: verdict.reasoning ?? '',
    acceptor: { name: 'run-root', tier: 3, role: 'root-acceptor' },
    executor: { name: produced?.name ?? actor.name, tier: produced?.tier ?? actor.tier,
      viaFallback: produced?.viaFallback ?? false },
    gates: [...gates.reviewFindings, ...(gates.rejection ? [gates.rejection] : [])]
      .map((finding) => ({ id: finding.gateId, disposition: finding.disposition })),
    probe: { requiresReview: probe.requiresReview, contradiction: probe.contradiction },
    floorCoverage, phaseCoverage: [...args.phaseCoverage],
    ...(judged.length > 0 ? { checklist: judged, checklistSource: source,
      ...(args.checklistOrigin?.digest ? { checklistDigest: args.checklistOrigin.digest } : {}) } : {}),
    basis: review && !gates.rejection ? 'validation-call' : 'mechanical',
  };
}
