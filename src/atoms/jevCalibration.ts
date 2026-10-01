import { createHash } from 'node:crypto';
import {
  JEV_THRESHOLDS,
  NEW_RECIPE,
  buildApproval,
  buildChoice,
  buildCompilation,
  buildTwin,
  readApproval,
  readChoice,
  readCompilation,
  readTwin,
  type JevAnswers,
  type JevChoiceOption,
  type JevQuestion,
  type JevThresholds,
} from '../core/jevQuestions.js';
import { jevOutcomeReport } from './jevOutcomes.js';
import {
  jevAsk,
  legacyApproval,
  legacyChoice,
  legacyReadApproval,
  legacyReadChoice,
  legacyReadTwin,
  legacyTwin,
} from '../core/jev.js';
import type { JevApprovalRequest, JevChoiceRequest, JevCompilationRequest, JevTwinRequest, Tier } from '../core/types.js';

/**
 * JEV CALIBRATION — the documented questions (`src/core/jevQuestions.ts`)
 * measured on the decisions the MODEL recorded, before they decide anything
 * (docs/jev-decisions-2026-09-28.md).
 *
 * Every prefilter and phase validation a run's model took is in its trace: the
 * prompt it read and the answer it gave. This module reads such a prompt back
 * into the request the Jev decider would have built, asks TypeSafe both the
 * documented questions and the ones the decider asks today (`legacy*` in
 * `jev.ts`) through the very builders the decider uses, and reads the answers
 * against any thresholds, the model's decision as the reference. Twin cases are
 * labelled by a person instead: no model takes that decision.
 *
 * A trace in which Jev decided is left out unless asked for: there the model
 * judged only what Jev handed it, so its decisions are a sample Jev chose, and
 * what Jev approved has no reference at all.
 *
 * Everything here is handed its traces, its key and its transport. The door is
 * `atoma_jev_calibrate` (src/mcp/tools.ts), which reads only the organisations
 * the host admits to Jev, so nothing leaves for TypeSafe that their own runs do
 * not already send.
 */

// ---------------------------------------------------------------------------
// The model's decisions, read out of traces
// ---------------------------------------------------------------------------

const ROLES = new Set(['prefilter', 'validate-plan', 'validate-result']);

export type RecordedRole = 'prefilter' | 'validate-plan' | 'validate-result';

/** One decision the model took, as its trace recorded it. */
export interface RecordedDecision {
  readonly runId: string;
  readonly orgId: string;
  readonly startedAt: string;
  readonly eventId: string;
  readonly role: RecordedRole;
  readonly actor: { readonly name: string; readonly tier: number };
  /** A skill-catalog prefilter rather than the agent one. */
  readonly recipe: boolean;
  readonly userContent: string;
  readonly response: string;
}

/** The skill prefilter's system prompt, told from the agent one (`SKILL_PREFILTER_SYSTEM_PROMPT`). */
export function isRecipePrefilter(systemPrompt: unknown): boolean {
  return typeof systemPrompt === 'string' && systemPrompt.startsWith('You match a subtask against a catalog of learned skills');
}

/**
 * One audit a trace records (`jev-audit`): the model validator's verdict on a
 * plan or result Jev had already approved. A refusal is a Jev false approval,
 * measured against the model; `null` when the call failed or did not parse.
 */
export interface RecordedAudit {
  readonly runId: string;
  readonly eventId: string;
  readonly subject: 'PLAN' | 'RESULT';
  readonly child: string;
  readonly approvedByModel: boolean | null;
}

export interface TraceDecisions {
  readonly startedAt: string | null;
  /** The Jev evaluations the trace records. */
  readonly jevEvents: number;
  readonly decisions: readonly RecordedDecision[];
  readonly audits: readonly RecordedAudit[];
}

/**
 * The model decisions one trace holds: its prefilter and phase-validation
 * `llm` events. Root acceptance is left out — it is never Jev's — and so is a
 * call that failed before answering. Its audits of Jev approvals are read
 * apart: they are the model judging what Jev decided, not a decision.
 */
