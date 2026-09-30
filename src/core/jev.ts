import { z } from 'zod';
import { estimateCostUsd, type ModelPrices } from './metrics.js';
import {
  JEV_MAX_OPTIONS,
  JEV_STATE_CHARS,
  NEW_RECIPE,
  NO_CANDIDATE,
  buildApproval,
  buildChoice,
  buildTwin,
  capped,
  headAndTail,
  newestEvidence,
  readApproval,
  readChoice,
  readTwin,
  resultState,
  taskState,
  type JevAnswer,
  type JevAnswers,
  type JevQuestion,
} from './jevQuestions.js';
import type {
  JevApprovalDecision,
  JevApprovalRequest,
  JevChoiceDecision,
  JevChoiceRequest,
  JevDecider,
  JevDecisionInfo,
  JevTwinDecision,
  JevTwinRequest,
} from './types.js';

export { NEW_RECIPE, NO_CANDIDATE, type JevAnswer, type JevAnswers, type JevQuestion };

/**
 * JEV (TypeSafe) TAKES THE BOUNDED DECISIONS IT CAN TAKE.
 * =======================================================
 *
 * Owner decision of 2026-09-28 (docs/jev-decisions-2026-09-28.md): "trust Jev,
 * and we will see". Jev is a typed decision model — it answers Choice, Score
 * and yes/no (Noul) questions over a state, far faster and cheaper than a
 * model call — so it takes the prefilter's pick and the APPROVAL half of plan
 * and result validation. It writes no text, so a refusal is always the model
 * validator's: that is where the remediation comes from.
 *
 * The decider asks the questions TypeSafe's documentation prescribes
 * (`jevQuestions.ts`, read in full on 2026-09-29), read against thresholds
 * `atoma_jev_calibrate` measured on the decisions the model recorded. The
 * questions it shipped with on 2026-09-28 (`legacy*`) stay exported as the
 * baseline every later calibration is compared with.
 *
 * It is deliberately NOT in `modelCatalog.json`: adding its vendor to
 * `MODEL_SELECTOR_VENDORS` would make `api:typesafe:*` a routable tier selector
 * that no transport serves. Its one price therefore lives here, beside its one
 * client, and is applied with the one cost formula (`estimateCostUsd`).
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/**
 * The VERSIONED id, never the `jev-latest` alias. The alias moves when a
 * release ships, and TypeSafe's models page says to pin the version once
 * thresholds are tuned against it (docs.typesafe.ai/models, read 2026-09-29):
 * every question and threshold below was measured on 1.13.0. A new version is
 * adopted by changing this line after re-measuring, on our schedule.
 */
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_EVALUATOR = `typesafe:${JEV_MODEL}`;

/** The credential Jev needs. Every run holding it lets Jev decide, unless the platform switch is off. */
export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';
/**
 * The PLATFORM switch, ON by default (owner decision 2026-09-30: every
 * organisation, existing or new, and every run). `0` on the host turns Jev off
 * for every run it launches, which inherit it; the coordinator writes `1` into
 * a project run's environment beside the key.
 */
export const JEV_ENV = 'ATOMA_JEV';
/**
 * No longer read. Until 2026-09-30 it named the organisations whose project
 * runs let Jev decide; it is named here only for the boot line to say so.
 */
export const JEV_ORGS_ENV = 'ATOMA_JEV_ORGS';

/**
 * USD per million tokens, as `ModelPrices` expects. TypeSafe's models page
 * (docs.typesafe.ai/models, read 2026-09-29) prices jev-1.13 at $0.042 per
 * million INPUT tokens and makes output tokens free; the Cloudflare Workers AI
 * listing read on 2026-09-28 says the same.
 */
export const JEV_PRICES: ModelPrices = { input: 0.042, output: 0, cachedInput: 0 };

/**
 * Longest a decision waits for Jev before the model takes it instead. Jev's
 * point is speed: a slower answer is worth less than the model's.
 */
export const JEV_DECISION_TIMEOUT_MS = 2_000;
/**
 * Failed decisions after which a run stops asking Jev — counted over the whole
 * run and never reset by a success, so neither parallel lanes nor a flapping
 * service can keep a run paying timeouts: at most this many per run. A retried
 * request that then succeeds is not a failed decision.
 */
