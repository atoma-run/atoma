import { describe, expect, it } from 'vitest';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { parsePlanTolerant } from '../src/atoms/json.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { reviewAcceptanceCriteria } from '../src/atoms/criteriaReview.js';
import { delegatedTaskContext } from '../src/atoms/taskContext.js';
import type { Task } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';

describe('Attica validation context regressions', () => {
  it('identifies the parser-generated wrapper without stripping actions or granting approval', async () => {
    const plan = parsePlanTolerant(jsonText({ reasoning: 'Inspect and repair the lock.',
      proposedAction: 'Read server.js, fix the error path, run the HTTP regression test.', expectedOutput: '400 then 202' }));
    expect(plan.subtasks).toHaveLength(1);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'A required error case is missing.', scope: 'ephemeral', modifications: {} }));
    const child = new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: '', tools: [], params: {} });
    const verdict = await llmVerdict({ ctx, model: 'test', supervisorName: 'Cell', supervisorTier: 2,
      child, subject: 'PLAN', task: { description: 'Repair all lock error paths.' }, payload: plan });
    const request = ctx.llm.calls[0]!;
    expect(request.userContent).toContain('host normalizes direct plans');
    expect(request.userContent).toContain(JSON.stringify(plan));
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('keeps static and execution proof distinct in the actual delegated validator request', async () => {
    const root: Task = { description: 'Remove debug.js and prove the lock releases through HTTP.',
      inputs: { startingRepository: { files: ['debug.js'] }, previousRunLanding: ['The old lock test failed.'] } };
    const task: Task = { ...delegatedTaskContext(root, { description: 'Clean up and test.' }),
      description: 'Clean up and test.', criteria: [
        { id: 'c1', behaviour: 'debug.js is absent.', source: 'user' },
        { id: 'c2', behaviour: 'An executed test observes resume 400 then start 202.', source: 'user' },
      ] };
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Fixture only.' }));
    const child = new L1Atom({ name: 'Water', ordinal: 1, systemPrompt: '', tools: [], params: {} });
    await llmVerdict({ ctx, model: 'test', supervisorName: 'Cell', supervisorTier: 2,
      child, subject: 'PLAN', task, payload: parsePlanTolerant(jsonText({ reasoning: 'r', proposedAction: 'Inspect and test.' })) });
    const request = ctx.llm.calls[0]!;
    expect(request.userContent).toContain('execution evidence is required only at RESULT time');
    expect(request.userContent).toContain('source can establish a static property');
    expect(request.userContent).toContain('required behavior needs observed execution');
    expect(request.userContent).toContain('is HTTP evidence');
    expect(request.userContent).toContain('not the current workspace');
    expect(request.userContent).toContain('fallible diagnoses from an earlier run');
    expect(request.userContent).not.toContain('source code does not prove it');
  });

  it('blinds focused reviews to prior landing diagnoses while preserving constraints and current failures', async () => {
    const ctx = makeCtx();
    const checklist = [{ id: 'c1', behaviour: 'debug.js is absent.', check: { kind: 'review' as const } }];
    ctx.llm.enqueue(req => {
      expect(req.userContent).not.toContain('OLD_LANDING_DIAGNOSIS');
      expect(req.userContent).toContain('Offline only');
      expect(req.userContent).toContain('CURRENT_TEST_FAILURE');
      expect(req.systemPrompt).toContain('Keep each judgment local to its criterion');
      expect(req.systemPrompt).toContain('that its own evidence independently establishes');
      expect(req.systemPrompt).not.toContain('scheduler');
      expect(req.systemPrompt).not.toContain('lock-release');
      return { text: jsonText({ approved: false, reasoning: 'File still present.', scope: 'ephemeral', modifications: {},
        criteria: [{ id: 'c1', met: false, reason: 'Current directory listing includes debug.js.' }] }),
      stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const reviewed = await reviewAcceptanceCriteria({ ctx, checklist,
      task: { description: 'Remove debug.js.', constraints: ['Offline only'], inputs: { previousRunLanding: ['OLD_LANDING_DIAGNOSIS'] } },
      evidence: 'debug.js is present. CURRENT_TEST_FAILURE' });
    expect(reviewed.approved).toBe(false);
    expect(reviewed.criteria[0]?.met).toBe(false);
  });
});
