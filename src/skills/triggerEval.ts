/**
 * TRIGGER EVALUATION AT LEARN TIME (owner decision 2026-10-15,
 * docs/skill-trigger-eval-2026-10-15.md).
 *
 * `when_to_use` is the only thing that decides whether a learned recipe is
 * ever picked, and until now nothing measured it before the save: a recipe
 * phrased as disk state was invisible for good, and one phrased too broadly
 * took its siblings' phases (the catalog's measured failure modes, in
 * src/skills/AGENTS.md). The skill-creator method Anthropic publishes closes
 * that gap with a loop — draft, trigger cases, compare, revise — run by a
 * person. Atoma runs it by itself, with ITS OWN selector as the judge:
 *
 *   1. cases: the lesson's task is the first positive; one author call adds
 *      a few paraphrased positives and NEAR-MISS negatives (tasks a sibling
 *      recipe should take, or none); the trigger corpus
 *      (`skill_trigger_samples`) adds the siblings' CREDITED tasks as real
 *      hard negatives, as it fills.
 *   2. evaluation: every case goes through `prefilterStrategy` with the
 *      production skill prompt over the catalog the draft would join — the
 *      very call a run makes, Jev first where present, so what passes here
 *      is what would match in a run.
 *   3. revision: a draft never picked on its positives, or picked on a
 *      negative, gets one author call rewriting `when_to_use` (and the
 *      one-line description) from the failures — the body is never touched
 *      here — and is evaluated again, at most `TRIGGER_EVAL_MAX_REVISIONS`
 *      times.
 *   4. verdict: picked on every positive and on no negative → saved with
 *      the summary in its provenance; still stealing or still invisible →
 *      NOT saved, the reason logged. A case generation or evaluation that
 *      errors ACCEPTS the draft as before (fail-open, like the twin guard):
 *      a lost lesson is cheap, a wrong refusal costs a recipe.
 *
 * Quota: at most one generation call, `TRIGGER_EVAL_MAX_REVISIONS` revision
 * calls, and `(positives + negatives) × (revisions + 1)` cheapest-tier
 * prefilter calls per draft — bounded by the constants below, on the learner's
 * own budget meter where learning is deferred. The owner authorised the spend
 * on 2026-10-15: quota spent on skills that improve the product globally.
 */
import type { RunContext } from '../core/types.js';
import { prefilterStrategy, SKILL_PREFILTER_SYSTEM_PROMPT } from '../atoms/cost.js';
import { extractJson } from '../atoms/json.js';
import { SKILL_AUTHOR_SYSTEM_PROMPT } from './compilePrompt.js';
import type { SkillLifecycleHost } from './lifecycle.js';
import type { TriggerSample } from './metaStore.js';

/** `when_to_use` revisions a draft may receive before the verdict. */
export const TRIGGER_EVAL_MAX_REVISIONS = 2;
/** Generated positives beside the lesson's own task. */
export const TRIGGER_EVAL_GENERATED_POSITIVES = 3;
/** Generated near-miss negatives. */
export const TRIGGER_EVAL_GENERATED_NEGATIVES = 4;
/** Real credited tasks of sibling recipes used as hard negatives (one per recipe, newest first). */
export const TRIGGER_EVAL_CORPUS_NEGATIVES = 4;
/** Characters of a case the author may produce; longer cases are cut. */
const CASE_MAX_CHARS = 600;

/** The draft under evaluation. The body is read by Jev's catalog only. */
export interface TriggerDraft {
  readonly id: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly body: string;
}

/** A recipe the draft would compete with in the catalog it joins. */
export interface CompetingRecipe {
  readonly id: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly body: string;
}

export interface TriggerCase {
  readonly task: string;
  /** The draft's id for a positive; a sibling's id, or null for "none fits", for a negative. */
  readonly expect: string | null;
  readonly source: 'lesson' | 'generated' | 'corpus';
}

export interface TriggerCaseFailure {
  readonly case: TriggerCase;
  /** What the selector picked: a recipe id, or null for escalate. */
  readonly picked: string | null;
}

export interface TriggerEvalRound {
  readonly positives: { readonly total: number; readonly hit: number };
  readonly negatives: { readonly total: number; readonly held: number };
  /** Sibling ids whose cases the draft took. */
  readonly stolenFrom: readonly string[];
  readonly failures: readonly TriggerCaseFailure[];
}

/** What the provenance keeps: counts and the verdict, never the case texts. */
export interface TriggerEvalSummary {
  readonly at: string;
  readonly cases: number;
  readonly positives: { readonly total: number; readonly hit: number };
  readonly negatives: { readonly total: number; readonly held: number };
  readonly stolenFrom: readonly string[];
  readonly revisions: number;
  readonly verdict: 'accepted' | 'rejected' | 'skipped';
  readonly reason?: string;
}

