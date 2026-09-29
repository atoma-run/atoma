import { z } from 'zod';
import { estimateCostUsd, type ModelPrices } from './metrics.js';
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

/**
 * JEV (TypeSafe) TAKES THE BOUNDED DECISIONS IT CAN TAKE.
 * =======================================================
 *
 * Owner decision of 2026-09-28 (docs/jev-decisions-2026-09-28.md): "trust Jev,
 * and we will see". Jev is a typed decision model — it answers Choice and
 * yes/no (Noul) questions over a state, far faster and cheaper than a model
 * call — so it takes the prefilter's pick and the APPROVAL half of plan and
 * result validation. It writes no text, so a refusal is always the model
 * validator's: that is where the remediation comes from.
 *
 * It is deliberately NOT in `modelCatalog.json`: adding its vendor to
 * `MODEL_SELECTOR_VENDORS` would make `api:typesafe:*` a routable tier selector
 * that no transport serves. Its one price therefore lives here, beside its one
 * client, and is applied with the one cost formula (`estimateCostUsd`).
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_EVALUATOR = `typesafe:${JEV_MODEL}`;

/** The credential. Crosses into a project run only for an admitted organisation. */
export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';
/** The run child's switch, written by the coordinator; an operator sets it by hand. */
export const JEV_ENV = 'ATOMA_JEV';
/** HOST only: comma-separated organisation ids whose project runs let Jev decide. */
export const JEV_ORGS_ENV = 'ATOMA_JEV_ORGS';

/**
 * USD per million tokens, as `ModelPrices` expects. Read 2026-09-28 from the
 * Cloudflare Workers AI listing of the model
 * (https://developers.cloudflare.com/ai/models/typesafe/jev/: input 0.042,
 * output and cached input 0). The TypeSafe docs publish no price page, so the
 * direct API's price is ASSUMED equal until an invoice says otherwise.
 */
export const JEV_PRICES: ModelPrices = { input: 0.042, output: 0, cachedInput: 0 };

/**
 * Longest a decision waits for Jev before the model takes it instead. Jev's
 * point is speed: a slower answer is worth less than the model's.
 */
export const JEV_DECISION_TIMEOUT_MS = 2_000;
/**
 * Failed calls after which a run stops asking Jev — counted over the whole run
 * and never reset by a success, so neither parallel lanes nor a flapping
 * service can keep a run paying timeouts: at most this many per run.
 */
export const JEV_MAX_FAILURES_PER_RUN = 3;
/** Jev's own "yes": a validation is approved at this probability or above. */
export const JEV_APPROVAL_THRESHOLD = 0.5;
/** Jev's documented ceiling on the options of one Choice question. */
const JEV_MAX_OPTIONS = 255;
/** Ceilings on what a validation state carries (Jev's context is 32k tokens). */
const SUMMARY_CHARS = 6_000;
const OUTPUT_CHARS = 14_000;
const PLAN_CHARS = 20_000;
const EVIDENCE_CHARS = 20_000;
const GROUND_TRUTH_CHARS = 8_000;
const EXCERPT_CHARS = 200;

export type JevQuestion =
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'noul'; readonly instructions: string };

