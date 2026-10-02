import { describe, expect, it, vi } from 'vitest';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { MERISTEM_DESCRIPTION, MERISTEM_SYSTEM_PROMPT, seedTissueCatalog } from '../src/run/tissues.js';
import { makeCtx, jsonText, jsonTextPair } from './helpers.js';
import { makePlan } from './helpers/factories.js';

describe('seeded Meristem delegation', () => {
  it('upgrades a seeded single-cell prompt once and preserves historical trust', () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const old = reg.create(3, { description: MERISTEM_DESCRIPTION,
        systemPrompt: 'You choose an L2 cell (reuse or create) and hand the task over.', tools: [], params: { maxTokens: 16384 }, createdBy: 'bootstrap-tissue-build' });
      reg.recordSuccess(old.name);
      const ctx = { registry: reg, toolDecls: [], log: () => {} };
      const updated = seedTissueCatalog(ctx);
      expect(updated).toMatchObject({ atomId: old.atomId, version: old.version + 1, successes: 1, consecutiveSuccesses: 0, systemPrompt: MERISTEM_SYSTEM_PROMPT });
      expect(updated.systemPrompt).toContain('for each subtask');
      expect(updated.systemPrompt).toContain('Different subtasks may use different L2 cells');
      expect(seedTissueCatalog(ctx).version).toBe(updated.version);
    } finally { db.close(); }
  });

  it('plans and delegates to two different existing L2 cells', async () => {
    const db = openDb(':memory:');
    try {
      const reg = new AtomRegistry(db);
      const tissue = seedTissueCatalog({ registry: reg, toolDecls: [], log: () => {} });
      const cells = ['Read source evidence', 'Synthesize evidence'].map(description => reg.create(2, {
        description, systemPrompt: description, tools: [], params: {}, createdBy: 'test',
      }));
      const l3 = L3Atom.fromType(tissue, reg);
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: cells[0]!.name, confidence: 'high', reasoning: 'Initial phase' }));
      ctx.llm.enqueueText(jsonTextPair({ strategy: 'reuse', target: cells[0]!.name, reasoning: 'Coordinate both cells' }, {
        reasoning: 'Read then synthesize', aggregation: { mode: 'sequential' },
        subtasks: cells.map(cell => ({ description: cell.description, preferredChild: cell.name })),
      }));
      const dispatched: string[] = [];
      vi.spyOn(L2Atom.prototype, 'plan').mockResolvedValue(makePlan());
      vi.spyOn(l3, 'validatePlan').mockResolvedValue({ approved: true, reasoning: 'Valid phase' });
      vi.spyOn(l3, 'validateResult').mockResolvedValue({ approved: true, reasoning: 'Observed phase' });
      vi.spyOn(L2Atom.prototype, 'execute').mockImplementation(async function (this: L2Atom) {
        dispatched.push(this.name);
        return { output: this.name, summary: `Completed ${this.name}`, producedBy: { tier: 2, name: this.name, viaFallback: false }, trace: [] };
      });
      const task = { description: 'Explain the system from observed evidence.' };
      const plan = await l3.plan(task, ctx);
      await l3.execute(task, plan, ctx);
      expect(dispatched).toEqual(cells.map(cell => cell.name));
    } finally { vi.restoreAllMocks(); db.close(); }
  });
});
