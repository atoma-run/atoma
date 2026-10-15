import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SkillRegistry } from '../src/skills/registry.js';
import { SkillLifecycle, type SkillLifecycleHost } from '../src/skills/lifecycle.js';
import {
  corpusNegatives,
  evaluateTriggerCases,
  qualifyDraft,
  triggerEvalEnabled,
  TRIGGER_EVAL_MAX_REVISIONS,
  type TriggerCase,
} from '../src/skills/triggerEval.js';
import { TRIGGER_SAMPLES_PER_SKILL, recordTriggerSample, triggerSamplesFor } from '../src/skills/metaStore.js';
import { SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { resolveTriggerEval } from '../src/run/runner.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';
import { namespaceOf } from '../src/skills/namespace.js';

/**
 * Trigger evaluation at learn time (owner decision 2026-10-15): a learned
 * draft's `when_to_use` is judged by the production skill selector on
 * held-out cases, revised up to twice, and saved only when it is picked on
 * its own cases and on none of its siblings'. Mocked LLM, no paid calls.
 */

const NS = namespaceOf({ atomId: 'atom-ns-1', name: 'Water' });

function host(): SkillLifecycleHost {
  return {
    name: 'Cell',
    model: 'mock-l2',
    params: {},
    toLlmRequest: (role, args) => ({
      model: 'mock-l2', role, userContent: args.userContent, systemPrompt: args.systemPromptOverride ?? 'sys',
      actor: { name: 'Cell', tier: 2 }, ...(args.params ? { params: args.params } : {}),
    }),
  };
}

const draft = {
  id: 'probe-json-api-lifecycle',
  description: 'probes a JSON API through its documented routes',
  whenToUse: 'when the subtask asks to verify a running API',
  body: '1. start the server.\n2. fetch each documented route.\n3. compare status codes.',
};
const sibling = {
  id: 'build-json-api',
  description: 'scaffolds a JSON API server',
  whenToUse: 'when the subtask asks to BUILD an HTTP JSON API from scratch',
  body: '1. write_file server.mjs.\n2. start_node_server.\n3. fetch a route.',
};

/** A selector stub: picks by substring rules over the task, like a trained prefilter would. */
function selector(rule: (task: string, catalog: string) => string | null) {
  return (req: LlmCompletionRequest) => {
    const task = /^Task: (.*)$/m.exec(req.userContent)?.[1] ?? '';
    const picked = rule(task, req.userContent);
    return {
      text: jsonText(picked ? { kind: 'reuse', target: picked, confidence: 'high', reasoning: 'rule' } : { kind: 'escalate', reasoning: 'rule' }),
      stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
}

describe('the trigger corpus (skill_trigger_samples)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atoma-trigger-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records the credited and blamed subtask with its counter, in the same transaction, bounded per recipe', () => {
    const db = new Database(join(dir, 'store.db'));
    const skills = new SkillRegistry(join(dir, 'skills'), { db });
    skills.save(NS, { ...sibling, kind: 'llm' });
    skills.recordSuccess(NS, sibling.id, { via: 'Water', task: 'Build a JSON API for books with GET and POST routes' });
    skills.recordFailure(NS, sibling.id, { via: 'Water', task: 'Build a JSON API for movies' });
    // A credit without a task (library callers) leaves no sample.
    skills.recordSuccess(NS, sibling.id);
    const rows = triggerSamplesFor(db, NS, sibling.id);
    expect(rows.map((r) => [r.task.slice(0, 20), r.outcome])).toEqual([
      ['Build a JSON API for', 'failure'],
      ['Build a JSON API for', 'success'],
    ].map(([t]) => expect.arrayContaining([t])));
    expect(rows).toHaveLength(2);
    expect(skills.loadFor(NS)[0]!.successes).toBe(2);
    for (let i = 0; i < TRIGGER_SAMPLES_PER_SKILL + 5; i += 1) {
      recordTriggerSample(db, { namespace: NS, skillId: sibling.id, task: `task ${i}`, outcome: 'success', at: `2026-10-15T00:00:${String(i).padStart(2, '0')}.000Z` });
    }
    expect(triggerSamplesFor(db, NS, sibling.id)).toHaveLength(TRIGGER_SAMPLES_PER_SKILL);
    // The registry reader excludes event recipes and the draft's own id.
    expect(skills.triggerSamples([NS], { excludeId: sibling.id })).toEqual([]);
    expect(skills.triggerSamples([NS]).length).toBe(TRIGGER_SAMPLES_PER_SKILL);
    db.close();
  });

  it('turns only credited samples into negatives, one per sibling, newest first', () => {
    const cases = corpusNegatives([
      { namespace: NS, skillId: 'a', task: 'old a', outcome: 'success', at: '2026-01-01T00:00:00.000Z' },
      { namespace: NS, skillId: 'a', task: 'new a', outcome: 'success', at: '2026-02-01T00:00:00.000Z' },
      { namespace: NS, skillId: 'b', task: 'blamed b', outcome: 'failure', at: '2026-03-01T00:00:00.000Z' },
    ]);
    expect(cases).toEqual([{ task: 'new a', expect: 'a', source: 'corpus' }]);
  });
});

describe('evaluateTriggerCases', () => {
  it('runs the production skill prefilter over the catalog the draft joins and scores hits, holds and thefts', async () => {
    const ctx = makeCtx();
    const cases: TriggerCase[] = [
      { task: 'Verify the running books API answers its documented routes', expect: draft.id, source: 'lesson' },
      { task: 'Build an HTTP JSON API for recipes', expect: sibling.id, source: 'generated' },
      { task: 'Write a static landing page', expect: null, source: 'generated' },
    ];
    for (const _ of cases) ctx.llm.enqueue(selector((task) => (/Verify|Build/.test(task) ? draft.id : null)));
    const round = await evaluateTriggerCases({ host: host(), ctx, draft, competing: [sibling] }, cases);
    expect(round.positives).toEqual({ total: 1, hit: 1 });
    expect(round.negatives).toEqual({ total: 2, held: 1 });
    expect(round.stolenFrom).toEqual([sibling.id]);
    expect(round.failures.map((f) => f.case.expect)).toEqual([sibling.id]);
    const first = ctx.llm.calls[0]!;
    expect(first.systemPrompt).toBe(SKILL_PREFILTER_SYSTEM_PROMPT);
    expect(first.role).toBe('prefilter');
    expect(first.userContent).toContain(`- ${sibling.id}: ${sibling.description}. When to use: ${sibling.whenToUse}`);
    expect(first.userContent).toContain(`- ${draft.id}: ${draft.description}. When to use: ${draft.whenToUse}`);
  });
});

describe('qualifyDraft', () => {
  const generation = jsonText({
    should_match: ['Confirm the deployed recipes API still serves its documented routes'],
    should_not_match: [
      { task: 'Build an HTTP JSON API for recipes from scratch', expect: sibling.id },
      { task: 'Document the API in a README', expect: 'no-such-recipe' },
    ],
  });

  it('accepts a draft picked on its positives and on no negative, without a revision', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(generation);
    // lesson + 1 generated positive + 2 generated negatives + 1 corpus negative = 5 selections
    for (let i = 0; i < 5; i += 1) ctx.llm.enqueue(selector((task) => (/Verify|Confirm/.test(task) ? draft.id : /Build/.test(task) ? sibling.id : null)));
    const out = await qualifyDraft({
      host: host(), ctx, draft, lessonTask: 'Verify the running books API', competing: [sibling],
      corpus: [{ namespace: NS, skillId: sibling.id, task: 'Build a JSON API for books', outcome: 'success', at: '2026-10-15T00:00:00.000Z' }],
    });
    expect(out.summary.verdict).toBe('accepted');
    expect(out.summary).toMatchObject({ cases: 5, positives: { total: 2, hit: 2 }, negatives: { total: 3, held: 3 }, revisions: 0, stolenFrom: [] });
    expect(out.draft).toEqual(draft);
    expect(ctx.llm.calls).toHaveLength(6);
  });

  it('revises when_to_use once when the draft steals a sibling\'s task, then accepts the revised surface', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(generation);
    // Round 1: the first surface is over-broad — picked on the build task too.
    for (let i = 0; i < 4; i += 1) ctx.llm.enqueue(selector((task, catalog) => (catalog.includes('NOT for building') ? (/Verify|Confirm/.test(task) ? draft.id : /Build/.test(task) ? sibling.id : null) : (/Verify|Confirm|Build/.test(task) ? draft.id : null))));
    ctx.llm.enqueueText(jsonText({ description: 'probes a running JSON API', when_to_use: 'when the subtask asks to VERIFY a running API; NOT for building one' }));
    for (let i = 0; i < 4; i += 1) ctx.llm.enqueue(selector((task, catalog) => (catalog.includes('NOT for building') ? (/Verify|Confirm/.test(task) ? draft.id : /Build/.test(task) ? sibling.id : null) : draft.id)));
    const out = await qualifyDraft({ host: host(), ctx, draft, lessonTask: 'Verify the running books API', competing: [sibling] });
    expect(out.summary.verdict).toBe('accepted');
    expect(out.summary.revisions).toBe(1);
    expect(out.draft.whenToUse).toContain('NOT for building');
    expect(out.draft.description).toBe('probes a running JSON API');
    expect(out.draft.body).toBe(draft.body);
    const revision = ctx.llm.calls[5]!;
    expect(revision.userContent).toContain('SHOULD NOT HAVE BEEN');
    expect(revision.userContent).toContain(`belongs to ${sibling.id}`);
  });

  it('rejects a draft that still takes a sibling\'s task after the revision budget', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(generation);
    const greedy = selector(() => draft.id);
    for (let i = 0; i < 4; i += 1) ctx.llm.enqueue(greedy);
    for (let r = 0; r < TRIGGER_EVAL_MAX_REVISIONS; r += 1) {
      ctx.llm.enqueueText(jsonText({ description: `d${r}`, when_to_use: `w${r}` }));
      for (let i = 0; i < 4; i += 1) ctx.llm.enqueue(greedy);
    }
    const out = await qualifyDraft({ host: host(), ctx, draft, lessonTask: 'Verify the running books API', competing: [sibling] });
    expect(out.summary.verdict).toBe('rejected');
    expect(out.summary.revisions).toBe(TRIGGER_EVAL_MAX_REVISIONS);
    expect(out.summary.stolenFrom).toEqual([sibling.id]);
    expect(out.summary.reason).toMatch(/negative case/);
    expect(ctx.llm.calls).toHaveLength(1 + 4 + TRIGGER_EVAL_MAX_REVISIONS * 5);
  });

  it('rejects a draft the selector never picks on its own cases', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ should_match: [], should_not_match: [] }));
    ctx.llm.enqueue(selector(() => null));
    // An unchanged revision ends the loop before its budget.
    ctx.llm.enqueueText(jsonText({ description: draft.description, when_to_use: draft.whenToUse }));
    const out = await qualifyDraft({ host: host(), ctx, draft, lessonTask: 'Verify the running books API', competing: [] });
    expect(out.summary.verdict).toBe('rejected');
    expect(out.summary.reason).toMatch(/never picked/);
    expect(out.summary.revisions).toBe(0);
  });

  it('fails open: an error in case generation accepts the draft unchanged as skipped', async () => {
    const ctx = makeCtx();
    const out = await qualifyDraft({ host: host(), ctx, draft, lessonTask: 'x', competing: [sibling] });
    expect(out.summary.verdict).toBe('skipped');
    expect(out.summary.reason).toMatch(/no queued reply/);
    expect(out.draft).toEqual(draft);
  });
});