export function decisionsOfTrace(trace: unknown, meta: { readonly runId: string; readonly orgId: string }): TraceDecisions {
  const run = trace as { startedAt?: unknown; events?: unknown } | null;
  const startedAt = typeof run?.startedAt === 'string' ? run.startedAt : null;
  const events = Array.isArray(run?.events) ? (run.events as unknown[]) : [];
  const decisions: RecordedDecision[] = [];
  const audits: RecordedAudit[] = [];
  let jevEvents = 0;
  for (const raw of events) {
    const event = raw as {
      id?: unknown;
      kind?: unknown;
      role?: unknown;
      subject?: unknown;
      actor?: { name?: unknown; tier?: unknown };
      child?: { name?: unknown };
      systemPrompt?: unknown;
      userContent?: unknown;
      response?: unknown;
      error?: unknown;
    } | null;
    if (event?.kind === 'jev') jevEvents += 1;
    if (event?.kind === 'llm' && event.role === 'jev-audit' && typeof event.id === 'string') {
      if (event.subject === 'PLAN' || event.subject === 'RESULT') {
        audits.push({
          runId: meta.runId,
          eventId: event.id,
          subject: event.subject,
          child: typeof event.child?.name === 'string' ? event.child.name : '?',
          approvedByModel: event.error == null && typeof event.response === 'string' ? modelApproved(event.response) : null,
        });
      }
      continue;
    }
    if (event?.kind !== 'llm' || typeof event.role !== 'string' || !ROLES.has(event.role)) continue;
    if (typeof event.id !== 'string' || typeof event.userContent !== 'string' || typeof event.response !== 'string') continue;
    const name = event.actor?.name;
    const tier = event.actor?.tier;
    if (typeof name !== 'string' || typeof tier !== 'number' || name === 'run-root') continue;
    decisions.push({
      runId: meta.runId,
      orgId: meta.orgId,
      startedAt: startedAt ?? '',
      eventId: event.id,
      role: event.role as RecordedRole,
      actor: { name, tier },
      recipe: isRecipePrefilter(event.systemPrompt),
      userContent: event.userContent,
      response: event.response,
    });
  }
  return { startedAt, jevEvents, decisions, audits };
}

/** One run's trace, as the door hands it over: read only when it can hold the window. */
export interface CorpusTrace {
  readonly runId: string;
  readonly orgId: string;
  /** The file's last write: a run that started in the window was written after it began. */
  readonly modifiedAtMs?: number;
  /** The parsed trace, or `null` when it cannot be read (absent, over the ceiling, not JSON). */
  readonly read: () => unknown;
}

export interface Corpus {
  readonly outcomes: readonly ReturnType<typeof jevOutcomeReport>[];
  /** Oldest run first, each run's decisions in the order it took them. */
  readonly decisions: readonly RecordedDecision[];
  /** Every audit in the window, runs Jev decided in included: that is where audits are. */
  readonly audits: readonly RecordedAudit[];
  readonly traces: {
    readonly read: number;
    readonly inWindow: number;
    readonly unreadable: number;
    /** In the window, but left out because Jev decided in them. */
    readonly withJev: number;
  };
}

/** The model decisions of every trace that started in `[since, until)`. */
export function collectCorpus(opts: {
  readonly traces: Iterable<CorpusTrace>;
  readonly since?: string;
  readonly until?: string;
  readonly includeJevRuns?: boolean;
}): Corpus {
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
  const untilMs = opts.until ? Date.parse(opts.until) : Infinity;
  const runs: TraceDecisions[] = [];
  const outcomes: ReturnType<typeof jevOutcomeReport>[] = [];
  const audits: RecordedAudit[] = [];
  let read = 0;
  let unreadable = 0;
  let withJev = 0;
  for (const trace of opts.traces) {
    if (trace.modifiedAtMs !== undefined && trace.modifiedAtMs < sinceMs) continue;
    read += 1;
    const parsed = trace.read();
    const found = parsed ? decisionsOfTrace(parsed, trace) : null;
    if (!found?.startedAt) {
      unreadable += 1;
      continue;
    }
    const startedMs = Date.parse(found.startedAt);
    if (!(startedMs >= sinceMs && startedMs < untilMs)) continue;
    audits.push(...found.audits);
    if (found.jevEvents > 0) outcomes.push(jevOutcomeReport(parsed, trace.runId));
    if (found.jevEvents > 0 && !opts.includeJevRuns) {
      withJev += 1;
      continue;
    }
    runs.push(found);
  }
  runs.sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
  outcomes.sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
  return {
    decisions: runs.flatMap((run) => run.decisions),
    audits,
    outcomes,
    traces: { read, inWindow: runs.length + withJev, unreadable, withJev },
  };
}

/**
 * What the audit sample says, per subject: of the Jev approvals the model
 * also judged, how many it would have refused — the false approvals the model
 * no longer sees once Jev decides. Reading it sends nothing to TypeSafe.
 */