export const JEV_MAX_FAILURES_PER_RUN = 3;
/** The 2026-09-28 approval's "yes", kept for the baseline: approved at this probability or above. */
export const JEV_APPROVAL_THRESHOLD = 0.5;
/** The 2026-09-28 decomposition bar, kept for the baseline. */
export const JEV_DECOMPOSABLE_THRESHOLD = 0.8;
/** Jev's documented ceiling on the levels of one Score question. */
const JEV_MAX_SCORE_LEVELS = 10;
const EXCERPT_CHARS = 200;
/** A retry is sent only when its wait plus a typical answer fits before the deadline. */
const RETRY_ANSWER_ALLOWANCE_MS = 400;
const DEFAULT_RETRY_DELAY_MS = 250;

const answerSchema = z.object({
  type: z.enum(['choice', 'noul', 'score']).optional(),
  choice: z.string().optional(),
  probabilities: z.record(z.string(), z.number().finite()).optional(),
  confidence: z.number().finite().optional(),
  noul: z.number().finite().optional(),
  score: z.number().finite().optional(),
});

const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export interface JevResult {
  readonly servedModel?: string;
  /** `x-typesafe-request-id`, what TypeSafe support asks for. */
  readonly requestId?: string;
  readonly answers: JevAnswers;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export class JevError extends Error {
  override readonly name = 'JevError';
}

/**
 * A message about a failed call. The credential is removed from the WHOLE text
 * before anything is cut: a key straddling the cut would otherwise survive as
 * its own prefix.
 */
function scrubbed(text: string, apiKey: string): string {
  const redacted = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return redacted.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
}

/** The network cause undici hides behind "fetch failed" (ECONNREFUSED, ENOTFOUND, a TLS code). */
function networkCause(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? ` (${cause.code})` : '';
}

/**
 * The statuses TypeSafe's SDKs retry (408, 429 and 5xx, 529 "overloaded"
 * included). The API reference asks callers to back off on 429 and 529.
 */
function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** How long the server asks us to wait: `retry-after-ms`, else `retry-after` (seconds or a date). */
function retryDelayMs(headers: Headers): number {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const after = headers.get('retry-after');
  if (after !== null) {
    if (Number.isFinite(Number(after))) return Math.max(0, Number(after) * 1000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new JevError('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new JevError('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function checkShapes(questions: Readonly<Record<string, JevQuestion>>): void {
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      if (count < 2 || count > JEV_MAX_OPTIONS) {
        throw new JevError(`choice "${id}" needs 2 to ${JEV_MAX_OPTIONS} options, got ${count}`);
      }
    } else if (question.type === 'score') {
      const count = question.criteria.length;
      if (count < 2 || count > JEV_MAX_SCORE_LEVELS) {
        throw new JevError(`score "${id}" needs 2 to ${JEV_MAX_SCORE_LEVELS} levels, got ${count}`);
      }
    }
  }
}

/** An answer carrying what its question's type promises, and no other type. */
function completeAnswer(question: JevQuestion, raw: unknown): JevAnswer | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const answer = parsed.data;
  if (answer.type !== undefined && answer.type !== question.type) return null;
  if (question.type === 'choice') return answer.choice !== undefined && answer.probabilities !== undefined ? answer : null;
  if (question.type === 'score') return answer.score !== undefined && answer.probabilities !== undefined ? answer : null;
  return answer.noul !== undefined ? answer : null;
}

/**
 * ONE request to Jev: several typed questions over one state. Throws
 * `JevError` on a refused, malformed or aborted call, or when an asked
 * question has no answer of its type; the message never carries the credential.
 * A retryable status (408, 429, 5xx) is retried ONCE, and only when the wait
 * the server asks for still leaves room for an answer before `deadlineAt`.
 */
export async function jevAsk(args: {
  readonly apiKey: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JevQuestion>>;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Epoch ms after which no retry is worth waiting for. Without one, no retry. */
  readonly deadlineAt?: number;
}): Promise<JevResult> {
  checkShapes(args.questions);
  const body = JSON.stringify({ model: JEV_MODEL, state: args.state, questions: args.questions });
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await (args.fetchImpl ?? fetch)(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
        body,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (error) {
      if (args.signal?.aborted) throw new JevError('aborted');
      const message = error instanceof Error ? error.message : String(error);
      throw new JevError(`request failed: ${scrubbed(message, args.apiKey)}${networkCause(error)}`);
    }
    const text = await response.text().catch(() => '');
    if (args.signal?.aborted) throw new JevError('aborted');
    if (!response.ok) {
      if (attempt === 0 && retryable(response.status) && args.deadlineAt !== undefined) {
        const wait = retryDelayMs(response.headers);
        if (Date.now() + wait + RETRY_ANSWER_ALLOWANCE_MS <= args.deadlineAt) {
          await pause(wait, args.signal);
          continue;
        }
      }
      throw new JevError(`HTTP ${response.status}${attempt > 0 ? ' after one retry' : ''}: ${scrubbed(text, args.apiKey)}`);
    }
    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(text));
    } catch {
      throw new JevError(`unreadable response: ${scrubbed(text, args.apiKey)}`);
    }
    const answers: Record<string, JevAnswer> = {};
    for (const [id, question] of Object.entries(args.questions)) {
      const answer = completeAnswer(question, parsed.answers[id]);
      if (!answer) throw new JevError(`response carries no ${question.type} answer for "${id}"`);
      answers[id] = answer;
    }
    const inputTokens = parsed.usage?.input_tokens ?? 0;
    const outputTokens = parsed.usage?.output_tokens ?? 0;
    const requestId = response.headers.get('x-typesafe-request-id');
    return {
      ...(parsed.model ? { servedModel: parsed.model } : {}),
      ...(requestId ? { requestId } : {}),
      answers,
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(
        { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        JEV_PRICES
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// The questions the decider asked on 2026-09-28: the calibration's baseline
// ---------------------------------------------------------------------------

const CHOICE_INSTRUCTIONS: Record<JevChoiceRequest['question'], string> = {
  agent:
    'A supervisor must hand the task in the state to ONE of the candidate agent types, or to none of them. ' +
    'Pick the candidate whose described capability clearly fits what the task needs. When several candidates ' +
    'can do it, pick the one with the fewest capabilities the task does not use: a word the task shares with ' +
    'a capability it does not need (a README is written, not searched for) is no reason to pick that ' +
    `candidate. If no candidate clearly fits, pick ${NO_CANDIDATE}: a wrong pick costs a whole supervision ` +
    `cycle, while ${NO_CANDIDATE} only hands the task to a supervisor that plans it.`,
  // The build-versus-verify split is the confusion the skills contract names
  // (same vocabulary, opposite work); run fd64b07e picked a serve-and-validate
  // recipe at 0.54 for a task that had to change the page.
  recipe:
    'An agent is about to do the task in the state. Pick the ONE stored recipe that clearly matches this task, ' +
    `or ${NO_CANDIDATE} when none does. A recipe matches when its "when to use" describes this kind of task, ` +
    'not merely when it shares tools or words with it. First decide whether the task must create or change ' +
    'files: a recipe that only serves, verifies, probes or documents does not match a task that must change ' +
    'the code, and a recipe that builds does not match a task that must only verify.',
};

const TWIN_INSTRUCTIONS: Record<JevTwinRequest['kind'], string> = {
  task:
    'A new recipe was just drafted from a successful run (the state). Does ONE of the existing recipes already ' +
    'apply to the same kind of task and prescribe essentially the same steps, so that saving the draft would ' +
    `create a duplicate? Pick that recipe, or ${NEW_RECIPE} when the draft covers a situation none of them ` +
    'covers. Recipes that share tools or words but differ in what they produce, or in whether they change files, ' +
    'are NOT duplicates.',
  event:
    'A new failure-recovery recipe was just drafted (the state): it says which reported failure it applies to and ' +
    'what to do differently on the retry. Does ONE of the existing recovery recipes already react to the same ' +
    `failure with essentially the same remedy? Pick it, or ${NEW_RECIPE} when the draft reacts to a failure none ` +
    'of them covers.',
};

// The model prefilter's own criterion (PREFILTER_SYSTEM_PROMPT): orthogonal
// only, coupled by default. A decomposable reuse costs a full cell plan call,
// which is exactly what the prefilter decision exists to save.
const DECOMPOSABLE_INSTRUCTIONS =
  'Does the task in the state ask for several GENUINELY ORTHOGONAL deliverables — pieces that share no code, ' +
  'no references and do not depend on one another, like three unrelated pages or three separate datasets? ' +
  'Answer false for one artefact, and for pieces of one feature that belong together: a server and the page ' +
  'that calls it, a library and its tests, code and the README that documents it.';

const APPROVAL_INSTRUCTIONS: Record<JevApprovalRequest['subject'], string> = {
  PLAN:
    "Is the child agent's PLAN in the state a correct way to do the task? True only when the plan addresses " +
    'every requirement of the task, relies only on the tools the child declares, and proposes concrete actions. ' +
    'False when it misses a requirement, needs a tool the child does not declare, or stays vague.',
  RESULT:
    "Does the child agent's RESULT in the state complete the task? True only when every requirement of the task " +
    'is addressed AND each claim the result makes is supported by the recorded evidence or the ground truth ' +
    '(tool outputs, probes, files read back). False when a requirement is missing, the evidence contradicts a ' +
    'claim, or a claim rests on narrative alone.',
};

function choiceOptions(request: JevChoiceRequest): Record<string, string> | string {
  if (request.candidates.length + 1 > JEV_MAX_OPTIONS) {
    return `${request.candidates.length} candidates exceed the ${JEV_MAX_OPTIONS - 1} a Choice can carry`;
  }
  const options: Record<string, string> = {};
  for (const candidate of request.candidates) {
    if (candidate.name === NO_CANDIDATE) return `a candidate is named ${NO_CANDIDATE}`;
    options[candidate.name] = candidate.description;
  }
  options[NO_CANDIDATE] =
    request.question === 'agent'
      ? 'No candidate clearly has the capability this task needs.'
      : 'No stored recipe clearly matches this task.';
  return options;
}

/**
 * Jev's pick, READ OVER IDENTICAL DESCRIPTIONS. Candidates described alike are
 * one option to a reader of descriptions: Jev spreads its probability across
 * them (run dbfaf275: four full-stack clones at 0.19–0.23, raw confidence
 * 0.15), and its raw argmax is then a coin toss among clones. So probability
 * is summed per description, the heaviest group wins against
 * `none_of_these`, and within it the FIRST candidate in catalog order is
 * taken — the registry lists by creation, so that is the canonical type
 * the others were branched from.
 */
function resolveIdenticalCandidates(
  candidates: JevChoiceRequest['candidates'],
  probabilities: Readonly<Record<string, number>>
): { readonly target: string | null; readonly confidence: number; readonly groupSize: number } {
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    const names = groups.get(candidate.description) ?? [];
    names.push(candidate.name);
    groups.set(candidate.description, names);
  }
  let best: { names: string[]; mass: number } | null = null;
  for (const names of groups.values()) {
    const mass = names.reduce((sum, name) => sum + (probabilities[name] ?? 0), 0);
    if (!best || mass > best.mass) best = { names, mass };
  }
  const none = probabilities[NO_CANDIDATE] ?? 0;
  if (!best || none >= best.mass) return { target: null, confidence: none, groupSize: 0 };
  return { target: best.names[0]!, confidence: best.mass, groupSize: best.names.length };
}

/** A pure reading of what the legacy decider does with its answer: its decision, outcome, answer and failure. */
export interface LegacyReading<D> {
  readonly decision: D | null;
  readonly outcome: string;
  readonly answer?: NonNullable<JevDecisionInfo['answer']>;
  readonly failure?: string;
}

/** The legacy prefilter question: one Choice over the candidates, and `decomposable` at L2. */
export function legacyChoice(
  request: JevChoiceRequest
): { readonly state: unknown; readonly questions: Readonly<Record<string, JevQuestion>> } | string {
  const options = choiceOptions(request);
  if (typeof options === 'string') return options;
  // Decomposition matters only where a reuse can short-circuit planning:
  // the L2 child catalog. L3 hands any pick to its strategy call anyway.
  const asksDecomposition = request.question === 'agent' && request.actorTier !== 3;
  return {
    state: taskState(request.task),
    questions: {
      choice: { type: 'choice', instructions: CHOICE_INSTRUCTIONS[request.question], criteria: options },
      ...(asksDecomposition ? { decomposable: { type: 'noul' as const, instructions: DECOMPOSABLE_INSTRUCTIONS } } : {}),
    },
  };
}

export function legacyReadChoice(request: JevChoiceRequest, answers: JevAnswers): LegacyReading<JevChoiceDecision> {
  const choice = answers['choice']!;
  const picked = choice.choice!;
  const decomposableYes = answers['decomposable']?.noul;
  const answer = {
    choice: picked,
    ...(choice.confidence !== undefined ? { confidence: choice.confidence } : {}),
    ...(choice.probabilities ? { probabilities: choice.probabilities } : {}),
    ...(decomposableYes !== undefined ? { yes: { decomposable: decomposableYes } } : {}),
  };
  const known = picked === NO_CANDIDATE || request.candidates.some((candidate) => candidate.name === picked);
  const resolved = known ? resolveIdenticalCandidates(request.candidates, choice.probabilities ?? {}) : null;
  const target = resolved?.target ?? null;
  const decomposable = (decomposableYes ?? 0) >= JEV_DECOMPOSABLE_THRESHOLD;
  const clones = resolved && resolved.groupSize > 1 ? ` (first of ${resolved.groupSize} identical)` : '';
  return {
    decision: known && resolved ? { target, confidence: resolved.confidence, decomposable } : null,
    // What Jev PICKED, handed to the caller — not the route: the L2 browser
    // redirect may still change the child, and at L3 a pick is a hint.
    outcome: !known
      ? 'model decides'
      : target
        ? `picked ${target}${clones}${decomposable ? ' (decomposable)' : ''}`
        : `picked ${NO_CANDIDATE}`,
    answer,
    ...(known ? {} : { failure: `answer "${picked}" is not an option` }),
  };
}

/** The legacy approval question: one Noul judging the whole plan or result. */
export function legacyApproval(
  request: JevApprovalRequest
): { readonly state: unknown; readonly questions: Readonly<Record<string, JevQuestion>> } | string {
  try {
    const state = {
      ...taskState(request.task),
      child: { name: request.child.name, tier: request.child.tier, declaredTools: request.child.tools },
      ...(request.subject === 'PLAN'
        ? { plan: capped(request.payload, JEV_STATE_CHARS.plan) }
        : { result: resultState(request.payload) }),
      ...(request.evidence !== undefined ? { evidence: newestEvidence(request.evidence, JEV_STATE_CHARS.evidence) } : {}),
      ...(request.groundTruth ? { groundTruth: headAndTail(request.groundTruth, JEV_STATE_CHARS.groundTruth) } : {}),
    };
    return { state, questions: { acceptable: { type: 'noul', instructions: APPROVAL_INSTRUCTIONS[request.subject] } } };
  } catch (error) {
    // A payload that cannot be serialised (a cycle, a BigInt) is the model's to judge.
    return `unserialisable state: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function legacyReadApproval(answers: JevAnswers): LegacyReading<JevApprovalDecision> {
  const probability = answers['acceptable']!.noul!;
  const approved = probability >= JEV_APPROVAL_THRESHOLD;
  return {
    decision: { approved, probability },
    outcome: approved ? 'approved' : 'deferred to the model',
    answer: { yes: { acceptable: probability } },
  };
}

/** The legacy twin question: one Choice over the existing recipes and `new_recipe`, or `null` with nothing to ask. */
export function legacyTwin(
  request: JevTwinRequest
): { readonly state: unknown; readonly questions: Readonly<Record<string, JevQuestion>>; readonly options: Readonly<Record<string, string>> } | null {
  if (request.existing.length === 0) return null;
  const options: Record<string, string> = {};
  for (const recipe of request.existing.slice(0, JEV_MAX_OPTIONS - 1)) {
    if (recipe.id === NEW_RECIPE) continue;
    options[recipe.id] = `${recipe.description} — applies when: ${recipe.whenToUse}`;
  }
  options[NEW_RECIPE] = 'The draft covers a situation none of the existing recipes covers.';
  if (Object.keys(options).length < 2) return null;
  return {
    state: {
      draft: {
        id: request.draft.id,
        description: request.draft.description,
        applies_when: request.draft.whenToUse,
        steps: capped(request.draft.body, JEV_STATE_CHARS.plan),
      },
    },
    questions: { choice: { type: 'choice', instructions: TWIN_INSTRUCTIONS[request.kind], criteria: options } },
    options,
  };
}

export function legacyReadTwin(options: Readonly<Record<string, string>>, answers: JevAnswers): LegacyReading<JevTwinDecision> {
  const choice = answers['choice']!;
  const picked = choice.choice!;
  const known = picked === NEW_RECIPE || picked in options;
  const twinOf = known && picked !== NEW_RECIPE ? picked : null;
  return {
    decision: known ? { twinOf, confidence: choice.confidence ?? 0 } : null,
    outcome: !known ? 'saved as before' : twinOf ? `not saved: twin of ${twinOf}` : 'saved: new recipe',
    answer: {
      choice: picked,
      ...(choice.confidence !== undefined ? { confidence: choice.confidence } : {}),
      ...(choice.probabilities ? { probabilities: choice.probabilities } : {}),
    },
    ...(known ? {} : { failure: `answer "${picked}" is not an option` }),
  };
}

// ---------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------

/**
 * The Jev decider. `record` receives exactly one `JevDecisionInfo` per
 * decision asked, answered or not. Never throws: every failure is recorded and
 * answered with `null`, which hands the decision back to the model.
 */
export function createJevDecider(opts: {
  readonly apiKey: string;
  readonly record: (info: JevDecisionInfo) => void;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxFailures?: number;
}): JevDecider {
  const timeoutMs = opts.timeoutMs ?? JEV_DECISION_TIMEOUT_MS;
  const maxFailures = opts.maxFailures ?? JEV_MAX_FAILURES_PER_RUN;
  // Per decider, which is per run: a run process builds exactly one.
  let failures = 0;

  const safeRecord = (info: JevDecisionInfo): void => {
    try {
      opts.record(info);
    } catch {
      // Observer-only: a recorder that throws must not reach the run.
    }
  };

  type Asked =
    | { readonly ok: true; readonly result: JevResult; readonly durationMs: number }
    | { readonly ok: false; readonly failure: string; readonly durationMs: number };

  /** One bounded call, with the breaker and the run's cancellation applied. */
  async function ask(
    state: unknown,
    questions: Readonly<Record<string, JevQuestion>>,
    signal: AbortSignal | undefined
  ): Promise<Asked> {
    if (signal?.aborted) return { ok: false, failure: 'aborted: the run was cancelled', durationMs: 0 };
    if (failures >= maxFailures) {
      return { ok: false, failure: `skipped: ${failures} failed calls in this run`, durationMs: 0 };
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      const result = await jevAsk({
        apiKey: opts.apiKey,
        state,
        questions,
        signal: controller.signal,
        deadlineAt: startedAt + timeoutMs,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      return { ok: true, result, durationMs: Date.now() - startedAt };
    } catch (error) {
      const cancelled = !timedOut && signal?.aborted === true;
      if (!cancelled) failures += 1;
      return {
        ok: false,
        failure: timedOut
          ? `timeout: no answer within ${timeoutMs} ms`
          : cancelled
            ? 'aborted: the run was cancelled'
            : error instanceof Error
              ? error.message
              : String(error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  const unanswered = { usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
  const attribution = (request: {
    readonly actorName?: string;
    readonly actorTier?: JevDecisionInfo['actorTier'];
    readonly branchId?: string;
  }) => ({
    ...(request.actorName !== undefined ? { actorName: request.actorName } : {}),
    ...(request.actorTier !== undefined ? { actorTier: request.actorTier } : {}),
    ...(request.branchId !== undefined ? { branchId: request.branchId } : {}),
  });
  const answered = (asked: Extract<Asked, { ok: true }>) => ({
    ...(asked.result.servedModel ? { servedModel: asked.result.servedModel } : {}),
    ...(asked.result.requestId ? { requestId: asked.result.requestId } : {}),
    durationMs: asked.durationMs,
    usage: { inputTokens: asked.result.inputTokens, outputTokens: asked.result.outputTokens },
    costUsd: asked.result.costUsd,
  });

  return {
    async choose(request: JevChoiceRequest): Promise<JevChoiceDecision | null> {
      const base = {
        role: 'prefilter' as const,
        evaluator: JEV_EVALUATOR,
        candidates: request.candidates.map((candidate) => candidate.name),
        ...attribution(request),
      };
      const plan = buildChoice(request);
      if (typeof plan === 'string') {
        safeRecord({ ...base, ...unanswered, outcome: 'model decides', failure: plan, durationMs: 0 });
        return null;
      }
      const asked = await ask(plan.state, plan.questions, request.signal);
      if (!asked.ok) {
        safeRecord({ ...base, ...unanswered, outcome: 'model decides', failure: asked.failure, durationMs: asked.durationMs });
        return null;
      }
      const reading = readChoice(plan, asked.result.answers);
      const stray = reading.causes?.includes('not_an_option') ? asked.result.answers['choice']?.choice : undefined;
      safeRecord({
        ...base,
        ...answered(asked),
        answer: reading.answer,
        outcome: reading.outcome,
        ...(stray !== undefined ? { failure: `answer "${stray}" is not an option` } : {}),
      });
      return reading.decision;
    },

    async approve(request: JevApprovalRequest): Promise<JevApprovalDecision | null> {
      const role = request.subject === 'PLAN' ? ('validate-plan' as const) : ('validate-result' as const);
      const base = {
        role,
        evaluator: JEV_EVALUATOR,
        childName: request.child.name,
        ...attribution(request),
      };
      const plan = buildApproval(request);
      if (typeof plan === 'string') {
        safeRecord({ ...base, ...unanswered, outcome: 'deferred to the model', failure: plan, durationMs: 0 });
        return null;
      }
      const asked = await ask(plan.state, plan.questions, request.signal);
      if (!asked.ok) {
        safeRecord({ ...base, ...unanswered, outcome: 'deferred to the model', failure: asked.failure, durationMs: asked.durationMs });
        return null;
      }
      const reading = readApproval(plan, asked.result.answers);
      safeRecord({ ...base, ...answered(asked), answer: reading.answer, outcome: reading.outcome });
      return reading.decision;
    },

    async twin(request: JevTwinRequest): Promise<JevTwinDecision | null> {
      const role = request.kind === 'task' ? ('learn-skill' as const) : ('learn-event-skill' as const);
      const plan = buildTwin(request);
      // Nothing to duplicate: no question, and nothing to record.
      if (!plan) return null;
      const base = {
        role,
        evaluator: JEV_EVALUATOR,
        candidates: plan.ids,
        ...attribution(request),
      };
      const asked = await ask(plan.state, plan.questions, request.signal);
      if (!asked.ok) {
        safeRecord({ ...base, ...unanswered, outcome: 'saved as before', failure: asked.failure, durationMs: asked.durationMs });
        return null;
      }
      const reading = readTwin(plan, asked.result.answers);
      safeRecord({ ...base, ...answered(asked), answer: reading.answer, outcome: reading.outcome });
      return reading.decision;
    },
  };
}

/**
 * Whether the runs a host launches let Jev decide: in EVERY organisation,
 * existing or new, and every run, whenever the host holds the credential and
 * its platform switch is not `0` — the owner's "toutes les orgs, existantes ou
 * nouvelles, et tous les runs doivent utiliser Jev" (2026-09-30), taken knowing
 * that each decision's state then reaches TypeSafe for organisations that are
 * not the operator's. Until then only the organisations the host named in
 * `ATOMA_JEV_ORGS` did.
 */
export function jevEnabled(hostEnv: NodeJS.ProcessEnv): boolean {
  return hostEnv[JEV_ENV] !== '0' && Boolean(hostEnv[JEV_KEY_ENV]?.trim());
}

/**
 * One line saying whether the HOST lets Jev decide, printed at server start:
 * Jev is expected in every run, so a missing key is said, never silent, and a
 * leftover `ATOMA_JEV_ORGS` is said to limit nothing any more.
 */
export function describeJevAdmission(hostEnv: NodeJS.ProcessEnv): string {
  const leftover = hostEnv[JEV_ORGS_ENV]?.trim() ? `; ${JEV_ORGS_ENV} is no longer read and can be removed` : '';
  if (hostEnv[JEV_ENV] === '0') return `jev: off for every run (${JEV_ENV}=0)${leftover}`;
  if (!hostEnv[JEV_KEY_ENV]?.trim()) return `jev: off (${JEV_KEY_ENV} is absent, so no run can ask it)${leftover}`;
  return `jev: deciding in every run (${JEV_EVALUATOR})${leftover}`;
}

/**
 * The decider a run gets from its environment snapshot: present whenever the
 * credential is there, unless the switch the run inherited is `0`.
 */
export function jevDeciderFromEnv(
  env: NodeJS.ProcessEnv,
  record: (info: JevDecisionInfo) => void
): JevDecider | undefined {
  if (env[JEV_ENV] === '0') return undefined;
  const apiKey = env[JEV_KEY_ENV]?.trim();
  if (!apiKey) return undefined;
  return createJevDecider({ apiKey, record });
}
