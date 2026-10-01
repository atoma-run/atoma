import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { EXISTING_FILE_GUIDANCE, READER_FACING_DOC_GUIDANCE, TEST_ONLY_ELEMENT_GUIDANCE } from '../src/atoms/prompts.js';
import { ensureCanonicalProjectDocsL1 } from '../src/atoms/capability.js';
import { VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { HOST_TOOL_NAMES } from '../src/contracts/toolTaxonomy.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';
import type { RunContext, ToolExecutor } from '../src/core/types.js';

/**
 * A DELIVERED DOCUMENT IS FOR ITS READER (owner decision 2026-09-30). Run
 * cdc34023's README closed on a "Verification evidence" section — smoke
 * values, a SHA-256, line numbers, quotes of the source — and earlier READMEs
 * listed "`1499` seconds remaining" beside each button.
 *
 * And a document a molecule edits loses what an earlier check left in it
 * (owner decision 2026-10-01): runs 1ed071e3 and 9854553c wrote clean
 * sections and kept, as "unrelated content", evidence sections that were by
 * then false.
 */

const flat = (text: string): string => text.replace(/\s+/g, ' ');

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
  it('reaches every molecule that can write a file when it plans and executes, whatever its stored prompt', async () => {
    // Serotonin, trusted and on the fast path, wrote 1ed071e3's page from a
    // prompt stored before the rule existed (review 2026-10-01).
    for (const [tools, reads] of [[['write_file', 'read_file'], true], [['edit_file'], true], [['run_shell'], true], [['read_file', 'fetch_url'], false]] as const) {
      const molecule = new L1Atom({ name: 'Serotonin', ordinal: 3, systemPrompt: 'a web molecule prompt stored before the rule', tools: makeTools([...tools]), params: {} });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'edit the README', expectedOutput: 'README' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
      const plan = await molecule.plan({ description: 'Update README.md' }, ctx);
      await molecule.execute({ description: 'Update README.md' }, plan, ctx);
      expect(ctx.llm.calls.map((call) => call.userContent.includes(READER_FACING_DOC_GUIDANCE))).toEqual([reads, reads]);
    }
  });

  it('tells every molecule that can edit a file to edit what exists, whatever its stored prompt (run 495c20ef)', async () => {
    for (const [tools, reads] of [[['write_file', 'edit_file', 'read_file'], true], [['edit_file'], true], [['write_file', 'read_file'], false], [['run_shell'], false]] as const) {
      const molecule = new L1Atom({ name: 'Serotonin', ordinal: 3, systemPrompt: 'a web molecule prompt stored before the rule', tools: makeTools([...tools]), params: {} });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'fix the title', expectedOutput: 'page' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
      const plan = await molecule.plan({ description: 'Fix the tab title of index.html' }, ctx);
      await molecule.execute({ description: 'Fix the tab title of index.html' }, plan, ctx);
      expect(ctx.llm.calls.map((call) => call.userContent.includes(EXISTING_FILE_GUIDANCE))).toEqual([reads, reads]);
    }
    const rule = flat(EXISTING_FILE_GUIDANCE);
    expect(rule).toContain('Never write_file over a file the workspace already holds, even where your instructions or a recipe step say to');
    expect(rule).toContain('Restoring a behaviour is an edit.');
    expect(rule).toContain('.atoma-probes.json is outside this rule.');
  });

  it('tells a molecule that validates a page to create a test-only control in its smoke, never in the page (run 81375f01)', async () => {
    for (const [tools, reads] of [[['write_file', 'edit_file', 'start_static_server', 'validate_html'], true], [['write_file', 'edit_file', 'read_file'], false]] as const) {
      const molecule = new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: 'a web molecule prompt', tools: makeTools([...tools]), params: {} });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
      await molecule.execute({ description: 'Add an F shortcut, ignored in text fields' }, makePlan({ proposedAction: 'edit and validate' }), ctx);
      expect(ctx.llm.calls[0]!.userContent.includes(TEST_ONLY_ELEMENT_GUIDANCE)).toBe(reads);
    }
    expect(TEST_ONLY_ELEMENT_GUIDANCE).toContain('is created by the smoke while it runs');
    expect(TEST_ONLY_ELEMENT_GUIDANCE).toContain('It never goes into a file you deliver.');
  });

  it('reaches a fallback executor that can edit a file, and never one without edit_file', async () => {
    for (const withEdit of [true, false]) {
      const reg = new AtomRegistry(openDb(':memory:'));
      const tools = makeTools(withEdit ? ['write_file', 'edit_file', 'read_file'] : ['write_file', 'read_file']);
      const seed = { description: 'seed', systemPrompt: 'sys', params: {}, createdBy: 'test', tools };
      const cell = L2Atom.fromType(reg.create(2, seed), reg);
      cell.setFallbackMode(true);
      const cellLlm = recordingLlm(twoPhases);
      await cell.execute({ description: 'fix the page' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
        { ...makeCtx(), llm: cellLlm.llm, tools: executor });
      const tissue = L3Atom.buildWithModel(reg.create(3, seed), reg, FALLBACK_OPUS);
      tissue.setFallbackMode(true);
      const tissueLlm = recordingLlm(twoPhases);
      await tissue.execute({ description: 'fix the page' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
        { ...makeCtx(), llm: tissueLlm.llm, tools: executor });
      for (const [content] of [cellLlm.byRole.get('fallback-execute')!, tissueLlm.byRole.get('fallback-execute')!]) {
        expect(content!.includes(EXISTING_FILE_GUIDANCE)).toBe(withEdit);
      }
    }
  });

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

  it('removes what an earlier check left in a document it edits, even where it still holds (owner decision 2026-10-01)', () => {
    const rule = flat(READER_FACING_DOC_GUIDANCE);
    // Only on a documentation task: a verifier cleaning a README would be
    // restored as damage, and a page is no document (review 2026-10-01).
    expect(rule).toContain('When the task has you write or update a README or other doc (never a page, code or data file), remove what an earlier check left in it');
    // c1d1b230 removed the evidence section and kept "The verified static entry point…" in another one.
    expect(rule).toContain('remove what an earlier check left in it, wherever it sits:');
    expect(rule).toContain('a single "verified" or "observed" line. Remove it even where it still holds, and do not copy it into your summary.');
    // 9854553c's evidence section was the only place stating the CLI's errors.
    expect(rule).toContain('Restate, from the current source code or this run\'s recorded probes (never by re-running them), any exit code or error message documented only there.');
    expect(rule).toContain('Keep such a record only when the task asks that document to keep or record it; an instruction to preserve unrelated or existing content does not.');
    expect(rule).toContain('A document or section that exists to record results (a test report, a benchmark or verification log, a changelog) keeps its entries.');
    expect(rule).toContain('statuses and the versions or platforms it supports are behaviour');
    expect(rule).toContain('.atoma-probes.json is a record, not a document: none of this touches it.');
  });

  it('tells the project-docs molecule where its citations go and what preserving never covers', () => {
    const tools = makeTools(['write_file', 'edit_file', 'read_file', 'list_files', 'run_shell', HOST_TOOL_NAMES[0]]);
    const docs = ensureCanonicalProjectDocsL1(new AtomRegistry(openDb(':memory:')), tools)!.systemPrompt;
    expect(docs).toContain('In your result, cite exact original quotes, relative paths, source digests and line spans.');
    expect(docs).toContain('Preserve unrelated content (a record of what an earlier check observed is not unrelated content)');
  });

  it('tells every validator, for a plan as for a result, that removing such a record is correct', () => {
    const prompt = flat(VALIDATION_SYSTEM_PROMPT);
    expect(prompt).toContain('never reject a plan or result for that removal, nor ask for it back, unless the task names that record and asks the document to keep or record it.');
    expect(prompt).toContain('An instruction to preserve, keep or extend other content is not such a request.');
    expect(prompt).toContain('never usage examples, example output or exit codes, nor the entries of a document or section that exists to record results');
    expect(prompt.indexOf('== DOCUMENTS AND WHAT EARLIER CHECKS OBSERVED ==')).toBeLessThan(prompt.indexOf('If Subject kind is PLAN:'));
    expect(prompt).not.toContain('follows the documentation rule');
    expect(prompt).toContain('State what Clear does, with no observation note');
  });
});