export function auditReport(audits: readonly RecordedAudit[], listLimit = 25): Record<string, unknown> {
  return {
    subjects: (['PLAN', 'RESULT'] as const).map((subject) => {
      const rows = audits.filter((audit) => audit.subject === subject);
      const judged = rows.filter((audit) => audit.approvedByModel !== null);
      const refused = judged.filter((audit) => audit.approvedByModel === false);
      return {
        subject,
        audited: rows.length,
        judged: judged.length,
        refusedByModel: refused.length,
        falseApprovalShare: share(refused.length, judged.length),
        modelDisagreementShare: share(refused.length, judged.length),
        refusals: refused.slice(0, listLimit).map(({ runId, eventId, child }) => ({ runId, eventId, child })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The model's prompts, read back into the decider's requests
// ---------------------------------------------------------------------------

/** The prefilter prompt `prefilterStrategy` renders, read back into a `JevChoiceRequest`. */
export function parsePrefilterPrompt(decision: RecordedDecision): JevChoiceRequest | null {
  const text = decision.userContent;
  const catalogAt = text.lastIndexOf('\nCatalog:\n');
  const taskAt = text.indexOf('Task: ');
  if (catalogAt < 0 || taskAt < 0) return null;
  const head = text.slice(taskAt + 'Task: '.length, catalogAt);
  const constraintsAt = head.indexOf('\nConstraints:\n');
  const excludedAt = head.indexOf('\nAlready tried and failed THIS task');
  const ends = [constraintsAt, excludedAt].filter((index) => index >= 0);
  const description = head.slice(0, ends.length ? Math.min(...ends) : head.length).trim();
  const constraints =
    constraintsAt >= 0
      ? head
          .slice(constraintsAt + '\nConstraints:\n'.length, excludedAt > constraintsAt ? excludedAt : head.length)
          .split('\n')
          .filter((line) => line.startsWith('- '))
          .map((line) => line.slice(2))
      : [];
  const candidates: { name: string; description: string }[] = [];
  for (const line of text.slice(catalogAt + '\nCatalog:\n'.length).split('\n')) {
    const entry = /^ {2}- ([^:\s]+): (.*)$/.exec(line);
    if (entry) candidates.push({ name: entry[1]!, description: entry[2]! });
    else if (/^ {4}/.test(line) && candidates.length > 0) {
      const last = candidates[candidates.length - 1]!;
      candidates[candidates.length - 1] = { ...last, description: `${last.description}\n${line}` };
    }
  }
  if (candidates.length === 0) return null;
  return {
    question: decision.recipe ? 'recipe' : 'agent',
    task: { description, ...(constraints.length ? { constraints } : {}) },
    candidates,
    actorName: decision.actor.name,
    actorTier: decision.actor.tier as Tier,
  };
}

/**
 * Markers of a validation the Jev fast path is never asked about: a mechanical
 * gate finding, uncovered or unreadable proof, a probe that requires review.
 */
const INELIGIBLE_MARKERS = [
  '== MECHANICAL GATE FINDINGS',
  'UNCOVERED —',
  '— MISSING or unreadable',
  'WARNING: file is EMPTY',
  '<-- SELF-REPORTED MISMATCH',
  '— NOT FOUND.',
  'NUMERIC LOOPBACK PORT',
  'but the tool call failed:',
  ': MALFORMED —',
];

/** The validation prompt `llmVerdict` renders, read back into a `JevApprovalRequest`. */
export function parseValidationPrompt(
  decision: RecordedDecision
): { readonly request: JevApprovalRequest; readonly eligible: boolean } | null {
  const subject = decision.role === 'validate-plan' ? 'PLAN' : 'RESULT';
  const lines = decision.userContent.split('\n');
  const child = /^Child: "([^"]+)" \(tier (\d)\)/.exec(lines.find((line) => line.startsWith('Child: ')) ?? '');
  const toolsLine = lines.find((line) => line.startsWith("Child's DECLARED TOOLS") || line.startsWith('Tools inherited by NEW'));
  const tools = toolsLine
    ? toolsLine
        .slice(toolsLine.indexOf(':') + 1)
        .split('. Existing children')[0]!
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name && name !== '(none)')
    : [];
  const taskAt = lines.findIndex((line) => line.startsWith('Task: '));
  const payloadAt = lines.findIndex((line) => line.startsWith(`${subject}: `));
  if (!child || taskAt < 0 || payloadAt < taskAt) return null;
  const taskEnd = lines.findIndex((line, index) => index > taskAt && line.startsWith('Delegation target(s):'));
  const description = [lines[taskAt]!.slice('Task: '.length), ...lines.slice(taskAt + 1, taskEnd > taskAt ? taskEnd : payloadAt)]
    .join('\n')
    .trim();
  let payload: unknown;
  try {
    payload = JSON.parse(lines[payloadAt]!.slice(`${subject}: `.length));
  } catch {
    return null;
  }
  const rest = lines.slice(payloadAt + 1);
  const headerAt = (prefix: string) => rest.findIndex((line) => line.startsWith(prefix));
  const nextHeader = (from: number) => {
    const at = rest.findIndex((line, index) => index > from && line.startsWith('== '));
    return at < 0 ? rest.length : at;
  };
  const truthAt = headerAt('== GROUND-TRUTH');
  const groundTruth = truthAt >= 0 ? rest.slice(truthAt, nextHeader(truthAt)).join('\n').trim() : '';
  const evidenceAt = headerAt('== TRANSPORT-OBSERVED TOOL EVIDENCE');
  const evidence: string[] = [];
  if (evidenceAt >= 0) {
    for (const line of rest.slice(evidenceAt + 1, nextHeader(evidenceAt))) {
      if (line.startsWith('These are historical observations')) continue;
      const omitted = /^(\d+) earlier observations omitted/.exec(line);
      if (omitted) evidence.push(`${omitted[1]} earlier observations omitted`);
      else if (line.trim()) evidence.push(line);
    }
  }
  return {
    request: {
      subject,
      task: { description },
      child: { name: child[1]!, tier: Number(child[2]) as Tier, tools },
      payload,
      ...(evidence.length ? { evidence } : {}),
      ...(groundTruth ? { groundTruth } : {}),
      actorName: decision.actor.name,
      actorTier: decision.actor.tier as Tier,
    },
    eligible: !INELIGIBLE_MARKERS.some((marker) => decision.userContent.includes(marker)),
  };
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The model prefilter's decision: a confident reuse of `target`, else an escalate (a low-confidence reuse IS one). */
export function modelPrefilterTarget(response: string): { readonly target: string | null } | null {
  const parsed = jsonObject(response);
  if (!parsed || typeof parsed['kind'] !== 'string') return null;
  const reuse = parsed['kind'] === 'reuse' && typeof parsed['target'] === 'string' && parsed['confidence'] === 'high';
  return { target: reuse ? (parsed['target'] as string) : null };
}

export function modelApproved(response: string): boolean | null {
  const parsed = jsonObject(response);
  return parsed && typeof parsed['approved'] === 'boolean' ? parsed['approved'] : null;
}

// ---------------------------------------------------------------------------
// Twin cases, labelled by a person
// ---------------------------------------------------------------------------

export interface TwinCases {
  readonly recipes: Readonly<
    Record<string, { readonly kind: 'task' | 'event'; readonly description: string; readonly whenToUse: string; readonly body?: string }>
  >;
  /** `twins`: the existing recipes a person judged the draft to duplicate; empty when it is new. */
  readonly cases: readonly { readonly draft: string; readonly existing: readonly string[]; readonly twins: readonly string[] }[];
}

export interface TwinCase {
  readonly request: JevTwinRequest;
  readonly expected: readonly string[];
}

/** The requests the twin guard would build for each labelled case, or what is wrong with the cases. */
export function twinCases(input: TwinCases): TwinCase[] | string {
  const out: TwinCase[] = [];
  for (const labelled of input.cases) {
    const draft = input.recipes[labelled.draft];
    if (!draft) return `case draft "${labelled.draft}" is not among the recipes`;
    const missing = [...labelled.existing, ...labelled.twins].find((id) => !input.recipes[id]);
    if (missing) return `recipe "${missing}" of case "${labelled.draft}" is not among the recipes`;
    const stray = labelled.twins.find((id) => !labelled.existing.includes(id));
    if (stray) return `twin "${stray}" of case "${labelled.draft}" is not one of its existing recipes`;
    out.push({
      request: {
        kind: draft.kind,
        draft: { id: labelled.draft, description: draft.description, whenToUse: draft.whenToUse, body: draft.body ?? '' },
        existing: labelled.existing.map((id) => ({ id, description: input.recipes[id]!.description, whenToUse: input.recipes[id]!.whenToUse })),
      },
      expected: labelled.twins,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Asking both designs
// ---------------------------------------------------------------------------

/** What every record carries: the raw answers, so any threshold can be read again without asking. */
interface RecordBase {
  readonly id: string;
  readonly answers?: JevAnswers;
  readonly legacyAnswers?: JevAnswers;
  readonly failure?: string;
  readonly legacyFailure?: string;
  /** The documented request's latency: what the decider would wait for. */
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly costUsd: number;
  readonly requestIds?: readonly string[];
  readonly servedModel?: string;
}

export interface PrefilterRecord extends RecordBase {
  readonly kind: 'prefilter';
  readonly runId: string;
  readonly question: 'agent' | 'recipe';
  readonly actorTier?: Tier;
  readonly task: string;
  readonly candidates: readonly { readonly name: string; readonly description: string }[];
  readonly options: readonly JevChoiceOption[];
  /** The model's decision: the candidate it reused confidently, or `null` for escalate. */
  readonly model: string | null;
}

export interface ApprovalRecord extends RecordBase {
  readonly kind: 'approval';
  readonly runId: string;
  readonly subject: 'PLAN' | 'RESULT';
  readonly child: string;
  readonly actorTier?: Tier;
  readonly requirements: readonly string[];
  readonly flags: readonly string[];
  readonly model: boolean;
}

export interface TwinRecord extends RecordBase {
  readonly kind: 'twin';
  readonly ids: readonly string[];
  readonly legacyOptions: Readonly<Record<string, string>>;
  readonly expected: readonly string[];
}

/** Caller-labelled eligibility only: calibration never generates or executes a script. */
export interface CompilationCase {
  readonly request: JevCompilationRequest;
  readonly expected: boolean | null;
}

export interface CompilationRecord extends RecordBase {
  readonly kind: 'compilation';
  readonly skillId: string;
  readonly expected: boolean | null;
  /** The exact state and questions asked, including the full compiler contract. */
  readonly requestHash: string;
}

export type CalibrationRecord = PrefilterRecord | ApprovalRecord | TwinRecord | CompilationRecord;

type Asking = { readonly state: unknown; readonly questions: Readonly<Record<string, JevQuestion>> };
type Outcome = Omit<RecordBase, 'id'>;

interface Job {
  readonly documented: Asking | string;
  readonly legacy: Asking | string | null;
  readonly finish: (outcome: Outcome) => CalibrationRecord;
  /** Its place in `decisions`; a twin case has none. */
  readonly decisionIndex?: number;
}

const clip = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)}…` : text);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface Calibration {
  readonly records: CalibrationRecord[];
  /** Decisions whose prompt or answer did not parse back: skipped, never guessed. */
  readonly unparsed: number;
  /** Validations the fast path is never asked about, per subject: not sent. */
  readonly ineligible: { readonly PLAN: number; readonly RESULT: number };
  /** Decisions not asked because the call's budget ran out or it was cancelled. */
  readonly unasked: number;
  /** The index in `decisions` to resume from when some were not asked, else `null`. */
  readonly resumeAt: number | null;
}

/**
 * Ask TypeSafe both designs on every decision and twin case, `concurrency`
 * requests in flight (the public limit is 1,200 requests a minute, shared with
 * any run deciding meanwhile). Twin cases go first, being few; nothing new is
 * sent past `budgetMs`, and `resumeAt` says where a next call picks up.
 */
export async function calibrate(args: {
  readonly decisions: readonly RecordedDecision[];
  readonly twins?: readonly TwinCase[];
  readonly compilations?: readonly CompilationCase[];
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly budgetMs?: number;
  readonly onProgress?: (done: number, total: number) => void;
}): Promise<Calibration> {
  const timeoutMs = args.timeoutMs ?? 20_000;
  const budgetMs = args.budgetMs ?? Infinity;
  let unparsed = 0;
  const ineligible = { PLAN: 0, RESULT: 0 };
  const jobs: Job[] = [];
  for (const [index, compilation] of (args.compilations ?? []).entries()) {
    const plan = buildCompilation(compilation.request);
    const requestHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    jobs.push({
      documented: plan,
      legacy: null,
      finish: (outcome) => ({
        kind: 'compilation', id: `${compilation.request.skillId}#${index + 1}`,
        skillId: compilation.request.skillId, expected: compilation.expected, requestHash, ...outcome,
      }),
    });
  }
  for (const twin of args.twins ?? []) {
    const plan = buildTwin(twin.request);
    const legacy = legacyTwin(twin.request);
    jobs.push({
      documented: plan ?? 'nothing to compare the draft with',
      legacy,
      finish: (outcome) => ({
        kind: 'twin',
        id: twin.request.draft.id,
        ids: plan?.ids ?? [],
        legacyOptions: legacy?.options ?? {},
        expected: twin.expected,
        ...outcome,
      }),
    });
  }
  for (const [decisionIndex, decision] of args.decisions.entries()) {
    if (decision.role === 'prefilter') {
      const request = parsePrefilterPrompt(decision);
      const model = modelPrefilterTarget(decision.response);
      if (!request || !model) {
        unparsed += 1;
        continue;
      }
      const plan = buildChoice(request);
      jobs.push({
        decisionIndex,
        documented: plan,
        legacy: legacyChoice(request),
        finish: (outcome) => ({
          kind: 'prefilter',
          id: decision.eventId,
          runId: decision.runId,
          question: request.question,
          ...(request.actorTier !== undefined ? { actorTier: request.actorTier } : {}),
          task: clip(request.task.description, 600),
          candidates: request.candidates.map(({ name, description }) => ({ name, description })),
          options: typeof plan === 'string' ? [] : plan.options,
          model: model.target,
          ...outcome,
        }),
      });
      continue;
    }
    const parsed = parseValidationPrompt(decision);
    const model = modelApproved(decision.response);
    if (!parsed || model === null) {
      unparsed += 1;
      continue;
    }
    if (!parsed.eligible) {
      ineligible[parsed.request.subject] += 1;
      continue;
    }
    const plan = buildApproval(parsed.request);
    jobs.push({
      decisionIndex,
      documented: plan,
      legacy: legacyApproval(parsed.request),
      finish: (outcome) => ({
        kind: 'approval',
        id: decision.eventId,
        runId: decision.runId,
        subject: parsed.request.subject,
        child: parsed.request.child.name,
        ...(parsed.request.actorTier !== undefined ? { actorTier: parsed.request.actorTier } : {}),
        requirements: typeof plan === 'string' ? [] : plan.requirements,
        flags: typeof plan === 'string' ? [] : plan.flags,
        model,
        ...outcome,
      }),
    });
  }

  const ask = async (asking: Asking) => {
    const bounded = AbortSignal.timeout(timeoutMs);
    const signal = args.signal ? AbortSignal.any([args.signal, bounded]) : bounded;
    const startedAt = Date.now();
    const result = await jevAsk({
      apiKey: args.apiKey,
      state: asking.state,
      questions: asking.questions,
      signal,
      deadlineAt: startedAt + timeoutMs,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
    return { result, durationMs: Date.now() - startedAt };
  };

  const startedAt = Date.now();
  const records: (CalibrationRecord | undefined)[] = new Array<CalibrationRecord | undefined>(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (args.signal?.aborted || Date.now() - startedAt > budgetMs) return;
      const index = next++;
      if (index >= jobs.length) return;
      const job = jobs[index]!;
      if (typeof job.documented === 'string') {
        records[index] = job.finish({ failure: job.documented, costUsd: 0 });
      } else {
        try {
          const documented = await ask(job.documented);
          let legacy: Awaited<ReturnType<typeof ask>> | null = null;
          let legacyFailure: string | undefined;
          if (typeof job.legacy === 'string') legacyFailure = job.legacy;
          else if (job.legacy) {
            try {
              legacy = await ask(job.legacy);
            } catch (error) {
              legacyFailure = messageOf(error);
            }
          }
          const requestIds = [documented.result.requestId, legacy?.result.requestId].filter((id): id is string => Boolean(id));
          records[index] = job.finish({
            answers: documented.result.answers,
            ...(legacy ? { legacyAnswers: legacy.result.answers } : {}),
            ...(legacyFailure ? { legacyFailure } : {}),
            durationMs: documented.durationMs,
            inputTokens: documented.result.inputTokens,
            costUsd: documented.result.costUsd + (legacy?.result.costUsd ?? 0),
            ...(requestIds.length ? { requestIds } : {}),
            ...(documented.result.servedModel ? { servedModel: documented.result.servedModel } : {}),
          });
        } catch (error) {
          if (args.signal?.aborted) return;
          records[index] = job.finish({ failure: messageOf(error), costUsd: 0 });
        }
      }
      done += 1;
      args.onProgress?.(done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency ?? 4) }, () => worker()));
  const kept = records.filter((record): record is CalibrationRecord => record !== undefined);
  // Workers take jobs in order, so what was not asked is a tail of the list.
  const firstUnasked = jobs.findIndex((job, index) => records[index] === undefined && job.decisionIndex !== undefined);
  return {
    records: kept,
    unparsed,
    ineligible,
    unasked: jobs.length - kept.length,
    resumeAt: firstUnasked < 0 ? null : jobs[firstUnasked]!.decisionIndex!,
  };
}

