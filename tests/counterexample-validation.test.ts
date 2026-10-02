import { describe, expect, it, vi } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { llmVerdict, VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { Witness } from '../src/contracts/witness.js';
import { jsonText, makeCtx } from './helpers.js';
import { makeTools } from './helpers/factories.js';

const seed = { description: 'reasoning', systemPrompt: 'Solve the assigned task.', tools: makeTools(['write_file']), params: {}, createdBy: 'test' };
// Run d5ca365f: the validator invented 13; the task never requested that count.
const facts = 'State (A,B,pA,pB), initially 0000. authorizeA requires B=0 and sets pA=1; authorizeB requires A=0 and sets pB=1. openA requires pA=1 and sets A=1,pA=0; openB requires pB=1 and sets B=1,pB=0. closeA clears A; closeB clears B. Only named bits change. Enumerate reachable states; no tools or files.';
const witness = '0000 --authorizeA--> 0010 --authorizeB--> 0011 --openB--> 0110 --authorizeB--> 0111 --openA--> 1101';
const answer = { output: { count: 15, witness }, summary: '1101 is reachable; the earlier count of 13 is incorrect.' };
const falseFeedback = 'There must be 13 states. Delete 1101 and 1110.';

describe('counterexample validation at production boundaries', () => {
  it('recovers from false coaching without replacing original facts or demanding tool evidence', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const molecule = reg.create(1, seed);
    const cell = L2Atom.fromType(reg.create(2, seed), reg);
    const execute = vi.fn(async () => { throw new Error('Reasoning must remain tool-free.'); });
    const ctx = { ...makeCtx(), requireObservedToolAction: true, tools: { has: () => true, execute } };
    let executions = 0;
    let verdicts = 0;
    for (let n = 0; n < 30; n++) ctx.llm.enqueue(req => {
      let response: unknown;
      if (req.role === 'prefilter') {
        response = { kind: 'reuse', target: molecule.name, confidence: 1, decomposable: false, reasoning: 'fits' };
      } else if (req.role === 'plan' && req.actor?.tier === 2) {
        response = [{ strategy: 'reuse', target: molecule.name, reasoning: 'fits' }, {
          reasoning: 'delegate', subtasks: [{ description: 'Enumerate and justify reachable states.', executionMode: 'reasoning' }],
          aggregation: { mode: 'sequential' }, expectedOutput: 'the reachable states with proof',
        }];
      } else if (req.role === 'execute') {
        executions++;
        expect(req.userContent).toContain(facts);
        expect(req.tools ?? []).toEqual([]);
        expect(req.executor).toBeUndefined();
        if (executions === 2) expect(req.systemPrompt).toContain(falseFeedback);
        response = answer;
      } else if (req.role === 'validate-result') {
        verdicts++;
        expect(req.systemPrompt).toBe(VALIDATION_SYSTEM_PROMPT);
        const inputs = JSON.parse(req.userContent.split('\n').find(line => line.startsWith('Inputs ('))!.split(': ').slice(1).join(': ')) as { originalTask: { description: string } };
        expect(inputs.originalTask.description).toBe(facts);
        expect(req.userContent).toContain(JSON.stringify(answer.output));
        expect(req.userContent).toContain('Tools are disabled');
        // Replay one historical wrong verdict, then the corrected judgment.
        // This proves recovery/context plumbing, not live-model accuracy.
        response = verdicts === 1
          ? { approved: false, reasoning: falseFeedback, confidence: 0.9, scope: 'ephemeral', modifications: { additionalContext: falseFeedback } }
          : { approved: true, reasoning: 'The witness follows the original transition rules.' };
      } else if (req.role === 'validate-plan') {
        response = { approved: true, reasoning: 'valid reasoning plan' };
      } else {
        response = { reasoning: 'enumerate transitions', proposedAction: 'derive states and witnesses from the supplied rules', expectedOutput: 'reachable states' };
      }
      return { text: jsonText(response), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    });
    const task = { description: facts, executionMode: 'reasoning' as const };
    const plan = await cell.plan(task, ctx);
    const result = await cell.execute(task, plan, ctx);
    expect(result.output).toEqual(answer.output);
    expect(executions).toBe(2);
    expect(verdicts).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves rejection of an invalid mathematical witness without converting it to a tool requirement', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const ctx = makeCtx();
    const rejection = { approved: false, reasoning: '0000 → 1000 by openA is invalid: pA=0, but openA requires pA=1.', confidence: 0.9, scope: 'ephemeral', modifications: { additionalContext: 'Check the openA precondition.' } };
    ctx.llm.enqueueText(jsonText(rejection));
    const result = await llmVerdict({
      ctx, model: 'test', supervisorName: 'Cell', supervisorTier: 2, subject: 'RESULT',
      child: L1Atom.fromType(reg.create(1, seed)), task: { description: facts, executionMode: 'reasoning' },
      payload: { output: '0000 --openA--> 1000', summary: 'A claimed witness' },
    });
    expect(result).toMatchObject({ approved: false, reasoning: rejection.reasoning, scope: 'ephemeral', modifications: rejection.modifications });
    expect(ctx.llm.calls[0]!.userContent).toContain('0000 --openA--> 1000');
    expect(ctx.llm.calls[0]!.userContent).toContain(facts);
  });

  it.each([
    { name: 'repaired and rechecked', observations: ['check cli.py: expected=6 actual=5', 'edit_file cli.py: ok', 'check cli.py: expected=6 actual=6'], approved: true },
    { name: 'changed but not rechecked', observations: ['check cli.py: expected=6 actual=5', 'edit_file cli.py: ok'], approved: false },
    { name: 'unrelated passing check', observations: ['check cli.py: expected=6 actual=5', 'check docs.md: exists=true'], approved: false },
    { name: 'regression after success', observations: ['check cli.py: expected=6 actual=6', 'edit_file cli.py: ok', 'check cli.py: expected=6 actual=5'], approved: false },
  ])('presents all observations in order: $name', async ({ observations, approved }) => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const ctx = makeCtx();
    const evidence: Witness[] = observations.map((observed, i) => ({ source: 'transport-observed', eventId: `observation-${i}`, tool: observed.startsWith('edit_file') ? 'edit_file' : 'run_shell', observed }));
    const decision = approved ? { approved: true, reasoning: 'The relevant recheck passes.' }
      : { approved: false, reasoning: 'The failure remains applicable.', confidence: 0.9, scope: 'ephemeral', modifications: { additionalContext: 'Fix and check the failed requirement.' } };
    ctx.llm.enqueueText(jsonText(decision));
    const result = await llmVerdict({
      ctx, model: 'test', supervisorName: 'Cell', supervisorTier: 2, subject: 'RESULT',
      child: L1Atom.fromType(reg.create(1, seed)), task: { description: 'Deliver cli.py returning 6.' },
      payload: { output: 'cli.py', summary: 'Delivered.' }, evidence,
      groundTruthBlock: 'Independent file read-back: cli.py exists; behaviour not checked.',
    });
    expect(result.approved).toBe(approved);
    const request = ctx.llm.calls[0]!;
    expect(request.systemPrompt).toBe(VALIDATION_SYSTEM_PROMPT);
    expect(request.userContent).toContain('historical observations');
    expect(request.userContent).toContain('behaviour not checked');
    const positions = observations.map((observation, i) => request.userContent.indexOf(`observation-${i}: ${observation}`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
