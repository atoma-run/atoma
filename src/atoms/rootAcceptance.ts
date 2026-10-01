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
  compareStartingWorkspace,
  renderStartingWorkspace,
  type StartingWorkspaceComparison,
} from '../contracts/startingWorkspace.js';
import {
  contradictedItems,
  inheritedChecksItems,
  recordedChecks,
  renderInheritedChecksBlock,
  type InheritedChecksReport,
  type InheritedJudgement,
  type ShownInheritedItem,
} from '../contracts/inheritedChecks.js';
import {
  renderRestorationsBlock,
  restorationDamaged,
  restorationMatters,
  staleObservations,
  type ReadOnlyRestoration,
} from '../contracts/readOnlyPhase.js';
import type { AttestationRecord } from '../contracts/attestation.js';
import type { Witness } from '../contracts/witness.js';
import {
  coverAcceptanceChecklist,
  renderChecklistCoverage,
  type AcceptanceChecklist,
  type ChecklistCoverage,
  type ChecklistSource,
  type LayoutObservation,
} from '../contracts/acceptanceChecklist.js';

/**
 * Cover the checklist from the attempt's HTTP and browser observations, taken
 * BEFORE the acceptor's own ground-truth probe runs: that probe fetches and
 * loads through the same attesting executor, and the root must not cover a
 * behaviour by looking. An observation recorded without a viewport was laid
 * out at 800x600, the only size there was before one was recorded.
 */
function checklistCoverage(ctx: RunContext, checklist: AcceptanceChecklist, stale: ReadonlySet<string>): ChecklistCoverage[] {
  const records = acceptedRecords(ctx, stale);
  const observations = records.flatMap((record) =>
    record.observation.kind === 'execution' && record.observation.http
      ? [{ eventId: record.eventId, http: record.observation.http }]
      : []);
  const layouts: LayoutObservation[] = records.flatMap((record) =>
    record.observation.kind === 'browser'
      ? [{ eventId: record.eventId, width: record.observation.viewport?.width ?? 800, ok: record.observation.ok }]
      : []);
  return coverAcceptanceChecklist(checklist, observations, layouts);
}

/**
 * The sizes THIS attempt's browser observations were laid out at, per
 * document: a mechanical fact beside the criteria, never a verdict. Each
 * observation line already carries its viewport; one line naming them all is
 * what lets the acceptor set "at 375 and 1280 pixels wide" against
 * "800x600" — production run 134d916a (2026-09-26) was accepted on overflow
 * checks that were only ever laid out at 800x600. It serves the goal's own
 * widths; a width a CRITERION names is also covered mechanically, item by
 * item (`namedLayoutWidths`), because the acceptor, shown this line, still
 * approved 800x600 twice (runs a939374e and 7389feee, 2026-09-27).
 */
