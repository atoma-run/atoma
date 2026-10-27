import { Tiktoken } from 'js-tiktoken/lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestingExecutor, createAttestationLog } from '../src/core/attestation.js';
import { archiveToolEvidence, readArchivedToolEvidence } from '../src/core/evidenceArchive.js';
import { modelContextWindow, reviewContextBudget, estimateTextTokens } from '../src/core/contextBudget.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { archiveHostFileRead, MAX_EVIDENCE_READ_ROUNDS } from '../src/atoms/evidenceReading.js';
import { criteriaFilesBlock } from '../src/atoms/fileEvidence.js';
import { decisionsOfTrace } from '../src/atoms/jevCalibration.js';
import { jevApproval } from '../src/atoms/cost.js';
import { modelForTier } from '../src/core/models.js';
import { acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { reviewAcceptanceCriteria } from '../src/atoms/criteriaReview.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { llmVerdict, VALIDATION_SYSTEM_PROMPT } from '../src/atoms/verdict.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { jsonText, makeCtx } from './helpers.js';
import type { AttestationRecord } from '../src/contracts/attestation.js';
import type { LlmCompletionResponse, RunContext } from '../src/core/types.js';

afterEach(() => vi.unstubAllEnvs());
const reply = (value: unknown): LlmCompletionResponse => ({ text: jsonText(value), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
const child = () => new L1Atom({ name: 'Methane', ordinal: 1, systemPrompt: 'Verify', params: {}, tools: [] });
function review(ctx: RunContext, evidence: ReturnType<typeof executorEvidence>) {
  return llmVerdict({ ctx, model: 'mock', supervisorName: 'Cell', supervisorTier: 2, child: child(),
    subject: 'RESULT', task: { description: 'Judge the actual assertions and observed outcome.' },
    payload: { output: 'Child report', summary: 'The child claims success.' }, evidence, groundTruthBlock: '' });
}

describe('complete evidence retained at the production executor seam', () => {
  it('preserves more than 200k characters, snapshots mutable objects and survives persisted trace serialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-full-evidence-'));
    const recorder = new TraceRecorder(dir);
    try {
      const run = recorder.beginRun({ description: 'Complete evidence' });
      const log = createAttestationLog(record => recorder.recordAttestation(record));
      const result = { exitCode: 1, stdout: 'a'.repeat(100_000) + 'ASSERTION_IN_THE_MIDDLE_é' + 'z'.repeat(110_000) };
      const request = { cmd: 'node meaningful.test.ts' };
      await attestingExecutor({ has: () => true, execute: async () => result }, log, 'left', undefined, 1)!.execute('run_shell', request);
      result.stdout = 'mutated after observation'; request.cmd = 'changed';
      recorder.endRun({});
      const saved = JSON.parse(readFileSync(join(dir, `${run.id}.json`), 'utf8')) as { attestations: Array<{ fullEvidence: ReturnType<typeof archiveToolEvidence> }> };
      const original = JSON.parse(readArchivedToolEvidence(saved.attestations[0]!.fullEvidence)) as { request: { cmd: string }; result: { stdout: string; exitCode: number } };
      expect(original.request.cmd).toBe('node meaningful.test.ts');
      expect(original.result.stdout.length).toBeGreaterThan(200_000);
      expect(original.result.stdout).toContain('ASSERTION_IN_THE_MIDDLE_é');
      expect(original.result.exitCode).toBe(1);
      expect(readArchivedToolEvidence(saved.attestations[0]!.fullEvidence)).toBe(readArchivedToolEvidence(log.forAttempt(1)[0]!.fullEvidence!));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('detects corruption instead of presenting damaged bytes as observed evidence', () => {
    const snapshot = archiveToolEvidence({ cmd: 'test' }, { stdout: 'proof' });
    expect(() => readArchivedToolEvidence({ ...snapshot, sha256: '0'.repeat(64) })).toThrow('integrity');
  });
});

describe('validator reading protocol', () => {
  it('requests a middle assertion absent from both 24k and 48k excerpts, without replaying any element', async () => {
    vi.stubEnv('ATOMA_MODEL_CONTEXT_WINDOWS', JSON.stringify({ mock: 150000 }));
    const ctx = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations: createAttestationLog() };
    const execute = vi.fn(async () => ({ exitCode: 1, stdout: 'a'.repeat(90_000) + 'REAL_FAILURE_ASSERTION' + 'z'.repeat(90_000) }));
    await attestingExecutor({ has: () => true, execute }, ctx.attestations, 'left', undefined, 1)!.execute('run_shell', { cmd: 'node verify.ts' });
    const record = ctx.attestations.forAttempt(1)[0]!;
    ctx.llm.enqueue(request => {
      expect(request.tools).toBeUndefined(); expect(request.executor).toBeUndefined();
      expect(request.userContent).not.toContain('REAL_FAILURE_ASSERTION');
      return reply({ readEvidence: [{ eventId: record.eventId, find: 'REAL_FAILURE_ASSERTION', length: 200 }] });
    });
    ctx.llm.enqueue(request => {
      expect(request.tools).toBeUndefined(); expect(request.executor).toBeUndefined();
      expect(request.userContent).toContain('REAL_FAILURE_ASSERTION');
      expect(request.userContent).toContain('"fullArchive":true');
      expect(estimateTextTokens(request.systemPrompt) + estimateTextTokens(request.userContent)).toBeLessThan(150000 - 2048);
      return reply({ approved: false, reasoning: 'The recorded assertion failed.' });
    });
    expect(await review(ctx, executorEvidence({}, ctx))).toMatchObject({ approved: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('offers full host source snapshots while keeping them separate from worker execution evidence', async () => {
    const ctx = { ...makeCtx(), attestations: createAttestationLog(), currentBranchId: 'left', attempt: 1,
      tools: { has: (name: string) => name === 'read_file', execute: async () => ({ content: 'x'.repeat(96_001) + 'FULL_HOST_ASSERTION' }) } };
    const initial = await criteriaFilesBlock(ctx, [], ['tests/full.test.ts'], '');
    expect(initial).not.toContain('FULL_HOST_ASSERTION');
    const records = ctx.attestations.forBranch('host-review:left:1');
    expect(executorEvidence({}, ctx)).toEqual([]);
    ctx.llm.enqueue(reply({ readEvidence: [{ eventId: records[0]!.eventId, offset: 96000, length: 500 }] }));
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('FULL_HOST_ASSERTION');
      expect(request.userContent).toContain('host_read_file');
      return reply({ approved: false, reasoning: 'Source is not test execution.' });
    });
    expect(await review(ctx, [])).toMatchObject({ approved: false });
  });

  it.each([false, true])('keeps superseded source archived but out of current judgement (restored=%s)', async restored => {
    const prior = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations: createAttestationLog() };
    await attestingExecutor({ has: () => true, execute: async () => ({ content: 'OBSOLETE_SOURCE_BODY' }) }, prior.attestations, 'left', undefined, 1)!.execute('read_file', { path: 'README.md' });
    const witnesses = executorEvidence({}, prior);
    if (!restored) archiveHostFileRead(prior, 'README.md', { content: 'OBSOLETE_HOST_BODY' });
    const historic = prior.attestations.forAttempt(1);
    const old = restored ? historic[0]! : historic.at(-1)!;
    const ctx = restored ? { ...prior, attestations: createAttestationLog(undefined, historic) } : prior;
    await attestingExecutor({ has: () => true, execute: async () => ({ ok: true }) }, ctx.attestations, 'left', undefined, 1)!.execute('write_file', { path: 'README.md', content: 'NEW_SOURCE' });
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('"stale":true');
      return reply({ readEvidence: [{ eventId: old.eventId }] });
    });
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('obsolete source bytes are retained');
      expect(request.userContent).not.toContain('OBSOLETE_HOST_BODY');
      expect(request.userContent).not.toContain('OBSOLETE_SOURCE_BODY');
      const pages = request.userContent.split('\n').filter(line => line.startsWith('{"eventId":'));
      expect(pages.join('')).not.toContain('OBSOLETE_SOURCE_BODY');
      return reply({ approved: false, reasoning: 'Source changed.' });
    });
    await review(ctx, [...witnesses, ...executorEvidence({}, ctx)]);
    expect(readArchivedToolEvidence(old.fullEvidence!)).toContain(restored ? 'OBSOLETE_SOURCE_BODY' : 'OBSOLETE_HOST_BODY');
  });

  it('keeps an earlier write body archived but omits its obsolete source after a later edit', async () => {
    const ctx = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations: createAttestationLog() };
    const tools = attestingExecutor({ has: () => true, execute: async () => ({ ok: true }) }, ctx.attestations, 'left', undefined, 1)!;
    await tools.execute('write_file', { path: 'index.ts', content: 'OBSOLETE_WRITE_BODY' });
    const old = ctx.attestations.forAttempt(1)[0]!;
    await tools.execute('edit_file', { path: './index.ts', old_string: 'OBSOLETE_WRITE_BODY', new_string: 'current' });
    ctx.llm.enqueue(reply({ readEvidence: [{ eventId: old.eventId }] }));
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('obsolete source bytes are retained');
      expect(request.userContent).not.toContain('OBSOLETE_WRITE_BODY');
      return reply({ approved: false, reasoning: 'Only current source can establish the static property.' });
    });
    await review(ctx, executorEvidence({}, ctx));
    expect(readArchivedToolEvidence(old.fullEvidence!)).toContain('OBSOLETE_WRITE_BODY');
  });

  it('does not revive a previous host snapshot when the current refresh fails', async () => {
    const ctx = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations: createAttestationLog(),
      tools: { has: () => true, execute: async () => { throw new Error('read unavailable'); } } };
    archiveHostFileRead(ctx, 'README.md', { content: 'OLD_HOST_ONLY' });
    const old = ctx.attestations.forBranch('host-review:left:1')[0]!;
    await criteriaFilesBlock(ctx, [], ['README.md'], '');
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('"unavailable":true');
      expect(request.userContent).not.toContain('OLD_HOST_ONLY');
      return reply({ readEvidence: [{ eventId: old.eventId }] });
    });
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('Not in this review inventory');
      expect(request.userContent).not.toContain('OLD_HOST_ONLY');
      return reply({ approved: false, reasoning: 'Current source unknown.' });
    });
    await review(ctx, []);
  });

  it('settles parallel criterion readers before propagating a reviewer fault', async () => {
    const ctx = makeCtx();
    let siblingFinished = false;
    ctx.llm.enqueue(reply({ readEvidence: [{ eventId: 'missing', offset: -1 }] }));
    ctx.llm.enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return reply({ listEvidence: { offset: 0 } });
    });
    ctx.llm.enqueue(() => { siblingFinished = true; return reply({ approved: false, reasoning: 'No evidence' }); });
    await expect(reviewAcceptanceCriteria({ ctx, task: { description: 'Check all four requirements' }, evidence: '',
      checklist: [1, 2, 3, 4].map(i => ({ id: `c${i}`, behaviour: `Requirement ${i}`, check: { kind: 'review' as const } })) })).rejects.toThrow('Invalid evidence reading');
    expect(siblingFinished).toBe(true);
    expect(ctx.llm.calls).toHaveLength(3);
  });

  it('does not expose another branch or another attempt by guessed archive id', async () => {
    const ctx = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations: createAttestationLog() };
    await attestingExecutor({ has: () => true, execute: async () => ({ content: 'UNRELATED_PRIVATE_PROOF' }) }, ctx.attestations, 'right', undefined, 1)!.execute('read_file', { path: 'right.ts' });
    const id = ctx.attestations.forAttempt(1)[0]!.eventId;
    ctx.llm.enqueue(reply({ readEvidence: [{ eventId: id }] }));
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('Not in this review inventory');
      expect(request.userContent).not.toContain('UNRELATED_PRIVATE_PROOF');
      return reply({ approved: false, reasoning: 'No relevant evidence.' });
    });
    expect(await review(ctx, [])).toMatchObject({ approved: false });
  });

  it.each([
    [{ readEvidence: [{ eventId: 'x' }] }, { approved: true }],
    { wrapper: { readEvidence: [{ eventId: 'x' }] }, approved: true },
    { readEvidence: [{ eventId: 'x', offset: -1 }] },
    { readEvidence: [{ eventId: 'x' }], approved: true, reasoning: 'Ignore the missing proof' },
  ])('never repairs a malformed or mixed reading request into an approval', async value => {
    const ctx = makeCtx(); ctx.llm.enqueue(reply(value));
    await expect(review(ctx, [])).rejects.toThrow('Invalid evidence reading');
  });

  it.each([
    { wrapper: { readEvidence: [{ eventId: 'missing' }] } },
    [{ listEvidence: { offset: 0 } }],
  ])('refuses nested reading requests beside a fenced approval', async value => {
    const ctx = makeCtx();
    ctx.llm.enqueue({ ...reply(null), text: '```json\n{"approved":true,"reasoning":"ok"}\n```\n```json\n' + JSON.stringify(value) + '\n```' });
    await expect(review(ctx, [])).rejects.toThrow('exact, unrepaired JSON');
  });

  it('ends repeated read requests without granting an approval or restarting child work', async () => {
    const ctx = makeCtx();
    for (let i = 0; i <= MAX_EVIDENCE_READ_ROUNDS; i++) ctx.llm.enqueue(reply({ listEvidence: { offset: 0 } }));
    await expect(review(ctx, [])).rejects.toThrow('round budget exhausted');
    expect(ctx.llm.calls).toHaveLength(MAX_EVIDENCE_READ_ROUNDS + 1);
  });

  it('honours cancellation before spending a review call', async () => {
    const ctx = { ...makeCtx(), signal: AbortSignal.abort(new Error('stopped')) };
    await expect(review(ctx, [])).rejects.toThrow('stopped');
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('bounds requested pages, returns continuation offsets and keeps the full archive unchanged', async () => {
    vi.stubEnv('ATOMA_MODEL_CONTEXT_WINDOWS', JSON.stringify({ mock: 100000 }));
    const ctx = { ...makeCtx(), attestations: createAttestationLog(), currentBranchId: 'left', attempt: 1 };
    archiveHostFileRead(ctx, 'large.ts', { content: '😀\n"'.repeat(60000) });
    const record = ctx.attestations.forBranch('host-review:left:1')[0]!;
    const original = record.fullEvidence!.sha256;
    ctx.llm.enqueue(reply({ readEvidence: [{ eventId: record.eventId, length: 1_000_000 }] }));
    ctx.llm.enqueue(request => {
      expect(estimateTextTokens(request.userContent) + estimateTextTokens(request.systemPrompt)).toBeLessThan(100000 - 2048);
      const page = request.userContent.split('\n').filter(line => line.startsWith('{"eventId":')).map(line => JSON.parse(line) as { nextOffset: number; totalChars: number }).at(-1)!;
      expect(page.nextOffset).toBeGreaterThan(0);
      expect(page.nextOffset).toBeLessThan(page.totalChars);
      return reply({ readEvidence: [{ eventId: record.eventId, offset: page.nextOffset, length: 100 }] });
    });
    ctx.llm.enqueue(reply({ approved: false, reasoning: 'Reading these bytes alone establishes no executed behavior.' }));
    expect(await review(ctx, [])).toMatchObject({ approved: false });
    expect(record.fullEvidence!.sha256).toBe(original);
    expect(ctx.attestations.size).toBe(1);
  });

  it('keeps reading turns out of the Decision calibration verdict corpus', () => {
    const metadata = { kind: 'llm', role: 'validate-result', actor: { name: 'Cell', tier: 2 }, userContent: 'Review' };
    const trace = { events: [{ ...metadata, id: 'read', response: jsonText({ readEvidence: [{ eventId: 'proof' }] }) },
      { ...metadata, id: 'final', response: jsonText({ approved: false, reasoning: 'Failed assertion' }) }] };
    expect(decisionsOfTrace(trace, { runId: 'r', orgId: 'o' }).decisions.map(value => value.eventId)).toEqual(['final']);
  });

  it('also gives the independent criterion validator access to complete worker evidence', async () => {
    const ctx = { ...makeCtx(), attestations: createAttestationLog(), currentBranchId: 'left', attempt: 1 };
    archiveHostFileRead(ctx, 'fixture.ts', { content: 'SOURCE_ASSERTION' });
    const record = ctx.attestations.forBranch('host-review:left:1')[0]!;
    ctx.llm.enqueue(reply({ readEvidence: [{ eventId: record.eventId }] }));
    ctx.llm.enqueue(request => {
      expect(request.userContent).toContain('SOURCE_ASSERTION');
      return reply({ approved: false, reasoning: 'No execution proof.', criteria: [{ id: 'c1', met: false, reason: 'Only source was recorded.' }] });
    });
    const verdict = await reviewAcceptanceCriteria({ ctx, task: { description: 'Execute the required check' },
      checklist: [{ id: 'c1', behaviour: 'The required check executes', check: { kind: 'review' } }], evidence: 'Host review context' });
    expect(verdict.approved).toBe(false);
  });

  it('defers Decision approval when its receipt cannot show the complete archived body', async () => {
    const approve = vi.fn();
    const ctx = { ...makeCtx(), attestations: createAttestationLog(), currentBranchId: 'left', attempt: 1,
      jev: { choose: vi.fn(), approve, twin: vi.fn() } };
    await attestingExecutor({ has: () => true, execute: async () => ({ exitCode: 0, stdout: 'a'.repeat(50000) }) }, ctx.attestations, 'left', undefined, 1)!.execute('run_shell', { cmd: 'check' });
    expect(await jevApproval({ ctx, subject: 'RESULT', supervisorName: 'Cell', supervisorTier: 2, child: child(),
      task: { description: 'Check' }, payload: {}, evidence: executorEvidence({}, ctx) })).toBeNull();
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('model context budgets', () => {
  it('uses transport-specific verified capabilities and reserves prompt, response and headroom', () => {
    expect(modelContextWindow('own:openai:gpt-5.6-luna')).toMatchObject({ tokens: 272000, verified: true });
    expect(modelContextWindow('api:openai:gpt-5.6-luna').verified).toBe(false);
    expect(modelContextWindow('api:ollama:custom', { OLLAMA_CONTEXT_LENGTH: '4096' }).tokens).toBe(32768);
    expect(modelContextWindow('api:ollama:custom', { OLLAMA_CONTEXT_LENGTH: 'invalid' }).tokens).toBe(32768);
    vi.stubEnv('ATOMA_MODEL_CONTEXT_WINDOWS', JSON.stringify({ small: 10000, large: 20000 }));
    const small = reviewContextBudget('small', 'system', 'base', 2000);
    const large = reviewContextBudget('large', 'system', 'base', 2000);
    expect(small.evidenceTokens).toBe(10000 - 1500 - 2000 - estimateTextTokens('system') - estimateTextTokens('base'));
    expect(large.evidenceTokens).toBe(20000 - 3000 - 2000 - estimateTextTokens('system') - estimateTextTokens('base'));
    expect(estimateTextTokens('é')).toBe(1);
    expect(estimateTextTokens(VALIDATION_SYSTEM_PROMPT)).toBeGreaterThan(0);
  });

  it('budgets root previews and pre-rendered criterion evidence from the run snapshot', async () => {
    const ctx = { ...makeCtx(), currentBranchId: 'left', attempt: 1, attestations: createAttestationLog(),
      modelContextEnv: { ATOMA_MODEL_CONTEXT_WINDOWS: JSON.stringify({ [modelForTier(1)]: 32768 }) } };
    const tools = attestingExecutor({ has: () => true, execute: async () => ({ exitCode: 0,
      stdout: Array.from({ length: 1600 }, (_, i) => String.fromCharCode(0x800 + i)).join('') }) }, ctx.attestations, 'left', undefined, 1)!;
    for (let i = 0; i < 120; i++) await tools.execute('run_shell', { cmd: `verify-case-${i}` });
    for (let i = 0; i < 2; i++) ctx.llm.enqueue(request => {
      expect(estimateTextTokens(request.systemPrompt) + estimateTextTokens(request.userContent)).toBeLessThan(32768 - 2048);
      return reply({ approved: true, reasoning: 'The supplied observations support the required output.',
        criteria: [{ id: 'c1', met: true, reason: 'Captured assertions support the output.' }] });
    });
    const accepted = await acceptRootResult({ ctx, actor: child(), task: { description: 'Verify the generated output.' },
      result: { output: {}, summary: 'Work completed', evidence: executorEvidence({}, ctx), trace: [],
        producedBy: { name: 'Methane', tier: 1, viaFallback: false } },
      floor: [], phaseCoverage: [], checklistOrigin: { source: 'user' },
      checklist: [{ id: 'c1', behaviour: 'The output satisfies the supplied assertions.', check: { kind: 'review' } }] });
    expect(accepted.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('archives dense pre-rendered context and reads the middle without dropping original criteria', async () => {
    const archived: AttestationRecord[] = [];
    const dense = Array.from({ length: 2048 }, (_, i) => String.fromCharCode(0x800 + i)).join('');
    const middle = 'DENSE_CONTEXT_MIDDLE_ASSERTION';
    const evidence = dense.repeat(25) + middle + dense.repeat(25);
    const base = { ...makeCtx(), attestations: createAttestationLog(), recordEvidenceSnapshot: (record: AttestationRecord) => archived.push(record),
      modelContextEnv: { ATOMA_MODEL_CONTEXT_WINDOWS: JSON.stringify({ [modelForTier(1)]: 32768 }) } };
    const ctx = forkBranch(forkBranch(base, 'parent'), 'review');
    base.llm.enqueue(request => {
      expect(request.userContent).toContain('INCOMPLETE HOST CONTEXT PREVIEW');
      expect(request.userContent).toContain('ORIGINAL_CRITERION_REQUIRED');
      expect(request.userContent).not.toContain(middle);
      expect(estimateTextTokens(request.systemPrompt) + estimateTextTokens(request.userContent)).toBeLessThan(32768 - 2048);
      const inventory = request.userContent.split('\n').filter(line => line.startsWith('{"inventory":'))
        .flatMap(line => (JSON.parse(line) as { inventory: Array<{ eventId: string; tool: string }> }).inventory);
      const entry = inventory.find(item => item.tool === 'host_review_context')!;
      return reply({ readEvidence: [{ eventId: entry.eventId, find: middle, length: 200 }] });
    });
    base.llm.enqueue(request => {
      expect(request.userContent).toContain(middle);
      expect(request.userContent).toContain('ORIGINAL_CRITERION_REQUIRED');
      expect(estimateTextTokens(request.systemPrompt) + estimateTextTokens(request.userContent)).toBeLessThan(32768 - 2048);
      return reply({ approved: false, reasoning: 'The requested recorded assertion is insufficient.',
        criteria: [{ id: 'c1', met: false, reason: 'The recorded assertion does not establish the original criterion.' }] });
    });
    const reviewed = await reviewAcceptanceCriteria({ ctx, task: { description: 'Review only the original criterion.' }, evidence,
      checklist: [{ id: 'c1', behaviour: 'ORIGINAL_CRITERION_REQUIRED', check: { kind: 'review' } }] });
    expect(reviewed.approved).toBe(false);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.fullEvidence!.bytes).toBeGreaterThan(200000);
    expect(readArchivedToolEvidence(archived[0]!.fullEvidence!)).toContain(evidence);
    expect(base.attestations.size).toBe(0);
    expect(base.llm.calls).toHaveLength(2);
  });

  it('uses the captured provider capacity through nested forks, ignoring changed ambient configuration', async () => {
    vi.stubEnv('ATOMA_MODEL_CONTEXT_WINDOWS', JSON.stringify({ mock: 200000 }));
    const base = { ...makeCtx(), modelContextEnv: Object.freeze({ ATOMA_MODEL_CONTEXT_WINDOWS: JSON.stringify({ mock: 4096 }) }) };
    const ctx = forkBranch(forkBranch(base, 'parent'), 'child');
    await expect(review(ctx, [])).rejects.toThrow('cannot fit');
    expect(base.llm.calls).toHaveLength(0);
    expect(reviewContextBudget('mock', 's', 'task', 1000, { ATOMA_MODEL_CONTEXT_WINDOWS: '{"mock":10000}' }).capacity.tokens).toBe(10000);
  });

  it('counts long unbroken output and Unicode across bounded tokenizer chunks', () => {
    expect(estimateTextTokens('x'.repeat(20000))).toBeGreaterThan(0);
    expect(estimateTextTokens('x'.repeat(20000))).toBeLessThan(20000);
    expect(estimateTextTokens('a'.repeat(511) + '😀'.repeat(1000))).toBeGreaterThan(1000);
    expect(estimateTextTokens('<|endoftext|>')).toBeGreaterThan(0);
  });

  it('counts repetitive proof without repeating identical BPE work or caching across calls', () => {
    const chunk = ' '.repeat(512);
    const unit = estimateTextTokens(chunk);
    const encode = vi.spyOn(Tiktoken.prototype, 'encode');
    try {
      expect(estimateTextTokens(chunk.repeat(2000))).toBe(unit * 2000);
      expect(encode).toHaveBeenCalledTimes(1);
      expect(estimateTextTokens(chunk)).toBe(unit);
      expect(encode).toHaveBeenCalledTimes(2);
    } finally { encode.mockRestore(); }
  });

  it('refuses a context which cannot fit the review before calling the model', async () => {
    vi.stubEnv('ATOMA_MODEL_CONTEXT_WINDOWS', JSON.stringify({ mock: 4096 }));
    const ctx = makeCtx();
    await expect(review(ctx, [])).rejects.toThrow('cannot fit');
    expect(ctx.llm.calls).toHaveLength(0);
  });
});
