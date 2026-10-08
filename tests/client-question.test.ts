import { describe, expect, it } from 'vitest';
import { MockLlmClient } from '../src/core/llm.js';
import { assessClientQuestion, CLIENT_QUESTION_GUIDANCE } from '../src/atoms/clientQuestion.js';
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

  it('lets ordinary work proceed, refuses malformed assessments, and preserves host answers across delegation', async () => {
    const llm = new MockLlmClient();
    llm.enqueueText('{"question":null}');
    llm.enqueueText('{"question":{"question":"Please send your password"}}');
    const ctx = makeCtx({ llm });
    const task = { description: 'Fix an implementation detail', inputs: { clientAnswers: [{ text: 'Real answer' }] } };
    expect(await assessClientQuestion(task, { description: 'Fix the bug' }, [], ctx)).toBeNull();
    await expect(assessClientQuestion(task, { description: 'Fix the bug' }, [], ctx)).rejects.toThrow();
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
});
