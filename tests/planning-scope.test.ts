import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { APPLICATION_TYPESCRIPT_GUIDANCE, PLANNING_SCOPE_GUIDANCE, PROPORTIONATE_PLANNING_GUIDANCE, delegatedTaskContext, taskContextLines } from '../src/atoms/taskContext.js';

it('renders repeated inherited corpus bytes once without dropping conflicting original facts', () => {
  const corpus = { version: 1, cases: 'preserve every assertion '.repeat(200) };
  const original = { description: 'Repair the detector', inputs: { corpus, protected: 'original '.repeat(100) } };
  const task = { description: 'Verify detector', originalTask: original,
    inputs: { corpus, protected: 'different '.repeat(100) } };
  const lines = taskContextLines(task).join('\n');
  expect(lines.split(corpus.cases)).toHaveLength(2);
  expect(lines).toContain(original.inputs.protected);
  expect(lines).toContain(task.inputs.protected);
  expect(original.inputs.corpus).toBe(corpus);
});
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { makeCtx, jsonTextPair, jsonText } from './helpers.js';
import type { Task } from '../src/core/types.js';
import { READ_ONLY_TASK_LINE } from '../src/contracts/readOnlyPhase.js';

const seed = { description: 'constrained writing', systemPrompt: 'Always use separate modeling, drafting, audit, correction and finalization phases.', tools: [], params: {}, createdBy: 'test' };

