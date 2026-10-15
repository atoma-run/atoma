# Trigger evaluation at learn time — owner decision 2026-10-15

Status: decided and implemented. This record states what changed, what it
costs, what it gives up, and the adversarial review its gate went through
before shipping. It claims no measured gain; the first measurement is listed
at the end.

## The decision

> Skill creation and improvement are automatic. No operator step. Model quota
> may be spent on it when it improves Atoma globally.

The question was whether to adopt Anthropic's `skill-creator`
([anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/skill-creator)).
Its loop — draft, trigger cases, compare, human review, revise — is run by a
person, in Python, over Claude Code's skill format. Atoma keeps its own format
(`when_to_use`, `kind`, bodies under atom-id namespaces, one catalog and one
trust for the platform) and already creates and revises recipes by itself.
What it had never done is MEASURE a recipe's matching surface before keeping
it. That is the one piece of the method worth taking, and it is taken in
TypeScript, inside the existing lifecycle, with the production selector as the
judge and no person in the loop.

## What was built

- `skill_trigger_samples` (`metaStore.ts`): the subtask text a recipe was
  credited or blamed on, written in the same transaction as the counter
  (`SkillRegistry.recordSuccess`/`recordFailure` take `task`; the cell passes
  its subtask description), 20 per recipe, newest kept. The corpus is empty
  on day one and fills with every credited match.
- `triggerEval.ts`: `qualifyDraft` builds the cases, evaluates them through
  `prefilterStrategy` with `SKILL_PREFILTER_SYSTEM_PROMPT` over the catalog the
  draft would join (Jev first where present, exactly as a run), revises the
  description and `when_to_use` from the failures with one author call per
  round, at most `TRIGGER_EVAL_MAX_REVISIONS = 2` rounds, and returns a
  verdict.
- `distillTaskSkill` runs it after the twin guard and before the save. A
  `rejected` draft is not saved and counts `skill-trigger-rejected`
  (`triggerRejections` in the run stats). An `accepted` draft is saved with
  the revised surface and the summary in its provenance (`evaluation`). A
  `skipped` evaluation (any error) saves the draft as drafted.
- The switch: `ATOMA_SKILL_TRIGGER_EVAL`. On everywhere unless an explicit
  `0`: the runner under learning (`resolveTriggerEval`), the learner from
  `policy.triggerEval` carried by the job (the learner's environment is the
  coordinator's, not the run's), and library callers at call time. The owner
  asked for no condition or configuration to use it; the test configuration
  is the one place that sets `0`.

## The cases

| Source | Count | Expectation |
|---|---|---|
| the lesson's own subtask | 1 | the draft |
| generated paraphrases, other domains | ≤ 3 | the draft |
| generated near misses | ≤ 4 | a named sibling, or none |
| newest credited task of each sibling (corpus) | ≤ 4 | that sibling |

A positive HITS when the selector picks the draft. A negative HOLDS when it
does not pick the draft — a sibling or an escalate both hold.

## The verdict

- rejected: picked on any negative (the sibling it stole from is named), or
  picked on no positive, after the revisions;
- accepted: picked on at least one positive and on no negative. Fewer than
  all positives is accepted and recorded as the reason: the lesson's own task
  is the one positive that is not synthetic.

## Cost

Per draft, worst case: 1 generation call + 2 revision calls on the author
tier, and 12 cases × 3 rounds = 36 selections on the cheapest tier, each
cached by the prefilter cache under the same key a run would use. In the
deferred learner they run on the source run's remaining budget and are
recorded in its receipt; a budget abort reaches `qualifyDraft` as an error and
the draft is saved as drafted.

## Adversarial review of the gate

The repository rule: a new gate is designed against the incidents collected
so far and reviewed adversarially before it lands. The incidents this gate
answers are the catalog's own: verification recipes phrased as disk state and
never matched (two measured casualties, `src/skills/AGENTS.md`), one compiled
verifier matched to three README phases and a code edit (round 6), the three
recovery twins on Glucose never matched (2026-09-28). The attacks considered:

1. **The generator and the selector are the same family of model.** A
   generated positive the selector then picks proves consistency, not
   generality. Accepted: the lesson's task and the corpus are the two
   non-synthetic sources, the corpus grows with every credited match, and the
   verdict's one hard requirement on positives is "at least one", which the
   lesson's task alone can carry.
2. **A generated negative with a wrong `expect`.** The generator names a
   sibling that would not in fact take the task. Because a negative holds
   whenever the draft is NOT picked, a wrong `expect` can only hurt when the
   draft IS picked on it — and then the draft took a task the generator wrote
   as belonging elsewhere, which is the over-broad surface the revision exists
   for. The reverse error (a negative that is really the draft's) is a false
   rejection; two revisions and the run stat bound and measure it.
3. **The prefilter cache serves the evaluation's answer to production.** The
   key is the exact catalog lines and task; identical inputs are the cache's
   contract. The evaluation's catalog is the draft's visible namespaces, which
   is what the next match in that home sees.
4. **Jev decides the evaluation.** Where Jev is present it decides first in a
   run, so it decides first here; evaluating with the model alone would judge
   a surface no run uses. A Jev that escalates on everything it has not seen
   rejects every draft as "never picked": the run stat shows it, and the
   remedy is Jev's calibration, not a bypass here.
5. **Rejecting a draft that was really a twin.** The twin guard runs first and
   is unchanged. A draft that steals a sibling's credited task after two
   revisions is either a twin the guard missed or a surface that cannot be
   told apart from its sibling's; in both cases the catalog is better without
   it.
6. **Spend on a lesson nobody will use.** The owner's decision covers it; the
   bounds above cap it; the deferred learner's receipt records it.
7. **The revision rewrites the body.** It cannot: `improveWhenToUse` returns
   two lines and `qualifyDraft` copies the body through. The test asserts it.
8. **A thrown error inside the loop loses the lesson.** Every path in
   `qualifyDraft` is under one try; an error returns `skipped` with the draft
   unchanged, and the distiller saves it as before.

## What it gives up

- It judges the LINE, not the recipe. A well-matched bad recipe passes; its
  outcome evidence stays the credit counters, and `improveSkillBody` answers
  a validator's diagnosis as before.
- The skill-creator's with/without execution comparison is not built. When it
  is, it is a separate evaluation job with its own budget and workspace — the
  supervisor never replays model-authored work — and this record is where its
  design starts.
- The corpus is empty until the first credited match after deployment, so the
  first drafts are judged on synthetic negatives only.

## First measurement

Read, after a week of production runs: `triggerRejections` across run stats,
the `evaluation.revisions` distribution over new recipes' provenance, and the
match counters of recipes learned since this date against those learned the
week before. A rejection rate near zero says the gate is inert; one above a
third says the generator or the selector is wrong about near misses, and the
cases of the rejected drafts are in the learning traces.
