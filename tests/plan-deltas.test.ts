import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom, ROOT_PLAN_ATTEMPTS } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { applyPlanDeltas, parsePlanPair, l2StrategySchema, planSchema, type PlanDelta } from '../src/atoms/json.js';
import { planBase } from '../src/core/atom.js';
import { superviseLoop, type SupervisionHooks } from '../src/core/supervisor.js';
import { PlanParseError } from '../src/core/errors.js';
import { MockLlmClient } from '../src/core/llm.js';
import { closeStoreHandles } from '../src/core/stores.js';
import type { LlmCompletionRequest, LlmCompletionResponse, Plan, Result, Task } from '../src/core/types.js';
import { makeCtx } from './helpers.js';

// M3 of records/designs/replan-loop-2026-10-23.md: behind ATOMA_REVIEW_REPAIR a
// planner may answer a refusal with typed deltas on its retained refused plan.

const databases: ReturnType<typeof openDb>[] = [];
const savedFlag = process.env['ATOMA_REVIEW_REPAIR'];

beforeEach(() => {
  process.env['ATOMA_REVIEW_REPAIR'] = '1';
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env['ATOMA_REVIEW_REPAIR'];
  else process.env['ATOMA_REVIEW_REPAIR'] = savedFlag;
  for (const db of databases.splice(0)) db.close();
  closeStoreHandles();
  vi.restoreAllMocks();
});

function actors() {
  const db = openDb(':memory:');
  databases.push(db);
  const registry = new AtomRegistry(db);
  const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
  const tissue = registry.create(3, seed);
  const cell = registry.create(2, seed);
  return {
    tissue: L3Atom.buildWithModel(tissue, registry, 'mock'),
    cell: L2Atom.fromType(registry.getByName(cell.name)!, registry),
    cellName: cell.name,
  };
}

// Bytes a re-serialization would be likeliest to touch: an escaped class, a
// CRLF, a tab and a non-ASCII character.
const SOURCE = "import { test, expect } from 'vitest';\r\nimport { add } from './add.ts';\ntest('adds digits', () => {\n\texpect(String(add(2, 3))).toMatch(/\\d+/);\n  expect(add(-2, 1)).toBe(-1); // signé\n});";
const NEGATIVE = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('rejects text', () => {\n  expect(() => add('2' as never, 3)).toThrow(TypeError);\n  expect(add(0, 0)).toBe(0);\n});";
const suite = { requirement: 'signed addition', cwd: '.', source: SOURCE };

const strategy = (target: string) => ({ strategy: 'reuse', target, reasoning: 'Existing module author' });
const rawPlan = (child: string) => ({
  reasoning: 'One tested module',
  delivery: 'files',
  subtasks: [{ description: 'Implement signed addition', preferredChild: child, outputs: ['add.ts'], acceptanceTests: suite }],
  aggregation: { mode: 'sequential' },
  expectedOutput: 'add.ts',
});
const reply = (target: string, second: unknown): string => JSON.stringify([strategy(target), second]);
const refusal = JSON.stringify({ approved: false, reasoning: 'GAP: no case rejects a non-number operand.', scope: 'ephemeral',
  modifications: { additionalContext: 'Add a negative case for a text operand.' } });
const approval = (count: number) => JSON.stringify({
  approved: true,
  reasoning: 'scope reviewed',
  delegationReview: {
    subtasks: Array.from({ length: count }, (_, index) => ({ index, kind: 'vitest', reason: 'actual assigned scope' })),
    integration: { kind: 'other', reason: 'integration scope' },
    independentWork: false,
    parallelReason: 'actual dependency analysis',
  },
});
const replaceSuite: PlanDelta[] = [{ kind: 'suite.replace', target: 0, source: NEGATIVE }];
const digestIn = (prompt: string): string => /PREVIOUS PLAN \(digest ([0-9a-f]{64});/.exec(prompt)?.[1] ?? 'missing';
const response = (text: string): LlmCompletionResponse => ({ text, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } });

