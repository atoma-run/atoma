import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { dispatchWithAggregation } from '../src/atoms/dispatch.js';
import { delegatedTaskContext, PREVIOUS_OBSERVATIONS_GUIDANCE } from '../src/atoms/taskContext.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { STATEFUL_EVIDENCE_GUIDANCE } from '../src/atoms/prompts.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import type { LlmCompletionResponse, Result, Task } from '../src/core/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

const reply = (value: unknown): LlmCompletionResponse => ({ text: jsonText(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });

describe('sequential phase observations', () => {
  it('carries real run browser proof and earlier edits through dispatch, nested delegation and reporting validation', async () => {
    const events = JSON.parse(gunzipSync(readFileSync(new URL('../benchmark/stateful-evidence-2026-10-05/live-events.json.gz', import.meta.url))).toString()) as {
      id: string; name?: string; args: Record<string, unknown>; result: unknown;
    }[];
    const selected = ['59c4d1f2-bd37-4e92-8552-e27dc212cdce', '7aaec442-4ed8-47ab-96f6-11f4d27dded1', '49a89cb6-49ab-4257-8040-e30f9a6f06ba'];
    const calls = selected.map(id => events.find(event => event.id === id)!);
    expect(calls.every(Boolean)).toBe(true);
    const ctx = makeCtx();
    const attestations = createAttestationLog();
    const child = new L1Atom({ name: 'Methane', ordinal: 2, systemPrompt: 'old stored prompt', tools: makeTools(['edit_file', 'validate_html']), params: {} });
    const plan = makePlan({ aggregation: { mode: 'sequential' }, subtasks: [
      { description: 'Update tests' }, { description: 'First browser check' }, { description: 'Verify browser' }, { description: 'Report prior observations' },
    ] });
    await dispatchWithAggregation(plan.subtasks, plan, ctx, async (subtask, index) => {
      const task: Task = { description: subtask.description, ...delegatedTaskContext({ description: 'Complete targeted verification' }, subtask) };
      const nested = { description: subtask.description, ...delegatedTaskContext(task, { description: subtask.description }) };
      const call = calls[index];
      const phaseCtx = { ...ctx, attestations, attempt: 1, currentBranchId: `phase-${index}`,
        tools: attestingExecutor({ has: () => true, execute: async () => call?.result }, attestations, `phase-${index}`, undefined, 1)! };
      ctx.llm.enqueue(async request => {
        if (call) await request.executor!.execute(call.name!, call.args);
        else {
          expect(request.userContent).toContain(PREVIOUS_OBSERVATIONS_GUIDANCE);
          expect(request.userContent).toContain('server.js');
          expect(request.userContent).toContain('edit_file');
          expect(request.userContent).toContain('keypress Tab');
          expect(request.userContent).toContain('390');
          expect(request.userContent).toContain('copy unavailable or reserved');
          expect(request.userContent).toContain('loanRendered');
          expect(request.userContent).toContain(STATEFUL_EVIDENCE_GUIDANCE);
        }
        return reply({ output: 'No files changed', summary: 'Model report is not evidence.' });
      });
      const result = await child.execute(nested, makePlan(), phaseCtx);
      if (index === calls.length) {
        ctx.llm.enqueue(reply({ approved: false, reasoning: 'The earlier edit contradicts the report.' }));
        await llmVerdict({ ctx, model: 'test', supervisorName: 'Cell', supervisorTier: 2, child, task: nested,
          subject: 'RESULT', payload: result, evidence: result.evidence, groundTruthBlock: '' });
        expect(ctx.llm.calls.at(-1)!.userContent).toContain('edit_file');
        expect(ctx.llm.calls.at(-1)!.userContent).toContain('keypress Tab');
        // Prior observations remain context, never credited as this leaf's tool work.
        expect(result.evidence ?? []).toHaveLength(0);
      }
      return result;
    });
  });

  it('preserves enclosing and local observations across nested sequential delegation with labelled bounds', () => {
    const parent = { description: 'Enclosing phase', inputs: { previousPhaseObservations: { lines: ['outer edit_file server.js'] } } };
    const nested = delegatedTaskContext(parent, { description: 'Local report', inputs: { previousPhaseObservations: { lines: ['inner validate_html keypress Tab'] } } });
    expect(JSON.stringify(nested.inputs)).toContain('outer edit_file');
    expect(JSON.stringify(nested.inputs)).toContain('inner validate_html');
    const bounded = delegatedTaskContext(parent, { description: 'Large report', inputs: { previousPhaseObservations: { lines: ['x'.repeat(30_000)] } } });
    expect(bounded.inputs?.['previousPhaseObservations']).toMatchObject({ truncated: true });
    expect(JSON.stringify(bounded.inputs?.['previousPhaseObservations']).length).toBeLessThan(25_000);
  });

  it.each(['sequential', 'concat'] as const)('does not promote declared probes or leak observations between parallel siblings (%s)', async mode => {
    const plan = makePlan({ aggregation: { mode }, subtasks: [{ description: 'First' }, { description: 'Second' }] });
    const result: Result = { output: 'answer', summary: 'claim', trace: [],
      producedBy: { tier: 1, name: 'Methane', viaFallback: false }, evidence: [
        { source: 'recorded-probe', cmd: 'fabricated declaration', stdout: 'all passed' },
        { source: 'transport-observed', eventId: 'observed', tool: 'run_shell', observed: 'exitCode=1' },
      ] };
    await dispatchWithAggregation(plan.subtasks, plan, makeCtx(), async (subtask, index) => {
      if (index === 1) {
        const observations = subtask.inputs?.['previousPhaseObservations'];
        if (mode === 'concat') expect(observations).toBeUndefined();
        else {
          expect(JSON.stringify(observations)).toContain('exitCode=1');
          expect(JSON.stringify(observations)).not.toContain('fabricated');
        }
      }
      return result;
    });
  });
});