// ---------------------------------------------------------------------------
// Reading the records against thresholds
// ---------------------------------------------------------------------------

const share = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((1000 * part) / whole) / 1000);

function percentile(values: readonly number[], at: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))]!;
}

function readApprovalRecord(row: ApprovalRecord, thresholds: JevThresholds) {
  return readApproval({ request: { subject: row.subject }, requirements: row.requirements, flags: row.flags }, row.answers!, thresholds);
}

function readPrefilterRecord(row: PrefilterRecord, thresholds: JevThresholds) {
  return readChoice(
    { options: row.options, request: row.actorTier !== undefined ? { actorTier: row.actorTier } : {} },
    row.answers!,
    thresholds
  );
}

function legacyPrefilterRequest(row: PrefilterRecord): JevChoiceRequest {
  return { question: row.question, task: { description: row.task }, candidates: row.candidates };
}

/** Two names for one option: candidates described alike are one choice to a reader of descriptions. */
function sameOption(options: readonly JevChoiceOption[], a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  return options.some((option) => option.names.includes(a) && option.names.includes(b));
}

function approvalCells(rows: readonly ApprovalRecord[], thresholds: JevThresholds) {
  let approvedRight = 0;
  let approvedWrong = 0;
  let legacyRight = 0;
  let legacyWrong = 0;
  const falseApprovals: string[] = [];
  const legacyFalseApprovals: string[] = [];
  const blockers: Record<string, number> = {};
  for (const row of rows) {
    const reading = readApprovalRecord(row, thresholds);
    if (reading.decision?.approved === true) {
      if (row.model) approvedRight += 1;
      else {
        approvedWrong += 1;
        falseApprovals.push(row.id);
      }
    } else if (row.model) {
      // A deferral the model then approved: the fast path this reading gave up.
      for (const cause of reading.causes ?? []) blockers[cause] = (blockers[cause] ?? 0) + 1;
    }
    if (row.legacyAnswers && legacyReadApproval(row.legacyAnswers).decision?.approved === true) {
      if (row.model) legacyRight += 1;
      else {
        legacyWrong += 1;
        legacyFalseApprovals.push(row.id);
      }
    }
  }
  const approvedByModel = rows.filter((row) => row.model).length;
  return {
    documented: { approves: approvedRight + approvedWrong, falseApprovals: approvedWrong, fastPath: share(approvedRight, approvedByModel) },
    legacy: { approves: legacyRight + legacyWrong, falseApprovals: legacyWrong, fastPath: share(legacyRight, approvedByModel) },
    falseApprovals,
    legacyFalseApprovals,
    blockers,
  };
}