export function observedLayoutsBlock(ctx: RunContext, stale: ReadonlySet<string> = new Set()): string {
  const layouts = new Map<string, Set<string>>();
  for (const record of acceptedRecords(ctx, stale)) {
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

/** What a seeded run did to the files it started from; undefined for an unseeded run or an unreadable workspace. */
function startingComparison(ctx: RunContext): StartingWorkspaceComparison | undefined {
  const seeded = ctx.startingWorkspace;
  if (!seeded) return undefined;
  try {
    return compareStartingWorkspace(seeded.start, seeded.now());
  } catch {
    return undefined;
  }
}

/**
 * The host's replay of the checks earlier runs recorded, on the page this run
 * delivers (docs/inherited-checks-replay-2026-10-01.md). Only a run that
 * changed a file has something to regress, and a result a gate already
 * refused is not replayed.
 */
async function inheritedReplay(
  ctx: RunContext,
  comparison: StartingWorkspaceComparison | undefined
): Promise<{ readonly report: InheritedChecksReport; readonly items: ShownInheritedItem[] } | undefined> {
  if (!ctx.inheritedChecks || !comparison || (comparison.changes.length === 0 && comparison.added.length === 0)) return undefined;
  const report = await ctx.inheritedChecks.compare({
    ...(ctx.deadlineAt !== undefined ? { deadlineAt: ctx.deadlineAt } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const rewritten = new Set(comparison.changes.filter((change) => change.status === 'rewritten').map((change) => change.path));
  return { report, items: inheritedChecksItems(report, rewritten) };
}

/** Every read-only execution of this attempt, whether it changed anything or not. */
function readOnlyRestorationsOf(ctx: RunContext): ReadOnlyRestoration[] {
  return (ctx.readOnlyPhases?.restorations() ?? []).filter((restoration) => restoration.attempt === (ctx.attempt ?? 1));
}

/** A workspace file's sha256 as the host reads it back now, memoised for one acceptance. */
type WorkspaceDigest = (path: string) => Promise<string | undefined>;

function workspaceDigests(ctx: RunContext): WorkspaceDigest {
  const reads = new Map<string, Promise<string | undefined>>();
  return (path) => {
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
}

/**
 * The attempt's attestations no acceptance may count. Everything a DAMAGED
 * read-only execution recorded (its own writes were put back: adversarial
 * review 2026-09-30, a verifier rewrote index.html, laid its page out at
 * 375 px, and the 375 px criterion read as passed). And a browser observation
 * any other restored execution made of a document whose bytes are no longer
 * the ones it saw. A verifier whose probes only made a server rewrite its
 * data file keeps the rest of its evidence (second review).
 */
async function staleRecordIds(ctx: RunContext, digest: WorkspaceDigest): Promise<ReadonlySet<string>> {
  const restorations = readOnlyRestorationsOf(ctx);
  const stale = new Set(staleObservations(restorations));
  const suspect = new Set(restorations.filter((restoration) => restorationMatters(restoration) && !restorationDamaged(restoration))
    .flatMap((restoration) => restoration.observations));
  if (suspect.size === 0) return stale;
  for (const record of ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? []) {
    if (!suspect.has(record.eventId) || record.observation.kind !== 'browser' || !record.observation.document) continue;
    if (await digest(record.observation.document.path) !== record.observation.document.sha256) stale.add(record.eventId);
  }
  return stale;
}

function acceptedRecords(ctx: RunContext, stale: ReadonlySet<string>): readonly AttestationRecord[] {
  const records = ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? [];
  return stale.size === 0 ? records : records.filter((record) => !stale.has(record.eventId));
}

/** A result's witnesses without the transport ones no acceptance may count. */
function acceptedEvidence(evidence: readonly Witness[] | undefined, stale: ReadonlySet<string>): readonly Witness[] | undefined {
  if (!evidence || stale.size === 0) return evidence;
  return evidence.filter((witness) => !(witness.source === 'transport-observed' && stale.has(witness.eventId)));
}

const NAMED_PATH = /(?<![\w./-])([\w-]{2,}(?:\/[\w.-]+)*\.(?:md|markdown|txt|html?|css|m?js|cjs|ts|json|csv|py|sh|ya?ml))(?![\w/-])/gi;
const CRITERIA_FILES_MAX = 4;
const CRITERIA_FILE_HEAD = 1200;
const CRITERIA_FILE_MATCHED_LINES = 15;
const CRITERIA_TOKEN = /[a-z][a-z0-9_-]{3,}/g;
const COMMON_WORDS = new Set(['with', 'that', 'this', 'every', 'each', 'from', 'into', 'have', 'shows', 'show', 'must',
  'documents', 'document', 'explains', 'lists', 'links', 'file', 'files', 'example', 'examples', 'readme']);

/**
 * What of a named file reaches the acceptor: its head, and past it the lines
 * holding a word of the criteria that name it ("curl", "route", "exit"), so a
 * criterion about a long README is not judged on its first screen only.
 */
function namedFileExcerpt(content: string, words: ReadonlySet<string>): string {
  const head = content.slice(0, CRITERIA_FILE_HEAD);
  if (content.length <= CRITERIA_FILE_HEAD) return JSON.stringify(head);
  const later = content.slice(CRITERIA_FILE_HEAD).split(/\r?\n/)
    .filter((line) => [...line.toLowerCase().matchAll(CRITERIA_TOKEN)].some((match) => words.has(match[0])))
    .slice(0, CRITERIA_FILE_MATCHED_LINES).map((line) => line.slice(0, 200));
  return `${JSON.stringify(head)} …(cut at ${CRITERIA_FILE_HEAD} of ${content.length} chars)` +
    (later.length > 0 ? `\n    later lines naming the criteria's words: ${JSON.stringify(later)}` : '');
}

/**
 * The files the CRITERIA name, read back by the host, so a criterion about a
 * document is judged on the document. Production run dc45c95b (2026-09-27):
 * "README documents every route with a curl example" was judged met on "README
 * exists", because the read-back only reads what the result names and it said
 * "README documentation". A name is a workspace path the text spells
 * ("docs/ERRORS.md") or a root Markdown file's stem ("README", "CHANGELOG").
 * They are read even when the ground-truth block lists them, since that shows
 * a 400-character head; a name that resolves to no file says nothing, and a
 * path leaving the workspace root is never read.
 */
async function criteriaFilesBlock(ctx: RunContext, checklist: AcceptanceChecklist): Promise<string> {
  if (checklist.length === 0 || !ctx.tools?.has('read_file')) return '';
  const tools = baseExecutorOf(ctx.tools);
  const text = checklist.map((item) => item.behaviour).join('\n');
  const wanted: string[] = [...text.matchAll(NAMED_PATH)].map((match) => match[1]!);
  if (tools.has('list_files')) {
    try {
      const listed = (await tools.execute('list_files', { path: '.' })) as { entries?: Array<{ name?: string; kind?: string }> } | null;
      for (const entry of listed?.entries ?? []) {
        const name = entry.name ?? '';
        const stem = name.replace(/\.(?:md|markdown|txt)$/i, '');
        if (entry.kind !== 'dir' && stem !== name && stem.length >= 4 &&
          new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) wanted.push(name);
      }
    } catch { /* a listing is a bonus */ }
  }
  const lines: string[] = [];
  for (const path of [...new Set(wanted)]) {
    if (lines.length >= CRITERIA_FILES_MAX || ctx.signal?.aborted) break;
    if (path.split('/').includes('..')) continue;
    const stem = path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();
    const naming = checklist.filter((item) => item.behaviour.toLowerCase().includes(stem)).map((item) => item.behaviour.toLowerCase());
    const words = new Set(naming.flatMap((text) => [...text.matchAll(CRITERIA_TOKEN)].map((match) => match[0]))
      .filter((word) => !COMMON_WORDS.has(word) && word !== stem));
    try {
      const read: unknown = await tools.execute('read_file', { path });
      const content = typeof read === 'string' ? read : read && typeof read === 'object' &&
        'content' in read && typeof read.content === 'string' ? read.content : undefined;
      if (content === undefined) continue;
      lines.push(`- ${path} (${content.length} chars): ${namedFileExcerpt(content, words)}`);
    } catch {
      // Silent, never refuting: "saves quote.txt" names a download, not a workspace file.
    }
  }
  return lines.length > 0
    ? ['FILES THE CRITERIA NAME, read back by the host (mechanical). An excerpt cut short is SILENT about what it',
      'does not show: never judge a criterion unmet on a part of the file you were not shown.', ...lines].join('\n')
    : '';
}

/** Root proof is stricter than phase proof: no binding or unreadable bytes never cover. */
export async function rootProofCoverage(
  ctx: RunContext,
  floor: ProofFloor,
  known?: { readonly digest: WorkspaceDigest; readonly stale: ReadonlySet<string> }
): Promise<AcceptanceInfo['floorCoverage']> {
  const digest = known?.digest ?? workspaceDigests(ctx);
  const records = acceptedRecords(ctx, known?.stale ?? await staleRecordIds(ctx, digest));
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

/**
 * An approval that judges a listed inherited check `asked: false` says the
 * delivery changed, unasked, a behaviour an earlier run required: the
 * acceptor's own statement refuses it, as `consistentWithCriteria` does for
 * an unmet criterion. A landed result keeps its landing.
 */
function consistentWithInherited(
  verdict: { readonly approved: boolean; readonly reasoning?: string },
  items: readonly ShownInheritedItem[],
  judgements: readonly InheritedJudgement[] | undefined,
  landed: boolean
): { readonly approved: boolean; readonly reasoning?: string } {
  if (!verdict.approved || landed) return verdict;
  const contradicted = contradictedItems(items, judgements);
  if (contradicted.length === 0) return verdict;
  return {
    approved: false,
    reasoning: `Inherited checks the acceptor judged changed without the task asking: ${contradicted.map((item) => `${item.id} ${item.summary}`).join('; ')}` +
      (verdict.reasoning ? ` — the acceptor's own verdict read: ${verdict.reasoning}` : ''),
  };
}

/**
 * What the trace keeps of one acceptance's replay, the run-start one
 * included: a run that kept no check says why, so "0 kept" never reads as
 * "every check stale" when the server, the cap or the worker image was the
 * reason (review 2026-10-01).
 */
function inheritedSummary(
  report: InheritedChecksReport,
  items: readonly ShownInheritedItem[],
  judgements: readonly InheritedJudgement[] | undefined
): NonNullable<AcceptanceInfo['inheritedChecks']> {
  const byId = new Map((judgements ?? []).map((judgement) => [judgement.id, judgement]));
  const { baseline } = report;
  return {
    selected: baseline.selected, considered: baseline.considered, kept: baseline.kept, baselineCannotRun: baseline.cannotRun,
    ...deadCounts(baseline),
    ...(baseline.stopped ? { baselineStopped: baseline.stopped } : {}),
    ...(baseline.note ? { baselineNote: baseline.note.slice(0, 240) } : {}),
    replayed: report.replayed, stillPassing: report.stillPassing, flaky: report.flaky,
    notReplayed: report.notReplayed, listed: report.listed.length,
    ...(report.stopped ? { stopped: report.stopped } : {}),
    ...(report.newPageError ? { newPageError: report.newPageError.slice(0, 240) } : {}),
    items: items.map((item) => {
      const judgement = byId.get(item.id);
      return {
        id: item.id, file: item.file, summary: item.summary.slice(0, 600), checks: recordedChecks(item),
        ...(judgement ? { asked: judgement.asked, ...(judgement.reason ? { reason: judgement.reason.slice(0, 400) } : {}) } : {}),
      };
    }),
  };
}

function deadCounts(baseline: { readonly markedDead?: number; readonly pruned?: number; readonly revived?: number }): Record<string, number> {
  return {
    ...(baseline.markedDead ? { markedDead: baseline.markedDead } : {}),
    ...(baseline.pruned ? { pruned: baseline.pruned } : {}),
    ...(baseline.revived ? { revived: baseline.revived } : {}),
  };
}

/** The record of an acceptance that compared nothing: the run-start replay, and why. */
async function baselineOnly(
  runtime: NonNullable<RunContext['inheritedChecks']>,
  notCompared: 'unchanged' | 'refused' | 'unreadable'
): Promise<NonNullable<AcceptanceInfo['inheritedChecks']>> {
  const baseline = await runtime.baseline();
  return {
    selected: baseline.selected, considered: baseline.considered, kept: baseline.kept, baselineCannotRun: baseline.cannotRun,
    ...deadCounts(baseline),
    ...(baseline.stopped ? { baselineStopped: baseline.stopped } : {}),
    ...(baseline.note ? { baselineNote: baseline.note.slice(0, 240) } : {}),
    replayed: 0, stillPassing: 0, flaky: 0, notReplayed: baseline.kept, listed: 0, notCompared, items: [],
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
  const digest = workspaceDigests(ctx);
  const stale = await staleRecordIds(ctx, digest);
  const coverage = checklistCoverage(ctx, checklist, stale);
  const checklistBlock = renderChecklistCoverage(checklist, coverage,
    { landed: Boolean(result.unfinishedPhases?.length), source });
  const layoutsBlock = observedLayoutsBlock(ctx, stale);
  const gates = await runResultGates(buildResultGateEnv({ task, result, ctx,
    childName: actor.name, childToolNames: actor.toolNames() }), ctx.mechanicalResultRejections, 'delegated');
  const evidence = acceptedEvidence(result.evidence, stale);
  const probe = await checkGroundTruth({ ctx, subject: 'RESULT',
    payload: { output: result.output, summary: result.summary }, child: actor,
    ...(evidence ? { evidence } : {}) });
  const floorCoverage = await rootProofCoverage(ctx, floor, { digest, stale });
  // Read once for the replay's trigger, and reused by the STARTING WORKSPACE
  // block: the acceptance replays serve files and write none (the start
  // replay's dead marks touch only the manifest, which no snapshot reads).
  const comparison = ctx.inheritedChecks && !gates.rejection ? startingComparison(ctx) : undefined;
  const inherited = await inheritedReplay(ctx, comparison);
  const inheritedItems = inherited?.items ?? [];

  // Criteria the user approved are READ, whatever the floor says: a covered
  // floor with no finding used to approve mechanically past them.
  const userCriteria = source === 'user' && coverage.length > 0;
  // A read-only phase cannot fix what it finds, and one that changed files
  // was put back with any fix it made: a floor an earlier phase covered
  // cannot say either, so any read-only phase of the attempt is read.
  const restorations = readOnlyRestorationsOf(ctx);
  const review = floor.length === 0 || gates.reviewFindings.length > 0 || probe.requiresReview ||
    floorCoverage.some((item) => item.status === 'uncovered') || userCriteria || restorations.length > 0 ||
    inheritedItems.length > 0;
  const judgementsAsked = checklistBlock !== '';
  // Read only for a validation call: nothing reads them on the mechanical path.
  // Named files only beside criteria the acceptor is shown (a drafted
  // review-only list renders nothing, so it names nothing either).
  const reviewing = review && !gates.rejection;
  const namedFilesBlock = reviewing && judgementsAsked ? await criteriaFilesBlock(ctx, checklist) : '';
  const startingBlock = reviewing ? renderStartingWorkspace(comparison ?? startingComparison(ctx)) : '';
  const restorationsBlock = reviewing ? renderRestorationsBlock(restorations) : '';
  const inheritedBlock = reviewing && inherited ? renderInheritedChecksBlock(inherited.report, inheritedItems) : '';
  const raw = gates.rejection
    ? { approved: false, reasoning: gates.rejection.reasoning }
    : review ? await llmVerdict({
      ctx, model: modelForTier(1), supervisorName: 'run-root', supervisorTier: 3,
      subject: 'RESULT', child: actor, task,
      payload: { output: result.output, summary: result.summary, producedBy: result.producedBy },
      ...(evidence ? { evidence } : {}),
      groundTruthBlock: probe.block,
      mechanicalFindingsBlock: renderResultGateFindings(gates.reviewFindings),
      proofCoverageBlock: 'ROOT DELIVERY PROOF (no effect on phase credits):\n' + JSON.stringify(floorCoverage) +
        (checklistBlock ? `\n\n${checklistBlock}\n${CRITERIA_JUDGEMENT_REQUEST}` : '') + (layoutsBlock ? `\n\n${layoutsBlock}` : '') +
        (namedFilesBlock ? `\n\n${namedFilesBlock}` : '') + (startingBlock ? `\n\n${startingBlock}` : '') +
        (restorationsBlock ? `\n\n${restorationsBlock}` : '') + (inheritedBlock ? `\n\n${inheritedBlock}` : ''),
      // A landed run always reaches here through a validation call, because it
      // stopped before it could prove the floor. Saying what a landing IS costs
      // one block and decides whether the phases it did complete survive.
      ...(result.unfinishedPhases?.length ? { landingBlock: LANDED_RESULT_GUIDANCE } : {}),
    }) : { approved: true, reasoning: 'No mechanical finding requires review.' };
  const judged = judgementsAsked && 'criteria' in raw ? judgeCoverage(coverage, raw.criteria) : coverage;
  const landed = Boolean(result.unfinishedPhases?.length);
  const inheritedJudgements = 'inherited' in raw ? raw.inherited : undefined;
  const verdict = consistentWithInherited(consistentWithCriteria(raw, judged, source, landed), inheritedItems, inheritedJudgements, landed);
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
    ...(inherited ? { inheritedChecks: inheritedSummary(inherited.report, inheritedItems, inheritedJudgements) }
      : ctx.inheritedChecks ? { inheritedChecks: await baselineOnly(ctx.inheritedChecks, gates.rejection ? 'refused' : comparison ? 'unchanged' : 'unreadable') }
        : {}),
    basis: review && !gates.rejection ? 'validation-call' : 'mechanical',
  };
}
