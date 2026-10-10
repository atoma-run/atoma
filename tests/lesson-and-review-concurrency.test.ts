import { describe, expect, it } from 'vitest';
import { saveLessons } from '../src/run/depth.js';
import { reviewAcceptanceCriteria } from '../src/atoms/criteriaReview.js';
import { makeCtx, jsonText } from './helpers.js';

describe('root finalization does not queue independent work', () => {
  it('runs one owner\'s lessons in order and different owners side by side', async () => {
    const ctx = makeCtx();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lesson = (owner: string | undefined, name: string, wait = false) => ({ owner, learn: async () => {
      log.push(`start ${name}`);
      if (wait) await gate;
      log.push(`end ${name}`);
    } });
    const done = saveLessons([lesson('Water', 'w1', true), lesson('Water', 'w2'), lesson('Ammonia', 'a1'), lesson(undefined, 'u1')],
      new AbortController().signal, ctx);
    await new Promise((r) => setTimeout(r, 0));
    // Ammonia did not wait for Water's first lesson; Water's second did.
    expect(log).toEqual(['start w1', 'start a1', 'end a1']);
    release();
    await done;
    expect(log).toEqual(['start w1', 'start a1', 'end a1', 'end w1', 'start w2', 'end w2', 'start u1', 'end u1']);
  });

  it('starts every criteria batch before the first answers, and keeps checklist order', async () => {
    const ctx = makeCtx();
    const started: string[] = [];
    const answers: Array<() => void> = [];
    const checklist = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, behaviour: `behaviour ${id}`, check: { kind: 'review' as const } }));
    const complete = ctx.llm.complete.bind(ctx.llm);
    ctx.llm.complete = async (req) => {
      const ids = [...req.userContent.matchAll(/"id":"(c\d)"/g)].map((m) => m[1]!);
      started.push(ids.join(','));
      await new Promise<void>((resolve) => answers.push(resolve));
      void complete;
      return { text: jsonText({ approved: true, reasoning: 'ok', criteria: ids.map((id) => ({ id, met: true, reason: 'seen' })) }),
        stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const review = reviewAcceptanceCriteria({ ctx, task: { description: 't' }, checklist, evidence: 'e' });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['c1,c2', 'c3,c4', 'c5']);
    answers.reverse().forEach((answer) => answer());
    const verdict = await review;
    expect(verdict.approved).toBe(true);
    expect(verdict.criteria.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });
});
