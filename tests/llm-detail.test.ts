import { describe, expect, it } from 'vitest';
import { llmDetailNodes } from '../src/viz/client/llm-detail.js';
import { buildStructuredDetail } from '../src/viz/client/structured-detail.js';
import type { VizEvent, VizRun } from '../src/viz/client/types.js';
const t = (key: string) => key;
const preview = '== ACTIVE SKILL: verify-ui ==\nTRUST BOUNDARY: recorded boilerplate.\n\nFollow this recipe step-by-step for the current subtask. Runtime rules.\n\n# Verify controls\n\n1. Click every control.\n\n== END ACTIVE SKILL ==';
const event: VizEvent = { id: 'plan', ts: 1, kind: 'llm', role: 'plan', branchId: 'phase',
  context: [{ id: 'recipe', source: 'skill', skillId: 'verify-ui', chars: preview.length, preview }] };
const run: VizRun = { id: 'run', label: 'Plan', startedAt: '2026-10-12T00:00:00Z', events: [{ id: 'branch', ts: 0, kind: 'branch', op: 'start', branchId: 'phase', label: 'Verify the notes interface.' }] };

describe('readable LLM detail', () => {
  it('puts the assigned task and proposed plan before supporting resources', () => {
    const response = buildStructuredDetail({ steps: ['Inspect the page', 'Verify controls'] }, t);
    const nodes = llmDetailNodes(event, run, response, false, t);
    expect(nodes.map(node => node.key)).toEqual(['mission', 'response', 'resources']);
    expect(nodes[0]).toMatchObject({ value: 'Verify the notes interface.' });
    expect(nodes[1]).toMatchObject({ label: 'detail.planning.proposal', children: response });
    expect(JSON.stringify(nodes)).toContain('Click every control');
    expect(JSON.stringify(nodes)).not.toMatch(/TRUST BOUNDARY|Runtime rules/);
  });
  it('retains the exact recorded context on demand, after the response', () => {
    const nodes = llmDetailNodes(event, run, [], true, t);
    expect(nodes[1]).toMatchObject({ key: 'response' });
    expect(JSON.stringify(nodes)).toContain(JSON.stringify(preview).slice(1, -1));
  });
  it('distinguishes missing output and truncated skill context', () => {
    const nodes = llmDetailNodes({ ...event, context: [{ ...event.context![0]!, chars: preview.length + 100 }] }, run, [], false, t);
    expect(JSON.stringify(nodes)).toContain('detail.llm.missingResponse');
    expect(JSON.stringify(nodes)).toContain('detail.skillContext.truncated');
  });
  it('never substitutes the root task for an unknown branch instruction', () => {
    const nodes = llmDetailNodes({ ...event, branchId: 'missing' }, { ...run, task: { description: 'Root task' } }, [], false, t);
    expect(nodes.some(node => node.key === 'mission')).toBe(false);
  });
});
