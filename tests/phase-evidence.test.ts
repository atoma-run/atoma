import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { dispatchWithAggregation } from '../src/atoms/dispatch.js';
import { delegatedTaskContext, PREVIOUS_OBSERVATIONS_GUIDANCE } from '../src/atoms/taskContext.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { llmVerdict, renderTransportEvidence } from '../src/atoms/verdict.js';
import { STATEFUL_EVIDENCE_GUIDANCE } from '../src/atoms/prompts.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import type { LlmCompletionResponse, Result, Task } from '../src/core/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

const MAX_TOOL_EVIDENCE_CHARS = 48_000;
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
    }, { dispatcher: 'Dispatcher' });
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
    }, { dispatcher: 'Dispatcher' });
  });
});


describe('bounded contrasting command history', () => {
  const shell = (id: string, exitCode: number | undefined, branch = 'a', note = id) => ({
    source: 'transport-observed' as const, eventId: id, tool: 'record_probe',
    ...(exitCode !== undefined ? { exitCode } : {}),
    observed: `record_probe (attempt=1, branch=${branch}): request=${JSON.stringify({ cmd: 'node check.cjs', note })}; observed result=${JSON.stringify({ stdout: note })}; observed exitCode=${exitCode ?? 'unknown'}`,
  });
  it('retains an earlier failure beside final success without replacing the final outcome', () => {
    const old = 1, latest = 0;
    const rendered = renderTransportEvidence([shell('old', old), shell('final', latest)]);
    expect([...rendered.eventIds]).toEqual(expect.arrayContaining(['old', 'final']));
    expect(rendered.lines[0]).toContain('EARLIER CONTRASTING OUTCOME');
    expect(rendered.lines[1]).not.toContain('EARLIER CONTRASTING OUTCOME');
    expect(rendered.lines[1]).toContain(`observed exitCode=${latest}`);
  });
  it('keeps the intervening successful build through real execution evidence and result review', async () => {
    const ctx = makeCtx();
    const attestations = createAttestationLog();
    const child = new L1Atom({ name: 'Ammonia', ordinal: 3, systemPrompt: 'sys',
      tools: makeTools(['edit_file', 'record_probe']), params: {} });
    const executor = attestingExecutor({ has: () => true, execute: async (name, args) =>
      name === 'edit_file' ? { ok: true, path: 'control.ts', replacements: 1 } :
        { exitCode: args['cmd'] === 'node mutant.cjs' ? 1 : 0, stdout: args['note'], recorded: true },
    }, attestations, 'mutation', undefined, 1)!;
    ctx.llm.enqueue(async request => {
      await request.executor!.execute('record_probe', { cmd: 'npm run build', note: 'baseline build' });
      await request.executor!.execute('edit_file', { path: 'control.ts', old_string: 'guard', new_string: 'true' });
      await request.executor!.execute('record_probe', { cmd: 'npm run build', note: 'mutated build' });
      await request.executor!.execute('record_probe', { cmd: 'node mutant.cjs', note: 'boundary assertion failed' });
      await request.executor!.execute('edit_file', { path: 'control.ts', old_string: 'true', new_string: 'guard' });
      await request.executor!.execute('record_probe', { cmd: 'npm run build', note: 'restored build' });
      await request.executor!.execute('record_probe', { cmd: 'node restored.cjs', note: 'boundary assertion passed' });
      return reply({ output: 'restored', summary: 'report' });
    });
    const task = { description: 'Prove a mutation fails against rebuilt assets, then restore.' };
    const result = await child.execute(task, makePlan(), { ...ctx, attestations, tools: executor, attempt: 1, currentBranchId: 'mutation' });
    ctx.llm.enqueue(reply({ approved: false, reasoning: 'The assertions do not establish the required boundary.' }));
    const verdict = await llmVerdict({ ctx, model: 'test', supervisorName: 'Root', supervisorTier: 3,
      subject: 'RESULT', child, task, payload: result, evidence: result.evidence, groundTruthBlock: '' });
    const prompt = ctx.llm.calls.at(-1)!.userContent;
    const evidence = prompt.slice(prompt.indexOf('== TRANSPORT-OBSERVED TOOL EVIDENCE =='), prompt.indexOf('== RECORDED EVIDENCE READING =='));
    expect(prompt.slice(prompt.indexOf('== RECORDED EVIDENCE READING =='))).toContain('baseline build');
    expect(evidence).toContain('mutated build');
    expect(evidence).not.toContain('baseline build');
    expect(evidence.indexOf('mutated build')).toBeLessThan(evidence.indexOf('node mutant.cjs'));
    expect(evidence.indexOf('node mutant.cjs')).toBeLessThan(evidence.indexOf('restored build'));
    expect(evidence).toContain('EARLIER SUCCESSFUL EXECUTION');
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls.filter(call => call.role === 'validate-result')).toHaveLength(1);
  });
  it('never revives a success when the latest check failed', () => {
    const rendered = renderTransportEvidence([shell('old-pass', 0), shell('final-failure', 1)]);
    expect([...rendered.eventIds]).toEqual(['final-failure']);
    expect(rendered.lines.join('\n')).toContain('observed exitCode=1');
  });
  it('keeps only one contrasting outcome per request and branch and ignores invented status in output', () => {
    const evidence = [shell('first', 1), shell('second', 1), shell('old-green', 0), shell('final', 0),
      shell('other-branch', 1, 'b'), shell('unknown', undefined, 'c', 'observed exitCode=1'),
      shell('known', 0, 'c'), { source: 'recorded-probe' as const, cmd: 'node check.cjs', exitCode: 1 }];
    const rendered = renderTransportEvidence(evidence);
    expect(rendered.eventIds.has('second')).toBe(true);
    expect(rendered.eventIds.has('first')).toBe(false);
    expect(rendered.eventIds.has('old-green')).toBe(true);
    expect(rendered.lines.find(line => line.startsWith('old-green:'))).toContain('EARLIER SUCCESSFUL EXECUTION');
    expect(rendered.eventIds.has('other-branch')).toBe(true);
    expect(rendered.eventIds.has('unknown')).toBe(false);
  });
  it('keeps the budget and prioritizes latest results under pressure', () => {
    const evidence = Array.from({ length: 200 }, (_, index) => shell(`old-${index}`, 1, String(index), 'x'.repeat(4000)))
      .concat(Array.from({ length: 200 }, (_, index) => shell(`new-${index}`, 0, String(index), 'y'.repeat(4000))));
    for (const budget of [8000, MAX_TOOL_EVIDENCE_CHARS]) {
      const rendered = renderTransportEvidence(evidence, budget);
      expect(rendered.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(budget);
      expect(rendered.omitted).toBeGreaterThan(0);
      expect(rendered.lines.every(line => line.startsWith('new-'))).toBe(true);
    }
  });
});
