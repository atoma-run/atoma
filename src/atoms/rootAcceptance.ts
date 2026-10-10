import { createHash } from 'node:crypto';
import { baseExecutorOf } from '../core/attestation.js';
import type { Atom } from '../core/atom.js';
import type { CriterionJudgement, Result, RunContext, Task } from '../core/types.js';
import { modelForTier } from '../core/models.js';
import type { DeliveryKind } from '../contracts/taskExecution.js';
import { RUN_ACTORS } from '../contracts/runActors.js';
import { establishesDomInteraction, fileReadsNeedingReadback, renderBrowserInputs, renderObservation, supersededFileReads } from '../contracts/attestation.js';
import type { AcceptanceInfo, PhaseCoverageRecord, ProofFloor } from '../contracts/depthRouting.js';
import { buildResultGateEnv, renderResultGateFindings, runResultGates } from './resultGates.js';
import { checkGroundTruth } from './groundTruth.js';
import { criteriaFilesBlock, ROOT_CRITERIA_SOURCE_CHARS } from './fileEvidence.js';
import { llmVerdict, renderTransportEvidence } from './verdict.js';
import { reviewAcceptanceCriteria } from './criteriaReview.js';
import { textReviewReference } from './textReview.js';
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
  baselineEstablishedNothing,
  type InheritedChecksReport,
  type InheritedJudgement,
  type ShownInheritedItem,
  type EarlierListedItem,
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
import { deliveryRunsEntry, serverCodeDigest } from '../contracts/serverDigest.js';
import {
  coverAcceptanceChecklist,
  httpCheckMatches,
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
async function checklistCoverage(ctx: RunContext, checklist: AcceptanceChecklist, stale: ReadonlySet<string>): Promise<ChecklistCoverage[]> {
  const records = acceptedRecords(ctx, stale);
  const observations = records.flatMap((record) =>
    record.observation.kind === 'execution' && record.observation.http
      ? [{ eventId: record.eventId, http: record.observation.http }]
      : []);
  const layouts: LayoutObservation[] = records.flatMap((record) =>
    record.observation.kind === 'browser'
      ? [{ eventId: record.eventId, width: record.observation.viewport?.width ?? 800, ok: record.observation.ok }]
      : []);
  return withStandingHttpEvidence(ctx, checklist, coverAcceptanceChecklist(checklist, observations, layouts), observations);
}

/**
 * An HTTP item this attempt did not observe is COVERED BY STANDING EVIDENCE when
 * the host recorded, in the seed lineage, a matching request answered by a
 * server whose code digest (`serverCodeDigest`: entry and relative imports) is
 * the one the delivered workspace holds NOW (owner decision 2026-10-04).
 * Its refs read `standing:<run>/<event>`; the rendering says RECORDED EARLIER.
 */
async function withStandingHttpEvidence(
  ctx: RunContext,
  checklist: AcceptanceChecklist,
  coverage: ChecklistCoverage[],
  current: ReadonlyArray<{ readonly http: { readonly method: string; readonly path: string; readonly status: number } }>
): Promise<ChecklistCoverage[]> {
  const standing = ctx.standingHttpEvidence ?? [];
  if (standing.length === 0 || !coverage.some((entry) => entry.kind === 'http' && entry.status === 'uncovered')) return coverage;
  if (!ctx.tools?.has('read_file')) return coverage;
  const tools = baseExecutorOf(ctx.tools);
  const read = async (path: string): Promise<string | undefined> => {
    try {
      const raw: unknown = await tools.execute('read_file', { path });
      return typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'content' in raw && typeof raw.content === 'string'
        ? raw.content : undefined;
    } catch { return undefined; }
  };
  const packageJson = await read('package.json');
  const digests = new Map<string, Promise<string | undefined>>();
  const digestOf = (entry: string) => {
    if (!digests.has(entry)) digests.set(entry, serverCodeDigest(entry, read).catch(() => undefined));
    return digests.get(entry)!;
  };
  const out: ChecklistCoverage[] = [];
  for (let i = 0; i < coverage.length; i += 1) {
    const entry = coverage[i]!;
    const check = checklist[i]?.check;
    if (entry.kind !== 'http' || entry.status !== 'uncovered' || check?.kind !== 'http') { out.push(entry); continue; }
    // This attempt answered the same route with another status: what it saw
    // stands, and nothing recorded earlier covers it.
    if (current.some((o) => httpCheckMatches({ ...check, status: o.http.status }, o.http))) { out.push(entry); continue; }
    const refs: string[] = [];
    for (const observation of standing) {
      if (!httpCheckMatches(check, observation)) continue;
      // The server the delivery still runs, never a file left behind.
      if (!deliveryRunsEntry(packageJson, observation.entry)) continue;
      if ((await digestOf(observation.entry)) === observation.codeDigest) refs.push(`standing:${observation.runId}/${observation.eventId}/${observation.entry}`);
    }
    out.push(refs.length > 0 ? { ...entry, status: 'covered', observationRefs: refs } : entry);
  }
  return out;
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

/**
 * What the refused pass observed that still holds: its browser observations
 * of a document whose bytes are unchanged. An attestation lives as long as
 * the bytes it was made against (src/run/AGENTS.md), and `stale` marks only
 * restored executions, so a first-pass observation of a page the remediation
 * rewrote would otherwise read as current. Unbound or unreadable never
 * carries, and the refused pass's own declarations are not observations.
 */
async function carriedEvidence(
  previous: readonly Witness[] | undefined,
  current: readonly Witness[] | undefined,
  recordsById: ReadonlyMap<string, AttestationRecord>,
  digest: WorkspaceDigest
): Promise<Witness[]> {
  const already = new Set((current ?? []).flatMap((witness) =>
    witness.source === 'transport-observed' ? [witness.eventId] : []));
  const carried: Witness[] = [];
  for (const witness of previous ?? []) {
    if (witness.source !== 'transport-observed' || already.has(witness.eventId)) continue;
    const observation = recordsById.get(witness.eventId)?.observation;
    const document = observation?.kind === 'browser' ? observation.document : undefined;
    if (document && await digest(document.path) === document.sha256) carried.push(witness);
  }
  return carried;
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
  '[{"id": "c1", "met": true|false, "reason": "<concrete assertion or observation and evidence location; otherwise the missing proof>"}], judged on the evidence. ' +
  'Keep reasons concise. A passing test name or suite total is not evidence of its claimed coverage; judge every required part of a compound criterion.';

function judgeCoverage(
  coverage: readonly ChecklistCoverage[],
  judgements: readonly CriterionJudgement[] | undefined
): ChecklistCoverage[] {
  const byId = new Map<string, CriterionJudgement>();
  for (const judgement of judgements ?? []) {
    if (byId.get(judgement.id)?.met !== false) byId.set(judgement.id, judgement);
  }
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
  const missing = judged.filter((item) => !item.judgement);
  if (missing.length > 0) return { approved: false, reasoning: `Acceptance omitted judgements for user criteria: ${missing.map((item) => item.id).join(', ')}` };
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
 * An approval of a remediation whose replay did not re-check what the
 * previous acceptance listed says nothing about that listing: it is refused,
 * and the run lands with the reason, which the next run reads. A landed
 * result is refused too: it stays partial either way, and the refusal is
 * what carries the listing forward.
 */
function consistentWithRecheck(
  verdict: { readonly approved: boolean; readonly reasoning?: string },
  earlier: readonly EarlierListedItem[],
  unrechecked: string | undefined
): { readonly approved: boolean; readonly reasoning?: string } {
  if (!verdict.approved || unrechecked === undefined) return verdict;
  return {
    approved: false,
    reasoning: `This run's previous acceptance listed changes it did not judge asked for ` +
      `(${earlier.map((item) => `${item.id} ${item.summary.slice(0, 200)}`).join('; ')}), ` +
      `and ${unrechecked}: nothing shows they were undone` + (verdict.reasoning ? ` — the acceptor's own verdict read: ${verdict.reasoning}` : ''),
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

/**
 * What a complete pass whose root plan declared no delivery delivered, read
 * from what the attempt did (code review 2026-10-09, 1.2). The cell's
 * prefilter shortcut builds its root plan in code, so it never declares one,
 * and undeclared read as files: a short-depth text answer went to the
 * report-blind criteria review, which never sees it, and was refused. Only an
 * attempt with no attested element that can change the workspace delivered
 * text; a shell call may have written files, so it keeps the file review.
 */
export function observedDelivery(ctx: RunContext): DeliveryKind {
  const changing = ['write_file', 'edit_file', 'run_shell', 'record_probe'];
  return (ctx.attestations?.forAttempt(ctx.attempt ?? 1) ?? []).some((record) => changing.includes(record.tool))
    ? 'files' : 'text';
}

/** A delivery verdict only: no registry, learning hook, or remediation lives here. */
export async function acceptRootResult(args: {
  actor: Atom; task: Task; result: Result; ctx: RunContext; floor: ProofFloor;
  /** The current pass's recorded root plan, not a claim in the result body. */
  delivery?: DeliveryKind;
  phaseCoverage: readonly PhaseCoverageRecord[];
  checklist?: AcceptanceChecklist;
  /** A `user` list is the host-held approved one; its digest rides the acceptance record. */
  checklistOrigin?: { readonly source: ChecklistSource; readonly digest?: string };
  /** The acceptance that refused this attempt's previous pass, when this one closes a remediation. */
  previousAcceptance?: AcceptanceInfo;
  /** Evidence earned by the refused pass in this same workspace and attempt; see `carriedEvidence`. */
  previousEvidence?: readonly Witness[];
}): Promise<AcceptanceInfo> {
  const { actor, task, result, ctx, floor } = args;
  const checklist = args.checklist ?? [];
  const source = args.checklistOrigin?.source ?? 'drafted';
  const digest = workspaceDigests(ctx);
  const stale = await staleRecordIds(ctx, digest);
  const records = acceptedRecords(ctx, stale);
  const superseded = supersededFileReads(records);
  const recordsById = new Map(records.map((record) => [record.eventId, record]));
  const coverage = await checklistCoverage(ctx, checklist, stale);
  const checklistBlock = renderChecklistCoverage(checklist, coverage,
    { landed: Boolean(result.unfinishedPhases?.length), source });
  const layoutsBlock = observedLayoutsBlock(ctx, stale);
  const inputsBlock = renderBrowserInputs(records);
  const gates = await runResultGates(buildResultGateEnv({ task, result, ctx,
    childName: actor.name, childToolNames: actor.toolNames() }), ctx.mechanicalResultRejections, 'delegated');
  // A previous phase may have rendered its witness before a later phase
  // edited the same file. Re-render those reads from host-held records.
  const passEvidence = [...await carriedEvidence(args.previousEvidence, result.evidence, recordsById, digest),
    ...(result.evidence ?? [])];
  const evidence = acceptedEvidence(passEvidence.length > 0 ? passEvidence : undefined, stale)?.map((witness) => {
    if (witness.source !== 'transport-observed') return witness;
    const rewritten = superseded.get(witness.eventId);
    const record = recordsById.get(witness.eventId);
    return rewritten && record
      ? { ...witness, observed: renderObservation(record, { rewrittenBy: rewritten.rewrittenBy }) }
      : witness;
  });
  const probe = await checkGroundTruth({ ctx, subject: 'RESULT', refreshSupersededReads: false,
    payload: { output: result.output, summary: result.summary }, child: actor,
    ...(evidence ? { evidence } : {}) });
  const floorCoverage = await rootProofCoverage(ctx, floor, { digest, stale });
  // Read once for the replay's trigger, and reused by the STARTING WORKSPACE
  // block: the acceptance replays serve files and write none (the start
  // replay's dead marks touch only the manifest, which no snapshot reads).
  const comparison = ctx.inheritedChecks && !gates.rejection ? startingComparison(ctx) : undefined;
  const inherited = await inheritedReplay(ctx, comparison);
  const inheritedItems = inherited?.items ?? [];
  // A remediation answers what this run's previous acceptance listed. Unless
  // this replay re-checked every check the run kept, nothing shows the
  // listing is gone: run 5dff35b0's second replay stopped at the deadline
  // before its first check, and the page the first acceptance refused was
  // approved and published.
  // Held by the host (depth.ts passes the refused pass's own record), never
  // read back from task inputs; every item not judged asked for counts.
  const earlier: EarlierListedItem[] = (args.previousAcceptance?.inheritedChecks?.items ?? [])
    .filter((item) => item.asked !== true)
    .slice(0, 10)
    .map((item, index) => ({ id: `p${index + 1}`, summary: item.summary.slice(0, 600) }));
  const unrechecked = earlier.length === 0 || gates.rejection || !ctx.inheritedChecks ? undefined
    : inherited ? (inherited.report.notReplayed > 0
      ? `${inherited.report.notReplayed} of the ${inherited.report.baseline.kept} inherited checks were not replayed` +
        (inherited.report.stopped ? ` (stopped: ${inherited.report.stopped})` : '')
      : undefined)
      : comparison === undefined ? 'the starting workspace could not be read, so no inherited check was replayed' : undefined;

  // Criteria the user approved are READ, whatever the floor says: a covered
  // floor with no finding used to approve mechanically past them.
  const userCriteria = source === 'user' && coverage.length > 0;
  // A read-only phase cannot fix what it finds, and one that changed files
  // was put back with any fix it made: a floor an earlier phase covered
  // cannot say either, so any read-only phase of the attempt is read.
  const restorations = readOnlyRestorationsOf(ctx);
  const review = args.delivery === 'text' || floor.length === 0 || gates.reviewFindings.length > 0 || probe.requiresReview ||
    floorCoverage.some((item) => item.status === 'uncovered') || userCriteria || restorations.length > 0 ||
    inheritedItems.length > 0 || (inherited?.report.notReplayed ?? 0) > 0 ||
    (inherited !== undefined && baselineEstablishedNothing(inherited.report.baseline)) ||
    // Refused below whatever it says; the call keeps the acceptor's own reading in the record.
    unrechecked !== undefined;
  const judgementsAsked = checklistBlock !== '';
  // Read only for a validation call: nothing reads them on the mechanical path.
  // Named criteria files and incomplete reads share one bounded reader.
  // A criterion need not spell a filename for an incomplete read to refresh.
  const reviewing = review && !gates.rejection;
  const transport = renderTransportEvidence(evidence);
  const namedFilesBlock = reviewing ? await criteriaFilesBlock(ctx, judgementsAsked ? checklist : [],
    [...new Set(fileReadsNeedingReadback(records, transport.eventIds).values())], task.description, ROOT_CRITERIA_SOURCE_CHARS) : '';
  const startingBlock = reviewing ? renderStartingWorkspace(comparison ?? startingComparison(ctx)) : '';
  const restorationsBlock = reviewing ? renderRestorationsBlock(restorations) : '';
  const inheritedBlock = reviewing && inherited ? renderInheritedChecksBlock(inherited.report, inheritedItems, earlier) : '';
  const textReference = reviewing && args.delivery === 'text'
    ? await textReviewReference(ctx, task, checklist) : undefined;
  const raw = gates.rejection
    ? { approved: false, reasoning: gates.rejection.reasoning }
    : review ? await llmVerdict({
      ctx, model: modelForTier(args.delivery === 'text' ? 2 : 1), supervisorName: RUN_ACTORS.root.name, supervisorTier: RUN_ACTORS.root.tier,
      subject: 'RESULT', child: actor, task,
      ...(textReference ? { independentTextReference: textReference } : {}),
      payload: { output: result.output, summary: result.summary, producedBy: result.producedBy },
      ...(evidence ? { evidence } : {}),
      groundTruthBlock: probe.block,
      mechanicalFindingsBlock: renderResultGateFindings(gates.reviewFindings),
      proofCoverageBlock: 'ROOT DELIVERY PROOF (no effect on phase credits):\n' + JSON.stringify(floorCoverage) +
        (checklistBlock ? `\n\n${checklistBlock}\n${CRITERIA_JUDGEMENT_REQUEST}` : '') + (layoutsBlock ? `\n\n${layoutsBlock}` : '') + (inputsBlock ? `\n\n${inputsBlock}` : '') +
        (namedFilesBlock ? `\n\n${namedFilesBlock}` : '') + (startingBlock ? `\n\n${startingBlock}` : '') +
        (restorationsBlock ? `\n\n${restorationsBlock}` : '') + (inheritedBlock ? `\n\n${inheritedBlock}` : ''),
      // A landed run always reaches here through a validation call, because it
      // stopped before it could prove the floor. Saying what a landing IS costs
      // one block and decides whether the phases it did complete survive.
      ...(result.unfinishedPhases?.length ? { landingBlock: LANDED_RESULT_GUIDANCE } : {}),
    }) : { approved: true, reasoning: 'No mechanical finding requires review.' };
  const landed = Boolean(result.unfinishedPhases?.length);
  const initialJudged = judgementsAsked && 'criteria' in raw ? judgeCoverage(coverage, raw.criteria) : coverage;
  const initial = consistentWithCriteria(raw, initialJudged, source, landed);
  // A holistic approval cannot manufacture checklist coverage. Completed file
  // deliveries with user criteria must also pass focused, report-blind reviews.
  // Review refused candidates too: remediation needs the complete checklist
  // gaps on its first pass, not fresh requirements after its only repair.
  // Landed/text/mechanically rejected paths retain their separate protocols.
  const focused = reviewing && userCriteria && !landed && args.delivery !== 'text'
    ? await reviewAcceptanceCriteria({ ctx, task, checklist,
      evidence: [probe.block, namedFilesBlock, checklistBlock, layoutsBlock, inputsBlock, startingBlock, restorationsBlock,
        inheritedBlock, renderResultGateFindings(gates.reviewFindings),
        [`Transport observations: ${transport.omitted} omitted; omissions establish no coverage.`, ...transport.lines]
          .join('\n')].filter(Boolean).join('\n\n') }) : undefined;
  const judged = focused ? judgeCoverage(coverage, focused.criteria) : initialJudged;
  const reviewed = focused && !focused.approved ? { approved: false,
    reasoning: [!initial.approved ? initial.reasoning : '', focused.reasoning].filter(Boolean).join('\n') } : initial;
  const inheritedJudgements = 'inherited' in raw ? raw.inherited : undefined;
  const verdict = consistentWithRecheck(
    consistentWithInherited(consistentWithCriteria(reviewed, judged, source, landed), inheritedItems, inheritedJudgements, landed),
    earlier, unrechecked);
  const produced = result.producedBy;
  return {
    attempt: ctx.attempt ?? 1, approved: verdict.approved, reasoning: verdict.reasoning ?? '',
    acceptor: { ...RUN_ACTORS.root, role: 'root-acceptor' },
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
