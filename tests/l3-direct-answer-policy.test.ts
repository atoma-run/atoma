import { describe, expect, it, vi } from 'vitest';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { jsonText, jsonTextPair, makeCtx } from './helpers.js';
import { makeTools } from './helpers/factories.js';

const seed = {
  description: 'general analysis', systemPrompt: 'Always write an answer file.',
  tools: makeTools(['write_file']), params: {}, createdBy: 'test',
};

describe('L3 direct-answer planning policy', () => {
  // Scripted model decisions exercise dispatch, not the semantic quality of a
  // live planner. The same production path must honour either valid shape.
  it.each([
    { goal: 'P takes 4 and Q takes 2 on R. Give the earliest finish; no files.', phases: ['Compute the finish.'], output: '6' },
    { goal: 'Derive reachable states from the supplied transition rules, then independently audit the proof; no files.', phases: ['Derive the states.', 'Audit the proof.'], output: 'Audited proof' },
  ])('executes $phases.length reasoning phase(s) through L3 → L2 → L1', async ({ goal, phases, output }) => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const molecule = reg.create(1, seed);
    const cell = reg.create(2, seed);
    const root = L3Atom.fromType(reg.create(3, seed), reg);
    const execute = vi.fn(async () => { throw new Error('No element may execute.'); });
    const ctx = { ...makeCtx(), requireObservedToolAction: true, tools: { has: () => true, execute } };
    for (let n = 0; n < 40; n++) ctx.llm.enqueue((req) => {
      let answer: unknown;
      if (req.role === 'prefilter') {
        answer = { kind: 'escalate', reasoning: 'use the planner' };
      } else if (req.role === 'plan' && req.actor?.tier === 3) {
        expect(req.userContent).toContain('prefer ONE reasoning subtask');
        expect(req.userContent).toContain('Self-contained does not mean indivisible');
        expect(req.userContent).toContain('executionMode: "reasoning"');
        expect(req.userContent).not.toContain('Emit EXACTLY ONE subtask');
        answer = [{ strategy: 'reuse', target: cell.name, reasoning: 'fits' }, {
          reasoning: 'decompose by the work', delivery: 'text',
          subtasks: phases.map(description => ({ description, preferredChild: cell.name, executionMode: 'reasoning' })),
          aggregation: { mode: 'sequential' }, expectedOutput: output,
        }];
      } else if (req.role === 'plan' && req.actor?.tier === 2) {
        answer = [{ strategy: 'reuse', target: molecule.name, reasoning: 'fits' }, {
          reasoning: 'delegate', subtasks: [{ description: 'Answer the assigned phase.', executionMode: 'tools' }],
          aggregation: { mode: 'sequential' }, expectedOutput: output,
        }];
      } else if (req.role === 'execute') {
        expect(req.actor?.tier).toBe(1);
        expect(req.tools ?? []).toEqual([]);
        expect(req.executor).toBeUndefined();
        expect(req.userContent).toContain(goal);
        expect(req.userContent).toContain('Preserve the supplied facts.');
        answer = { output, summary: 'Reasoning complete.' };
      } else if (req.role?.startsWith('validate')) {
        answer = { approved: true, reasoning: 'correct' };
      } else {
        answer = { reasoning: 'derive from supplied facts', proposedAction: 'reason directly', expectedOutput: output };
      }
      return { text: jsonText(answer), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    });
    const task = { description: goal, constraints: ['Preserve the supplied facts.'] };
    const plan = await root.plan(task, ctx);
    expect(plan.delivery).toBe('text');
    expect(plan.subtasks).toHaveLength(phases.length);
    expect(plan.subtasks.every(s => s.executionMode === 'reasoning')).toBe(true);
    const result = await root.execute(task, plan, ctx);
    expect(result.output).toBe(output);
    expect(ctx.llm.calls.filter(c => c.role === 'execute')).toHaveLength(phases.length);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the planner’s file delivery and tool phases for artefact work', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const cell = reg.create(2, seed);
    const root = L3Atom.fromType(reg.create(3, seed), reg);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'plan the build' }));
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', target: cell.name, reasoning: 'build work' },
      {
        reasoning: 'implement then verify', delivery: 'files', subtasks: [
          { description: 'Implement the CLI.', preferredChild: cell.name, outputs: ['cli.py'], executionMode: 'tools' },
          { description: 'Verify the CLI.', preferredChild: cell.name, executionMode: 'tools' },
        ], aggregation: { mode: 'sequential' }, expectedOutput: 'a verified CLI',
      }
    ));
    const plan = await root.plan({ description: 'Build and verify a Python CLI.' }, ctx);
    expect(plan.delivery).toBe('files');
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks.every(s => s.executionMode === 'tools')).toBe(true);
    expect(plan.subtasks[0]!.outputs).toEqual(['cli.py']);
  });
});
