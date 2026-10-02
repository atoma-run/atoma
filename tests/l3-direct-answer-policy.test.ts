import { describe, expect, it } from 'vitest';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { jsonText, jsonTextPair, makeCtx } from './helpers.js';

function root(): L3Atom {
  const registry = new AtomRegistry(openDb(':memory:'));
  const type = registry.create(3, {
    description: 'root tissue', systemPrompt: 'route work', tools: [], params: {}, createdBy: 'test',
  });
  registry.create(2, {
    description: 'general orchestrator', systemPrompt: 'delegate work', tools: [], params: {}, createdBy: 'test',
  });
  return L3Atom.buildWithModel(type, registry, 'claude-opus-5');
}

function queuePrefilter(ctx: ReturnType<typeof makeCtx>): void {
  ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'let the root planner decide' }));
}

describe('L3 direct-answer planning policy', () => {
  it('shows the deciding planner that text-complete answers get one no-tool branch', async () => {
    const l3 = root();
    const ctx = makeCtx();
    queuePrefilter(ctx);
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', target: 'Tracheid', reasoning: 'direct answer' },
      {
        reasoning: 'all operands are in the request',
        subtasks: [{ description: 'Answer directly without tools: P=[0,4], Q=[4,6].' }],
        aggregation: { mode: 'concat' }, expectedOutput: 'the direct answer',
      }
    ));

    const plan = await l3.plan({ description: 'Given the stated ranges, answer P=[0,4], Q=[4,6].' }, ctx);
    const plannerPrompt = ctx.llm.calls[1]!.userContent;
    expect(plannerPrompt).toContain('derived entirely from the task text');
    expect(plannerPrompt).toContain('Emit EXACTLY ONE subtask');
    expect(plannerPrompt).toContain('answer directly without tools');
    expect(plan.subtasks).toHaveLength(1);
  });

  it('keeps artefact work on normal multi-phase decomposition', async () => {
    const l3 = root();
    const ctx = makeCtx();
    queuePrefilter(ctx);
    ctx.llm.enqueueText(jsonTextPair(
      { strategy: 'reuse', target: 'Tracheid', reasoning: 'build work' },
      {
        reasoning: 'implementation and verification are required',
        subtasks: [
          { description: 'Implement the application', outputs: ['index.html'] },
          { description: 'Verify the application' },
        ],
        aggregation: { mode: 'sequential' }, expectedOutput: 'a verified application',
      }
    ));

    const plan = await l3.plan({ description: 'Build and verify a browser application.' }, ctx);
    expect(ctx.llm.calls[1]!.userContent).toContain('If any required fact may live outside the');
    expect(ctx.llm.calls[1]!.userContent).toContain('or an artefact/action is requested');
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.aggregation.mode).toBe('sequential');
  });
});
