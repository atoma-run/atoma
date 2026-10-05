import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reviewAcceptanceCriteria } from '../src/atoms/criteriaReview.js';
import { remediationTask } from '../src/run/depth.js';
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { markLanded } from '../src/atoms/dispatch.js';
import { ASSERTION_EVIDENCE_GUIDANCE } from '../src/atoms/prompts.js';
import { DELEGATED_SCOPE_GUIDANCE } from '../src/atoms/taskContext.js';
import type { LlmCompletionResponse, Result } from '../src/core/types.js';
import { makeCtx, jsonText } from './helpers.js';

const checklist = [
  { id: 'c4', behaviour: 'tests/spec.test.js verifies conflicting duplicate IDs preserve existing outputs.', check: { kind: 'review' as const } },
  { id: 'c6', behaviour: 'tests/spec.test.js asserts deterministic stock.csv and audit.json across repeated executions.', check: { kind: 'review' as const } },
];
const reply = (criteria: Array<{ id: string; met: boolean; reason?: string }>, approved = true): LlmCompletionResponse => ({
  text: jsonText({ approved, reasoning: 'Fixture verdict', scope: 'ephemeral', modifications: {}, criteria }),
  stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
});
const met = checklist.map(item => ({ id: item.id, met: true, reason: 'Observed assertions establish this requirement.' }));
const missing = checklist.map(item => ({ id: item.id, met: false, reason: `${item.id}: required assertion is absent.` }));
const task = { description: 'Build and verify the reconciliation CLI.' };
const result: Result = { output: { files: ['tests/spec.test.js'] }, summary: 'MODEL_SUCCESS_SENTINEL: all requirements passed.', trace: [],
  producedBy: { tier: 1, name: 'Methane', viaFallback: false } };
const actor = new L1Atom({ name: 'Methane', ordinal: 1, systemPrompt: '', tools: [], params: {} });

