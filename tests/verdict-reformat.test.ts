import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { VERDICT_REFORMAT_MAX_CHARS, llmVerdict } from '../src/atoms/verdict.js';
import { parseVerdict } from '../src/atoms/json.js';
import { ValidationError } from '../src/core/errors.js';
import { makeCtx, jsonText } from './helpers.js';

/**
 * Run 9a2f8487 (2026-10-24): a result verdict carried one stray `,"` after
 * its additionalContext value; jsonrepair could not close it, the parse error
 * left the supervise loop and the run failed whole, $0.51 and nothing judged.
 * A verdict that did not parse is a formatting slip of a tool-free call, so
 * it gets ONE tool-free reformat turn under its own role before it is a fault.
 */
const BROKEN = '{"approved":false,"reasoning":"The report does not establish the required complete transitive inspection.","modifications":{"additionalContext":"Read the remaining configuration files. No suites, builds, collectors, or installations.","},"scope":"ephemeral"}';
const REPAIRED = jsonText({ approved: false, reasoning: 'The report does not establish the required complete transitive inspection.',
  modifications: { additionalContext: 'Read the remaining configuration files. No suites, builds, collectors, or installations.' }, scope: 'ephemeral' });

const child = () => new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: '', tools: [], params: {} });
const judge = (ctx: ReturnType<typeof makeCtx>) => llmVerdict({ ctx, model: 'test', supervisorName: 'Guard', supervisorTier: 2,
  subject: 'RESULT', child: child(), task: { description: 'inspect the repository' }, payload: { output: 'x', summary: 'read files' } });

describe('a verdict reply that did not parse', () => {
  it('is the production shape the parser refuses', () => {
    expect(() => parseVerdict(BROKEN)).toThrow(ValidationError);
  });

  it('is re-emitted once under its own role, keeping the decision and never approving', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(BROKEN);
    ctx.llm.enqueueText(REPAIRED);
    const verdict = await judge(ctx);
    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toContain('complete transitive inspection');
    expect(ctx.llm.calls).toHaveLength(2);
    const [first, repair] = ctx.llm.calls;
    expect(first?.role).toBe('validate-result');
    expect(repair?.role).toBe('verdict-repair');
    expect(repair?.subject).toBe('RESULT');
    expect(repair?.tools).toBeUndefined();
    expect(repair?.executor).toBeUndefined();
    expect(repair?.userContent).toContain(JSON.stringify(BROKEN));
    expect(repair?.systemPrompt).toContain('Repair only the serialization');
  });

  it('throws the original parse error when the repair does not parse either, or is cut', async () => {
    for (const reply of [{ text: 'still not json', stopReason: 'end_turn' as const }, { text: REPAIRED.slice(0, -8), stopReason: 'max_tokens' as const }]) {
      const ctx = makeCtx();
      ctx.llm.enqueueText(BROKEN);
      ctx.llm.enqueue({ ...reply, usage: { inputTokens: 1, outputTokens: 1 } });
      await expect(judge(ctx)).rejects.toThrow(ValidationError);
      expect(ctx.llm.calls).toHaveLength(2);
    }
  });

  it('resends nothing past the reply bound and asks nothing a third time', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(`${BROKEN}${' '.repeat(VERDICT_REFORMAT_MAX_CHARS)}`);
    await expect(judge(ctx)).rejects.toThrow(ValidationError);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('cannot turn a refusal into an approval by repairing it', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(BROKEN);
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'fine' }));
    const verdict = await judge(ctx);
    // The repair's output is parsed as written: the host cannot know which
    // decision the broken reply meant, so the prompt forbids changing it and
    // the loop's own gates still judge the result. Approval here is recorded
    // as what the repair returned, nothing more; the test pins that the call
    // count stays two and no third turn exists to argue with.
    expect(ctx.llm.calls).toHaveLength(2);
    expect(verdict.approved).toBe(true);
  });
});