/** Routes the real L3.plan and the root review; a plan entry may read the prompt it answers. */
function routedLlm(plans: (string | ((prompt: string) => string))[], reviews: string[]): MockLlmClient {
  const llm = new MockLlmClient();
  const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
    if (req.role === 'plan') {
      const next = plans.shift();
      if (next === undefined) throw new Error('Unexpected plan call');
      return response(typeof next === 'string' ? next : next(req.userContent));
    }
    if (req.role === 'validate-plan') {
      const next = reviews.shift();
      if (next === undefined) throw new Error('Unexpected review call');
      return response(next);
    }
    if (req.role === 'prefilter') return response(JSON.stringify({ kind: 'escalate', reasoning: 'plan it' }));
    throw new Error(`Unexpected ${req.role} call`);
  };
  for (let i = 0; i < 40; i++) llm.enqueue(route);
  return llm;
}

const delivered: Result = { output: { exports: ['add(a,b)'] }, summary: 'Observed add export', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };

describe('applyPlanDeltas', () => {
  const base = planSchema.parse({
    reasoning: 'two branches and a report',
    subtasks: [
      { description: 'Implement add', preferredChild: 'Urea', executionMode: 'tools', outputs: ['add.ts'], inputs: { note: 'kept' },
        proofObligations: ['dom-interaction'], criteria: ['c1'], acceptanceTests: suite },
      { description: 'Implement sub', preferredChild: 'Urea', outputs: ['sub.ts'], acceptanceTests: { ...suite, requirement: 'subtraction' } },
      { description: 'Report', dependsOn: [0, 1] },
    ],
    aggregation: { mode: 'concat' },
    acceptanceTests: { requirement: 'integration', cwd: '.', source: SOURCE },
    expectedOutput: 'add.ts and sub.ts',
  });

  it('never alters a suite source: kept suites are the base strings, a replacement is the delta\'s bytes', () => {
    const amended = applyPlanDeltas(base, [
      { kind: 'suite.replace', target: 1, source: NEGATIVE },
      { kind: 'dependsOn.set', target: 1, dependsOn: [0] },
      { kind: 'criteria.assign', target: 2, criteria: ['c2'] },
      { kind: 'aggregation.set', aggregation: { mode: 'sequential' } },
    ]);
    expect(amended.subtasks[0]?.acceptanceTests?.source).toBe(SOURCE);
    expect(amended.acceptanceTests?.source).toBe(SOURCE);
    expect(amended.subtasks[1]?.acceptanceTests).toEqual({ requirement: 'subtraction', cwd: '.', source: NEGATIVE });
    expect(amended.subtasks[1]?.dependsOn).toEqual([0]);
    expect(amended.subtasks[2]?.criteria).toEqual(['c2']);
    expect(amended.aggregation).toEqual({ mode: 'sequential' });
    // Pure: the base is untouched.
    expect(base.subtasks[1]?.acceptanceTests?.source).toBe(SOURCE);
    expect(base.subtasks[1]?.dependsOn).toBeUndefined();
  });

  it('gives each split part the target\'s routing, mode, outputs, inputs, obligations and criteria, and makes dependents wait for every part', () => {
    const amended = applyPlanDeltas(base, [{ kind: 'suite.split', target: 0, into: [
      { description: 'Implement add for integers', acceptanceTests: { ...suite, source: NEGATIVE } },
      { description: 'Implement add for decimals', acceptanceTests: suite, criteria: ['c3'] },
    ] }]);
    expect(amended.subtasks).toHaveLength(4);
    for (const part of amended.subtasks.slice(0, 2)) {
      expect(part).toMatchObject({ preferredChild: 'Urea', executionMode: 'tools', outputs: ['add.ts'], inputs: { note: 'kept' }, proofObligations: ['dom-interaction'] });
    }
    expect(amended.subtasks[0]?.criteria).toEqual(['c1']);
    expect(amended.subtasks[1]?.criteria).toEqual(['c3']);
    expect(amended.subtasks[0]?.acceptanceTests?.source).toBe(NEGATIVE);
    expect(amended.subtasks[1]?.acceptanceTests?.source).toBe(SOURCE);
    expect(amended.subtasks[2]?.description).toBe('Implement sub');
    expect(amended.subtasks[3]?.dependsOn).toEqual([0, 1, 2]);
  });

  it('refuses an index out of range, a dependency on a later subtask, and a suite added without its requirement', () => {
    const schema = (deltas: PlanDelta[]) => {
      try {
        applyPlanDeltas(base, deltas);
      } catch (error) {
        return error instanceof PlanParseError ? error.kind : 'other';
      }
      return 'applied';
    };
    expect(schema([{ kind: 'criteria.assign', target: 3, criteria: ['c1'] }])).toBe('schema');
    expect(schema([{ kind: 'dependsOn.set', target: 0, dependsOn: [2] }])).toBe('schema');
    expect(schema([{ kind: 'suite.replace', target: 2, source: NEGATIVE }])).toBe('schema');
    expect(schema([{ kind: 'suite.replace', target: 2, requirement: 'report check', source: NEGATIVE }])).toBe('applied');
  });
});