describe('focused criterion review', () => {
  it('carries the shared evidence policy to each bounded review and retains all compound gaps', async () => {
    const ctx = makeCtx();
    const required = [
      { id: 'c1', behaviour: 'Executed tests separately assert subtotal, tax and total for JPY and KWD.', check: { kind: 'review' as const } },
      { id: 'c2', behaviour: 'Executed tests compare both report.csv and audit.json across runs.', check: { kind: 'review' as const } },
      { id: 'c3', behaviour: 'Implementation applies the discount before adding the fixed fee.', check: { kind: 'review' as const } },
    ];
    const judgments = [
      { id: 'c1', met: false, reason: 'Only totals asserted; JPY and KWD subtotal and tax remain unverified.' },
      { id: 'c2', met: false, reason: 'Only report.csv compared; audit.json bytes remain unverified.' },
      { id: 'c3', met: true, reason: 'Source applies discount before fee; no executed distinguishing test was required.' },
    ];
    for (const batch of [judgments.slice(0, 2), judgments.slice(2)]) ctx.llm.enqueue(request => {
      // This verifies policy delivery and propagation, not model understanding.
      // Real semantic judgments are retained in the paired benchmark replay.
      expect(request.systemPrompt).toContain(ASSERTION_EVIDENCE_GUIDANCE);
      expect(request.systemPrompt).toContain('Report every unsupported part');
      expect(request.tools).toBeUndefined();
      expect(request.executor).toBeUndefined();
      return reply(batch, batch.every(item => item.met));
    });
    const review = await reviewAcceptanceCriteria({ ctx, task, checklist: required, evidence: 'Bounded fixture evidence.' });
    expect(review.criteria).toEqual(judgments);
    expect(review.reasoning).toContain(judgments[0]!.reason);
    expect(review.reasoning).toContain(judgments[1]!.reason);
    expect(review.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it.each([false, true])('shares the bounded readback across files without losing assertions (over budget=%s)', async overBudget => {
    const paths = ['stock-reconcile.js', 'test/stock-reconcile.test.js'];
    const files = new Map(paths.map(path => [path, overBudget ? 'x'.repeat(13_000)
      : readFileSync(new URL(`../benchmark/warehouse-repair-2026-10-05/artifact/${path.replace('/', '-')}.txt`, import.meta.url), 'utf8')]));
    const ctx = { ...makeCtx(), tools: {
      has: (name: string) => name === 'read_file',
      execute: async (_name: string, args: Record<string, unknown>) => ({ content: files.get(String(args['path'])) }),
    } };
    const listed = paths.map((path, i) => ({ id: `c${i + 1}`, behaviour: `${path} implements and tests the required behavior.`, check: { kind: 'review' as const } }));
    const judgments = listed.map(item => ({ id: item.id, met: true, reason: 'Fixture accepts observed behavior.' }));
    for (let call = 0; call < 2; call++) ctx.llm.enqueue(req => {
      for (const content of files.values()) {
        if (overBudget) {
          expect(req.userContent).not.toContain(JSON.stringify(content));
          expect(req.userContent).toContain('cut at 1200 of 13000 chars');
        } else expect(req.userContent).toContain(JSON.stringify(content));
      }
      return reply(judgments);
    });
    await acceptRootResult({ actor, task, result: { ...result, output: {} }, ctx, floor: [], phaseCoverage: [],
      checklist: listed, checklistOrigin: { source: 'user' } });
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it.each(['spec.test.js', 'tests/spec.test.js'])('keeps the archived missing assertions in %s visible and blocks a global false approval through real root acceptance', async testPath => {
    const source = readFileSync(new URL('../benchmark/stock-reconcile-2026-10-05/published/stock-reconcile.test.js.txt', import.meta.url), 'utf8');
    const ctx = { ...makeCtx(), tools: {
      has: (name: string) => name === 'read_file',
      execute: async (_name: string, args: Record<string, unknown>) => {
        if (args['path'] !== testPath) throw new Error('ENOENT');
        return { content: source };
      },
    } };
    ctx.llm.enqueue(reply(met)); // Reproduce the global false positive.
    ctx.llm.enqueue(request => {
      expect(request.actor?.name).toBe('run-criteria');
      expect(request.userContent).not.toContain(DELEGATED_SCOPE_GUIDANCE);
      expect(request.userContent).toContain(JSON.stringify(source));
      expect(request.userContent).not.toContain('MODEL_SUCCESS_SENTINEL');
      expect(request.tools).toBeUndefined();
      expect(request.executor).toBeUndefined();
      // Even contradictory approved:true cannot override met:false.
      return reply(missing);
    });
    const accepted = await acceptRootResult({ actor, task, result: { ...result, output: { files: [testPath] } }, ctx, floor: [], phaseCoverage: [],
      checklist: checklist.map(item => ({ ...item, behaviour: item.behaviour.replace('tests/spec.test.js', testPath) })),
      checklistOrigin: { source: 'user' } });
    expect(accepted.approved).toBe(false);
    expect(accepted.checklist?.map(item => item.judgement)).toEqual(missing.map(({ met, reason }) => ({ met, reason })));
    expect(accepted.reasoning).toContain('required assertion is absent');
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('allows a supported delivery and preserves focused reasons instead of the global prose', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueue(reply(met.map(j => ({ ...j, reason: 'global claim' }))));
    ctx.llm.enqueue(reply(met));
    const accepted = await acceptRootResult({ actor, task, result: { ...result, output: {} }, ctx,
      floor: [], phaseCoverage: [], checklist, checklistOrigin: { source: 'user' } });
    expect(accepted.approved).toBe(true);
    expect(accepted.checklist?.every(item => item.judgement?.reason === met[0]!.reason)).toBe(true);
  });

  it.each([
    'not json',
    jsonText({ criteria: met }),
    reply([]).text,
    reply([met[0]!]).text,
    reply([met[0]!, met[0]!]).text,
    reply([met[0]!, { ...met[1]!, id: 'c9' }]).text,
    reply(met.map(({ id, met }) => ({ id, met }))).text,
    reply(met.map(j => ({ ...j, reason: '   ' }))).text,
  ])('never accepts an incomplete criterion response: %s', async text => {
    const ctx = makeCtx();
    ctx.llm.enqueue({ ...reply(met), text });
    const reviewed = await reviewAcceptanceCriteria({ ctx, task, checklist, evidence: 'host evidence' });
    expect(reviewed.approved).toBe(false);
    expect(reviewed.criteria.map(c => c.id)).toEqual(['c4', 'c6']);
    expect(reviewed.criteria.every(c => !c.met && c.reason?.includes('no implementation defect'))).toBe(true);
  });

  it('rejects a truncated but parseable response without retrying or inventing proof', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueue({ ...reply(met), stopReason: 'max_tokens' });
    expect((await reviewAcceptanceCriteria({ ctx, task, checklist, evidence: '' })).approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('reviews every batch, excluding earlier verdicts and phase summaries without dropping original input data', async () => {
    const ctx = makeCtx();
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `c${i + 1}`, behaviour: `Required behavior ${i + 1}`, check: { kind: 'review' as const } }));
    for (const group of [many.slice(0, 2), many.slice(2, 4), many.slice(4)]) ctx.llm.enqueue(req => {
      expect(req.userContent).not.toContain('UNTRUSTED_SUCCESS_SENTINEL');
      expect(req.userContent).toContain('original source data');
      for (const item of group) expect(req.userContent).toContain(item.behaviour);
      for (const item of many.filter(i => !group.includes(i))) expect(req.userContent).not.toContain(item.behaviour);
      return reply(group.map(item => ({ id: item.id, met: item.id !== 'c1', reason: 'Observed outcome for this criterion.' })));
    });
    const reviewed = await reviewAcceptanceCriteria({ ctx, checklist: many, evidence: 'observed data',
      task: { ...task, inputs: { data: 'original source data', previousStepSummary: 'UNTRUSTED_SUCCESS_SENTINEL', rootAcceptanceRefusal: 'UNTRUSTED_SUCCESS_SENTINEL' } } });
    expect(reviewed.approved).toBe(false);
    expect(reviewed.criteria).toHaveLength(5);
    expect(ctx.llm.calls).toHaveLength(3);
  });

  it('preserves explicit scoped refusal even when every item says met', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueue(reply(met, false));
    expect((await reviewAcceptanceCriteria({ ctx, task, checklist, evidence: '' })).approved).toBe(false);
  });

  it('propagates transport failure and cancellation instead of fabricating an approval', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueue(() => { throw new Error('provider unavailable'); });
    await expect(reviewAcceptanceCriteria({ ctx, task, checklist, evidence: '' })).rejects.toThrow('provider unavailable');
    const aborted = { ...makeCtx(), signal: AbortSignal.abort(new Error('cancelled')) };
    await expect(reviewAcceptanceCriteria({ ctx: aborted, task, checklist, evidence: '' })).rejects.toThrow('cancelled');
    expect(aborted.llm.calls).toHaveLength(0);
  });

  it.each([true, false])('reviews every criterion after a global refusal and preserves it (focused approval=%s)', async focusedApproval => {
    const ctx = makeCtx();
    const required = Array.from({ length: 5 }, (_, i) => ({ id: `c${i + 1}`, behaviour: `Required behavior ${i + 1}`, check: { kind: 'review' as const } }));
    ctx.llm.enqueue({ ...reply(required.map(item => ({ id: item.id, met: true, reason: 'global claim' })), false),
      text: jsonText({ approved: false, reasoning: 'GLOBAL_DEFECT_SENTINEL', scope: 'ephemeral', modifications: {} }) });
    for (const batch of [required.slice(0, 2), required.slice(2, 4), required.slice(4)]) ctx.llm.enqueue(req => {
      expect(req.userContent).not.toContain('GLOBAL_DEFECT_SENTINEL');
      expect(req.userContent).not.toContain('MODEL_SUCCESS_SENTINEL');
      return reply(batch.map(item => ({ id: item.id, met: focusedApproval, reason: `Focused evidence for ${item.id}` })), focusedApproval);
    });
    const accepted = await acceptRootResult({ actor, task, result, ctx, floor: [], phaseCoverage: [],
      checklist: required, checklistOrigin: { source: 'user' } });
    expect(ctx.llm.calls).toHaveLength(4);
    expect(accepted.approved).toBe(false);
    expect(accepted.reasoning).toContain('GLOBAL_DEFECT_SENTINEL');
    expect(accepted.checklist?.map(item => item.judgement?.met)).toEqual(Array(5).fill(focusedApproval));
    const remediation = remediationTask(task, accepted);
    expect(remediation.inputs?.['rootAcceptanceRefusal']).toBe(accepted.reasoning);
    if (!focusedApproval) {
      for (const item of required) expect(accepted.reasoning).toContain(`Focused evidence for ${item.id}`);
      expect(remediation.inputs).not.toHaveProperty('rootRemediationScope');
    }
  });

  it('does not add paid checks to a drafted or landed delivery', async () => {
    for (const mode of ['drafted', 'landed'] as const) {
      const ctx = makeCtx();
      ctx.llm.enqueue(reply(mode === 'landed' ? missing : met));
      const accepted = await acceptRootResult({ actor, task, result: mode === 'landed' ? markLanded(result, [{ description: 'pending' }]) : result,
        ctx, floor: [], phaseCoverage: [], checklist, checklistOrigin: { source: mode === 'drafted' ? 'drafted' : 'user' } });
      expect(accepted.approved).toBe(true);
      expect(ctx.llm.calls).toHaveLength(1);
    }
  });
});