describe('distillation under ATOMA_SKILL_TRIGGER_EVAL=1', () => {
  let dir: string;
  const env = process.env['ATOMA_SKILL_TRIGGER_EVAL'];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atoma-trigger-')); process.env['ATOMA_SKILL_TRIGGER_EVAL'] = '1'; });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (env === undefined) delete process.env['ATOMA_SKILL_TRIGGER_EVAL']; else process.env['ATOMA_SKILL_TRIGGER_EVAL'] = env;
  });

  function lifecycle(db: Database.Database): { skills: SkillRegistry; engine: SkillLifecycle } {
    const skills = new SkillRegistry(join(dir, 'skills'), { db });
    return { skills, engine: new SkillLifecycle(host(), skills, (ns) => ns) };
  }

  it('saves the revised matching surface with the evaluation in its provenance, and refuses a draft that steals', async () => {
    const db = new Database(join(dir, 'store.db'));
    const { skills, engine } = lifecycle(db);
    skills.save(NS, { ...sibling, kind: 'llm' });
    skills.recordSuccess(NS, sibling.id, { task: 'Build a JSON API for books' });
    process.env['ATOMA_SKILL_PROMOTE'] = '0';
    const ctx = makeCtx();
    // 1. distillation
    ctx.llm.enqueueText(jsonText({ id: draft.id, description: draft.description, when_to_use: draft.whenToUse, body: draft.body }));
    // 2. case generation; 3. lesson + 1 positive + 1 negative + 1 corpus = 4 selections, the corpus one stolen
    ctx.llm.enqueueText(jsonText({ should_match: ['Confirm the API routes'], should_not_match: [{ task: 'Document the API', expect: null }] }));
    for (let i = 0; i < 4; i += 1) ctx.llm.enqueue(selector((task, catalog) => (/Document/.test(task) ? null : catalog.includes('NOT for building') && /Build/.test(task) ? sibling.id : draft.id)));
    // 4. revision; 5. second round holds
    ctx.llm.enqueueText(jsonText({ description: draft.description, when_to_use: 'when asked to VERIFY an API; NOT for building one' }));
    for (let i = 0; i < 4; i += 1) ctx.llm.enqueue(selector((task) => (/Document/.test(task) ? null : /Build/.test(task) ? sibling.id : draft.id)));
    await engine.learnSkillFromRun({
      l1Name: NS,
      subTask: { description: 'Verify the running books API answers its routes' },
      result: { summary: 'probed', output: {}, toolCallResults: [{ ok: true }] } as never,
      child: { name: 'Water', toolNames: () => ['run_shell', 'read_file'] } as never,
      ctx,
      visibleNamespaces: [NS],
    });
    const saved = skills.loadFor(NS).find((s) => s.id === draft.id);
    expect(saved).toBeDefined();
    expect(saved!.whenToUse).toBe('when asked to VERIFY an API; NOT for building one');
    expect(saved!.provenance?.evaluation).toMatchObject({ verdict: 'accepted', revisions: 1, cases: 4, stolenFrom: [] });
    expect(saved!.provenance?.mechanism).toBe('distilled');
    db.close();
  });

  it('does not save a draft the evaluation rejects, and counts the rejection', async () => {
    const db = new Database(join(dir, 'store.db'));
    const { skills, engine } = lifecycle(db);
    skills.save(NS, { ...sibling, kind: 'llm' });
    process.env['ATOMA_SKILL_PROMOTE'] = '0';
    const stats: string[] = [];
    const ctx = { ...makeCtx(), recordRunStat: (s: string) => { stats.push(s); } };
    ctx.llm.enqueueText(jsonText({ id: draft.id, description: draft.description, when_to_use: draft.whenToUse, body: draft.body }));
    ctx.llm.enqueueText(jsonText({ should_match: [], should_not_match: [{ task: 'Build an API', expect: sibling.id }] }));
    const greedy = selector(() => draft.id);
    ctx.llm.enqueue(greedy); ctx.llm.enqueue(greedy);
    for (let r = 0; r < TRIGGER_EVAL_MAX_REVISIONS; r += 1) {
      ctx.llm.enqueueText(jsonText({ description: `d${r}`, when_to_use: `w${r}` }));
      ctx.llm.enqueue(greedy); ctx.llm.enqueue(greedy);
    }
    await engine.learnSkillFromRun({
      l1Name: NS,
      subTask: { description: 'Verify the running books API' },
      result: { summary: 'probed', output: {}, toolCallResults: [{ ok: true }] } as never,
      child: { name: 'Water', toolNames: () => ['run_shell'] } as never,
      ctx,
      visibleNamespaces: [NS],
    });
    expect(skills.loadFor(NS).map((s) => s.id)).toEqual([sibling.id]);
    expect(stats).toContain('skill-trigger-rejected');
    db.close();
  });
});

