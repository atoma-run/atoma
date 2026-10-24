import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { PLAN_REVIEW_MAX_TOKENS, STRATEGY_MAX_TOKENS } from '../src/atoms/cost.js';
import { VALIDATION_PARAMS } from '../src/atoms/verdict.js';
import { AnthropicLlmClient } from '../src/core/llm.js';
import { offeredCatalogModels } from '../src/core/modelCatalog.js';
import type { Result } from '../src/core/types.js';
import { makePlan } from './helpers/factories.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

const seed = {
  description: 'with a greedy ceiling',
  systemPrompt: 'sys',
  tools: [],
  params: { maxTokens: 32_000, temperature: 0.2 },
  createdBy: 'test',
};

describe('strategy maxTokens cap', () => {
  it('L2.plan caps maxTokens to STRATEGY_MAX_TOKENS even when the atom type is greedy', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed); // Tracheid (empty tier-1 catalog → no prefilter, full plan path)
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);

    const ctx = makeCtx();
    // Full plan path returns a [strategy, plan] pair
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'create', seed: { description: 'x', systemPrompt: 'y', tools: [], params: {} }, reasoning: 'r' },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );

    await l2.plan({ description: 't' }, ctx);
    const lastCall = ctx.llm.calls[ctx.llm.calls.length - 1]!;
    expect(lastCall.params?.maxTokens).toBe(STRATEGY_MAX_TOKENS);
    expect(lastCall.params?.maxTokens).toBe(16_384);
  });

  it('L3.plan caps maxTokens to STRATEGY_MAX_TOKENS', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3Type = reg.create(3, seed);
    const l3 = L3Atom.buildWithModel(l3Type, reg, FALLBACK_OPUS);

    const ctx = makeCtx();
    ctx.llm.enqueueText(
      jsonTextPair(
        { strategy: 'create', seed: { description: 'x', systemPrompt: 'y', tools: [], params: {} }, reasoning: 'r' },
        { reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }
      )
    );

    await l3.plan({ description: 't' }, ctx);
    const lastCall = ctx.llm.calls[ctx.llm.calls.length - 1]!;
    expect(lastCall.params?.maxTokens).toBe(STRATEGY_MAX_TOKENS);
    expect(lastCall.params?.maxTokens).toBe(16_384);
  });

  it('prefilter path does not hit the strategy call (no strategy cap applies)', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'fetches URLs' });  // Water
    const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);

    const ctx = makeCtx();
    // prefilter picks Water
    ctx.llm.enqueueText(
      jsonText({
        kind: 'reuse',
        target: 'Water',
        confidence: 'high',
        reasoning: 'matches',
      })
    );

    await l2.plan({ description: 'fetch example.com' }, ctx);
    // Only the prefilter call happened; strategy call was skipped
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.params?.maxTokens).toBeLessThanOrEqual(256);
  });

  // Group G4, 2026-10-16: the plan cap rose, the plan-review cap did not.
  describe('plan reviews keep their own cap', () => {
    const suite = {
      requirement: 'signed addition',
      cwd: '.',
      source: "import {test,expect} from 'vitest';import {add} from './add.ts';test('signed sums',()=>{expect(add(-2,1)).toBe(-1)});",
    };
    const approval = JSON.stringify({
      approved: true,
      reasoning: 'scope reviewed',
      delegationReview: {
        subtasks: [{ index: 0, kind: 'vitest', reason: 'actual assigned scope' }],
        integration: { kind: 'other', reason: 'integration scope' },
        independentWork: false,
        parallelReason: 'actual dependency analysis',
      },
    });
    const runnable = () => makePlan({ subtasks: [{ description: 'Implement signed addition', outputs: ['add.ts'], acceptanceTests: suite }] });
    const result: Result = { output: 'o', summary: 's', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
    const actors = () => {
      const reg = new AtomRegistry(openDb(':memory:'));
      const tissue = L3Atom.buildWithModel(reg.create(3, seed), reg, FALLBACK_OPUS);
      const cellType = reg.create(2, seed);
      for (let i = 0; i < 10; i++) reg.recordSuccess(cellType.name);
      return { tissue, cell: L2Atom.fromType(reg.getByName(cellType.name)!, reg) };
    };

    it('reviews a root plan at 8,000 tokens', async () => {
      const { tissue } = actors();
      const ctx = makeCtx();
      vi.spyOn(tissue, 'plan').mockResolvedValue(runnable());
      vi.spyOn(tissue, 'execute').mockResolvedValue(result);
      ctx.llm.enqueueText(approval);
      await tissue.handle({ description: 'Implement signed addition' }, ctx);
      const review = ctx.llm.calls.find(call => call.role === 'validate-plan');
      expect(PLAN_REVIEW_MAX_TOKENS).toBe(8000);
      expect(review?.params?.maxTokens).toBe(8000);
    });

    it('reviews a child plan with VALIDATION_PARAMS first and at 8,000 tokens on its second attempt', async () => {
      const { tissue, cell } = actors();
      const ctx = makeCtx();
      ctx.llm.enqueueText('not a verdict');
      ctx.llm.enqueueText('still not a verdict'); // the reformat turn of that reply fails too
      ctx.llm.enqueueText(approval);
      const verdict = await tissue.validatePlan(cell, runnable(), { description: 'add', acceptanceTests: suite }, ctx);
      expect(verdict.approved).toBe(true);
      const reviews = ctx.llm.calls.filter(call => call.role === 'validate-plan');
      expect(reviews).toHaveLength(2);
      expect(reviews[0]?.params).toEqual(VALIDATION_PARAMS);
      expect(reviews[1]?.params?.maxTokens).toBe(8000);
    });
  });

  // The Anthropic SDK refuses a non-streaming call whose cap could outlast ten
  // minutes (above 21,333 tokens; above 8,192 for the dated Opus 4 and 4.1
  // ids) before any request is sent. Plan calls are not streamed, so the cap
  // must pass that check on every model the catalogue offers.
  describe('the plan cap through the real Anthropic SDK', () => {
    const reply = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '[]' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const clientWith = (bodies: unknown[]) => new AnthropicLlmClient(new Anthropic({
      apiKey: 'test',
      maxRetries: 0,
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }));
    const request = (model: string, maxTokens: number) => ({
      model,
      systemPrompt: 'sys',
      userContent: 'plan',
      params: { maxTokens, effort: 'medium' as const },
    });

    it('sends 16,384 to every offered Anthropic model without demanding streaming', async () => {
      const models = offeredCatalogModels('anthropic').map(model => model.id);
      expect(models.length).toBeGreaterThan(0);
      const bodies: unknown[] = [];
      const client = clientWith(bodies);
      for (const model of models) await client.complete(request(model, STRATEGY_MAX_TOKENS));
      expect(bodies).toHaveLength(models.length);
      expect(bodies.every(body => (body as { max_tokens: number }).max_tokens === 16_384)).toBe(true);
    });

    it('would demand streaming one token above its ceiling', async () => {
      const bodies: unknown[] = [];
      const client = clientWith(bodies);
      const current = offeredCatalogModels('anthropic')[0]!.id;
      await expect(client.complete(request(current, 21_334))).rejects.toThrow('Streaming is required');
      expect(bodies).toHaveLength(0);
    });

    it('offers no dated Opus 4 or 4.1 id, whose non-streaming ceiling is 8,192', () => {
      const dated = offeredCatalogModels('anthropic').map(model => model.id)
        .filter(id => /^claude-(?:opus-4(?:-[01])?|4-opus)(?:-\d{8}|@\d{8}|-0)?$/.test(id));
      expect(dated).toEqual([]);
    });
  });
});
