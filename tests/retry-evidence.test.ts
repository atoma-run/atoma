import { describe, expect, it } from 'vitest';
import { Atom, type Supervisor } from '../src/core/atom.js';
import { archiveToolEvidence } from '../src/core/evidenceArchive.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { historicalExecutionRecords } from '../src/core/executionHistory.js';
import { keptWithoutSynthesis } from '../src/atoms/dispatch.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { llmVerdict } from '../src/atoms/verdict.js';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { superviseLoop } from '../src/core/supervisor.js';
import type { Result, RunContext, Task } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';

class RetryChild extends L1Atom {
  private executions = 0;
  override async plan() { return makePlan(); }
  override async execute(task: Task, plan: ReturnType<typeof makePlan>, ctx: RunContext) {
    const branch = `repair-${++this.executions}`;
    return super.execute(task, plan, { ...ctx, currentBranchId: branch,
      tools: attestingExecutor(ctx.tools, ctx.attestations, branch, undefined, ctx.attempt) });
  }
}
class ReviewingParent extends Atom implements Supervisor<RetryChild> {
  readonly tier = 2 as const;
  readonly model = 'mock';
  constructor() { super({ name: 'Reviewer', ordinal: 1, systemPrompt: 'Review', tools: [], params: {} }); }
  async plan() { return makePlan(); }
  async execute(): Promise<Result> { throw new Error('Unexpected fallback'); }
  async validatePlan() { return { approved: true as const, reasoning: 'Targeted repair' }; }
  async validateResult(child: RetryChild, result: Result, task: Task, ctx: RunContext) {
    return llmVerdict({ ctx, model: 'mock', supervisorName: this.name, supervisorTier: 2,
      subject: 'RESULT', child, task, payload: { output: result.output, summary: result.summary },
      evidence: result.evidence,
      historicalEvidenceIds: result.historicalEvidenceIds,
      groundTruthBlock: '' });
  }
}
const reply = (value: unknown) => ({ text: JSON.stringify(value), stopReason: 'end_turn' as const,
  usage: { inputTokens: 1, outputTokens: 1 } });