const answerSchema = z.object({
  choice: z.string().optional(),
  probabilities: z.record(z.string(), z.number().finite()).optional(),
  confidence: z.number().finite().optional(),
  noul: z.number().finite().optional(),
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

export type JevAnswer = z.infer<typeof answerSchema>;

export interface JevResult {
  readonly servedModel?: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
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
 * ONE request to Jev: several typed questions over one state. Throws
 * `JevError` on a refused, malformed or aborted call, or when an asked
 * question has no answer of its type; the message never carries the credential.
 */
export async function jevAsk(args: {
  readonly apiKey: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JevQuestion>>;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<JevResult> {
  for (const [id, question] of Object.entries(args.questions)) {
    if (question.type !== 'choice') continue;
    const count = Object.keys(question.criteria).length;
    if (count < 2 || count > JEV_MAX_OPTIONS) {
      throw new JevError(`choice "${id}" needs 2 to ${JEV_MAX_OPTIONS} options, got ${count}`);
    }
  }
  const body = JSON.stringify({ model: JEV_MODEL, state: args.state, questions: args.questions });
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
    throw new JevError(`HTTP ${response.status}: ${scrubbed(text, args.apiKey)}`);
  }
  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(JSON.parse(text));
  } catch {
    throw new JevError(`unreadable response: ${scrubbed(text, args.apiKey)}`);
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(args.questions)) {
    const answer = answerSchema.safeParse(parsed.answers[id]);
    const complete =
      answer.success &&
      (question.type === 'choice'
        ? answer.data.choice !== undefined && answer.data.probabilities !== undefined
        : answer.data.noul !== undefined);
    if (!complete) throw new JevError(`response carries no ${question.type} answer for "${id}"`);
    answers[id] = answer.data;
  }
  const inputTokens = parsed.usage?.input_tokens ?? 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;
  return {
    ...(parsed.model ? { servedModel: parsed.model } : {}),
    answers,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(
      { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      JEV_PRICES
    ),
  };
}

/** The option Jev picks when no candidate fits — the prefilter's `escalate`. */
export const NO_CANDIDATE = 'none_of_these';

const CHOICE_INSTRUCTIONS: Record<JevChoiceRequest['question'], string> = {
  agent:
    'A supervisor must hand the task in the state to ONE of the candidate agent types, or to none of them. ' +
    'Pick the candidate whose described capability clearly fits what the task needs. When several candidates ' +
    'can do it, pick the one with the fewest capabilities the task does not use: a word the task shares with ' +
    'a capability it does not need (a README is written, not searched for) is no reason to pick that ' +
    `candidate. If no candidate clearly fits, pick ${NO_CANDIDATE}: a wrong pick costs a whole supervision ` +
    `cycle, while ${NO_CANDIDATE} only hands the task to a supervisor that plans it.`,
  recipe:
    'An agent is about to do the task in the state. Pick the ONE stored recipe that clearly matches this task, ' +
    `or ${NO_CANDIDATE} when none does. A recipe matches when its "when to use" describes this kind of task, ` +
    'not merely when it shares tools or words with it.',
};

/** The option Jev picks when a draft recipe duplicates none of the existing ones. */
export const NEW_RECIPE = 'new_recipe';

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

const DECOMPOSABLE_INSTRUCTIONS =
  'Does the task in the state ask for several independent deliverables that are better planned as separate ' +
  'subtasks, rather than one piece of work a single agent can carry end to end?';

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

function capped(value: unknown, chars: number): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length > chars ? `${text.slice(0, chars)}… [truncated]` : value;
}

/** A long text kept by its head AND its tail: a block's last section is often its verdict. */
function headAndTail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const half = Math.floor(chars / 2);
  return `${text.slice(0, half)}\n… [middle truncated] …\n${text.slice(-half)}`;
}

/**
 * Observations kept NEWEST first, as the model validator budgets them: a page
 * that passed early and broke after a later rewrite is judged on the break.
 */
function newestEvidence(evidence: unknown, chars: number): unknown {
  if (!Array.isArray(evidence)) return capped(evidence, chars);
  const kept: unknown[] = [];
  let used = 0;
  for (let index = evidence.length - 1; index >= 0; index--) {
    const size = JSON.stringify(evidence[index])?.length ?? 0;
    if (used + size > chars) break;
    kept.unshift(evidence[index]);
    used += size;
  }
  const dropped = evidence.length - kept.length;
  return dropped > 0 ? [`… ${dropped} older observations omitted`, ...kept] : kept;
}

/** The RESULT the model validator reads, with its summary never pushed out by a long output. */
function resultState(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return capped(payload, OUTPUT_CHARS);
  const { summary, output } = payload as { summary?: unknown; output?: unknown };
  return {
    summary: capped(summary, SUMMARY_CHARS),
    output: capped(output, OUTPUT_CHARS),
  };
}

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

function taskState(task: JevChoiceRequest['task']): Record<string, unknown> {
  return {
    task: task.description,
    ...(task.constraints?.length ? { constraints: task.constraints } : {}),
  };
}

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

  return {
    async choose(request: JevChoiceRequest): Promise<JevChoiceDecision | null> {
      const base = {
        role: 'prefilter' as const,
        evaluator: JEV_EVALUATOR,
        candidates: request.candidates.map((candidate) => candidate.name),
        ...attribution(request),
      };
      const options = choiceOptions(request);
      if (typeof options === 'string') {
        safeRecord({ ...base, ...unanswered, outcome: 'model decides', failure: options, durationMs: 0 });
        return null;
      }
      // Decomposition matters only where a reuse can short-circuit planning:
      // the L2 child catalog. L3 hands any pick to its strategy call anyway.
      const asksDecomposition = request.question === 'agent' && request.actorTier !== 3;
      const questions: Record<string, JevQuestion> = {
        choice: { type: 'choice', instructions: CHOICE_INSTRUCTIONS[request.question], criteria: options },
        ...(asksDecomposition
          ? { decomposable: { type: 'noul' as const, instructions: DECOMPOSABLE_INSTRUCTIONS } }
          : {}),
      };
      const asked = await ask(taskState(request.task), questions, request.signal);
      if (!asked.ok) {
        safeRecord({ ...base, ...unanswered, outcome: 'model decides', failure: asked.failure, durationMs: asked.durationMs });
        return null;
      }
      const { result } = asked;
      const choice = result.answers['choice']!;
      const picked = choice.choice!;
      const decomposableYes = result.answers['decomposable']?.noul;
      const answer = {
        choice: picked,
        ...(choice.confidence !== undefined ? { confidence: choice.confidence } : {}),
        ...(choice.probabilities ? { probabilities: choice.probabilities } : {}),
        ...(decomposableYes !== undefined ? { yes: { decomposable: decomposableYes } } : {}),
      };
      const known = picked === NO_CANDIDATE || request.candidates.some((candidate) => candidate.name === picked);
      const target = picked === NO_CANDIDATE ? null : picked;
      const decomposable = (decomposableYes ?? 0) >= JEV_APPROVAL_THRESHOLD;
      safeRecord({
        ...base,
        ...(result.servedModel ? { servedModel: result.servedModel } : {}),
        answer,
        // What Jev PICKED, handed to the caller — not the route: the L2 browser
        // redirect may still change the child, and at L3 a pick is a hint.
        outcome: !known
          ? 'model decides'
          : target
            ? `picked ${target}${decomposable ? ' (decomposable)' : ''}`
            : `picked ${NO_CANDIDATE}`,
        ...(known ? {} : { failure: `answer "${picked}" is not an option` }),
        durationMs: asked.durationMs,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        costUsd: result.costUsd,
      });
      if (!known) return null;
      return { target, confidence: choice.confidence ?? 0, decomposable };
    },

    async approve(request: JevApprovalRequest): Promise<JevApprovalDecision | null> {
      const role = request.subject === 'PLAN' ? ('validate-plan' as const) : ('validate-result' as const);
      const base = {
        role,
        evaluator: JEV_EVALUATOR,
        childName: request.child.name,
        ...attribution(request),
      };
      let state: Record<string, unknown>;
      try {
        state = {
          ...taskState(request.task),
          child: { name: request.child.name, tier: request.child.tier, declaredTools: request.child.tools },
          ...(request.subject === 'PLAN'
            ? { plan: capped(request.payload, PLAN_CHARS) }
            : { result: resultState(request.payload) }),
          ...(request.evidence !== undefined ? { evidence: newestEvidence(request.evidence, EVIDENCE_CHARS) } : {}),
          ...(request.groundTruth ? { groundTruth: headAndTail(request.groundTruth, GROUND_TRUTH_CHARS) } : {}),
        };
      } catch (error) {
        // A payload that cannot be serialised (a cycle, a BigInt) is the model's to judge.
        const failure = `unserialisable state: ${error instanceof Error ? error.message : String(error)}`;
        safeRecord({ ...base, ...unanswered, outcome: 'deferred to the model', failure, durationMs: 0 });
        return null;
      }
      const asked = await ask(
        state,
        { acceptable: { type: 'noul', instructions: APPROVAL_INSTRUCTIONS[request.subject] } },
        request.signal
      );
      if (!asked.ok) {
        safeRecord({ ...base, ...unanswered, outcome: 'deferred to the model', failure: asked.failure, durationMs: asked.durationMs });
        return null;
      }
      const probability = asked.result.answers['acceptable']!.noul!;
      const approved = probability >= JEV_APPROVAL_THRESHOLD;
      safeRecord({
        ...base,
        ...(asked.result.servedModel ? { servedModel: asked.result.servedModel } : {}),
        answer: { yes: { acceptable: probability } },
        outcome: approved ? 'approved' : 'deferred to the model',
        durationMs: asked.durationMs,
        usage: { inputTokens: asked.result.inputTokens, outputTokens: asked.result.outputTokens },
        costUsd: asked.result.costUsd,
      });
      return { approved, probability };
    },

    async twin(request: JevTwinRequest): Promise<JevTwinDecision | null> {
      const role = request.kind === 'task' ? ('learn-skill' as const) : ('learn-event-skill' as const);
      // Nothing to duplicate: no question, and nothing to record.
      if (request.existing.length === 0) return null;
      const base = {
        role,
        evaluator: JEV_EVALUATOR,
        candidates: request.existing.map((recipe) => recipe.id),
        ...attribution(request),
      };
      const options: Record<string, string> = {};
      for (const recipe of request.existing.slice(0, JEV_MAX_OPTIONS - 1)) {
        if (recipe.id === NEW_RECIPE) continue;
        options[recipe.id] = `${recipe.description} — applies when: ${recipe.whenToUse}`;
      }
      options[NEW_RECIPE] = 'The draft covers a situation none of the existing recipes covers.';
      if (Object.keys(options).length < 2) return null;
      const state = {
        draft: {
          id: request.draft.id,
          description: request.draft.description,
          applies_when: request.draft.whenToUse,
          steps: capped(request.draft.body, PLAN_CHARS),
        },
      };
      const asked = await ask(
        state,
        { choice: { type: 'choice', instructions: TWIN_INSTRUCTIONS[request.kind], criteria: options } },
        request.signal
      );
      if (!asked.ok) {
        safeRecord({ ...base, ...unanswered, outcome: 'saved as before', failure: asked.failure, durationMs: asked.durationMs });
        return null;
      }
      const choice = asked.result.answers['choice']!;
      const picked = choice.choice!;
      const known = picked === NEW_RECIPE || picked in options;
      const twinOf = known && picked !== NEW_RECIPE ? picked : null;
      safeRecord({
        ...base,
        ...(asked.result.servedModel ? { servedModel: asked.result.servedModel } : {}),
        answer: {
          choice: picked,
          ...(choice.confidence !== undefined ? { confidence: choice.confidence } : {}),
          ...(choice.probabilities ? { probabilities: choice.probabilities } : {}),
        },
        outcome: !known ? 'saved as before' : twinOf ? `not saved: twin of ${twinOf}` : 'saved: new recipe',
        ...(known ? {} : { failure: `answer "${picked}" is not an option` }),
        durationMs: asked.durationMs,
        usage: { inputTokens: asked.result.inputTokens, outputTokens: asked.result.outputTokens },
        costUsd: asked.result.costUsd,
      });
      if (!known) return null;
      return { twinOf, confidence: choice.confidence ?? 0 };
    },
  };
}

function listedOrgs(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((id) => id.trim()).filter(Boolean));
}