describe('resolveTriggerEval', () => {
  it('is on with nothing set, for library callers too, and off only on an explicit 0', () => {
    const saved = process.env['ATOMA_SKILL_TRIGGER_EVAL'];
    delete process.env['ATOMA_SKILL_TRIGGER_EVAL'];
    expect(triggerEvalEnabled()).toBe(true);
    process.env['ATOMA_SKILL_TRIGGER_EVAL'] = 'anything';
    expect(triggerEvalEnabled()).toBe(true);
    process.env['ATOMA_SKILL_TRIGGER_EVAL'] = '0';
    expect(triggerEvalEnabled()).toBe(false);
    if (saved === undefined) delete process.env['ATOMA_SKILL_TRIGGER_EVAL']; else process.env['ATOMA_SKILL_TRIGGER_EVAL'] = saved;
  });
  it('is on by default under learning, off on an explicit 0, and moot when learning is off', () => {
    expect(resolveTriggerEval(true, undefined)).toEqual({ enabled: true, source: 'default-enable' });
    expect(resolveTriggerEval(true, '0')).toEqual({ enabled: false, source: 'environment-disable' });
    expect(resolveTriggerEval(true, 'yes')).toEqual({ enabled: true, source: 'default-enable' });
    expect(resolveTriggerEval(false, undefined).enabled).toBe(false);
  });
});