function prefilterCells(rows: readonly PrefilterRecord[], thresholds: JevThresholds) {
  const documented = { agree: 0, disagree: 0, deferred: 0 };
  const legacy = { agree: 0, disagree: 0, deferred: 0 };
  const disagreements: string[] = [];
  const causes: Record<string, number> = {};
  for (const row of rows) {
    const reading = readPrefilterRecord(row, thresholds);
    for (const cause of reading.causes ?? []) causes[cause] = (causes[cause] ?? 0) + 1;
    if (!reading.decision) documented.deferred += 1;
    else if (sameOption(row.options, reading.decision.target, row.model)) documented.agree += 1;
    else {
      documented.disagree += 1;
      disagreements.push(`${row.id}: jev ${reading.decision.target ?? 'escalate'}, model ${row.model ?? 'escalate'} — ${reading.outcome}`);
    }
    if (row.legacyAnswers) {
      const old = legacyReadChoice(legacyPrefilterRequest(row), row.legacyAnswers).decision;
      if (!old) legacy.deferred += 1;
      else if (sameOption(row.options, old.target, row.model)) legacy.agree += 1;
      else legacy.disagree += 1;
    }
  }
  return { documented, legacy, disagreements, causes };
}

function twinRows(rows: readonly TwinRecord[], thresholds: JevThresholds) {
  return rows.map((row) => {
    const documented = readTwin({ ids: row.ids }, row.answers!, thresholds);
    const legacy = row.legacyAnswers ? legacyReadTwin(row.legacyOptions, row.legacyAnswers) : null;
    const right = (twinOf: string | null | undefined) =>
      row.expected.length > 0 ? row.expected.includes(twinOf ?? '') : twinOf === null;
    return {
      draft: row.id,
      expected: row.expected.length > 0 ? row.expected : NEW_RECIPE,
      documented: documented.outcome,
      documentedRight: right(documented.decision?.twinOf),
      legacy: legacy?.outcome ?? null,
      legacyRight: legacy ? right(legacy.decision?.twinOf) : null,
      scores: documented.answer.scores ?? {},
    };
  });
}