/**
 * Whether a project run of `orgId` lets Jev decide: the host holds the
 * credential AND names that organisation. Anything missing answers no.
 */
export function jevAdmitsOrg(hostEnv: NodeJS.ProcessEnv, orgId: string | undefined): boolean {
  if (!orgId || !hostEnv[JEV_KEY_ENV]?.trim()) return false;
  return listedOrgs(hostEnv[JEV_ORGS_ENV]).has(orgId);
}

const ORG_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One line saying whether the HOST lets Jev decide, and why not — printed at
 * server start, because a missing key or a slug written for an id otherwise
 * turns Jev off in silence. `null` when the host asks nothing of Jev.
 */
export function describeJevAdmission(hostEnv: NodeJS.ProcessEnv): string | null {
  const orgs = [...listedOrgs(hostEnv[JEV_ORGS_ENV])];
  const hasKey = Boolean(hostEnv[JEV_KEY_ENV]?.trim());
  if (orgs.length === 0) return hasKey ? `jev: off (${JEV_KEY_ENV} is set but ${JEV_ORGS_ENV} names no organisation)` : null;
  if (!hasKey) return `jev: off (${JEV_ORGS_ENV} names ${orgs.length} organisation(s) but ${JEV_KEY_ENV} is absent)`;
  const malformed = orgs.filter((id) => !ORG_ID_SHAPE.test(id));
  const suffix =
    malformed.length > 0 ? `; not organisation ids, so they match no run: ${malformed.join(', ')}` : '';
  return `jev: deciding in project runs of ${orgs.length - malformed.length} organisation(s) (${JEV_EVALUATOR})${suffix}`;
}

/**
 * The decider a run gets from its environment snapshot: present only when the
 * switch is `1` and the credential is there, absent otherwise.
 */
export function jevDeciderFromEnv(
  env: NodeJS.ProcessEnv,
  record: (info: JevDecisionInfo) => void
): JevDecider | undefined {
  if (env[JEV_ENV] !== '1') return undefined;
  const apiKey = env[JEV_KEY_ENV]?.trim();
  if (!apiKey) return undefined;
  return createJevDecider({ apiKey, record });
}
