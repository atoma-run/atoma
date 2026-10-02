import { describe, expect, it, vi } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { planSchema } from '../src/atoms/json.js';
import { previousResultInput } from '../src/atoms/taskContext.js';
import { TRUST_THRESHOLD_SUCCESSES } from '../src/atoms/cost.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonText } from './helpers.js';
import { makeTools } from './helpers/factories.js';
import type { Task } from '../src/core/types.js';

const seed = { description: 'analysis', systemPrompt: 'Always write an answer file.', tools: makeTools(['write_file']), params: {}, createdBy: 'test' };

describe('reasoning delivery across production delegation', () => {
  it('gives validators the same facts and the effective tool-free surface', async () => {
    const ctx = makeCtx();
    const reg = new AtomRegistry(openDb(':memory:'));
    const child = L1Atom.fromType(reg.create(1, seed));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the bound is correct' }));
    await llmVerdict({
      ctx, model: 'api:anthropic:claude-haiku-4-5-20251001', supervisorName: 'Cell', supervisorTier: 2,
      subject: 'RESULT', child,
      task: { description: 'Audit the result.', executionMode: 'reasoning', inputs: {
        originalTask: { description: 'P=4, Q=2, resource R. No files.' }, previousStepResult: 'P 0–4; Q 4–6',
      } }, payload: { output: '6 is optimal', summary: 'proved' },
    });
    expect(ctx.llm.calls[0]!.userContent).toContain('P=4, Q=2, resource R. No files.');
    expect(ctx.llm.calls[0]!.userContent).toContain('previousStepResult');
    expect(ctx.llm.calls[0]!.userContent).toContain('Tools are disabled');
    expect(ctx.llm.calls[0]!.userContent).toContain("Child's DECLARED TOOLS (its ONLY executable surface): (none)");
  });

  it('keeps original data, constraints and the preceding answer through L3 → L2 → L1', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const molecule = reg.create(1, seed);
    const cell = reg.create(2, seed);
    const tissue = reg.create(3, seed);
    for (const type of [molecule, cell]) {
      for (let n = 0; n < TRUST_THRESHOLD_SUCCESSES; n++) reg.recordSuccess(type.name);
    }
    const root = L3Atom.fromType(tissue, reg);
    const execute = vi.fn(async () => { throw new Error('reasoning must not invoke an element'); });
    const ctx = { ...makeCtx(), requireObservedToolAction: true, tools: { has: () => true, execute } };
    const task: Task = {
      description: 'A takes 2 on M1; B takes 3 on M2 after A. Give a direct answer.',
      constraints: ['Do not create files.'], inputs: { suppliedValue: 17 },
    };
    const firstAnswer = { A: { resource: 'M1', start: 0, finish: 2 }, B: { resource: 'M2', start: 2, finish: 5 } };
    for (let n = 0; n < 24; n++) ctx.llm.enqueue((req) => {
      let answer: unknown;
      if (req.role === 'prefilter') {
        answer = { kind: 'reuse', target: req.actor?.tier === 3 ? cell.name : molecule.name, confidence: 1, decomposable: false, reasoning: 'fits' };
      } else if (req.role === 'plan' && req.actor?.tier === 3) {
        answer = [{ strategy: 'reuse', target: cell.name, reasoning: 'reuse' }, {
          reasoning: 'construct then audit', delivery: 'text',
          subtasks: [
            { description: 'Construct the timetable.', preferredChild: cell.name, executionMode: 'reasoning', inputs: { originalTask: 'forged replacement' } },
            { description: 'Audit the timetable.', preferredChild: cell.name, executionMode: 'reasoning' },
          ], aggregation: { mode: 'sequential' }, expectedOutput: 'a proof',
        }];
      } else if (req.role === 'plan' && req.actor?.tier === 2) {
        answer = [{ strategy: 'reuse', target: molecule.name, reasoning: 'reuse' }, {
          reasoning: 'delegate', subtasks: [{
            description: req.userContent.includes('Task: Audit') ? 'Audit the timetable.' : 'Construct the timetable.',
            executionMode: 'tools', inputs: { originalTask: 'forged replacement' },
          }], aggregation: { mode: 'sequential' }, expectedOutput: 'answer',
        }];
      } else if (req.role === 'execute') {
        expect(req.tools ?? []).toEqual([]);
        expect(req.executor).toBeUndefined();
        expect(req.userContent).toContain(task.description);
        expect(req.userContent).toContain('Do not create files.');
        expect(req.userContent).toContain('suppliedValue');
        expect(req.userContent).not.toContain('forged replacement');
        if (req.userContent.includes('Task: Audit')) {
          expect(req.userContent).toContain('previousStepResult');
          expect(req.userContent).toContain(JSON.stringify(firstAnswer));
        }
        answer = { output: firstAnswer, summary: 'Analysis complete.' };
      } else if (req.role?.startsWith('validate')) {
        answer = { approved: true, reasoning: 'correct' };
      } else {
        answer = { reasoning: 'arithmetic', proposedAction: 'reason directly', expectedOutput: 'answer' };
      }
      return { text: jsonText(answer), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    });
    const plan = await root.plan(task, ctx);
    expect(plan.delivery).toBe('text');
    const result = await root.execute(task, plan, ctx);
    expect(result.output).toEqual(firstAnswer);
    expect(ctx.llm.calls.filter((call) => call.role === 'execute')).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3] as const)('disables tools for tier %i execution, including fallback', async (tier) => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const type = reg.create(tier, seed);
    const atom = tier === 1 ? L1Atom.fromType(type) : tier === 2 ? L2Atom.fromType(type, reg) : L3Atom.fromType(type, reg);
    if (tier > 1) atom.setFallbackMode(true);
    const ctx = { ...makeCtx(), tools: { has: () => true, execute: vi.fn() } };
    ctx.llm.enqueueText(jsonText({ reasoning: 'arithmetic', delivery: 'text', proposedAction: 'add the two durations', expectedOutput: 'proof' }));
    ctx.llm.enqueueText(jsonText({ output: '4 + 2 = 6', summary: 'proved' }));
    const task: Task = { description: 'Prove the bound.', executionMode: 'reasoning' };
    const plan = await atom.plan(task, ctx);
    expect(plan.delivery).toBe('text');
    await atom.execute(task, plan, ctx);
    for (const call of ctx.llm.calls) {
      expect(call.tools ?? []).toEqual([]);
      expect(call.executor).toBeUndefined();
    }
    expect(ctx.tools.execute).not.toHaveBeenCalled();
  });

  it('preserves structured small answers and labels bounded large handovers', () => {
    expect(previousResultInput({ exact: 'M1' })).toEqual({ exact: 'M1' });
    expect(previousResultInput('x'.repeat(30_000))).toMatchObject({ truncated: true, originalChars: 30_002 });
    expect(planSchema.parse({ reasoning: 'r', subtasks: [{ description: 'think', executionMode: 'reasoning' }], delivery: 'text' }).delivery).toBe('text');
  });
});