const bucketOf = (row: PrefilterRecord): string => `${row.question}@L${row.actorTier ?? '?'}`;

function compilationCells(rows: readonly CompilationRecord[], thresholds: JevThresholds) {
  const readings = rows.map((row) => ({ row, decision: readCompilation(row.answers!, thresholds).decision }));
  return {
    cases: rows.length,
    labelled: rows.filter((row) => row.expected !== null).length,
    allowed: readings.filter(({ decision }) => decision?.compilable === true).length,
    postponed: readings.filter(({ decision }) => decision?.compilable === false).length,
    deferred: readings.filter(({ decision }) => decision === null).length,
    falsePostponements: readings.filter(({ row, decision }) => row.expected === true && decision?.compilable === false).length,
    falseAllowances: readings.filter(({ row, decision }) => row.expected === false && decision?.compilable === true).length,
  };
}

/**
 * What the records say under `thresholds`: per subject, how often each design
 * approves what the model refused (the error that compounds trust) and how
 * much of the model's approvals it takes (the speed), with what blocked the
 * rest; per prefilter bucket, agreement with the model; per twin case, whether
 * each design was right. `sweep` adds the same figures under neighbouring
 * thresholds, so one call shows where a threshold should sit.
 */
export function calibrationReport(
  records: readonly CalibrationRecord[],
  opts: { readonly thresholds?: JevThresholds; readonly sweep?: boolean; readonly listLimit?: number } = {}
): Record<string, unknown> {
  const thresholds = opts.thresholds ?? JEV_THRESHOLDS;
  const limit = opts.listLimit ?? 25;
  const answered = records.filter((record) => record.answers);
  const approvals = answered.filter((record): record is ApprovalRecord => record.kind === 'approval');
  const prefilters = answered.filter((record): record is PrefilterRecord => record.kind === 'prefilter');
  const twins = answered.filter((record): record is TwinRecord => record.kind === 'twin');
  const compilations = answered.filter((record): record is CompilationRecord => record.kind === 'compilation');
  const durations = answered.flatMap((record) => (record.durationMs !== undefined ? [record.durationMs] : []));
  const tokens = answered.flatMap((record) => (record.inputTokens !== undefined ? [record.inputTokens] : []));

  const approvalBuckets = (['PLAN', 'RESULT'] as const).flatMap((subject) => {
    const rows = approvals.filter((row) => row.subject === subject);
    if (rows.length === 0) return [];
    const cells = approvalCells(rows, thresholds);
    return [
      {
        subject,
        decisions: rows.length,
        refusedByModel: rows.filter((row) => !row.model).length,
        documented: cells.documented,
        legacy: cells.legacy,
        blockers: cells.blockers,
        falseApprovals: cells.falseApprovals.slice(0, limit),
        legacyFalseApprovals: cells.legacyFalseApprovals.slice(0, limit),
        ...(opts.sweep
          ? {
              sweep: [0.6, 0.7, 0.8, 0.9].flatMap((requirement) =>
                [0.2, 0.3, 0.4, 0.5].map((flag) => {
                  const swept = approvalCells(rows, { ...thresholds, requirementShown: requirement, requirementCovered: requirement, flag });
                  return { requirement, flag, falseApprovals: swept.documented.falseApprovals, fastPath: swept.documented.fastPath };
                })
              ),
            }
          : {}),
      },
    ];
  });

  const prefilterBuckets = [...new Set(prefilters.map(bucketOf))].sort().map((bucket) => {
    const rows = prefilters.filter((row) => bucketOf(row) === bucket);
    const cells = prefilterCells(rows, thresholds);
    return {
      bucket,
      decisions: rows.length,
      escalatedByModel: rows.filter((row) => row.model === null).length,
      documented: cells.documented,
      legacy: cells.legacy,
      causes: cells.causes,
      disagreements: cells.disagreements.slice(0, limit),
      ...(opts.sweep
        ? {
            sweep: [0.3, 0.5, 0.7].flatMap((pickConfidence) =>
              [0.5, 0.7, 0.85].map((fit) => ({ pickConfidence, fit, ...prefilterCells(rows, { ...thresholds, pickConfidence, fit }).documented }))
            ),
          }
        : {}),
    };
  });

  const twinTable = twinRows(twins, thresholds);
  return {
    thresholds,
    totals: {
      records: records.length,
      answered: answered.length,
      failed: records.filter((record) => record.failure).length,
      failures: [...new Set(records.flatMap((record) => (record.failure ? [record.failure] : [])))].slice(0, 5),
      legacyFailed: records.filter((record) => record.legacyFailure).length,
      costUsd: Math.round(records.reduce((sum, record) => sum + record.costUsd, 0) * 1e6) / 1e6,
      latencyMs: { median: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: percentile(durations, 1) },
      inputTokens: { median: percentile(tokens, 0.5), max: percentile(tokens, 1) },
      servedModels: [...new Set(answered.flatMap((record) => (record.servedModel ? [record.servedModel] : [])))],
    },
    approvals: approvalBuckets,
    prefilter: prefilterBuckets,
    ...(compilations.length ? { compilation: {
      ...compilationCells(compilations, thresholds),
      ...(opts.sweep ? { sweep: [0.7, 0.8, 0.9, 0.95].map((compilationObstacle) => ({
        compilationObstacle,
        ...compilationCells(compilations, { ...thresholds, compilationObstacle }),
      })) } : {}),
    } } : {}),
    ...(twinTable.length
      ? {
          twins: {
            cases: twinTable.length,
            documentedRight: twinTable.filter((row) => row.documentedRight).length,
            legacyRight: twinTable.filter((row) => row.legacyRight).length,
            rows: twinTable,
            ...(opts.sweep
              ? {
                  sweep: [1.0, 1.25, 1.5, 1.75].map((twin) => ({
                    twin,
                    documentedRight: twinRows(twins, { ...thresholds, twin }).filter((row) => row.documentedRight).length,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * One row per record: the probabilities the documented questions gave and
 * what each design would have done, beside the model's decision — what a
 * person reads to see WHY a threshold moves a decision.
 */
export function calibrationDetails(
  records: readonly CalibrationRecord[],
  opts: { readonly thresholds?: JevThresholds; readonly offset?: number; readonly limit?: number } = {}
): Record<string, unknown>[] {
  const thresholds = opts.thresholds ?? JEV_THRESHOLDS;
  const offset = opts.offset ?? 0;
  return records.slice(offset, offset + (opts.limit ?? 20)).map((record) => {
    const common = {
      kind: record.kind,
      id: record.id,
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.requestIds ? { requestIds: record.requestIds } : {}),
    };
    if (record.kind === 'compilation') {
      const reading = record.answers ? readCompilation(record.answers, thresholds) : null;
      return { ...common, skillId: record.skillId, expected: record.expected,
        requestHash: record.requestHash, documented: reading?.outcome ?? null,
        compilable: reading?.decision?.compilable ?? null, yes: reading?.answer.yes ?? null };
    }
    if (record.kind === 'approval') {
      const reading = record.answers ? readApprovalRecord(record, thresholds) : null;
      return {
        ...common,
        runId: record.runId,
        subject: record.subject,
        child: record.child,
        model: record.model ? 'approved' : 'refused',
        documented: reading?.outcome ?? null,
        yes: reading?.answer.yes ?? null,
        legacy: record.legacyAnswers ? legacyReadApproval(record.legacyAnswers).outcome : null,
        legacyYes: record.legacyAnswers?.['acceptable']?.noul ?? null,
        requirements: record.requirements,
      };
    }
    if (record.kind === 'prefilter') {
      const reading = record.answers ? readPrefilterRecord(record, thresholds) : null;
      return {
        ...common,
        runId: record.runId,
        bucket: bucketOf(record),
        task: record.task,
        model: record.model ?? 'escalate',
        documented: reading?.outcome ?? null,
        answer: reading?.answer ?? null,
        legacy: record.legacyAnswers ? legacyReadChoice(legacyPrefilterRequest(record), record.legacyAnswers).outcome : null,
      };
    }
    const reading = record.answers ? readTwin({ ids: record.ids }, record.answers, thresholds) : null;
    return {
      ...common,
      expected: record.expected,
      documented: reading?.outcome ?? null,
      scores: reading?.answer.scores ?? null,
      legacy: record.legacyAnswers ? legacyReadTwin(record.legacyOptions, record.legacyAnswers).outcome : null,
    };
  });
}