describe('parsePlanPair with a retained base', () => {
  const base = planBase(planSchema.parse(rawPlan('Urea')));
  const deltaReply = (deltas: unknown, digest = base.digest) => reply('Urea', { planDeltas: { base: digest, deltas } });
  const kind = (text: string, context?: { base: typeof base }): string => {
    try {
      parsePlanPair(text, l2StrategySchema, 'end_turn', context);
    } catch (error) {
      return error instanceof PlanParseError ? error.kind : 'other';
    }
    return 'parsed';
  };

  it('reads deltas only against the base its caller retained', () => {
    expect(parsePlanPair(deltaReply(replaceSuite), l2StrategySchema, 'end_turn', { base }).plan)
      .toEqual(applyPlanDeltas(base.plan, replaceSuite));
    expect(kind(deltaReply(replaceSuite, 'f'.repeat(64)), { base })).toBe('schema');
    // No base, no deltas: the reply is no plan.
    expect(kind(deltaReply(replaceSuite))).toBe('schema');
  });

  it('refuses a 12,001-character suite, in a delta reply and in a whole plan', () => {
    const long = `${NEGATIVE}\n//${'x'.repeat(12_001 - NEGATIVE.length - 3)}`;
    expect(long).toHaveLength(12_001);
    expect(kind(deltaReply([{ kind: 'suite.replace', target: 0, source: long }]), { base })).toBe('schema');
    const whole = rawPlan('Urea');
    expect(kind(reply('Urea', { ...whole, subtasks: [{ ...whole.subtasks[0], acceptanceTests: { ...suite, source: long } }] }), { base })).toBe('suite-size');
  });

  it('bounds a reply to six deltas, two of them carrying a suite', () => {
    const criteria = { kind: 'criteria.assign', target: 0, criteria: ['c1'] };
    expect(kind(deltaReply(Array.from({ length: 7 }, () => criteria)), { base })).toBe('schema');
    const replace = { kind: 'suite.replace', target: 0, source: NEGATIVE };
    expect(kind(deltaReply([replace, replace]), { base })).toBe('parsed');
    expect(kind(deltaReply([replace, replace, replace]), { base })).toBe('schema');
  });
});

