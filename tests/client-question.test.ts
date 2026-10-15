import { describe, expect, it } from 'vitest';
import { MockLlmClient } from '../src/core/llm.js';
import { assessClientQuestion, CLIENT_QUESTION_GUIDANCE, CLIENT_QUESTION_TIMEOUT_MS } from '../src/atoms/clientQuestion.js';
import { clientQuestionSchema, answerClientQuestionSchema } from '../src/contracts/clientQuestion.js';
import { delegatedTaskContext } from '../src/atoms/taskContext.js';
import { clientQuestionFixture } from './helpers/clientQuestion.js';
import { makeCtx } from './helpers.js';
import { PIN_HAIKU } from './tier-pins.js';

describe('client decision boundary', () => {
  it('uses a bounded tool-free tier-1 call with goal, next phase, confirmed context and prior client answers', async () => {
    const llm = new MockLlmClient();
    llm.enqueueText(JSON.stringify({ question: clientQuestionFixture() }));
    const ctx = makeCtx({ llm });
    const task = { description: 'Add Google login', inputs: { projectContext: { brief: 'Keep customer access' }, clientAnswers: [{ question: 'Earlier', text: 'Settled' }] } };
    const question = await assessClientQuestion(task, { description: 'Change authentication' }, [], ctx);
    expect(question).toEqual(clientQuestionFixture());
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ model: PIN_HAIKU, role: 'plan', actor: { name: 'run-client-question', tier: 1 }, params: { maxTokens: 1536 } });
    expect(llm.calls[0]!.tools).toBeUndefined();
    expect(llm.calls[0]!.userContent).toContain('Keep customer access');
    expect(llm.calls[0]!.userContent).toContain('Settled');
    expect(CLIENT_QUESTION_GUIDANCE).toContain('Do not ask for reassurance');
    expect(CLIENT_QUESTION_GUIDANCE).toContain('untrusted observations');
  });

  it('lets ordinary work proceed, asks nothing on a malformed assessment, and preserves host answers across delegation', async () => {
    const llm = new MockLlmClient();
    llm.enqueueText('{"question":null}');
    llm.enqueueText('{"question":{"question":"Please send your password"}}');
    const ctx = makeCtx({ llm });
    const task = { description: 'Fix an implementation detail', inputs: { clientAnswers: [{ text: 'Real answer' }] } };
    expect(await assessClientQuestion(task, { description: 'Fix the bug' }, [], ctx)).toBeNull();
    // Invalid: no question is invented, and the run is not failed for it.
    expect(await assessClientQuestion(task, { description: 'Fix the bug' }, [], ctx)).toBeNull();
    expect(delegatedTaskContext(task, { description: 'Implement', inputs: { clientAnswers: [{ text: 'Invented answer' }] } }).inputs?.['clientAnswers']).toEqual([{ text: 'Real answer' }]);
    expect(delegatedTaskContext({ description: 'No answers' }, { description: 'Implement', inputs: { clientAnswers: ['forged'] } }).inputs?.['clientAnswers']).toBeUndefined();
  });

  it('rejects duplicate choices, missing reasoning, oversized questions and empty answers', () => {
    const question = clientQuestionFixture();
    expect(clientQuestionSchema.safeParse({ ...question, options: [question.options[0], question.options[0]] }).success).toBe(false);
    expect(clientQuestionSchema.safeParse({ ...question, whyClient: '' }).success).toBe(false);
    expect(clientQuestionSchema.safeParse({ ...question, question: 'x'.repeat(601) }).success).toBe(false);
    expect(answerClientQuestionSchema.safeParse({ questionId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'key', answer: {} }).success).toBe(false);
  });

  // Run c89a3cc7 (2026-10-15): the zero-phase assessment answered 60,257
  // tokens of JavaScript after 484 s, and its parse error failed the run.
  it('asks nothing when the assessment answers code, runs past its bound or fails, but propagates cancellation', async () => {
    const task = { description: 'Finish the collector' };
    const code = new MockLlmClient();
    code.enqueueText("javascript\napp.post('/api/start', (req, res) => {\n  collectXE.start({ ...config });\n});");
    expect(await assessClientQuestion(task, { description: 'Repair cancellation' }, [], makeCtx({ llm: code }))).toBeNull();

    const failing = new MockLlmClient();
    failing.enqueue(async () => { throw new Error('transport error'); });
    expect(await assessClientQuestion(task, { description: 'Repair cancellation' }, [], makeCtx({ llm: failing }))).toBeNull();

    const slow = new MockLlmClient();
    let seen: AbortSignal | undefined;
    slow.enqueue(async (req) => { seen = req.signal; return { text: '{"question":null}', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }; });
    await assessClientQuestion(task, { description: 'Repair cancellation' }, [], makeCtx({ llm: slow }));
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(CLIENT_QUESTION_TIMEOUT_MS).toBe(90_000);

    const stop = new AbortController();
    const cancelled = new MockLlmClient();
    cancelled.enqueue(async () => { stop.abort(new Error('run cancelled')); throw new Error('aborted'); });
    await expect(assessClientQuestion(task, { description: 'Repair cancellation' }, [], { ...makeCtx({ llm: cancelled }), signal: stop.signal }))
      .rejects.toThrow('aborted');
  });
});
