import { describe, expect, it } from 'vitest';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { READER_FACING_DOC_GUIDANCE } from '../src/atoms/prompts.js';
import { ensureCanonicalProjectDocsL1 } from '../src/atoms/capability.js';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { HOST_TOOL_NAMES } from '../src/contracts/toolTaxonomy.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';
import type { RunContext, ToolExecutor } from '../src/core/types.js';

/**
 * A DELIVERED DOCUMENT IS FOR ITS READER (owner decision 2026-09-30). Run
 * cdc34023's README closed on a "Verification evidence" section — smoke
 * values, a SHA-256, line numbers, quotes of the source — and earlier READMEs
 * listed "`1499` seconds remaining" beside each button. Every molecule that
 * writes documentation is told what a document leaves out
 * (tests/canonical-bootstrap.test.ts); these cases pin the other paths.
 */

const reply = (value: unknown) => ({ text: JSON.stringify(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

/** Records every request's user content by role, and answers a planner once. */
function recordingLlm(plan: unknown) {
  const byRole = new Map<string, string[]>();
  const llm = {
    async complete(req: { role?: string; userContent: string }) {
      const role = req.role ?? 'unknown';
      byRole.set(role, [...(byRole.get(role) ?? []), req.userContent]);
      if (role === 'prefilter') return reply({ kind: 'escalate', reasoning: 'plan it' });
      if (role === 'plan') return { ...reply(null), text: JSON.stringify([{ strategy: 'create', reasoning: 'r' }, plan]) };
      return reply({ output: 'done', summary: 'ok' });
    },
  };
  return { llm: llm as unknown as RunContext['llm'], byRole };
}

const executor: ToolExecutor = { has: () => true, execute: async () => ({ ok: true }) };

function registry() {
  const reg = new AtomRegistry(openDb(':memory:'));
  const seed = { description: 'seed', systemPrompt: 'sys', params: {}, createdBy: 'test' };
  return {
    reg,
    l3: reg.create(3, { ...seed, tools: makeTools(['write_file', 'read_file']) }),
    l2: reg.create(2, { ...seed, tools: makeTools(['write_file', 'read_file']) }),
  };
}

const twoPhases = {
  reasoning: 'build, then document',
  subtasks: [
    { description: 'build the page', outputs: ['index.html'] },
    { description: 'write the README', outputs: ['README.md'] },
  ],
  aggregation: { mode: 'sequential' },
  expectedOutput: 'a documented page',
};

describe('a delivered document is for its reader', () => {
  it('reaches a fallback executor that writes files, and never one without tools', async () => {
    const { reg, l3, l2 } = registry();
    for (const withTools of [true, false]) {
      const cell = L2Atom.fromType(l2, reg);
      cell.setFallbackMode(true);
      const cellLlm = recordingLlm(twoPhases);
      await cell.execute({ description: 'write the README' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
        { ...makeCtx(), llm: cellLlm.llm, ...(withTools ? { tools: executor } : {}) });
      const tissue = L3Atom.buildWithModel(l3, reg, FALLBACK_OPUS);
      tissue.setFallbackMode(true);
      const tissueLlm = recordingLlm(twoPhases);
      await tissue.execute({ description: 'write the README' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
        { ...makeCtx(), llm: tissueLlm.llm, ...(withTools ? { tools: executor } : {}) });
      for (const [content] of [cellLlm.byRole.get('fallback-execute')!, tissueLlm.byRole.get('fallback-execute')!]) {
        expect(content!.includes(READER_FACING_DOC_GUIDANCE)).toBe(withTools);
      }
    }
  });

  it('never reaches a planner, which points a documentation phase at its proof as a source, not as content', async () => {
    const { reg, l3, l2 } = registry();
    const tissueLlm = recordingLlm(twoPhases);
    await L3Atom.buildWithModel(l3, reg, FALLBACK_OPUS).plan({ description: 'build a page and document it' }, { ...makeCtx(), llm: tissueLlm.llm });
    const tissuePlan = tissueLlm.byRole.get('plan')![0]!;
    expect(tissuePlan).not.toContain(READER_FACING_DOC_GUIDANCE);
    expect(tissuePlan).toContain('point it at the recorded probes as its source,');
    expect(tissuePlan).toContain('never as content for the document');

    const cellLlm = recordingLlm(twoPhases);
    await L2Atom.fromType(l2, reg).plan({ description: 'build a page and document it' }, { ...makeCtx(), llm: cellLlm.llm });
    expect(cellLlm.byRole.get('plan')![0]).not.toContain(READER_FACING_DOC_GUIDANCE);
  });

  it('tells the project-docs molecule its citations go in its result, and the validator to coach no observation note', () => {
    const tools = makeTools(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', HOST_TOOL_NAMES[0]]);
    const docs = ensureCanonicalProjectDocsL1(new AtomRegistry(openDb(':memory:')), tools)!;
    expect(docs.systemPrompt).toContain('In your result, cite exact original quotes, relative paths, source digests and line spans.');
    expect(docs.systemPrompt).toContain(READER_FACING_DOC_GUIDANCE);
    expect(VALIDATION_SYSTEM_PROMPT).toContain('State what Clear does, with no observation note');
    expect(VALIDATION_SYSTEM_PROMPT).not.toContain('Rewrite that sentence from the recorded check');
  });
});