describe('the root loop under ATOMA_REVIEW_REPAIR', () => {
  it('reviews and executes exactly applyPlanDeltas(refused plan, deltas), its sources byte-equal', async () => {
    const { tissue, cellName } = actors();
    const deltas = (prompt: string) => reply(cellName, { planDeltas: { base: digestIn(prompt), deltas: replaceSuite } });
    const ctx = makeCtx({ llm: routedLlm([reply(cellName, rawPlan(cellName)), deltas], [refusal, approval(1)]) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(delivered);

    await tissue.handle({ description: 'Implement signed addition' }, ctx);

    const plans = ctx.llm.calls.filter(call => call.role === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[0]?.userContent).not.toContain('PREVIOUS PLAN (');
    const refused = planSchema.parse(rawPlan(cellName));
    expect(digestIn(plans[1]!.userContent)).toBe(planBase(refused).digest);
    // Shown by digest, first line and size, never by its bytes.
    expect(plans[1]?.userContent).toContain(`suite sha256 ${createHash('sha256').update(SOURCE).digest('hex')}; ` +
      `first line \\"import { test, expect } from 'vitest';\\"; ${SOURCE.length} characters]`);
    expect(plans[1]?.userContent).not.toContain('expect(add(-2, 1)).toBe(-1); // signé');
    const executed = execute.mock.calls[0]?.[1] as Plan;
    expect(executed).toEqual(applyPlanDeltas(refused, replaceSuite));
    expect(executed.subtasks[0]?.acceptanceTests?.source).toBe(NEGATIVE);
    // The review read the amended plan as a whole plan, with its new bytes.
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews).toHaveLength(2);
    expect(reviews[1]?.userContent).toContain("toThrow(TypeError)");
  });

  it('spends one attempt on a wrong base, tells the planner why, and keeps the base for the next reply', async () => {
    const { tissue, cellName } = actors();
    const wrong = reply(cellName, { planDeltas: { base: 'f'.repeat(64), deltas: replaceSuite } });
    const right = (prompt: string) => reply(cellName, { planDeltas: { base: digestIn(prompt), deltas: replaceSuite } });
    const ctx = makeCtx({ llm: routedLlm([reply(cellName, rawPlan(cellName)), wrong, right], [refusal, approval(1)]) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(delivered);

    await tissue.handle({ description: 'Implement signed addition' }, ctx);

    const plans = ctx.llm.calls.filter(call => call.role === 'plan');
    expect(plans).toHaveLength(3);
    expect(plans.length).toBeLessThan(ROOT_PLAN_ATTEMPTS);
    expect(plans[2]?.userContent).toContain('plan reply unparseable: planDeltas name base ffff');
    expect(digestIn(plans[2]!.userContent)).toBe(digestIn(plans[1]!.userContent));
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(2);
    expect((execute.mock.calls[0]?.[1] as Plan).subtasks[0]?.acceptanceTests?.source).toBe(NEGATIVE);
  });
});

describe('the cell loop under ATOMA_REVIEW_REPAIR', () => {
  const hooks: SupervisionHooks<L2Atom> = { applyByScope: child => Promise.resolve(child), branchOnEscalation: () => Promise.resolve() };

  it('hands the refused cell plan to its planner through superviseLoop, and executes the split plan the review approved', async () => {
    const { tissue, cell } = actors();
    const llm = new MockLlmClient();
    const split: PlanDelta[] = [{ kind: 'suite.split', target: 0, into: [
      { description: 'Implement add for integers', acceptanceTests: suite },
      { description: 'Reject text operands', acceptanceTests: { ...suite, requirement: 'rejects text', source: NEGATIVE } },
    ] }];
    llm.enqueue(response(reply('Urea', rawPlan('Urea'))));
    llm.enqueue(response(refusal));
    llm.enqueue(req => response(reply('Urea', { planDeltas: { base: digestIn(req.userContent), deltas: split } })));
    llm.enqueue(response(approval(2)));
    llm.enqueue(response(JSON.stringify({ approved: true, reasoning: 'the phase holds' })));
    const ctx = makeCtx({ llm });
    const plan = vi.spyOn(cell, 'plan');
    const execute = vi.spyOn(cell, 'execute').mockResolvedValue(delivered);
    const task: Task = { description: 'Implement signed addition' };

    const result = await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(result.producedBy.viaFallback).toBe(false);
    expect(plan).toHaveBeenCalledTimes(2);
    const first = await plan.mock.results[0]!.value as Plan;
    expect(plan.mock.calls[0]).toHaveLength(3);
    expect(plan.mock.calls[1]?.[3]).toEqual({ base: planBase(first) });
    const executed = execute.mock.calls[0]?.[1] as Plan;
    expect(executed).toEqual(applyPlanDeltas(first, split));
    expect(executed.subtasks.map(subtask => subtask.preferredChild)).toEqual(['Urea', 'Urea']);
    expect(executed.subtasks.map(subtask => subtask.acceptanceTests?.source)).toEqual([SOURCE, NEGATIVE]);
  });
});

describe('the base superviseLoop retains', () => {
  const hooks: SupervisionHooks<L2Atom> = { applyByScope: child => Promise.resolve(child), branchOnEscalation: () => Promise.resolve() };
  const task: Task = { description: 'Implement signed addition' };
  const resultRefusal = { approved: false as const, reasoning: 'the negative case was never run', scope: 'ephemeral' as const,
    modifications: { additionalContext: 'Run the negative case.' } };

  function cellLoop(plans: (string | ((prompt: string) => string))[], reviews: string[]) {
    const { tissue, cell } = actors();
    const ctx = makeCtx({ llm: routedLlm(plans, reviews) });
    const plan = vi.spyOn(cell, 'plan');
    vi.spyOn(cell, 'execute').mockResolvedValue(delivered);
    return { tissue, cell, ctx, plan };
  }

  it('is dropped once a plan is approved: the replan after a refused result builds on nothing', async () => {
    const { tissue, cell, ctx, plan } = cellLoop([reply('Urea', rawPlan('Urea')), reply('Urea', rawPlan('Urea')), reply('Urea', rawPlan('Urea'))],
      [refusal, approval(1)]);
    vi.spyOn(tissue, 'validateResult').mockResolvedValueOnce(resultRefusal).mockResolvedValueOnce({ approved: true, reasoning: 'the phase holds' });

    await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(plan).toHaveBeenCalledTimes(3);
    const first = await plan.mock.results[0]!.value as Plan;
    expect(plan.mock.calls[1]?.[3]).toEqual({ base: planBase(first) });
    expect(plan.mock.calls[2]).toHaveLength(3);
    expect(ctx.llm.calls.filter(call => call.role === 'plan')[2]?.userContent).not.toContain('PREVIOUS PLAN (');
  });

  it('is kept through an unparseable reply: the next one may still answer in deltas on it', async () => {
    const deltas = (prompt: string) => reply('Urea', { planDeltas: { base: digestIn(prompt), deltas: replaceSuite } });
    const { tissue, cell, ctx, plan } = cellLoop([reply('Urea', rawPlan('Urea')), 'not a plan', deltas], [refusal, approval(1)]);
    vi.spyOn(tissue, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'the phase holds' });

    await superviseLoop(tissue, cell, task, ctx, hooks);

    expect(plan).toHaveBeenCalledTimes(3);
    const first = await plan.mock.results[0]!.value as Plan;
    expect(plan.mock.calls[1]?.[3]).toEqual({ base: planBase(first) });
    expect(plan.mock.calls[2]?.[3]).toEqual({ base: planBase(first) });
    expect((vi.mocked(cell.execute).mock.calls[0]?.[1] as Plan).subtasks[0]?.acceptanceTests?.source).toBe(NEGATIVE);
  });
});

describe('with ATOMA_REVIEW_REPAIR off', () => {
  beforeEach(() => {
    delete process.env['ATOMA_REVIEW_REPAIR'];
  });

  it('leaves the cell planner\'s prompt byte-identical with or without a retained base, and refuses a delta reply', async () => {
    const { cell } = actors();
    const base = planBase(planSchema.parse(rawPlan('Urea')));
    const ctx = makeCtx();
    ctx.llm.enqueueText(reply('Urea', rawPlan('Urea')));
    ctx.llm.enqueueText(reply('Urea', rawPlan('Urea')));
    ctx.llm.enqueueText(reply('Urea', { planDeltas: { base: base.digest, deltas: replaceSuite } }));
    const task: Task = { description: 'Implement signed addition' };
    await cell.plan(task, ctx, ['Previous plan refused']);
    await cell.plan(task, ctx, ['Previous plan refused'], { base });
    await expect(cell.plan(task, ctx, ['Previous plan refused'], { base })).rejects.toBeInstanceOf(PlanParseError);
    const prompts = ctx.llm.calls.filter(call => call.role === 'plan').map(call => call.userContent);
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[0]).not.toContain('PREVIOUS PLAN (');
    expect(prompts[0]).not.toContain('planDeltas');
  });

  it('retains no base at the root: the planner is called as before', async () => {
    const { tissue, cellName } = actors();
    const ctx = makeCtx({ llm: routedLlm([reply(cellName, rawPlan(cellName)), reply(cellName, rawPlan(cellName))], [refusal, approval(1)]) });
    const plan = vi.spyOn(tissue, 'plan');
    vi.spyOn(tissue, 'execute').mockResolvedValue(delivered);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    expect(plan.mock.calls.map(call => call.length)).toEqual([3, 3]);
    const plans = ctx.llm.calls.filter(call => call.role === 'plan');
    expect(plans[1]?.userContent).not.toContain('PREVIOUS PLAN (');
    expect(plans[1]?.userContent).toContain('GAP: no case rejects a non-number operand.');
  });
});
