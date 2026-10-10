import { describe, expect, it, beforeEach } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import { PHASE_BUDGET_SPENT_PREFIX } from '../src/core/phaseBudget.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';

/**
 * Run bad74240 executed one molecule 13 times, 27 executions and 404 browser
 * checks in 4,222 s: a cell's retry ladder, run again whole by the tissue.
 * A root phase now gets one ladder: its cell's refused fallback goes up
 * unjudged for root acceptance to judge (owner decision 2026-10-10).
 */
const seed = { description: 'orchestrator', systemPrompt: 'You are an L2.', tools: [], params: {}, createdBy: 'test' };

describe('one ladder per root phase', () => {
  let reg: AtomRegistry;
  beforeEach(() => {
    reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
  });

  it('a tissue does not re-run a phase whose cell spent its ladder: the refused fallback goes up marked', async () => {
    reg.create(3, { ...seed, description: 'tissue', systemPrompt: 'You are an L3.' });
    const tissue = L3Atom.buildWithModel(reg.listByTier(3)[0]!, reg, FALLBACK_OPUS);
    const ctx = makeCtx();
    let executions = 0;
    const ok = (text: string) => ({ text, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });
    const phase = { description: 'build the page', outputs: ['index.html'] };
    // Every plan approved, every result rejected, for ever: without the budget
    // the cell's ladder (retries, a branch, its fallback) runs again under
    // each of the tissue's retries.
    const respond = (req: LlmCompletionRequest) => {
      const tier = req.actor?.tier;
      if (req.role === 'prefilter') return ok(jsonText({ kind: 'escalate', reasoning: 'no match' }));
      if (req.role === 'plan' && tier === 3) return ok(jsonTextPair({ strategy: 'reuse', target: 'Tracheid', reasoning: 'r' },
        { reasoning: 'one phase', subtasks: [{ ...phase, preferredChild: 'Tracheid' }], aggregation: { mode: 'sequential' }, expectedOutput: 'page' }));
      if (req.role === 'plan' && tier === 2) return ok(jsonTextPair({ strategy: 'reuse', target: 'Water', reasoning: 'r' },
        { reasoning: 'one step', subtasks: [{ ...phase, preferredChild: 'Water' }], aggregation: { mode: 'sequential' }, expectedOutput: 'page' }));
      if (req.role === 'plan' || req.role === 'fallback-plan') return ok(jsonText({ reasoning: 'r', proposedAction: 'write it', expectedOutput: 'page' }));
      // A molecule's execution and a supervisor's fallback both count.
      if (req.role === 'execute' || req.role === 'fallback-execute') { executions++; return ok(jsonText({ output: `attempt ${executions}`, summary: `attempt ${executions}` })); }
      if (req.role === 'validate-plan') return ok(jsonText({ approved: true, reasoning: 'fine' }));
      return ok(jsonText({ approved: false, reasoning: `still missing ${executions}`, scope: 'ephemeral', modifications: { additionalContext: 'fix it' } }));
    };
    for (let i = 0; i < 400; i++) ctx.llm.enqueue(respond);
    const result = await tissue.handle({ description: 'build the page' }, ctx);
    // Six molecule executions (three tries, a branch's three) and the cell's
    // fallback: one ladder, never a second.
    expect(executions).toBe(7);
    expect(result.phaseBudgetSpent).toBe(true);
    expect(result.summary).toContain(PHASE_BUDGET_SPENT_PREFIX);
    expect(result.summary).toContain('attempt 7');
    expect(result.summary).toContain('still missing 7');
  });

  it('forces review, never rejects', async () => {
    const env = buildResultGateEnv({ task: { description: 't' }, childName: 'Cell', childToolNames: [], ctx: makeCtx(),
      result: { output: null, summary: 's', trace: [], producedBy: { tier: 2, name: 'Cell', viaFallback: true }, phaseBudgetSpent: true } });
    const outcome = await runResultGates(env, new Set(), 'delegated');
    expect(outcome.rejection).toBeNull();
    expect(outcome.reviewFindings.map((f) => f.gateId)).toContain('phase-budget-spent');
  });
});
