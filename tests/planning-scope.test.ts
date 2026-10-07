import { describe, expect, it } from 'vitest';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { PLANNING_SCOPE_GUIDANCE, PROPORTIONATE_PLANNING_GUIDANCE } from '../src/atoms/taskContext.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonTextPair, jsonText } from './helpers.js';
import type { Task } from '../src/core/types.js';

const seed = { description: 'constrained writing', systemPrompt: 'Always use separate modeling, drafting, audit, correction and finalization phases.', tools: [], params: {}, createdBy: 'test' };

describe('runtime planning scope for existing catalog agents', () => {
  it.each([
    { tier: 2, delegated: false }, { tier: 2, delegated: true },
    { tier: 3, delegated: false }, { tier: 3, delegated: true },
  ] as const)('keeps the checklist on root planners only (tier=$tier, delegated=$delegated)', async ({ tier, delegated }) => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const molecule = reg.create(tier === 2 ? 1 : 2, seed);
      const parent = reg.create(tier, seed);
      const cell = tier === 2 ? L2Atom.fromType(parent, reg) : L3Atom.fromType(parent, reg);
      const original = { description: 'Write a four-stanza poem with six words per line.', inputs: { acceptanceChecklist: 'ROOT_CHECKLIST' } };
      const task: Task = delegated ? {
        description: 'Model the requirements as a checklist; do not draft the poem.',
        executionMode: 'reasoning', originalTask: original,
        inputs: { originalTask: original, acceptanceChecklist: 'ROOT_CHECKLIST', previousStepResult: 'Prior observations' },
      } : { description: original.description, inputs: original.inputs };
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'Needs a plan' }));
      ctx.llm.enqueue(req => {
        expect(req.userContent).toContain(`Task: ${task.description}`);
        expect(req.userContent).toContain(PLANNING_SCOPE_GUIDANCE);
        expect(req.userContent).toContain(PROPORTIONATE_PLANNING_GUIDANCE);
        expect(req.userContent.includes('ROOT_CHECKLIST')).toBe(!delegated);
        if (delegated) {
          expect(req.userContent).toContain(original.description);
          expect(req.userContent).toContain('Prior observations');
        }
        return { text: jsonTextPair({ strategy: 'reuse', target: molecule.name, reasoning: 'fits' }, {
          reasoning: 'one requested outcome', subtasks: [{ description: task.description }],
          aggregation: { mode: 'sequential' }, expectedOutput: 'the current phase output',
        }), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
      });
      const plan = await cell.plan(task, ctx);
      expect(plan.subtasks.map(s => s.description)).toEqual([task.description]);
      expect(task.inputs).toHaveProperty('acceptanceChecklist', 'ROOT_CHECKLIST');
      expect(original.inputs.acceptanceChecklist).toBe('ROOT_CHECKLIST');
    } finally { db.close(); }
  });

  it.each([1, 4])('keeps model-selected %i phases without a mechanical phase cap', async count => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const cell = reg.create(2, seed);
      const tissue = L3Atom.fromType(reg.create(3, seed), reg);
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: cell.name, confidence: 1, reasoning: 'fits' }));
      const subtasks = Array.from({ length: count }, (_, i) => ({ description: `Requested deliverable ${i}`, preferredChild: cell.name, executionMode: 'reasoning' }));
      ctx.llm.enqueue(req => {
        expect(req.systemPrompt).toContain(seed.systemPrompt);
        expect(req.userContent).toContain(PROPORTIONATE_PLANNING_GUIDANCE);
        expect(req.userContent).toContain('Multiple requirements alone do not require multiple phases.');
        expect(req.userContent).not.toContain('ALWAYS emit ≥2');
        expect(req.userContent).not.toContain('For non-trivial tasks emit 2-5');
        return { text: jsonTextPair({ strategy: 'reuse', target: cell.name, reasoning: 'fits' }, {
          reasoning: 'decompose according to dependencies', delivery: 'text', subtasks,
          aggregation: { mode: 'sequential' }, expectedOutput: 'requested output',
        }), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
      });
      const plan = await tissue.plan({ description: 'Produce the requested text and its necessary checks.' }, ctx);
      expect(plan.subtasks.map(s => s.description)).toEqual(subtasks.map(s => s.description));
      expect(ctx.llm.calls.filter(c => c.role === 'plan')).toHaveLength(1);
    } finally { db.close(); }
  });
});
