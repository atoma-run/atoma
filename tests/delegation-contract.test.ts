import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { approvalDigest, enforceDelegationReview, routingIndexNote } from '../src/atoms/delegationReview.js';
import type { RootPhaseCheckpoint } from '../src/contracts/runCheckpoint.js';
import { planSchema } from '../src/atoms/json.js';
import type { BranchEventInfo, LlmCompletionRequest, LlmCompletionResponse, Plan, Result, RunContext, Task, Tool, ToolExecutor } from '../src/core/types.js';
import { parentTestSuiteDigest, type ParentTestSuite } from '../src/contracts/parentTests.js';
import { READ_ONLY_TASK_LINE } from '../src/contracts/readOnlyPhase.js';
import { mockOtherProofReview } from './helpers/delegationReview.js';
import { MockLlmClient } from '../src/core/llm.js';
import { modelForTier } from '../src/core/models.js';
import { ValidationError } from '../src/core/errors.js';
import { ROOT_DELEGATION_REVIEW_PARAMS } from '../src/atoms/cost.js';
import { VALIDATION_PARAMS } from '../src/atoms/verdict.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const databases: ReturnType<typeof openDb>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function actors() {
  const db = openDb(':memory:');
  databases.push(db);
  const registry = new AtomRegistry(db);
  const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
  const tissue = registry.create(3, seed);
  const cell = registry.create(2, seed);
  for (let i = 0; i < 10; i++) registry.recordSuccess(cell.name);
  return {
    tissue: L3Atom.buildWithModel(tissue, registry, 'mock'),
    cell: L2Atom.fromType(registry.getByName(cell.name)!, registry),
  };
}

const suite = {
  requirement: 'signed addition',
  cwd: '.',
  source: "import {test,expect} from 'vitest';import {add} from './add.ts';test('signed sums',()=>{expect(add(2,3)).toBe(5);expect(add(-2,1)).toBe(-1)});",
};

const result: Result = {
  output: { exports: ['add(a,b)'] },
  summary: 'Observed add export',
  trace: [],
  producedBy: { name: 'cell', tier: 2, viaFallback: false },
};

function review(kinds: ('vitest' | 'inspection' | 'other')[], independentWork = false, integration: 'vitest' | 'inspection' | 'other' = 'other') {
  return {
    approved: true,
    reasoning: 'scope reviewed',
    delegationReview: {
      subtasks: kinds.map((kind, index) => ({ index, kind, reason: 'actual assigned scope' })),
      integration: { kind: integration, reason: 'integration scope' },
      independentWork,
      parallelReason: 'actual dependency analysis',
    },
  };
}

const runnable = () => makePlan({ subtasks: [{ description: 'Implement signed addition', outputs: ['add.ts'], acceptanceTests: suite }] });

