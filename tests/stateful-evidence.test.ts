import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { STATEFUL_EVIDENCE_GUIDANCE, STATEFUL_EVIDENCE_REVIEW } from '../src/atoms/prompts.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import type { LlmCompletionResponse, ToolExecutor } from '../src/core/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

const reply = (value: unknown): LlmCompletionResponse => ({
  text: jsonText(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
});

describe('stateful evidence at executor and validator boundaries', () => {
  it('preserves the failed setup beside the mislabeled sixth request from run ce89c84a', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../benchmark/stateful-evidence-2026-10-05/fixture.json', import.meta.url), 'utf8')) as {
      events: { name: string; args: Record<string, unknown>; result: unknown }[];
    };
    const calls = fixture.events.filter(event => event.name === 'fetch_url' &&
      String(event.args['url']) === 'http://localhost:45713/api/loans' &&
      /^premium (loan [1-5]|sixth refusal)$/.test(String(event.args['note'])));
    expect(calls).toHaveLength(6);
    const base: ToolExecutor = { has: () => true, execute: async (_name, args) => {
      const event = calls.find(call => call.args['note'] === args['note']);
      if (!event) throw new Error('Unexpected fixture call');
      return event.result;
    } };
    const attestations = createAttestationLog();
    const ctx = { ...makeCtx(), attestations, attempt: 1, currentBranchId: 'phase',
      tools: attestingExecutor(base, attestations, 'phase', undefined, 1)! };
    const child = new L1Atom({ name: 'Methane', ordinal: 2, systemPrompt: 'old stored prompt',
      tools: makeTools(['fetch_url']), params: {} });
    ctx.llm.enqueue(async request => {
      expect(request.userContent).toContain(STATEFUL_EVIDENCE_GUIDANCE);
      for (const call of calls) await request.executor!.execute(call.name, call.args);
      return reply({ output: 'verification', summary: 'Premium limit verified.' });
    });
    const task = { description: 'Verify a maximum of five active loans for premium members.' };
    const result = await child.execute(task, makePlan({ proposedAction: 'verify' }), ctx);
    ctx.llm.enqueue(reply({ approved: false, reasoning: 'Limit scenario remains unverified.' }));
    await llmVerdict({ ctx, model: 'test', supervisorName: 'Cell', supervisorTier: 2, child,
      task, subject: 'RESULT', payload: { output: result.output, summary: result.summary },
      evidence: result.evidence, groundTruthBlock: '' });
    const request = ctx.llm.calls.at(-1)!;
    expect(request.systemPrompt).toContain(STATEFUL_EVIDENCE_GUIDANCE);
    expect(request.userContent).toContain(STATEFUL_EVIDENCE_REVIEW);
    const fifth = request.userContent.split('\n').find(line => line.includes('premium loan 5'))!;
    const sixth = request.userContent.split('\n').find(line => line.includes('premium sixth refusal'))!;
    expect(fifth).toContain('"status":409');
    expect(fifth).toContain('copy unavailable or reserved');
    expect(sixth).toContain('"status":201');
    expect(request.userContent.indexOf(fifth)).toBeLessThan(request.userContent.indexOf(sixth));
    // The mocked verdict proves context plumbing only; live judgment is archived separately.
  });

  it('teaches observed setup in planning, without adding tools to reasoning tasks', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueue(reply({ reasoning: 'Inspect observed transitions', proposedAction: 'verify', expectedOutput: 'evidence' }));
    const child = new L1Atom({ name: 'Methane', ordinal: 2, systemPrompt: 'old stored prompt',
      tools: makeTools(['run_shell']), params: {} });
    await child.plan({ description: 'Verify state transitions' }, ctx);
    expect(ctx.llm.calls[0]!.userContent).toContain(STATEFUL_EVIDENCE_GUIDANCE);
    ctx.llm.enqueue(reply({ output: 'answer', summary: 'derived' }));
    await child.execute({ description: 'Derive the answer without tools', executionMode: 'reasoning' }, makePlan(), ctx);
    expect(ctx.llm.calls.at(-1)!.tools ?? []).toEqual([]);
    expect(ctx.llm.calls.at(-1)!.executor).toBeUndefined();
  });
});