describe('refused execution history', () => {
  it('carries the real baseline failure through a repair and raw review without fresh proof credit', async () => {
    const ctx = makeCtx();
    const attestations = createAttestationLog();
    let baseline = '';
    const tools = attestingExecutor({ has: () => true, execute: async (_name, args) => ({
      exitCode: args['cmd'] === 'baseline' ? 1 : 0,
      stdout: args['cmd'] === 'baseline' ? 'BASELINE_ASSERTION_FAILED ' + 'x'.repeat(30000) : 'FINAL_ASSERTION_PASSED',
    }) }, attestations, 'repair', undefined, 1)!;
    const runCtx = { ...ctx, tools, attestations, currentBranchId: 'repair', attempt: 1 };
    const child = new RetryChild({ name: 'Methane', ordinal: 1, systemPrompt: 'Repair', tools: makeTools(['run_shell']), params: {} });
    ctx.llm.enqueue(async request => {
      await request.executor!.execute('run_shell', { cmd: 'baseline' });
      baseline = attestations.forAttempt(1)[0]!.eventId;
      return reply({ output: 'Initial failure', summary: 'Repair remains' });
    });
    ctx.llm.enqueue(reply({ approved: false, reasoning: 'Repair the observed defect', scope: 'ephemeral', modifications: {} }));
    ctx.llm.enqueue(async request => {
      await request.executor!.execute('run_shell', { cmd: 'final' });
      return reply({ output: 'Fixed', summary: 'Latest check passes; initial failure omitted from this report' });
    });
    ctx.llm.enqueue(request => {
      expect(request.executor).toBeUndefined();
      expect(request.tools).toBeUndefined();
      expect(request.userContent).toContain('PRIOR EXECUTION CONTEXT');
      expect(request.userContent).toContain(baseline);
      return reply({ readEvidence: [{ eventId: baseline, offset: 0, length: 10000 }] });
    });
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('BASELINE_ASSERTION_FAILED');
      expect(request.userContent).toContain('priorExecution');
      expect(request.userContent).toContain('not current execution');
      return reply({ approved: true, reasoning: 'Baseline and final observations inspected' });
    });
    const result = await superviseLoop(new ReviewingParent(), child, { description: 'Reproduce then repair' }, runCtx,
      { applyByScope: async c => c, branchOnEscalation: async () => {} });
    expect(result.evidence?.filter(w => w.source === 'transport-observed').map(w => w.eventId)).not.toContain(baseline);
    expect(result.historicalEvidenceIds).toEqual([baseline]);
    expect(attestations.forAttempt(1)).toHaveLength(2);
    expect(ctx.llm.calls.filter(call => call.role === 'execute')).toHaveLength(2);
  });
  it('rejects unknown, stale-attempt and source-read references, and never scans unrelated siblings', async () => {
    const ctx = { ...makeCtx(), attestations: createAttestationLog(), attempt: 2 };
    const executor = attestingExecutor({ has: () => true, execute: async () => ({ exitCode: 0, stdout: 'private sibling' }) }, ctx.attestations, 'sibling', undefined, 2)!;
    await executor.execute('run_shell', { cmd: 'private' });
    const sibling = ctx.attestations.forAttempt(2)[0]!;
    ctx.attestations.append({ ...sibling, eventId: 'old-attempt', attempt: 1 });
    ctx.attestations.append({ ...sibling, eventId: 'source-read', tool: 'read_file' });
    ctx.attestations.append({ ...sibling, eventId: 'before-restart', historical: true });
    expect(historicalExecutionRecords(ctx, ['unknown', 'old-attempt', 'source-read', 'before-restart'])).toEqual([]);
    ctx.llm.enqueue(request => {
      expect(request.userContent).not.toContain(sibling.eventId);
      expect(request.userContent).not.toContain('private sibling');
      return reply({ approved: false, reasoning: 'No evidence supplied' });
    });
    await llmVerdict({ ctx, model: 'mock', supervisorName: 'Root', supervisorTier: 3,
      subject: 'RESULT', child: new RetryChild({ name: 'Methane', ordinal: 1, systemPrompt: 'x', tools: [], params: {} }),
      task: { description: 'Review a different sibling' }, payload: {}, evidence: [], historicalEvidenceIds: ['unknown', 'old-attempt', 'source-read', 'before-restart'], groundTruthBlock: '' });
  });

  it('offers complete redirected logs beside a prior success without masking the current failure', async () => {
    const ctx = { ...makeCtx(), attestations: createAttestationLog(), attempt: 1, currentBranchId: 'final' };
    const log = archiveToolEvidence({ path: 'check.log' }, { content: 'RECOVERED_BASELINE_LOG' });
    const old = attestingExecutor({ has: () => true, execute: async () => ({ exitCode: 0, stdout: 'old green',
      capturedCommandLogs: { directory: 'logs', omitted: [], files: [{ path: 'check.log', bytes: log.bytes, sha256: log.sha256, evidence: log }] } }) }, ctx.attestations, 'prior', undefined, 1)!;
    await old.execute('run_shell', { cmd: 'old check' });
    const id = ctx.attestations.forAttempt(1)[0]!.eventId;
    const current = attestingExecutor({ has: () => true, execute: async () => ({ exitCode: 1, stdout: 'CURRENT_FAILED' }) }, ctx.attestations, 'final', undefined, 1)!;
    await current.execute('run_shell', { cmd: 'final check' });
    const evidence = executorEvidence({}, ctx);
    ctx.llm.enqueue(request => {
      const fresh = request.userContent.slice(request.userContent.indexOf('== TRANSPORT-OBSERVED TOOL EVIDENCE =='), request.userContent.indexOf('== RECORDED EVIDENCE READING =='));
      expect(fresh).toContain('CURRENT_FAILED');
      expect(fresh).not.toContain('old green');
      expect(request.userContent).toContain(`${id}:log:0`);
      return reply({ readEvidence: [{ eventId: `${id}:log:0`, offset: 0, length: 1000 }] });
    });
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('RECOVERED_BASELINE_LOG');
      expect(request.userContent).toContain('priorExecution');
      return reply({ approved: false, reasoning: 'Current check fails; an old pass does not prove the final state' });
    });
    const verdict = await llmVerdict({ ctx, model: 'mock', supervisorName: 'Root', supervisorTier: 3,
      subject: 'RESULT', child: new RetryChild({ name: 'Methane', ordinal: 1, systemPrompt: 'x', tools: [], params: {} }),
      task: { description: 'Review final repair' }, payload: {}, evidence, historicalEvidenceIds: [id, id], groundTruthBlock: '' });
    expect(verdict.approved).toBe(false);
    expect(evidence).toHaveLength(1);
    const result = { output: '', summary: '', evidence, historicalEvidenceIds: [id], trace: [], producedBy: { tier: 2 as const, name: 'Cell', viaFallback: false } };
    const kept = keptWithoutSynthesis([result, result], result.producedBy, 'provider unavailable');
    expect(kept.historicalEvidenceIds).toEqual([id]);
    expect(kept.evidence).toHaveLength(2);
  });

});