describe('mandatory delegation contracts', () => {
  it('blocks the observed deferred-tests migration plan even when a reviewer says approved', async () => {
    const { tissue } = actors();
    const ctx = makeCtx();
    const observed = makePlan({
      aggregation: { mode: 'sequential' },
      subtasks: [
        { description: 'Inspect and obtain parent approval later' },
        { description: 'Migrate all application modules after that review', outputs: ['server.ts', 'ui.ts'] },
        { description: 'Check the built app' },
      ],
    });
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(observed);
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    for (let i = 0; i < 3; i++) ctx.llm.enqueueText(JSON.stringify(review(['inspection', 'vitest', 'other'], true, 'vitest')));

    await expect(tissue.handle({ description: 'Migrate Attica to TypeScript' }, ctx)).rejects.toThrow('Missing parent-owned');

    expect(plan).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.llm.calls.every(c => c.role === 'validate-plan' && !c.tools && !c.executor)).toBe(true);
  });

  it('rejects linear or grouped plans when the review identifies independent work', () => {
    expect(enforceDelegationReview(runnable(), JSON.stringify(review(['vitest'], true)), false)?.approved).toBe(false);
    const chain = makePlan({
      subtasks: [
        { description: 'A', acceptanceTests: suite },
        { description: 'B', acceptanceTests: suite, dependsOn: [0] },
      ],
    });
    expect(enforceDelegationReview(chain, JSON.stringify(review(['vitest', 'vitest'], true)), false)?.approved).toBe(false);
    const parallel = { ...chain, subtasks: chain.subtasks.map(s => ({ ...s, dependsOn: undefined })) };
    expect(enforceDelegationReview(parallel, JSON.stringify(review(['vitest', 'vitest'], true)), false)).toBeUndefined();
  });

  it('permits a reviewed non-code task and does not invent Vitest requirements', async () => {
    const { tissue } = actors();
    const ctx = makeCtx();
    vi.spyOn(tissue, 'plan').mockResolvedValue(makePlan({ subtasks: [{ description: 'Write usage documentation', outputs: ['README.md'] }] }));
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['other'])));

    await expect(tissue.handle({ description: 'Document the existing API' }, ctx)).resolves.toBe(result);

    expect(execute).toHaveBeenCalledOnce();
  });

  it('executes only the repaired plan after rejecting missing tests', async () => {
    const { tissue } = actors();
    const ctx = makeCtx();
    vi.spyOn(tissue, 'plan')
      .mockResolvedValueOnce(makePlan({ subtasks: [{ description: 'Implement add' }] }))
      .mockResolvedValueOnce(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));

    await tissue.handle({ description: 'Implement signed addition' }, ctx);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests).toEqual(suite);
  });

  it('performs read-only discovery then replans from observed interfaces before implementation', async () => {
    const { tissue } = actors();
    const ctx = {
      ...makeCtx(),
      rootCheckpoint: {
        restore: () => null,
        completed: [],
        planned: vi.fn<RootPhaseCheckpoint['planned']>(),
        beforePhase: vi.fn(),
        afterPhase: vi.fn(async () => {}),
        finalizing: vi.fn(),
      },
    };
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
    const { tissue } = actors();
    const ctx = makeCtx();
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue({ ...makePlan({ subtasks: [{ description: 'inspect' }] }), replanAfter: true });
    vi.spyOn(tissue, 'execute').mockResolvedValue({ ...result, refusal: 'inspection failed' });
    ctx.llm.enqueueText(JSON.stringify(review(['inspection'], false, 'inspection')));

    expect((await tissue.handle({ description: 'Migrate' }, ctx)).refusal).toBe('inspection failed');

    expect(plan).toHaveBeenCalledOnce();
  });

  it('does not accept missing, duplicate or out-of-range classifications', () => {
    const p = runnable();
    for (const r of [
      { approved: true },
      review([]),
      review(['vitest', 'vitest']),
      {
        ...review(['vitest']),
        delegationReview: { ...review(['vitest']).delegationReview, subtasks: [{ index: 1, kind: 'vitest', reason: 'wrong' }] },
      },
    ]) {
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
    const { tissue, cell } = actors();
    const ctx = makeCtx();
    ctx.llm.enqueueText(JSON.stringify(review(['vitest'])));

    const verdict = await tissue.validatePlan(cell, makePlan({ subtasks: [{ description: 'Implement add' }] }), { description: 'add', acceptanceTests: suite }, ctx);

    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toContain('Missing parent-owned');
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
  function routedLlm(
    cellName: string,
    plans: { text: string; stopReason?: string }[],
    reviews: { text: string; stopReason?: string }[],
  ): MockLlmClient {
    const llm = new MockLlmClient();
    const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
      let next: { text: string; stopReason?: string } | undefined;
      if (req.role === 'prefilter') {
        next = { text: JSON.stringify({ kind: 'reuse', target: cellName, confidence: 'high', reasoning: 'fits' }) };
      } else if (req.role === 'plan') {
        next = plans.shift();
      } else if (req.role === 'validate-plan') {
        next = reviews.shift();
      }
      if (!next) throw new Error(`Unexpected ${req.role} call`);
      return {
        text: next.text,
        stopReason: next.stopReason ?? 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    };
    for (let i = 0; i < 40; i++) llm.enqueue(route);
    return llm;
  }

  function routedActors() {
    const db = openDb(':memory:');
    databases.push(db);
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
    ['duplicate indices', {
      text: JSON.stringify({
        ...review(['vitest']),
        delegationReview: {
          ...review(['vitest']).delegationReview,
          subtasks: [{ index: 0, kind: 'vitest', reason: 'a' }, { index: 0, kind: 'vitest', reason: 'b' }],
        },
      }),
    }],
  ];

  it.each(faults)('reviews the same plan again on the validation model after %s', async (_, fault) => {
    const { tissue } = actors();
    const ctx = makeCtx();
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(runnable());
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    ctx.llm.enqueue({
      text: fault.text,
      stopReason: fault.stopReason ?? 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
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
      const review = {
        subtasks: [{ index: 0, kind: 'vitest' as const, reason: 'module' }],
        integration: { kind: 'other' as const, reason: 'one module' },
        independentWork: false,
        parallelReason: 'one module',
      };
      const actor = { name: tissue.name, atomId: tissue.atomId, version: tissue.registryVersion() };
      const digest = approvalDigest({ plan, from: 0, task, actor, model: modelForTier(2) });
      return {
        plan: JSON.parse(JSON.stringify(plan)),
        strategy: { strategy: 'reuse', target: 'cell', reasoning: 'r' },
        plannedPhases: 1,
        inputs: task.inputs,
        approval: { digest, from: 0, review },
      };
    }

    function resumingCtx(root: ReturnType<typeof savedRoot>) {
      const planned = vi.fn<RootPhaseCheckpoint['planned']>();
      const ctx = {
        ...makeCtx(),
        rootCheckpoint: {
          restore: () => root,
          completed: [],
          planned,
          beforePhase: vi.fn(),
          afterPhase: vi.fn(async () => {}),
          finalizing: vi.fn(),
        },
      };
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
      const { ctx } = resumingCtx({
        ...root,
        approval: { ...root.approval, review: { ...root.approval.review, subtasks: [] } },
      });
      vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      ctx.llm.enqueueText(approval);
      await tissue.handle(task, ctx);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
    });
  });
});

// Review 2026-10-16, point 7: capability routing runs inside `L3Atom.plan`,
// before the mandatory review, so the reviewer classifies exactly the plan
// that is dispatched. These tests go through the real `handle`, `plan`,
// review, dispatch and cells; only the model is mocked.
describe('capability routing under the root review', () => {
  const MODULE_SUITE: ParentTestSuite = {
    requirement: 'module A renders the page',
    cwd: '.',
    source: "import { test, expect } from 'vitest';\nimport { render } from './a.ts';\ntest('renders', () => {\n  expect(render()).toContain('<main');\n});",
  };
  const CHECKPOINT = 'Confirm the page in a real browser with selector-based interactions. Run node test-api.js and require it to pass.';
  const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' } });

  function routingRegistry(options: { fullStack?: boolean } = {}) {
    const db = openDb(':memory:');
    databases.push(db);
    const registry = new AtomRegistry(db);
    const seed = {
      description: 'orchestrator',
      systemPrompt: 'You orchestrate.',
      tools: [] as Tool[],
      params: {},
      createdBy: 'test',
    };
    const tissue = registry.create(3, seed);
    const shell = registry.create(2, { ...seed, tools: [tool('run_shell'), tool('start_node_server')] });
    const web = registry.create(2, { ...seed, tools: [tool('validate_html')] });
    const fullStack = options.fullStack
      ? registry.create(2, { ...seed, tools: [tool('validate_html'), tool('run_shell'), tool('start_node_server')] })
      : undefined;
    const molecule = registry.create(1, { ...seed, tools: [tool('write_file')] });
    return { registry, tissue, shell: shell.name, web: web.name, fullStack: fullStack?.name, molecule: molecule.name };
  }

  function dagPlan(names: { shell: string; web: string }, checkpointCell = names.web) {
    return {
      reasoning: 'Two modules, one checkpoint, then the README',
      delivery: 'files',
      subtasks: [
        { description: 'Scaffold the project.', preferredChild: names.shell, outputs: ['package.json'] },
        {
          description: 'Implement a.ts. Confirm the page in a real browser with selector-based interactions.',
          preferredChild: names.shell,
          outputs: ['a.ts'],
          acceptanceTests: MODULE_SUITE,
        },
        { description: 'Implement b.ts.', preferredChild: names.shell, outputs: ['b.ts'], dependsOn: [0] },
        { description: CHECKPOINT, preferredChild: checkpointCell, dependsOn: [1, 2] },
        { description: 'Write the README.', preferredChild: names.shell, outputs: ['README.md'], dependsOn: [3] },
      ],
      aggregation: { mode: 'concat' },
      expectedOutput: 'the application',
    };
  }

  const ok = (value: unknown): LlmCompletionResponse => ({
    text: typeof value === 'string' ? value : JSON.stringify(value),
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  /** Classifies a suite-bearing subtask as vitest and everything else as other. */
  function classify(plan: Plan) {
    return {
      approved: true,
      reasoning: 'scope reviewed',
      delegationReview: {
        subtasks: plan.subtasks.map((subtask, index) => ({
          index,
          kind: subtask.acceptanceTests ? 'vitest' : 'other',
          reason: 'actual assigned scope',
        })),
        integration: { kind: 'other', reason: 'the checkpoint proves integration' },
        independentWork: false,
        parallelReason: 'actual dependencies',
      },
    };
  }

  /**
   * One model for every tier: the root plans are the test's, every cell reuses
   * the molecule, every molecule reports without writing, and every child
   * review approves. The ROOT review (a tissue judging its own plan) is the
   * test's `review`, handed the plan it was shown.
   */
  function routingModel(args: { cell: string; molecule: string; rootPlans: unknown[]; review: (plan: Plan) => unknown }) {
    const requests: LlmCompletionRequest[] = [];
    const reviewedPlans: Plan[] = [];
    const llm = {
      complete: async (req: LlmCompletionRequest): Promise<LlmCompletionResponse> => {
        requests.push(req);
        const tier = req.actor?.tier;
        if (req.role === 'prefilter') {
          const target = tier === 3 ? args.cell : args.molecule;
          return ok({ kind: 'reuse', target, confidence: 'high', reasoning: 'fits' });
        }
        if (req.role === 'plan' && tier === 3) {
          const plan = args.rootPlans.length > 1 ? args.rootPlans.shift() : args.rootPlans[0];
          return ok([{ strategy: 'reuse', target: args.cell, reasoning: 'fits' }, plan]);
        }
        if (req.role === 'plan' && tier === 2) {
          const plan = {
            reasoning: 'one molecule',
            subtasks: [{ description: 'do it', preferredChild: args.molecule }],
            aggregation: { mode: 'concat' },
            expectedOutput: 'done',
          };
          return ok([{ strategy: 'reuse', target: args.molecule, reasoning: 'fits' }, plan]);
        }
        if (req.role === 'plan' || req.role === 'fallback-plan') {
          return ok({ reasoning: 'r', proposedAction: 'act', expectedOutput: 'e' });
        }
        if (req.role === 'execute' || req.role === 'fallback-execute') {
          return ok({ output: { done: true }, summary: 'reported' });
        }
        if (req.role === 'validate-plan' && req.child?.tier === 3) {
          const encoded = /^PLAN: (.*)$/m.exec(req.userContent)?.[1];
          if (!encoded) throw new Error('the root review was not shown its plan');
          const plan = JSON.parse(encoded) as Plan;
          reviewedPlans.push(plan);
          return ok(args.review(plan));
        }
        return ok({ approved: true, reasoning: 'fine', ...mockOtherProofReview(req) });
      },
    };
    return { llm: llm as unknown as RunContext['llm'], requests, reviewedPlans };
  }

  /** The fixed runner's shell: every suite it is handed passes. */
  function passingSuites(): ToolExecutor & { readonly suites: string[] } {
    const suites: string[] = [];
    return {
      suites,
      has: (name) => name === 'run_shell',
      execute: async (name, args) => {
        if (name !== 'run_shell' || args['command'] !== 'atoma-verify') return {};
        const suite = JSON.parse((args['args'] as string[])[0]!) as ParentTestSuite;
        suites.push(suite.requirement);
        return {
          suiteDigest: parentTestSuiteDigest(suite),
          workspaceDigest: 'w'.repeat(64),
          status: 'passed',
          cause: 'ran',
          passed: 1,
          failed: 0,
          skipped: 0,
          details: JSON.stringify(['', { name: 'renders', status: 'passed', failures: [] }]),
        };
      },
    };
  }

  it('reviews exactly the routed plan it dispatches, and orders the split checkpoint', async () => {
    const actors = routingRegistry();
    const model = routingModel({
      cell: actors.shell,
      molecule: actors.molecule,
      rootPlans: [dagPlan(actors)],
      review: classify,
    });
    const tools = passingSuites();
    const branches: BranchEventInfo[] = [];
    const recorded: Plan[] = [];
    const ctx: RunContext = {
      ...makeCtx(),
      llm: model.llm,
      tools,
      recordBranch: (info) => branches.push(info),
      recordRootPlan: (plan) => recorded.push(plan),
    };

    await L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock').handle({ description: 'Build the application' }, ctx);

    expect(model.reviewedPlans).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(model.reviewedPlans[0]).toEqual(JSON.parse(JSON.stringify(recorded[0])));
    expect(recorded[0]!.subtasks.map((subtask) => subtask.dependsOn)).toEqual([undefined, undefined, [0], [1, 2], [1, 2, 3], [3, 4]]);
    const rootReview = model.requests.find((req) => req.role === 'validate-plan' && req.child?.tier === 3)!;
    expect(rootReview.userContent).toContain(routingIndexNote(recorded[0]!));
    expect(rootReview.userContent).toContain("subtasks 3 and 4 are the host's browser then exact-shell verification of planner subtask 3");

    const root = branches.filter((info) => info.actorTier === 3);
    const starts = root.filter((info) => info.op === 'start');
    expect(starts).toHaveLength(6);
    expect(starts.every((info) => info.total === 6)).toBe(true);
    const at = (op: 'start' | 'end', index: number) => root.findIndex((info) => info.op === op && info.index === index);
    expect(at('start', 4)).toBeGreaterThan(at('end', 3));
    expect(at('start', 5)).toBeGreaterThan(at('end', 3));
    expect(at('start', 5)).toBeGreaterThan(at('end', 4));
    expect(tools.suites).toEqual([MODULE_SUITE.requirement]);
  });

  it('refuses a review that classifies the planner indices instead of the routed ones', async () => {
    const actors = routingRegistry();
    const plannerCount = (plan: Plan) => {
      const verdict = classify(plan);
      return {
        ...verdict,
        delegationReview: { ...verdict.delegationReview, subtasks: verdict.delegationReview.subtasks.slice(0, 5) },
      };
    };
    const model = routingModel({
      cell: actors.shell,
      molecule: actors.molecule,
      rootPlans: [dagPlan(actors)],
      review: plannerCount,
    });
    const ctx: RunContext = { ...makeCtx(), llm: model.llm, tools: passingSuites() };
    const tissue = L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock');
    const execute = vi.spyOn(tissue, 'execute');

    await expect(tissue.handle({ description: 'Build the application' }, ctx)).rejects.toThrow(/classify every subtask exactly once/);

    expect(model.reviewedPlans.every((plan) => plan.subtasks.length === 6)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a rejection citing a routed index back to the planner, who keeps the checkpoint whole', async () => {
    const actors = routingRegistry({ fullStack: true });
    const rejection = {
      approved: false,
      reasoning: 'subtask 4 cannot start the server it must probe.',
      scope: 'ephemeral',
      modifications: {},
    };
    let reviews = 0;
    const model = routingModel({
      cell: actors.shell,
      molecule: actors.molecule,
      rootPlans: [dagPlan(actors), dagPlan(actors, actors.fullStack)],
      review: (plan) => ++reviews === 1 ? rejection : classify(plan),
    });
    const ctx: RunContext = { ...makeCtx(), llm: model.llm, tools: passingSuites() };
    const tissue = L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock');
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);

    await tissue.handle({ description: 'Build the application' }, ctx);

    const rootPlans = model.requests.filter((req) => req.role === 'plan' && req.actor?.tier === 3);
    expect(rootPlans).toHaveLength(2);
    expect(rootPlans[1]!.userContent).toContain('Delegation contract rejected before execution: subtask 4 cannot start the server');
    expect(rootPlans[1]!.userContent).toContain("subtasks 3 and 4 are the host's browser then exact-shell verification of planner subtask 3");
    expect(execute).toHaveBeenCalledOnce();
    const dispatched = execute.mock.calls[0]![1];
    expect(dispatched.subtasks).toHaveLength(5);
    expect(dispatched.subtasks[3]!.preferredChild).toBe(actors.fullStack);
    expect(dispatched.subtasks[3]!.description).toBe(CHECKPOINT);
    expect(dispatched.subtasks.some((subtask) => subtask.routedFrom)).toBe(false);
  });

  it('fails closed when every review rejects a host split', async () => {
    const actors = routingRegistry();
    const rejection = {
      approved: false,
      reasoning: 'subtask 3 cannot start the server it must probe.',
      scope: 'ephemeral',
      modifications: {},
    };
    const model = routingModel({
      cell: actors.shell,
      molecule: actors.molecule,
      rootPlans: [dagPlan(actors)],
      review: () => rejection,
    });
    const ctx: RunContext = { ...makeCtx(), llm: model.llm, tools: passingSuites() };
    const tissue = L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock');
    const execute = vi.spyOn(tissue, 'execute');

    await expect(tissue.handle({ description: 'Build the application' }, ctx)).rejects.toBeInstanceOf(ValidationError);

    expect(model.reviewedPlans).toHaveLength(3);
    expect(execute).not.toHaveBeenCalled();
  });

  it('counts planner phases for read-only marking before a sequential checkpoint is split', async () => {
    const actors = routingRegistry();
    const twoPhases = {
      reasoning: 'build, then verify',
      delivery: 'files',
      subtasks: [
        { description: 'Build the notes page in index.html.', preferredChild: actors.shell, outputs: ['index.html'] },
        { description: 'Confirm the notes page in a real browser. Then make node test.js exit 0.', preferredChild: actors.web },
      ],
      aggregation: { mode: 'sequential' },
      expectedOutput: 'a verified notes page',
    };
    const model = routingModel({
      cell: actors.shell,
      molecule: actors.molecule,
      rootPlans: [twoPhases],
      review: classify,
    });
    const planned = vi.fn<RootPhaseCheckpoint['planned']>();
    const checkpoint: RootPhaseCheckpoint = {
      restore: () => null,
      completed: [],
      planned,
      beforePhase: vi.fn(),
      afterPhase: vi.fn(async () => {}),
      finalizing: vi.fn(),
    };
    const ctx: RunContext = { ...makeCtx(), llm: model.llm, tools: passingSuites(), rootCheckpoint: checkpoint };

    await L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock').handle({ description: 'Build the notes page' }, ctx);

    expect(planned).toHaveBeenCalledOnce();
    expect(planned.mock.calls[0]![1].subtasks).toHaveLength(3);
    expect(planned.mock.calls[0]![3]).toBe(2);
    const phaseReviews = model.requests.filter((req) => req.actor?.tier === 3 && req.child?.tier === 2);
    const reviewsOf = (prefix: string) => phaseReviews.filter((req) => req.userContent.includes(`Task: ${prefix}`));
    expect(reviewsOf('Build the notes page').length).toBeGreaterThan(0);
    expect(reviewsOf('Build the notes page').every((req) => !req.userContent.includes(READ_ONLY_TASK_LINE))).toBe(true);
    expect(reviewsOf('BROWSER VERIFICATION ONLY').length).toBeGreaterThan(0);
    expect(reviewsOf('BROWSER VERIFICATION ONLY').every((req) => req.userContent.includes(READ_ONLY_TASK_LINE))).toBe(true);
    expect(reviewsOf('FINAL SHELL/HARNESS VERIFICATION ONLY').length).toBeGreaterThan(0);
    expect(reviewsOf('FINAL SHELL/HARNESS VERIFICATION ONLY').every((req) => req.userContent.includes(READ_ONLY_TASK_LINE))).toBe(true);
  });
});