describe('runtime planning scope for existing catalog agents', () => {
  it.each([2, 3] as const)('keeps discovery criteria as context in the tier %i planner', async tier => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const child = reg.create(tier === 2 ? 1 : 2, seed);
      const parent = reg.create(tier, seed);
      const atom = tier === 2 ? L2Atom.fromType(parent, reg) : L3Atom.fromType(parent, reg);
      const task: Task = {
        description: 'Inspect the normalizer and reproduce its existing failure without changing files.',
        originalTask: { description: 'Remove the unwanted normalized id alias and preserve the source id.' },
        readOnly: true,
        criteria: [{ id: 'c1', behaviour: 'The normalized row has no id alias.', source: 'user', unassigned: true }],
      };
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'Inspect first' }));
      ctx.llm.enqueue(req => {
        expect(req.userContent).toContain(READ_ONLY_TASK_LINE);
        expect(req.userContent).toContain('they add no requirement to this phase');
        expect(req.userContent).not.toContain('the runtime hands it their exact text as its requirements');
        expect(req.userContent).toContain('Do not turn a desired final state into the success condition of an inspection');
        return { text: jsonTextPair({ strategy: 'reuse', target: child.name, reasoning: 'fits' }, {
          reasoning: 'observe the current state, including defects',
          subtasks: [{ description: task.description, criteria: ['c1'] }],
          aggregation: { mode: 'concat' }, expectedOutput: 'observations and current failures',
        }), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
      });
      await atom.plan(task, ctx);
      expect(task.criteria?.[0]?.unassigned).toBe(true);
    } finally { db.close(); }
  });

  // The TypeScript policy reaches tool-mode planners only: a reasoning task
  // holds no tools and builds nothing (review 2026-10-16, group F).
  it.each([
    { tier: 2, delegated: false, reasoning: false },
    { tier: 2, delegated: true, reasoning: true },
    { tier: 2, delegated: true, reasoning: false },
    { tier: 3, delegated: false, reasoning: false },
    { tier: 3, delegated: true, reasoning: true },
    { tier: 3, delegated: true, reasoning: false },
  ] as const)('keeps the checklist on root planners only (tier=$tier, delegated=$delegated, reasoning=$reasoning)', async ({ tier, delegated, reasoning }) => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const molecule = reg.create(tier === 2 ? 1 : 2, seed);
      const parent = reg.create(tier, seed);
      const cell = tier === 2 ? L2Atom.fromType(parent, reg) : L3Atom.fromType(parent, reg);
      const original = { description: 'Write a four-stanza poem with six words per line.', inputs: { acceptanceChecklist: 'ROOT_CHECKLIST' } };
      const task: Task = delegated ? {
        description: 'Model the requirements as a checklist; do not draft the poem.',
        ...(reasoning ? { executionMode: 'reasoning' as const } : {}),
        originalTask: original,
        inputs: { originalTask: original, acceptanceChecklist: 'ROOT_CHECKLIST', previousStepResult: 'Prior observations' },
      } : { description: original.description, inputs: original.inputs };
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'Needs a plan' }));
      ctx.llm.enqueue(req => {
        expect(req.userContent).toContain(`Task: ${task.description}`);
        expect(req.userContent).toContain(PLANNING_SCOPE_GUIDANCE);
        expect(req.userContent).toContain(PROPORTIONATE_PLANNING_GUIDANCE);
        expect(req.userContent.includes(APPLICATION_TYPESCRIPT_GUIDANCE)).toBe(!reasoning);
        if (!reasoning) {
          expect(req.userContent).toContain('Do not turn a local repair into a repository-wide migration');
          expect(req.userContent).toContain('Inspection, verification-only and reporting phases do not migrate');
          expect(req.userContent).toContain('Final application acceptance requires observed successful npm run check and npm run build on the final source');
        }
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

  it.each([1, 2, 3] as const)('renders discovery once in the tier %i planner after delegation and serialization', async tier => {
    const db = openDb(':memory:');
    try {
      const registry = new AtomRegistry(db);
      const child = registry.create(tier === 3 ? 2 : 1, seed);
      const type = registry.create(tier, seed);
      const atom = tier === 1 ? L1Atom.fromType(type) : tier === 2 ? L2Atom.fromType(type, registry) : L3Atom.fromType(type, registry);
      const marker = 'DISCOVERY_CONTRACT_482d';
      const discovery = { branches: [{ report: marker + 'x'.repeat(6000) }], summary: 'Observed interfaces' };
      const original: Task = { description: 'Repair the application', inputs: { repositoryDiscovery: discovery, stableFact: 'Preserve exports' } };
      const phase: Task = { description: 'Implement the adapter', ...delegatedTaskContext(original, { description: 'Implement the adapter' }) };
      const delegated: Task = { description: 'Write the adapter', ...delegatedTaskContext(phase, { description: 'Write the adapter' }) };
      const task = JSON.parse(JSON.stringify(delegated)) as Task;
      const ctx = makeCtx();
      if (tier !== 1) ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'Plan the phase' }));
      ctx.llm.enqueue(req => {
        expect(req.userContent.split(marker)).toHaveLength(2);
        expect(req.userContent).toContain('Preserve exports');
        return { text: tier === 1 ? jsonText({ reasoning: 'r', proposedAction: 'Implement adapter', expectedOutput: 'adapter' }) : jsonTextPair(
          { strategy: 'reuse', target: child.name, reasoning: 'Fits' },
          { reasoning: 'One phase', subtasks: [{ description: task.description }], aggregation: { mode: 'concat' }, expectedOutput: 'adapter' },
        ), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      });
      await atom.plan(task, ctx);
      expect(task.originalTask?.inputs?.['repositoryDiscovery']).toEqual(discovery);
      expect(original.inputs?.['repositoryDiscovery']).toBe(discovery);
    } finally { db.close(); }
  });

  it('keeps discovery host-owned across child input overrides and preserves original-only history', () => {
    const discovery = { summary: 'Observed actual interfaces', branches: [{ report: 'ROOT_DISCOVERY_e824' }] };
    const original: Task = { description: 'Repair the app', inputs: { repositoryDiscovery: discovery } };
    const delegated = delegatedTaskContext(original, { description: 'Implement', inputs: { repositoryDiscovery: 'FORGED_DISCOVERY' } });
    expect(delegated.inputs?.['repositoryDiscovery']).toBe(discovery);
    expect(delegated.originalTask?.inputs?.['repositoryDiscovery']).toBe(discovery);
    const rendered = taskContextLines({ description: 'Original-only legacy context', originalTask: original }).join('\n');
    expect(rendered.split('ROOT_DISCOVERY_e824')).toHaveLength(2);
    expect(original.inputs?.['repositoryDiscovery']).toBe(discovery);
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