export interface TriggerEvalArgs {
  readonly host: SkillLifecycleHost;
  readonly ctx: RunContext;
  readonly draft: TriggerDraft;
  /** The subtask the draft was distilled from — always the first positive. */
  readonly lessonTask: string;
  readonly competing: readonly CompetingRecipe[];
  /** The trigger corpus of the competing recipes (the draft's own id excluded). */
  readonly corpus?: readonly TriggerSample[];
}

const clip = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, CASE_MAX_CHARS);

const parseStringList = (value: unknown, limit: number): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(clip).slice(0, limit)
    : [];

/**
 * ONE author call: paraphrased positives and near-miss negatives for the
 * draft, in the voice of a planner's subtask. Returns empty lists on a
 * malformed answer; the caller still has the lesson task and the corpus.
 */
export async function generateTriggerCases(args: TriggerEvalArgs): Promise<{
  positives: string[];
  negatives: { task: string; expect: string | null }[];
}> {
  const siblings = args.competing.map((r) => `- ${r.id}: ${r.whenToUse}`);
  const userContent = [
    `You are writing TRIGGER CASES for a skill — a reusable recipe a worker atom follows`,
    `when a planner's subtask matches its "when_to_use" line. A selector reads subtask`,
    `text and the catalog lines ONLY, so a recipe is only ever picked through that line.`,
    ``,
    `== THE RECIPE UNDER EVALUATION ==`,
    `id: ${args.draft.id}`,
    `description: ${args.draft.description}`,
    `when_to_use: ${args.draft.whenToUse}`,
    `body:`,
    args.draft.body,
    ``,
    `== THE SUBTASK IT WAS LEARNED FROM ==`,
    args.lessonTask,
    ``,
    ...(siblings.length > 0
      ? [`== RECIPES IT WILL COMPETE WITH (id: when_to_use) ==`, ...siblings, ``]
      : []),
    `Write subtasks the way a planner phrases them: one paragraph each, concrete,`,
    `naming the artefact and the request, in a DIFFERENT domain from the learned`,
    `subtask (a recipe learned on a movie API must match a book API).`,
    ``,
    `"should_match": ${TRIGGER_EVAL_GENERATED_POSITIVES} subtasks this recipe should drive end to end.`,
    `"should_not_match": ${TRIGGER_EVAL_GENERATED_NEGATIVES} NEAR MISSES — subtasks that share vocabulary`,
    `with the recipe but need a structurally different workflow (it builds, the`,
    `subtask only documents; it probes an API, the subtask writes a static page).`,
    `For each, "expect" is the id of the competing recipe that SHOULD take it, or`,
    `null when none of the listed recipes fits.`,
    ``,
    `Output ONLY a JSON object, first character "{":`,
    `{"should_match": ["..."], "should_not_match": [{"task": "...", "expect": "<id>|null"}]}`,
  ].join('\n');
  const resp = await args.ctx.llm.complete(args.host.toLlmRequest('skill', {
    systemPromptOverride: SKILL_AUTHOR_SYSTEM_PROMPT,
    userContent,
    params: { ...args.host.params, maxTokens: 1800, temperature: 0 },
    ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
  }));
  const parsed = extractJson(resp.text ?? '') as { should_match?: unknown; should_not_match?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') return { positives: [], negatives: [] };
  const known = new Set(args.competing.map((r) => r.id));
  const negatives = Array.isArray(parsed.should_not_match)
    ? parsed.should_not_match
        .filter((v): v is { task: string; expect?: unknown } => !!v && typeof v === 'object' && typeof (v as { task?: unknown }).task === 'string')
        .map((v) => ({
          task: clip(v.task),
          // An expectation naming a recipe the catalog does not hold is "none fits".
          expect: typeof v.expect === 'string' && known.has(v.expect) ? v.expect : null,
        }))
        .filter((v) => v.task.length > 0)
        .slice(0, TRIGGER_EVAL_GENERATED_NEGATIVES)
    : [];
  return { positives: parseStringList(parsed.should_match, TRIGGER_EVAL_GENERATED_POSITIVES), negatives };
}

/**
 * The corpus' contribution: the newest CREDITED task of each sibling, up to
 * `TRIGGER_EVAL_CORPUS_NEGATIVES`, each expecting its own recipe. A blamed
 * task says nothing about where it belonged, so it is not a case.
 */
export function corpusNegatives(corpus: readonly TriggerSample[]): TriggerCase[] {
  const seen = new Set<string>();
  const out: TriggerCase[] = [];
  for (const sample of [...corpus].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) {
    if (sample.outcome !== 'success' || seen.has(sample.skillId)) continue;
    seen.add(sample.skillId);
    out.push({ task: clip(sample.task), expect: sample.skillId, source: 'corpus' });
    if (out.length >= TRIGGER_EVAL_CORPUS_NEGATIVES) break;
  }
  return out;
}

/** The catalog lines exactly as `matchSkill` builds them, with the draft among its siblings. */
function catalogWith(draft: TriggerDraft, competing: readonly CompetingRecipe[]) {
  return [...competing.filter((r) => r.id !== draft.id), draft].map((s) => ({
    name: s.id,
    description: `${s.description}. When to use: ${s.whenToUse}`,
    detail: s.body,
  }));
}

/**
 * One round: every case through the production selector. A positive HITS
 * when the draft is picked; a negative HOLDS when the draft is NOT picked —
 * a sibling or an escalate both hold, because the question this evaluation
 * answers is whether the draft takes what is not its own, not whether the
 * sibling's own line is good (that was judged when the sibling was learned).
 */
export async function evaluateTriggerCases(
  args: Pick<TriggerEvalArgs, 'host' | 'ctx' | 'draft' | 'competing'>,
  cases: readonly TriggerCase[]
): Promise<TriggerEvalRound> {
  const catalog = catalogWith(args.draft, args.competing);
  let hit = 0;
  let held = 0;
  let positives = 0;
  let negatives = 0;
  const stolen = new Set<string>();
  const failures: TriggerCaseFailure[] = [];
  for (const c of cases) {
    const outcome = await prefilterStrategy({
      ctx: args.ctx,
      task: { description: c.task },
      catalog,
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
      actor: { name: args.host.name, tier: 2 },
    });
    const picked = outcome?.kind === 'reuse' ? outcome.target : null;
    if (c.expect === args.draft.id) {
      positives += 1;
      if (picked === args.draft.id) hit += 1;
      else failures.push({ case: c, picked });
    } else {
      negatives += 1;
      if (picked !== args.draft.id) held += 1;
      else {
        failures.push({ case: c, picked });
        if (c.expect) stolen.add(c.expect);
      }
    }
  }
  return {
    positives: { total: positives, hit },
    negatives: { total: negatives, held },
    stolenFrom: [...stolen].sort(),
    failures,
  };
}

/**
 * One author call rewriting the matching surface from the round's failures.
 * The body is never revised here: a trigger failure is a failure of the
 * line, and `improveSkillBody` answers a validator's diagnosis, not this.
 */
export async function improveWhenToUse(
  args: Pick<TriggerEvalArgs, 'host' | 'ctx' | 'draft' | 'competing'>,
  round: TriggerEvalRound
): Promise<{ whenToUse: string; description: string } | null> {
  const missed = round.failures.filter((f) => f.case.expect === args.draft.id);
  const stolen = round.failures.filter((f) => f.case.expect !== args.draft.id);
  const userContent = [
    `You are revising the MATCHING SURFACE of a skill: its one-line "description" and`,
    `its "when_to_use" line. A selector reads a subtask and the catalog lines only;`,
    `these two lines decide whether the recipe is ever picked. The body stays as it is.`,
    ``,
    `== CURRENT ==`,
    `id: ${args.draft.id}`,
    `description: ${args.draft.description}`,
    `when_to_use: ${args.draft.whenToUse}`,
    `body:`,
    args.draft.body,
    ``,
    ...(args.competing.length > 0
      ? [`== COMPETING RECIPES (id: when_to_use) ==`, ...args.competing.map((r) => `- ${r.id}: ${r.whenToUse}`), ``]
      : []),
    ...(missed.length > 0
      ? [
          `== SUBTASKS THE RECIPE SHOULD HAVE BEEN PICKED FOR, AND WAS NOT ==`,
          ...missed.map((f) => `- picked ${f.picked ?? 'none'}: ${f.case.task}`),
          ``,
        ]
      : []),
    ...(stolen.length > 0
      ? [
          `== SUBTASKS THE RECIPE WAS PICKED FOR, AND SHOULD NOT HAVE BEEN ==`,
          ...stolen.map((f) => `- belongs to ${f.case.expect ?? 'no recipe'}: ${f.case.task}`),
          ``,
        ]
      : []),
    `Rewrite both lines so the selector picks this recipe for the first group and`,
    `not for the second. Describe the SHAPE of the request (what is built, probed`,
    `or documented, with which tools) and say what the recipe is NOT for, in`,
    `reusable capability language — never a task theme, never a file that exists`,
    `on disk, never a literal from one run. Keep description ≤90 characters and`,
    `when_to_use ≤140 characters.`,
    ``,
    `Output ONLY a JSON object, first character "{": {"description": "...", "when_to_use": "..."}`,
  ].join('\n');
  const resp = await args.ctx.llm.complete(args.host.toLlmRequest('skill', {
    systemPromptOverride: SKILL_AUTHOR_SYSTEM_PROMPT,
    userContent,
    params: { ...args.host.params, maxTokens: 400, temperature: 0 },
    ...(args.ctx.signal ? { signal: args.ctx.signal } : {}),
  }));
  const parsed = extractJson(resp.text ?? '') as { description?: unknown; when_to_use?: unknown; whenToUse?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') return null;
  const whenToUse = typeof parsed.when_to_use === 'string' ? parsed.when_to_use : typeof parsed.whenToUse === 'string' ? parsed.whenToUse : '';
  const description = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : args.draft.description;
  if (!whenToUse.trim()) return null;
  return { whenToUse: whenToUse.trim().slice(0, 200), description: description.slice(0, 120) };
}

/**
 * The loop. Returns the draft to save — its matching surface possibly
 * revised — with the summary for its provenance, or `verdict: 'rejected'`
 * when the draft still takes its siblings' tasks or is never picked on its
 * own. Never throws; an error anywhere skips the evaluation and accepts the
 * draft unchanged (`verdict: 'skipped'`).
 */
export async function qualifyDraft(args: TriggerEvalArgs): Promise<{ draft: TriggerDraft; summary: TriggerEvalSummary }> {
  const at = new Date().toISOString();
  const competing = args.competing.filter((r) => r.id !== args.draft.id);
  let draft = args.draft;
  try {
    const generated = await generateTriggerCases({ ...args, competing });
    const cases: TriggerCase[] = [
      { task: clip(args.lessonTask), expect: draft.id, source: 'lesson' },
      ...generated.positives.map((task): TriggerCase => ({ task, expect: draft.id, source: 'generated' })),
      ...generated.negatives.map((n): TriggerCase => ({ task: n.task, expect: n.expect, source: 'generated' })),
      ...corpusNegatives(args.corpus ?? []),
    ];
    let revisions = 0;
    let round = await evaluateTriggerCases({ ...args, draft, competing }, cases);
    while (round.failures.length > 0 && revisions < TRIGGER_EVAL_MAX_REVISIONS) {
      const revised = await improveWhenToUse({ ...args, draft, competing }, round);
      if (!revised || (revised.whenToUse === draft.whenToUse && revised.description === draft.description)) break;
      revisions += 1;
      draft = { ...draft, whenToUse: revised.whenToUse, description: revised.description };
      round = await evaluateTriggerCases({ ...args, draft, competing }, cases);
    }
    const base = {
      at, cases: cases.length, positives: round.positives, negatives: round.negatives,
      stolenFrom: round.stolenFrom, revisions,
    };
    // The verdict reads the LAST round: the draft to save is the revised one.
    if (round.stolenFrom.length > 0 || round.negatives.held < round.negatives.total) {
      return { draft, summary: { ...base, verdict: 'rejected',
        reason: `picked on ${round.negatives.total - round.negatives.held} of ${round.negatives.total} negative case(s)` +
          (round.stolenFrom.length ? ` belonging to ${round.stolenFrom.join(', ')}` : '') } };
    }
    if (round.positives.hit === 0) {
      return { draft, summary: { ...base, verdict: 'rejected', reason: `never picked on its ${round.positives.total} positive case(s)` } };
    }
    return { draft, summary: { ...base, verdict: 'accepted',
      ...(round.positives.hit < round.positives.total
        ? { reason: `picked on ${round.positives.hit} of ${round.positives.total} positive case(s)` } : {}) } };
  } catch (err) {
    return { draft: args.draft, summary: { at, cases: 0, positives: { total: 0, hit: 0 }, negatives: { total: 0, held: 0 },
      stolenFrom: [], revisions: 0, verdict: 'skipped', reason: (err as Error).message } };
  }
}

/**
 * The one switch, read at call time. ON everywhere — runs, the deferred
 * learner, library callers — unless it is an explicit `0` (owner decision
 * 2026-10-15: no condition or configuration to use the mechanism). The test
 * configuration is the one place that sets `0`.
 */
export function triggerEvalEnabled(): boolean {
  return process.env['ATOMA_SKILL_TRIGGER_EVAL'] !== '0';
}
