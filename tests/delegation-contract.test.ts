import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { approvalDigest, enforceDelegationReview } from '../src/atoms/delegationReview.js';
import type { RootPhaseCheckpoint } from '../src/contracts/runCheckpoint.js';
import { planSchema } from '../src/atoms/json.js';
import type { LlmCompletionRequest, LlmCompletionResponse, Plan, Result, Task } from '../src/core/types.js';
import { MockLlmClient } from '../src/core/llm.js';
import { modelForTier } from '../src/core/models.js';
import { ValidationError } from '../src/core/errors.js';
import { ROOT_DELEGATION_REVIEW_PARAMS } from '../src/atoms/cost.js';
import { VALIDATION_PARAMS } from '../src/atoms/verdict.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function actors() {
  const db = openDb(':memory:'); databases.push(db);
  const registry = new AtomRegistry(db);
  const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
  const tissue = registry.create(3, seed), cell = registry.create(2, seed);
  for (let i = 0; i < 10; i++) registry.recordSuccess(cell.name);
  return { tissue: L3Atom.buildWithModel(tissue, registry, 'mock'), cell: L2Atom.fromType(registry.getByName(cell.name)!, registry) };
}
const suite = { requirement: 'signed addition', cwd: '.', source: "import {test,expect} from 'vitest';import {add} from './add.ts';test('signed sums',()=>{expect(add(2,3)).toBe(5);expect(add(-2,1)).toBe(-1)});" };
const result: Result = { output: { exports: ['add(a,b)'] }, summary: 'Observed add export', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
function review(kinds: ('vitest' | 'inspection' | 'other')[], independentWork = false, integration: 'vitest' | 'inspection' | 'other' = 'other') {
  return { approved: true, reasoning: 'scope reviewed', delegationReview: {
    subtasks: kinds.map((kind, index) => ({ index, kind, reason: 'actual assigned scope' })),
    integration: { kind: integration, reason: 'integration scope' }, independentWork, parallelReason: 'actual dependency analysis',
  } };
}
const runnable = () => makePlan({ subtasks: [{ description: 'Implement signed addition', outputs: ['add.ts'], acceptanceTests: suite }] });

describe('mandatory delegation contracts', () => {
  it('blocks the observed deferred-tests migration plan even when a reviewer says approved', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    const observed = makePlan({ aggregation: { mode: 'sequential' }, subtasks: [
      { description: 'Inspect and obtain parent approval later' },
      { description: 'Migrate all application modules after that review', outputs: ['server.ts', 'ui.ts'] },
      { description: 'Check the built app' },
    ] });
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(observed);
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    for (let i = 0; i < 3; i++) ctx.llm.enqueueText(JSON.stringify(review(['inspection', 'vitest', 'other'], true, 'vitest')));
    await expect(tissue.handle({ description: 'Migrate Attica to TypeScript' }, ctx)).rejects.toThrow('Missing parent-owned');
    expect(plan).toHaveBeenCalledTimes(3); expect(execute).not.toHaveBeenCalled();
    expect(ctx.llm.calls.every(c => c.role === 'validate-plan' && !c.tools && !c.executor)).toBe(true);
  });

  it('rejects linear or grouped plans when the review identifies independent work', () => {
    expect(enforceDelegationReview(runnable(), JSON.stringify(review(['vitest'], true)), false)?.approved).toBe(false);
    const chain = makePlan({ subtasks: [{ description: 'A', acceptanceTests: suite }, { description: 'B', acceptanceTests: suite, dependsOn: [0] }] });
    expect(enforceDelegationReview(chain, JSON.stringify(review(['vitest', 'vitest'], true)), false)?.approved).toBe(false);
    const parallel = { ...chain, subtasks: chain.subtasks.map(s => ({ ...s, dependsOn: undefined })) };
    expect(enforceDelegationReview(parallel, JSON.stringify(review(['vitest', 'vitest'], true)), false)).toBeUndefined();
  });

  it('permits a reviewed non-code task and does not invent Vitest requirements', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValue(makePlan({ subtasks: [{ description: 'Write usage documentation', outputs: ['README.md'] }] }));
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['other'])));
    await expect(tissue.handle({ description: 'Document the existing API' }, ctx)).resolves.toBe(result);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('executes only the repaired plan after rejecting missing tests', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValueOnce(makePlan({ subtasks: [{ description: 'Implement add' }] })).mockResolvedValueOnce(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['vitest']))); ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests).toEqual(suite);
  });

  it('performs read-only discovery then replans from observed interfaces before implementation', async () => {
    const { tissue } = actors(); const ctx = { ...makeCtx(), rootCheckpoint: {
      restore: () => null, completed: [], planned: vi.fn<RootPhaseCheckpoint['planned']>(), beforePhase: vi.fn(), afterPhase: vi.fn(async () => {}), finalizing: vi.fn(),
    } };
    const discovery = planSchema.parse({ ...makePlan({ subtasks: [{ description: 'Inspect exports' }] }), replanAfter: true });
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValueOnce(discovery).mockResolvedValueOnce(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['inspection'], false, 'inspection')));
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    await tissue.handle({ description: 'Migrate the real application' }, ctx);
    expect(execute.mock.calls[0]?.[0].readOnly).toBe(true);
    expect(execute.mock.calls[0]?.[2].rootCheckpoint).toBeUndefined();
    expect(plan.mock.calls[1]?.[0].inputs?.['repositoryDiscovery']).toMatchObject({ summary: result.summary });
    expect(plan.mock.calls[1]?.[0].description).toBe('Migrate the real application');
    expect(execute.mock.calls[1]?.[0].readOnly).toBeUndefined();
    expect(execute.mock.calls[1]?.[1].subtasks[0]?.acceptanceTests).toEqual(suite);
    expect(ctx.rootCheckpoint.planned).toHaveBeenCalledOnce();
    expect(ctx.rootCheckpoint.planned.mock.calls[0]?.[1]).toMatchObject({ subtasks: [{ acceptanceTests: suite }] });
  });

  it('never turns a failed discovery into implementation', async () => {
    const { tissue } = actors(); const ctx = makeCtx();
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue({ ...makePlan({ subtasks: [{ description: 'inspect' }] }), replanAfter: true });
    vi.spyOn(tissue, 'execute').mockResolvedValue({ ...result, refusal: 'inspection failed' });
    ctx.llm.enqueueText(JSON.stringify(review(['inspection'], false, 'inspection')));
    expect((await tissue.handle({ description: 'Migrate' }, ctx)).refusal).toBe('inspection failed');
    expect(plan).toHaveBeenCalledOnce();
  });

  it('does not accept missing, duplicate or out-of-range classifications', () => {
    const p = runnable();
    for (const r of [{ approved: true }, review([]), review(['vitest', 'vitest']), { ...review(['vitest']), delegationReview: { ...review(['vitest']).delegationReview, subtasks: [{ index: 1, kind: 'vitest', reason: 'wrong' }] } }]) {
      expect(enforceDelegationReview(p, JSON.stringify(r), false)?.approved).toBe(false);
    }
  });

  it('refuses discovery with writes, repeated discovery, and child-authored discovery', () => {
    const discovery: Plan = { ...runnable(), replanAfter: true };
    expect(enforceDelegationReview(discovery, JSON.stringify(review(['inspection'], false, 'inspection')), true)?.approved).toBe(false);
    const clean = { ...discovery, subtasks: [{ description: 'inspect' }] };
    expect(enforceDelegationReview(clean, JSON.stringify(review(['inspection'], false, 'inspection')), false)?.approved).toBe(false);
    expect(enforceDelegationReview(clean, JSON.stringify(review(['vitest'])), true)?.approved).toBe(false);
  });

  it('makes L3 reject a trusted L2 omitting L1 suites before leaf execution', async () => {
    const { tissue, cell } = actors(); const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    const verdict = await tissue.validatePlan(cell, makePlan({ subtasks: [{ description: 'Implement add' }] }), { description: 'add', acceptanceTests: suite }, ctx);
    expect(verdict.approved).toBe(false); expect(verdict.reasoning).toContain('Missing parent-owned');
    expect(ctx.llm.calls).toHaveLength(1);
  });
});

