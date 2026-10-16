import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom, routeCrossBucketVerification } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { DELEGATION_REVIEW_REQUEST, approvalDigest, delegationReviewTaskKey, enforceDelegationReview, routingIndexNote } from '../src/atoms/delegationReview.js';
import type { RootPhaseCheckpoint } from '../src/contracts/runCheckpoint.js';
import { planSchema } from '../src/atoms/json.js';
import type { BranchEventInfo, LlmCompletionRequest, LlmCompletionResponse, Plan, Result, RunContext, Task, Tool, ToolExecutor } from '../src/core/types.js';
import { parentTestSuiteDigest, type DelegationReview, type ParentTestSuite } from '../src/contracts/parentTests.js';
import { READ_ONLY_TASK_LINE } from '../src/contracts/readOnlyPhase.js';
import { mockOtherProofReview } from './helpers/delegationReview.js';
import { MockLlmClient } from '../src/core/llm.js';
import { modelForTier } from '../src/core/models.js';
import { ValidationError } from '../src/core/errors.js';
import { ROOT_DELEGATION_REVIEW_PARAMS } from '../src/atoms/cost.js';
import { VALIDATION_PARAMS, VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunCheckpointStore, SequentialCheckpoint } from '../src/run/checkpoint.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { withRecoveryEffects } from '../src/core/recoveryEffects.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const databases: ReturnType<typeof openDb>[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  closeStoreHandles();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
    // Second review 2026-10-16: an allowlist on end_turn. The Claude CLI hands
    // back its error subtypes with salvaged text that jsonrepair would close
    // into a complete approval.
    ['a review the transport ended on an error subtype', { text: approval.slice(0, -12), stopReason: 'error_during_execution' }],
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

  it.each(faults)('reviews a child plan again on the root review model after %s, never handing the fault to its planner', async (_, fault) => {
    const { tissue, cell } = actors();
    const ctx = makeCtx();
    ctx.llm.enqueue({ text: fault.text, stopReason: fault.stopReason ?? 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    ctx.llm.enqueueText(approval);
    const verdict = await tissue.validatePlan(cell, runnable(), { description: 'add', acceptanceTests: suite }, ctx);
    expect(verdict.approved).toBe(true);
    const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
    expect(reviews.map(call => [call.model, call.params])).toEqual([
      [modelForTier(1), VALIDATION_PARAMS],
      [modelForTier(2), ROOT_DELEGATION_REVIEW_PARAMS],
    ]);
  });

  it('returns a child plan review that faults twice as a reviewer refusal, never a thrown error', async () => {
    const { tissue, cell } = actors();
    const ctx = makeCtx();
    for (let i = 0; i < 2; i++) {
      ctx.llm.enqueue({ text: '{"approved": true, "reasoning": "cut', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 } });
    }
    const verdict = await tissue.validatePlan(cell, runnable(), { description: 'add', acceptanceTests: suite }, ctx);
    expect(verdict.approved).toBe(false);
    expect(verdict).toMatchObject({ delegationRefusal: 'reviewer' });
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(2);
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
    expect(plans[1]?.userContent).toContain('PREVIOUS PLAN ATTEMPT:');
    expect(plans[1]?.userContent).toContain('plan reply hit the plan output cap and was cut; return a shorter reply');
    expect(plans[1]?.userContent).toContain('each suite a self-contained file under 8,000 characters');
    // No token number the planner cannot act on, no advice the runner cannot honour.
    expect(plans[1]?.userContent).not.toMatch(/STRATEGY_MAX_TOKENS|16,?384/);
    expect(plans[1]?.userContent).not.toContain('integration suite, no duplicated setup');
    expect(plans[1]?.userContent).not.toContain('fewer or shorter suites');
    expect(plans[1]?.userContent).not.toContain('escape every backslash, double quote and newline, test sources included');
    expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(SOURCE);
  });

  // Group G4, 2026-10-16: a new suite over the authored bound is refused on
  // the real root path before review, and the planner is told where and why
  // on the planner-feedback channel, beside any earlier review refusal.
  describe('a suite over the authored bound', () => {
    const sized = (length: number) => `${SOURCE}\n// ${'x'.repeat(length - SOURCE.length - 4)}`;
    const sizeMessage = 'over the 12,000 characters the host accepts for a new suite';

    it('is never reviewed, and the planner is asked again with its location and length', async () => {
      const { tissue, cellName } = routedActors();
      const atBound = sized(12_000);
      const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: planReply(cellName, sized(12_001)) }, { text: planReply(cellName, atBound) }], [{ text: approval }]) });
      const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      await tissue.handle({ description: 'Implement signed addition' }, ctx);
      const roles = ctx.llm.calls.map(call => call.role).filter(role => role === 'plan' || role === 'validate-plan');
      expect(roles).toEqual(['plan', 'plan', 'validate-plan']);
      const plans = ctx.llm.calls.filter(call => call.role === 'plan');
      expect(plans[0]?.userContent).not.toContain('PREVIOUS PLAN ATTEMPT:');
      const retry = plans[1]?.userContent ?? '';
      expect(retry).toContain('PREVIOUS PLAN ATTEMPT:');
      expect(retry).toContain('plan reply refused: acceptanceTests.source ' + sizeMessage);
      expect(retry).toContain('subtask index 0 (zero-based) (12,001)');
      expect(retry).toContain('keep each suite under 8,000 characters');
      expect(retry).not.toContain('escape every backslash, double quote and newline');
      // The channel never reaches the prefilter or the task's constraints.
      const prefilters = ctx.llm.calls.filter(call => call.role === 'prefilter');
      expect(prefilters.length).toBeGreaterThan(0);
      expect(prefilters.every(call => !call.userContent.includes(sizeMessage))).toBe(true);
      expect(retry).not.toContain('Constraints:');
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0].constraints).toBeUndefined();
      expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(atBound);
    });

    it('ends the run after three, naming the bound', async () => {
      const { tissue, cellName } = routedActors();
      const over = { text: planReply(cellName, sized(13_240)) };
      const ctx = makeCtx({ llm: routedLlm(cellName, [over, { ...over }, { ...over }], []) });
      const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      await expect(tissue.handle({ description: 'Implement signed addition' }, ctx)).rejects.toThrow(sizeMessage);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
    });

    it('keeps the review refusal beside the size message on the next attempt', async () => {
      const { tissue, cellName } = routedActors();
      const refusal = JSON.stringify({ approved: false, reasoning: 'the suite misses negative operands', scope: 'ephemeral', modifications: {} });
      const ctx = makeCtx({ llm: routedLlm(cellName,
        [{ text: planReply(cellName) }, { text: planReply(cellName, sized(12_001)) }, { text: planReply(cellName) }],
        [{ text: refusal }, { text: approval }]) });
      vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      await tissue.handle({ description: 'Implement signed addition' }, ctx);
      const plans = ctx.llm.calls.filter(call => call.role === 'plan');
      expect(plans).toHaveLength(3);
      expect(plans[1]?.userContent).toContain('Delegation contract rejected before execution: the suite misses negative operands');
      expect(plans[1]?.userContent).not.toContain(sizeMessage);
      expect(plans[2]?.userContent).toContain('Delegation contract rejected before execution: the suite misses negative operands');
      expect(plans[2]?.userContent).toContain(sizeMessage);
    });
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

  // Group G4, 2026-10-16: suites are written alone into a disposable copy, so
  // the guidance says so and states the size target; reviewers ask within it.
  it('tells root and cell planners that each suite is self-contained and states the size target', async () => {
    const { tissue, cellName } = routedActors();
    const ctx = makeCtx({ llm: routedLlm(cellName, [{ text: planReply(cellName) }], [{ text: approval }]) });
    vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    await tissue.handle({ description: 'Implement signed addition' }, ctx);
    const { cell } = actors();
    const cellCtx = makeCtx();
    cellCtx.llm.enqueueText(planReply('Urea'));
    await cell.plan({ description: 'Implement signed addition', acceptanceTests: suite }, cellCtx);
    const prompts = [
      ctx.llm.calls.find(call => call.role === 'plan')?.userContent ?? '',
      cellCtx.llm.calls.find(call => call.role === 'plan')?.userContent ?? '',
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('Each suite is a self-contained file: it cannot import or share setup with another suite');
      expect(prompt).toContain('under 8,000;');
      expect(prompt).not.toMatch(/shared fixtures|setup (?:once )?in the integration suite|fewer subtasks/i);
    }
    expect(VALIDATION_SYSTEM_PROMPT).toContain('Ask for the coverage a suite can carry within 8,000 characters');
    expect(VALIDATION_SYSTEM_PROMPT).toContain('ask for the branch to be split rather than for a longer suite');
  });

  describe('resuming a saved root plan', () => {
    const criteria = [{ id: 'c1', behaviour: 'Signed sums are correct', source: 'user' as const }];

    type Actor = { name: string; atomId?: string; version: number | null };
    function savedRoot(tissue: L3Atom, task: Task, plan: Plan, bound: {
      model?: string; actor?: (actor: Actor) => Actor; digest?: (args: Parameters<typeof approvalDigest>[0]) => string;
    } = {}) {
      const review = {
        subtasks: [{ index: 0, kind: 'vitest' as const, reason: 'module' }],
        integration: { kind: 'other' as const, reason: 'one module' },
        independentWork: false,
        parallelReason: 'one module',
      };
      const current = { name: tissue.name, atomId: tissue.atomId, version: tissue.registryVersion() };
      const args = { plan, from: 0, task, actor: bound.actor?.(current) ?? current, model: bound.model ?? modelForTier(2) };
      const digest = (bound.digest ?? approvalDigest)(args);
      return {
        plan: JSON.parse(JSON.stringify(plan)),
        strategy: { strategy: 'reuse', target: 'cell', reasoning: 'r' },
        plannedPhases: 1,
        inputs: task.inputs,
        approval: { digest, from: 0, review },
      };
    }

    function resumingCtx(root: ReturnType<typeof savedRoot>, at: { completed?: Result[]; replanAfterAnswer?: boolean } = {}) {
      const planned = vi.fn<RootPhaseCheckpoint['planned']>();
      const ctx = {
        ...makeCtx(),
        rootCheckpoint: {
          restore: () => root,
          completed: at.completed ?? [],
          ...(at.replanAfterAnswer ? { replanAfterAnswer: true } : {}),
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

    // Group G4, 2026-10-16: the authored bound is the parser's, never the
    // schema's, so a plan saved with a longer suite still restores.
    it('runs a recorded approval over a suite longer than the authored bound', async () => {
      const { tissue } = actors();
      const task: Task = { description: 'Implement signed addition', inputs: { a: 1 }, criteria };
      const long = { ...suite, source: `${suite.source}\n// ${'x'.repeat(20_000 - suite.source.length - 4)}` };
      expect(long.source).toHaveLength(20_000);
      const saved = planSchema.parse({ ...runnable(), subtasks: [{ ...runnable().subtasks[0]!, acceptanceTests: long }], aggregation: { mode: 'sequential' } });
      const root = savedRoot(tissue, task, saved);
      const { ctx, planned } = resumingCtx(root);
      const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      await tissue.handle(task, ctx);
      expect(ctx.llm.calls).toHaveLength(0);
      expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(long.source);
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

    // Second review 2026-10-16: the digest binds the contract, the system
    // prompt, the reviewing model and the root actor; each is changed alone.
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const digestOver = (contract: string, prompt: string) => (args: Parameters<typeof approvalDigest>[0]) => sha(JSON.stringify([
      contract, sha(prompt), args.model, args.from, planSchema.parse(JSON.parse(JSON.stringify(args.plan))),
      ...(JSON.parse(JSON.stringify(delegationReviewTaskKey(args.task))) as unknown[]),
      { name: args.actor.name, atomId: args.actor.atomId ?? null, version: args.actor.version },
    ]));

    it('binds the recorded approval exactly as this replica computes it', () => {
      const { tissue } = actors();
      const task: Task = { description: 'Implement signed addition', inputs: { a: 1 } };
      const actor = { name: tissue.name, atomId: tissue.atomId, version: tissue.registryVersion() };
      const args = { plan: sequential(), from: 0, task, actor, model: modelForTier(2) };
      expect(digestOver(DELEGATION_REVIEW_REQUEST, VALIDATION_SYSTEM_PROMPT)(args)).toBe(approvalDigest(args));
    });

    it.each([
      ['another reviewing model', { model: 'api:anthropic:claude-other-model' }],
      ['another version of the root actor', { actor: (actor: Actor) => ({ ...actor, version: (actor.version ?? 0) + 1 }) }],
      ['another root actor id', { actor: (actor: Actor) => ({ ...actor, atomId: 'another-atom' }) }],
      ['another review contract', { digest: digestOver(`${DELEGATION_REVIEW_REQUEST}\nOne more rule.`, VALIDATION_SYSTEM_PROMPT) }],
      ['another validation system prompt', { digest: digestOver(DELEGATION_REVIEW_REQUEST, `${VALIDATION_SYSTEM_PROMPT} `) }],
    ])('reviews again when the approval was recorded under %s', async (_, bound) => {
      const { tissue } = actors();
      const task: Task = { description: 'Implement signed addition', inputs: { a: 1 } };
      const root = savedRoot(tissue, task, sequential(), bound);
      const { ctx, planned } = resumingCtx(root);
      vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      ctx.llm.enqueueText(approval);
      await tissue.handle(task, ctx);
      expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
      expect(planned.mock.calls[0]?.[4]?.digest).not.toBe(root.approval.digest);
    });

    // Second review 2026-10-16: a resumed non-sequential remaining plan spends
    // an attempt before any review; dispatched, it would run the completed
    // prefix again in parallel.
    describe('a remaining plan that is not sequential', () => {
      const prefixPhase = { description: 'Write the shared types', outputs: ['types.ts'] };
      const twoPhases = () => planSchema.parse({ ...makePlan({ subtasks: [prefixPhase, runnable().subtasks[0]!] }), aggregation: { mode: 'sequential' } });
      const concat = () => planSchema.parse({ ...runnable(), aggregation: { mode: 'concat' } });
      const done: Result = { ...result, summary: 'types written' };

      it('is asked for again with the reason, never reviewed, and the prefix is kept in a sequential plan', async () => {
        const { tissue } = actors();
        const task: Task = { description: 'Implement signed addition', inputs: { a: 1 } };
        const { ctx } = resumingCtx(savedRoot(tissue, task, twoPhases()), { completed: [done], replanAfterAnswer: true });
        const plan = vi.spyOn(tissue, 'plan')
          .mockResolvedValueOnce(concat())
          .mockResolvedValueOnce(planSchema.parse({ ...runnable(), aggregation: { mode: 'sequential' } }));
        const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
        ctx.llm.enqueueText(approval);
        await tissue.handle(task, ctx);
        expect(plan).toHaveBeenCalledTimes(2);
        expect(plan.mock.calls[0]?.[0].constraints ?? []).toEqual([]);
        expect(plan.mock.calls[0]?.[2]).toEqual([]);
        // The reason travels on the planner channel, never in the task's constraints.
        expect(plan.mock.calls[1]?.[0].constraints ?? []).toEqual([]);
        expect(plan.mock.calls[1]?.[2]?.at(-1)).toContain('a resumed run executes sequentially');
        expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(1);
        const executed = execute.mock.calls[0]?.[1];
        expect(executed?.aggregation.mode).toBe('sequential');
        expect(executed?.subtasks.map(subtask => subtask.description)).toEqual([prefixPhase.description, 'Implement signed addition']);
      });

      it('ends the run after three, without a review or an execution', async () => {
        const { tissue } = actors();
        const task: Task = { description: 'Implement signed addition', inputs: { a: 1 } };
        const { ctx } = resumingCtx(savedRoot(tissue, task, twoPhases()), { completed: [done], replanAfterAnswer: true });
        vi.spyOn(tissue, 'plan').mockResolvedValue(concat());
        const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
        await expect(tissue.handle(task, ctx)).rejects.toThrow(/^Saved delegation plan requires a new run: Remaining plan rejected before review/);
        expect(ctx.llm.calls.filter(call => call.role === 'validate-plan')).toHaveLength(0);
        expect(execute).not.toHaveBeenCalled();
      });
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

  function routingRegistry(options: { fullStack?: boolean; shellExtra?: string[] } = {}) {
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
    const shellTools = ['run_shell', 'start_node_server', ...(options.shellExtra ?? [])];
    const shell = registry.create(2, { ...seed, tools: shellTools.map(tool) });
    const web = registry.create(2, { ...seed, tools: [tool('validate_html'), tool('start_static_server')] });
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
  /**
   * GROUP G5 (2026-10-16): the parts of a host-split checkpoint hear its
   * criteria as context unless their cell can prove both browser and command
   * evidence; the mark survives a durable checkpoint and a resume.
   */
  describe('criteria of a split checkpoint', () => {
    const userCriteria = [
      { id: 'c1', behaviour: 'A note is added with the keyboard only, no mouse', source: 'user' as const },
      { id: 'c2', behaviour: 'node test-api.js exits 0', source: 'user' as const },
      { id: 'c3', behaviour: 'module A renders the page', source: 'user' as const },
    ];

    /** The criteria ids a phase review lists under each header. */
    function criteriaSections(content: string) {
      const listed = (header: string): string[] => {
        const lines = content.split('\n');
        const start = lines.findIndex((line) => line.startsWith(header));
        if (start < 0) return [];
        const items: string[] = [];
        for (const line of lines.slice(start + 1)) {
          const item = /^- (c\d+): /.exec(line);
          if (!item) break;
          items.push(item[1]!);
        }
        return items;
      };
      return {
        binding: listed('Acceptance criteria this phase must prove'),
        context: listed('Acceptance criteria the root acceptor will also judge'),
      };
    }

    /** Every request that hands a phase's task to a model: its plans, executions and reviews, below the prefilter. */
    function phaseRequests(requests: readonly LlmCompletionRequest[], prefix: string) {
      return requests.filter((req) => req.role !== 'prefilter' && req.userContent.includes(`Task: ${prefix}`));
    }

    function withCriteria(plan: ReturnType<typeof dagPlan>) {
      return {
        ...plan,
        subtasks: plan.subtasks.map((subtask, index) =>
          index === 1 ? { ...subtask, criteria: ['c3'] } : index === 3 ? { ...subtask, criteria: ['c1', 'c2'] } : subtask
        ),
      };
    }

    async function run(actors: ReturnType<typeof routingRegistry>, checkpointCell = actors.web) {
      const model = routingModel({
        cell: actors.shell,
        molecule: actors.molecule,
        rootPlans: [withCriteria(dagPlan(actors, checkpointCell))],
        review: classify,
      });
      const ctx: RunContext = { ...makeCtx(), llm: model.llm, tools: passingSuites() };
      await L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock').handle({ description: 'Build the application', criteria: userCriteria }, ctx);
      return model.requests;
    }

    it('gives both parts the checkpoint\'s criteria as context when neither cell can prove both', async () => {
      const requests = await run(routingRegistry());

      const browserRequests = phaseRequests(requests, 'BROWSER VERIFICATION ONLY');
      const shellRequests = phaseRequests(requests, 'FINAL SHELL/HARNESS VERIFICATION ONLY');
      const moduleRequests = phaseRequests(requests, 'Implement a.ts');
      expect(browserRequests.length).toBeGreaterThan(0);
      expect(shellRequests.length).toBeGreaterThan(0);
      expect(moduleRequests.length).toBeGreaterThan(0);
      for (const req of [...browserRequests, ...shellRequests]) {
        expect(criteriaSections(req.userContent)).toEqual({ binding: [], context: ['c1', 'c2'] });
      }
      for (const req of moduleRequests) {
        expect(criteriaSections(req.userContent)).toEqual({ binding: ['c3'], context: [] });
      }
    });

    it('binds the criteria to the browser part when it is routed to a cell holding both capabilities', async () => {
      // The checkpoint is planned on the shell cell, which holds a tool the
      // full-stack cell lacks: it splits, and its browser part goes to the
      // full-stack cell, which can start the shell cell's Node server.
      const actors = routingRegistry({ fullStack: true, shellExtra: ['call_mcp_tool'] });

      const requests = await run(actors, actors.shell);

      const browserRequests = phaseRequests(requests, 'BROWSER VERIFICATION ONLY');
      const shellRequests = phaseRequests(requests, 'FINAL SHELL/HARNESS VERIFICATION ONLY');
      expect(browserRequests.length).toBeGreaterThan(0);
      expect(shellRequests.length).toBeGreaterThan(0);
      for (const req of browserRequests) {
        expect(criteriaSections(req.userContent)).toEqual({ binding: ['c1', 'c2'], context: [] });
      }
      for (const req of shellRequests) {
        expect(criteriaSections(req.userContent)).toEqual({ binding: [], context: ['c1', 'c2'] });
      }
    });

    it('keeps the routing marks through a durable checkpoint and a resume under the recorded approval', async () => {
      const actors = routingRegistry();
      const tissue = L3Atom.buildWithModel(actors.tissue, actors.registry, 'mock');
      const task: Task = { description: 'Build the notes page', inputs: { a: 1 }, criteria: userCriteria.slice(0, 2) };
      const planned = planSchema.parse({
        reasoning: 'build, then verify',
        subtasks: [
          { description: 'Build the notes page in index.html.', preferredChild: actors.shell, outputs: ['index.html'] },
          { description: CHECKPOINT, preferredChild: actors.web, criteria: ['c1', 'c2'] },
        ],
        aggregation: { mode: 'sequential' },
        expectedOutput: 'a verified notes page',
      });
      const routed = routeCrossBucketVerification(planned, actors.registry);
      expect(routed.subtasks).toHaveLength(3);
      const actor = { name: tissue.name, atomId: tissue.atomId, version: tissue.registryVersion() };
      const approval = {
        digest: approvalDigest({ plan: routed, from: 0, task, actor, model: modelForTier(2) }),
        from: 0,
        review: classify(routed).delegationReview as DelegationReview,
      };

      const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-g5-resume-')));
      roots.push(root);
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      writeFileSync(join(workspace, 'index.html'), '<main>notes</main>');
      const store = new RunCheckpointStore(join(root, 'atoma.db'));
      const id = randomUUID();
      const data = {
        version: 1, id, scope: { orgId: 'org', projectId: 'proj', principalId: 'alice', runId: id }, goal: task.description, workspace,
        policy: '{}', actor, checklist: [], root: null, completed: [], workspaceDigest: null, processes: [],
        consumed: { tokens: 0, costUsd: 0 }, remainingMs: 600_000, lastRunId: null,
      };
      await withRecoveryEffects(async () => {
        const writer = new SequentialCheckpoint(data as never, store, {
          fresh: true, automatic: true, pauseAfter: 1, account: () => ({ tokens: 1, costUsd: 0.1 }),
          deadlineAt: Date.now() + 600_000, settle: async () => {}, processes: () => [],
        });
        writer.planned(task, routed, { strategy: 'reuse', target: actors.shell, reasoning: 'r' }, 2, approval);
        await writer.beforePhase(0, routed.subtasks[0]);
        const built: Result = {
          ...result,
          summary: 'page built',
          trace: [{ kind: 'verdict-result', ts: '0', atom: tissue.name, payload: { approved: true, reasoning: 'reviewed' } }],
        };
        await expect(writer.afterPhase(0, built)).rejects.toThrow();
        writer.release();
      });
      const saved = store.read(id);
      expect(saved.root?.approval).toEqual(approval);

      const model = routingModel({ cell: actors.shell, molecule: actors.molecule, rootPlans: [], review: classify });
      const recorded: Plan[] = [];
      const plannedAgain = vi.fn<RootPhaseCheckpoint['planned']>();
      const ctx: RunContext = {
        ...makeCtx(),
        llm: model.llm,
        tools: passingSuites(),
        recordRootPlan: (plan) => recorded.push(plan),
        rootCheckpoint: {
          restore: () => saved.root ?? null,
          completed: saved.completed.map((phase) => ({ ...phase, trace: [] })),
          planned: plannedAgain,
          beforePhase: vi.fn(),
          afterPhase: vi.fn(async () => {}),
          finalizing: vi.fn(),
        },
      };

      await tissue.handle(task, ctx);

      expect(model.reviewedPlans).toHaveLength(0);
      expect(plannedAgain.mock.calls[0]?.[4]).toEqual(approval);
      expect(recorded[0]!.subtasks.map((subtask) => subtask.routedFrom)).toEqual([
        undefined,
        { index: 1, role: 'browser-verification', criteria: 'context' },
        { index: 1, role: 'shell-verification', criteria: 'context' },
      ]);
      const browserRequests = phaseRequests(model.requests, 'BROWSER VERIFICATION ONLY');
      expect(browserRequests.length).toBeGreaterThan(0);
      for (const req of browserRequests) {
        expect(criteriaSections(req.userContent)).toEqual({ binding: [], context: ['c1', 'c2'] });
      }
    });
  });
});
