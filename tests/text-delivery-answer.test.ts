import { mockOtherProofReview } from './helpers/delegationReview.js';
import { describe, expect, it, vi } from 'vitest';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { delegatedDelivery, delegatedTaskContext, taskContextLines, withPlannedDelivery } from '../src/atoms/taskContext.js';
import { extractResultUrl } from '../src/atoms/groundTruth.js';
import { TEXT_DELIVERY_CONTEXT, TEXT_DELIVERY_GUIDANCE } from '../src/contracts/taskExecution.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { seedTissueCatalog } from '../src/run/tissues.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan } from './helpers/factories.js';
import type { Task } from '../src/core/types.js';

/**
 * Run 4e5c5c4b (2026-10-12): a deep run's root plan declared a text
 * delivery, but the molecule that wrote it kept the file envelope it is
 * taught ({files, probes}), so the answer reached the person inside the
 * summary's evidence block. The declaration now reaches the tasks whose
 * output IS that text, and only those.
 */
describe('a declared text delivery reaches the tasks that write the answer', () => {
  it('is stamped on the root task only by a text plan', () => {
    const root: Task = { description: 'Review the tool.' };
    expect(withPlannedDelivery(root, { delivery: 'files' })).toBe(root);
    expect(withPlannedDelivery(root, {})).toBe(root);
    expect(withPlannedDelivery(root, { delivery: 'text' })).toEqual({ description: 'Review the tool.', delivery: 'text' });
    expect(root).not.toHaveProperty('delivery');
  });

  it('goes to the last sequential phase, every concatenated part, and never to a file phase or a nested declaration', () => {
    const text: Task = { description: 'root', delivery: 'text' };
    const phase = { description: 'phase' };
    expect(delegatedDelivery(text, phase, 0, 2, 'sequential')).toEqual({});
    expect(delegatedDelivery(text, phase, 1, 2, 'sequential')).toEqual({ delivery: 'text' });
    expect(delegatedDelivery(text, phase, 0, 2, 'concat')).toEqual({ delivery: 'text' });
    expect(delegatedDelivery(text, phase, 0, 2, 'llm-synthesize')).toEqual({ delivery: 'text' });
    expect(delegatedDelivery(text, { ...phase, outputs: ['notes.md'] }, 1, 2, 'sequential')).toEqual({});
    // Only the root decides: an untagged parent passes nothing, whatever a nested plan said.
    expect(delegatedDelivery({ description: 'root' }, { ...phase, delivery: 'text' } as never, 0, 1, 'concat')).toEqual({});
    expect(delegatedTaskContext(text, phase)).not.toHaveProperty('delivery');
  });

  it('instructs the executor, informs planners and validators, ahead of the inputs', () => {
    const task: Task = { description: 'phase', delivery: 'text', inputs: { previousStepResult: 'x'.repeat(30_000) } };
    const executor = taskContextLines(task, { executor: true });
    const reviewer = taskContextLines(task);
    expect(executor).toContain(TEXT_DELIVERY_GUIDANCE);
    expect(executor).not.toContain(TEXT_DELIVERY_CONTEXT);
    expect(reviewer).toContain(TEXT_DELIVERY_CONTEXT);
    expect(reviewer).not.toContain(TEXT_DELIVERY_GUIDANCE);
    // Jev caps its context head-first: the fact precedes the long inputs.
    expect(reviewer.indexOf(TEXT_DELIVERY_CONTEXT)).toBeLessThan(reviewer.findIndex(line => line.startsWith('Inputs')));
    for (const quiet of [{ ...task, executionMode: 'reasoning' as const }, { ...task, outputs: ['notes.md'] }, { description: 'phase' }]) {
      expect(taskContextLines(quiet, { executor: true }).join('\n')).not.toContain('Delivery: text');
    }
    // The person's request is the exception, not a phase description the planner wrote.
    expect(TEXT_DELIVERY_GUIDANCE).toContain("unless the person's original request asks for it");
    expect(TEXT_DELIVERY_GUIDANCE).toContain('== GROUND TRUTH ==');
  });

  it('reaches only the last phase of a real tissue root that declared it', async () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const tissue = seedTissueCatalog({ registry: reg, toolDecls: [], log: () => {} });
      const cells = ['Run the samples', 'Write the ranked review'].map(description => reg.create(2, {
        description, systemPrompt: description, tools: [], params: {}, createdBy: 'test',
      }));
      const l3 = L3Atom.fromType(tissue, reg);
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: cells[0]!.name, confidence: 'high', reasoning: 'first phase' }));
      ctx.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: cells[0]!.name, reasoning: 'run, then write' }, {
        reasoning: 'observe, then answer', delivery: 'text', aggregation: { mode: 'sequential' },
        subtasks: cells.map(cell => ({ description: cell.description, preferredChild: cell.name })),
      }));
      ctx.llm.enqueue(req => ({ text: JSON.stringify({ approved: true, reasoning: 'Text scope reviewed', ...mockOtherProofReview(req) }),
        stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }));
      const received: Array<[string, Task['delivery']]> = [];
      vi.spyOn(L2Atom.prototype, 'plan').mockResolvedValue(makePlan());
      vi.spyOn(l3, 'validatePlan').mockResolvedValue({ approved: true, reasoning: 'valid' });
      vi.spyOn(l3, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'observed' });
      vi.spyOn(L2Atom.prototype, 'execute').mockImplementation(async function (this: L2Atom, task: Task) {
        received.push([this.name, task.delivery]);
        return { output: `${this.name} done`, summary: this.name, producedBy: { tier: 2, name: this.name, viaFallback: false }, trace: [] };
      });
      await l3.handle({ description: 'Review which CSV inputs budget.mjs refuses.' }, ctx);
      expect(received).toEqual([[cells[0]!.name, undefined], [cells[1]!.name, 'text']]);
    } finally { vi.restoreAllMocks(); db.close(); }
  });
});

describe('the supervisor probe never follows a link a text answer cites', () => {
  it('takes only a loopback URL from free text, in the answer or its summary', () => {
    // Review 2026-10-13: a Markdown answer citing a W3C page made that page
    // the first URL, and a static-web validator would have browsed it.
    expect(extractResultUrl({ output: 'See https://www.w3.org/WAI/ for the rule.',
      summary: 'Checked.\n== GROUND TRUTH ==\nserved at http://localhost:41359/ ok' })).toBe('http://localhost:41359/');
    expect(extractResultUrl({ output: 'See https://www.w3.org/WAI/ and https://example.com.', summary: 'No server.' })).toBeNull();
    // Explicit fields stay byte-honest.
    expect(extractResultUrl({ output: { url: 'https://example.com/app' } })).toBe('https://example.com/app');
  });
});
