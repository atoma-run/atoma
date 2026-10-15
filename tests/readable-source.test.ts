import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { READABLE_SOURCE_GUIDANCE, READABLE_SOURCE_RULE } from '../src/atoms/prompts.js';
import { fallbackProofTurnContent } from '../src/atoms/fallbackProof.js';
import { RECIPE_STEP_LIMITS, eventSkillBlock } from '../src/skills/events.js';
import { FALLBACK_OPUS } from './tier-pins.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';
import type { RunContext, ToolExecutor } from '../src/core/types.js';

/**
 * SOURCE IS WRITTEN FOR A READER (2026-10-15). The three Attica runs of that
 * day wrote every function and test body on one line because the repository's
 * first file was dense and the model matched it; 27 of their 310 edit_file
 * calls failed, nine of them on a leading space recalled where the file has
 * none. The rule is RUNTIME text: a molecule whose stored prompt predates it
 * hears it when it plans and executes, and so do the fallback executors, the
 * proof turn and the recipe limits.
 */

const flat = (text: string): string => text.replace(/\s+/g, ' ');
const reply = (value: unknown) => ({ text: JSON.stringify(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

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
const twoPhases = { reasoning: 'build, then document', subtasks: [{ description: 'build the page' }, { description: 'write the README' }], aggregation: { mode: 'concat' } };

describe('readable source rule', () => {
  it('says what it must, once', () => {
    const rule = flat(READABLE_SOURCE_GUIDANCE);
    expect(rule).toContain('one statement per line');
    expect(rule).toContain("the file's own indentation where it has one");
    expect(rule).toContain('never a function, class body or test on one line');
    expect(rule).toContain('Keep this where the files already there are dense');
    expect(rule).toContain('lines you do not otherwise change stay as they are');
    expect(rule).toContain('minified or generated asset and a data file are left as they are');
    expect(READABLE_SOURCE_RULE.join('\n')).toBe(READABLE_SOURCE_GUIDANCE);
  });

  it('reaches every molecule that writes or edits a file when it plans and executes, whatever its stored prompt', async () => {
    for (const [tools, reads] of [[['write_file', 'read_file'], true], [['edit_file'], true], [['run_shell'], true], [['read_file', 'list_files'], false], [['validate_html'], false]] as const) {
      const molecule = new L1Atom({ name: 'Methane', ordinal: 4, systemPrompt: 'a prompt stored before the rule', tools: makeTools([...tools]), params: {} });
      const ctx = makeCtx();
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'write the module', expectedOutput: 'module' }));
      ctx.llm.enqueueText(jsonText({ output: 'done', summary: 'done' }));
      const plan = await molecule.plan({ description: 'Add a scheduler module' }, ctx);
      await molecule.execute({ description: 'Add a scheduler module' }, plan, ctx);
      expect(ctx.llm.calls.map((call) => call.userContent.includes(READABLE_SOURCE_GUIDANCE))).toEqual([reads, reads]);
    }
  });

  it('reaches the fallback executors that hold tools, and never one without', async () => {
    for (const withTools of [true, false]) {
      const reg = new AtomRegistry(openDb(':memory:'));
      const seed = { description: 'seed', systemPrompt: 'sys', params: {}, createdBy: 'test', tools: makeTools(['write_file', 'read_file']) };
      const cell = L2Atom.fromType(reg.create(2, seed), reg);
      cell.setFallbackMode(true);
      const cellLlm = recordingLlm(twoPhases);
      await cell.execute({ description: 'build the page' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
        { ...makeCtx(), llm: cellLlm.llm, ...(withTools ? { tools: executor } : {}) });
      const tissue = L3Atom.buildWithModel(reg.create(3, seed), reg, FALLBACK_OPUS);
      tissue.setFallbackMode(true);
      const tissueLlm = recordingLlm(twoPhases);
      await tissue.execute({ description: 'build the page' }, makePlan({ reasoning: 'r', proposedAction: 'p', expectedOutput: 'e' }),
        { ...makeCtx(), llm: tissueLlm.llm, ...(withTools ? { tools: executor } : {}) });
      for (const calls of [cellLlm.byRole.get('fallback-execute') ?? [], tissueLlm.byRole.get('fallback-execute') ?? []]) {
        expect(calls.length).toBeGreaterThan(0);
        for (const content of calls) expect(content.includes(READABLE_SOURCE_GUIDANCE)).toBe(withTools);
      }
    }
  });

  it('reaches the proof turn and the recipe limits', () => {
    const turn = fallbackProofTurnContent({ task: { description: 'prove the page' }, coverage: [], previousSummary: 'built', servedUrl: null });
    expect(turn).toContain(READABLE_SOURCE_GUIDANCE);
    expect(RECIPE_STEP_LIMITS.join('\n')).toContain(READABLE_SOURCE_RULE[0]);
    expect(RECIPE_STEP_LIMITS[0]).toBe('Three things no recipe step changes.');
    expect(eventSkillBlock({ id: 'e', body: 'steps', trigger: 'edit_file-not-found' })).toContain(READABLE_SOURCE_RULE[0]);
  });
});