// Group D, review 2026-10-16: the root review runs on tier 2 with its own
// parameters, a reviewer's own failure re-reviews the same plan on the
// validation model, and an unparseable root plan spends an attempt.
describe('root delegation review robustness', () => {
  const SOURCE = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('adds digits', () => {\n  expect(String(add(2, 3))).toMatch(/\\d+/);\n  expect(add(-2, 1)).toBe(-1);\n});";

  function planReply(cellName: string, source = SOURCE): string {
    const strategy = { strategy: 'reuse', target: cellName, reasoning: 'Existing module author' };
    const plan = {
      reasoning: 'One tested module',
      delivery: 'files',
      subtasks: [{ description: 'Implement signed addition', preferredChild: cellName, outputs: ['add.ts'],
        acceptanceTests: { requirement: 'signed addition', cwd: '.', source } }],
      aggregation: { mode: 'sequential' },
      expectedOutput: 'add.ts',
    };
    return JSON.stringify([strategy, plan]);
  }

  /** Routes by role: the real L3.plan (prefilter, plan) and the root review. */
  function routedLlm(cellName: string, plans: { text: string; stopReason?: string }[], reviews: { text: string; stopReason?: string }[]): MockLlmClient {
    const llm = new MockLlmClient();
    const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
      let next: { text: string; stopReason?: string } | undefined;
      if (req.role === 'prefilter') next = { text: JSON.stringify({ kind: 'reuse', target: cellName, confidence: 'high', reasoning: 'fits' }) };
      else if (req.role === 'plan') next = plans.shift();
      else if (req.role === 'validate-plan') next = reviews.shift();
      if (!next) throw new Error(`Unexpected ${req.role} call`);
      return { text: next.text, stopReason: next.stopReason ?? 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    };
    for (let i = 0; i < 40; i++) llm.enqueue(route);
    return llm;
  }

  function routedActors() {
    const db = openDb(':memory:'); databases.push(db);
    const registry = new AtomRegistry(db);
    const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
    const tissue = registry.create(3, seed);
    const cell = registry.create(2, seed);
    return { tissue: L3Atom.buildWithModel(tissue, registry, 'mock'), cellName: cell.name };
  }

  const approval = JSON.stringify(review(['vitest']));

  it('reviews the root plan on tier 2 with its own parameters, and child plans on the validation model', async () => {
    const { tissue, cell } = actors();
    const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValue(runnable());
    vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(approval);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    const root = ctx.llm.calls.find(call => call.role === 'validate-plan');
    expect(root?.model).toBe(modelForTier(2));
    expect(root?.params).toEqual(ROOT_DELEGATION_REVIEW_PARAMS);

    ctx.llm.enqueueText(approval);
    await tissue.validatePlan(cell, runnable(), { description: 'add', acceptanceTests: suite }, ctx);
    const child = ctx.llm.calls.at(-1);
    expect(child?.model).toBe(modelForTier(1));
    expect(child?.params).toEqual(VALIDATION_PARAMS);
  });

  it('constructs a tissue without a tier-2 pin', () => {
    const saved = process.env['ATOMA_MODEL_L2'];
    delete process.env['ATOMA_MODEL_L2'];
    try {
      expect(() => routedActors()).not.toThrow();
    } finally {
      process.env['ATOMA_MODEL_L2'] = saved;
    }
  });

  const faults: [string, { text: string; stopReason?: string }][] = [
    ['an unfinished review', { text: '{"approved": true, "reasoning": "cut', stopReason: 'max_tokens' }],
    ['a non-JSON review', { text: 'I approve this plan.' }],
    ['an approval without its classification', { text: JSON.stringify({ approved: true, reasoning: 'fine' }) }],
    ['duplicate indices', { text: JSON.stringify({ ...review(['vitest']), delegationReview: { ...review(['vitest']).delegationReview,
      subtasks: [{ index: 0, kind: 'vitest', reason: 'a' }, { index: 0, kind: 'vitest', reason: 'b' }] } }) }],
  ];

  it.each(faults)('reviews the same plan again on the validation model after %s', async (_, fault) => {
    const { tissue } = actors();
    const ctx = makeCtx();
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueue({ text: fault.text, stopReason: fault.stopReason ?? 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    ctx.llm.enqueueText(approval);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    expect(plan).toHaveBeenCalledOnce();
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.model).toBe(modelForTier(2));
    expect(reviews[1]?.model).toBe(modelForTier(1));
    expect(reviews[1]?.params).toEqual(VALIDATION_PARAMS);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('ends the run after three reviewer faults without executing', async () => {
    const { tissue } = actors();
    const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValue(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    for (let i = 0; i < 3; i++) ctx.llm.enqueueText('not a verdict');
    await expect(tissue.handle({ description: 'Implement signed addition' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks the real root planner again after an invalid escape, with the parser message, and never reviews the bad reply', async () => {
    const { tissue, cellName } = routedActors();
    const good = planReply(cellName);
    const badEscape = good.replace('\\\\d', '\\d');
    expect(badEscape).not.toBe(good);
    const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: badEscape }, { text: good }], [{ text: approval }]) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(SOURCE);
    const plans = ctx.llm.calls.filter(call => call.role === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[1]?.userContent).toContain('plan reply unparseable');
    expect(plans[1]?.userContent).toContain('Bad escaped character');
    expect(plans[1]?.userContent).toContain('near');
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
  });

  it('ends the run after three unparseable root plans, naming the parser', async () => {
    const { tissue, cellName } = routedActors();
    const bad = planReply(cellName).replace('\\\\d', '\\d');
    const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: bad }, { text: bad }, { text: bad }], []) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    await expect(tissue.handle({ description: 'Implement signed addition' }, ctx)).rejects.toThrow(/plan reply unparseable: .*Bad escaped character/);
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(0);
  });

  it('escapes raw newlines in a test source losslessly on the first reply', async () => {
    const { tissue, cellName } = routedActors();
    const rawNewlines = planReply(cellName).split('\\n').join('\n');
    const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: rawNewlines }], [{ text: approval }]) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    expect(ctx.llm.calls.filter(call => call.role === 'plan')).toHaveLength(1);
    expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(SOURCE);
  });

  it('never reviews or executes a root plan cut at the output cap, and asks for a shorter one', async () => {
    const { tissue, cellName } = routedActors();
    const good = planReply(cellName);
    const cut = good.slice(0, good.indexOf('toMatch'));
    const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: cut, stopReason: 'max_tokens' }, { text: good }], [{ text: approval }]) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    const plans = ctx.llm.calls.filter(call => call.role === 'plan');
    expect(plans[1]?.userContent).toContain('STRATEGY_MAX_TOKENS output cap');
    expect(plans[1]?.userContent).toContain('return a shorter reply');
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(SOURCE);
  });

  it('tells root and cell planners how to write a test source inside JSON', async () => {
    const { tissue, cellName } = routedActors();
    const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: planReply(cellName) }], [{ text: approval }]) });
    vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    const sentence = 'source is a JSON string: write every backslash as \\\\ (a regex \\d becomes \\\\d in JSON) and escape double quotes and newlines; prefer single-quoted TypeScript strings in test code.';
    expect(ctx.llm.calls.find(call => call.role === 'plan')?.userContent).toContain(sentence);

    const { cell } = actors();
    const cellCtx = makeCtx();
    cellCtx.llm.enqueueText(planReply('Urea'));
    await cell.plan({ description: 'Implement signed addition', acceptanceTests: suite }, cellCtx);
    expect(cellCtx.llm.calls.find(call => call.role === 'plan')?.userContent).toContain(sentence);
  });

  describe('resuming a saved root plan', () => {
    const criteria = [{ id: 'c1', behaviour: 'Signed sums are correct', source: 'user' as const }];

    function savedRoot(tissue: L3Atom, task: Task, plan: Plan) {
      const review = { subtasks: [{ index: 0, kind: 'vitest' as const, reason: 'module' }],
        integration: { kind: 'other' as const, reason: 'one module' }, independentWork: false, parallelReason: 'one module' };
      const actor = { name: tissue.name, atomId: tissue.atomId, version: tissue.registryVersion() };
      const digest = approvalDigest({ plan, from: 0, task, actor, model: modelForTier(2) });
      return { plan: JSON.parse(JSON.stringify(plan)), strategy: { strategy: 'reuse', target: 'cell', reasoning: 'r' },
        plannedPhases: 1, inputs: task.inputs, approval: { digest, from: 0, review } };
    }

    function resumingCtx(root: ReturnType<typeof savedRoot>) {
      const planned = vi.fn<RootPhaseCheckpoint['planned']>();
      const ctx = { ...makeCtx(), rootCheckpoint: {
        restore: () => root, completed: [], planned, beforePhase: vi.fn(), afterPhase: vi.fn(async () => {}), finalizing: vi.fn(),
      } };
      return { ctx, planned };
    }

    const sequential = () => planSchema.parse({ ...runnable(), aggregation: { mode: 'sequential' } });

    it('runs a recorded approval without asking a model, and records it again', async () => {
      const { tissue } = actors();
      const task: Task = { description: 'Implement signed addition', inputs: { a: 1 }, criteria };
      const root = savedRoot(tissue, task, sequential());
      const { ctx, planned } = resumingCtx(root);
      const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      await tissue.handle(task, ctx);
      expect(ctx.llm.calls).toHaveLength(0);
      expect(execute).toHaveBeenCalledOnce();
      expect(planned.mock.calls[0]?.[4]).toEqual(root.approval);
    });

    it('reviews again when the criteria changed since the approval', async () => {
      const { tissue } = actors();
      const task: Task = { description: 'Implement signed addition', inputs: { a: 1 }, criteria };
      const root = savedRoot(tissue, task, sequential());
      const { ctx, planned } = resumingCtx(root);
      vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      ctx.llm.enqueueText(approval);
      await tissue.handle({ ...task, criteria: [{ ...criteria[0]!, behaviour: 'Signed sums are correct and fast' }] }, ctx);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
      expect(planned.mock.calls[0]?.[4]?.digest).not.toBe(root.approval.digest);
    });

    it('reviews again when the recorded classification no longer holds mechanically', async () => {
      const { tissue } = actors();
      const task: Task = { description: 'Implement signed addition', inputs: { a: 1 } };
      const root = savedRoot(tissue, task, sequential());
      const { ctx } = resumingCtx({ ...root, approval: { ...root.approval, review: { ...root.approval.review, subtasks: [] } } });
      vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      ctx.llm.enqueueText(approval);
      await tissue.handle(task, ctx);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
    });
  });
});
