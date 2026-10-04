import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Atom, type Supervisor } from '../src/core/atom.js';
import { createAttestationLog, attestingExecutor } from '../src/core/attestation.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { superviseLoop } from '../src/core/supervisor.js';
import type { Plan, Result, RunContext, Task, Tier, ToolExecutor, Verdict } from '../src/core/types.js';
import { modelForTier } from '../src/core/models.js';
import { rootProofCoverage, acceptRootResult } from '../src/atoms/rootAcceptance.js';
import { executorEvidence } from '../src/atoms/executorEvidence.js';
import { dispatchWithAggregation, markLanded } from '../src/atoms/dispatch.js';
import { NON_JSON_PAYLOAD_SUMMARY_PREFIX } from '../src/atoms/json.js';
import { buildResultGateEnv, runResultGates } from '../src/atoms/resultGates.js';
import { PROBE_MANIFEST_FILENAME } from '../src/contracts/probeManifest.js';
import { runDepthTask, MAX_ROOT_REMEDIATIONS, remediationTask } from '../src/run/depth.js';
import { landingReasons } from '../src/contracts/runLanding.js';
import type { InheritedChecksReport, ListedCheck } from '../src/contracts/inheritedChecks.js';
import { snapshotDeliveredWorkspace, snapshotStartingWorkspace } from '../src/run/workspace.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { TEXT_VERIFICATION_GUIDANCE } from '../src/contracts/taskExecution.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptanceSchema, type AcceptanceInfo, type PhaseCoverageRecord, type TopologyInfo } from '../src/contracts/depthRouting.js';
import { makeCtx, jsonText } from './helpers.js';
import { makePlan, makeTools } from './helpers/factories.js';
import { serverCodeDigest } from '../src/contracts/serverDigest.js';

const task: Task = { description: 'Build the page' };
const floor = [{ obligation: 'dom-interaction' as const, deliverable: 'index.html' }];
const result: Result = { output: { complete: true }, summary: 'Done', trace: [], producedBy: { tier: 1, name: 'leaf', viaFallback: false } };
class Executor implements ToolExecutor {
  files: Record<string, string> = { 'index.html': '<button>Click</button>' };
  has(name: string) { return ['read_file', 'validate_html'].includes(name); }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const path = typeof args['path'] === 'string' ? args['path'] : 'index.html';
    if (name === 'read_file') {
      if (!(path in this.files)) throw new Error('ENOENT');
      return { content: this.files[path] };
    }
    return { ok: true, url: 'http://localhost:5050/', errors: [], warnings: [], failedRequests: [],
      interactionLog: ['click button'], requestedInteractions: 1, ignoredInteractions: 0,
      document: { path, sha256: createHash('sha256').update(this.files[path]!).digest('hex') } };
  }
}
class Actor extends Atom implements Supervisor<Actor> {
  readonly model = 'test';
  fallbackExecutions = 0;
  plans = 0;
  constructor(readonly tier: Tier = 2, readonly reject = false, toolNames = ['read_file', 'validate_html']) {
    super({ name: `actor-${tier}`, ordinal: 1, systemPrompt: '', tools: makeTools(toolNames), params: {} });
  }
  async plan(): Promise<Plan> { this.plans++; return makePlan(); }
  async execute(): Promise<Result> {
    if (this.isFallbackMode()) this.fallbackExecutions++;
    return { ...result, producedBy: { name: this.name, tier: this.tier, viaFallback: this.isFallbackMode() } };
  }
  async validatePlan(): Promise<Verdict> {
    return this.reject ? { approved: false, reasoning: 'fixture verdict', scope: 'ephemeral', modifications: {} }
      : { approved: true, reasoning: 'fixture verdict' };
  }
  async validateResult(): Promise<Verdict> { return this.validatePlan(); }
}
function context(executor = new Executor()) {
  return { ...makeCtx(), tools: executor, attempt: 1, attestations: createAttestationLog() };
}
async function observe(ctx: RunContext, branch = 'descendant', path = 'index.html') {
  const fork = forkBranch(forkBranch(ctx, 'ancestor'), branch);
  await fork.tools!.execute('validate_html', { path });
}

describe('standing HTTP evidence at root acceptance (owner decision 2026-10-04)', () => {
  const server = "import { route } from './lib/routes.js';\nroute();\n";
  const routes = 'export function route() { return 200; }\n';
  const pkg = JSON.stringify({ scripts: { start: 'node server.js' } });
  const accept = async (files: Record<string, string>, recordedDigest: string, observe?: (ctx: RunContext) => Promise<void>) => {
    const executor = new Executor();
    executor.files = { ...files };
    const ctx = { ...context(executor), standingHttpEvidence: [{ runId: 'seed-run', eventId: 'e-404', method: 'POST',
      path: '/api/loans', status: 404, entry: 'server.js', codeDigest: recordedDigest }] };
    await observe?.(ctx);
    let prompt = '';
    ctx.llm.enqueue((req) => {
      prompt = req.userContent;
      return { text: jsonText({ approved: true, reasoning: 'met', criteria: [{ id: 'c1', met: true }] }),
        stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const accepted = await acceptRootResult({ actor: new Actor(3, false, []), task: { description: 'Build the API.' },
      result, ctx, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c1', behaviour: 'unknown book refused', check: { kind: 'http', method: 'POST', path: '/api/loans', status: 404 } }],
      checklistOrigin: { source: 'user' } });
    return { accepted, prompt };
  };

  it('covers an unobserved HTTP item with a host-recorded probe of the seed lineage while the server code is unchanged', async () => {
    const files = { 'server.js': server, 'lib/routes.js': routes, 'package.json': pkg };
    const digest = (await serverCodeDigest('server.js', (path) => files[path as keyof typeof files]))!;
    const { accepted, prompt } = await accept(files, digest);
    expect(accepted.checklist?.[0]).toMatchObject({ status: 'covered', observationRefs: ['standing:seed-run/e-404/server.js'] });
    expect(prompt).toContain('[RECORDED EARLIER] c1');
    expect(prompt).toContain('recorded by run seed-run against server.js');
  });

  it('does not count a file the delivery no longer runs', async () => {
    const files = { 'server.js': server, 'lib/routes.js': routes, 'package.json': JSON.stringify({ scripts: { start: 'node src/index.js' } }) };
    const digest = (await serverCodeDigest('server.js', (path) => files[path as keyof typeof files]))!;
    const { accepted } = await accept(files, digest);
    expect(accepted.checklist?.[0]).toMatchObject({ status: 'uncovered' });
  });

  it('lets what this attempt saw on the same route stand against what an earlier run recorded', async () => {
    const files = { 'server.js': server, 'lib/routes.js': routes, 'package.json': pkg };
    const digest = (await serverCodeDigest('server.js', (path) => files[path as keyof typeof files]))!;
    const { accepted } = await accept(files, digest, async (ctx) => {
      ctx.attestations!.append({ eventId: 'now-500', attempt: 1, tool: 'fetch_url',
        observation: { kind: 'execution', request: 'POST /api/loans', response: '500', http: { method: 'POST', path: '/api/loans', status: 500 } } } as never);
    });
    expect(accepted.checklist?.[0]).toMatchObject({ status: 'uncovered' });
  });

  it('does not count it once an imported module changed', async () => {
    const before = { 'server.js': server, 'lib/routes.js': routes, 'package.json': pkg };
    const digest = (await serverCodeDigest('server.js', (path) => before[path as keyof typeof before]))!;
    const { accepted, prompt } = await accept({ 'server.js': server, 'lib/routes.js': 'export function route() { return 500; }\n', 'package.json': pkg }, digest);
    expect(accepted.checklist?.[0]).toMatchObject({ status: 'uncovered', observationRefs: [] });
    expect(prompt).toContain('[NOT OBSERVED] c1');
  });
});

describe('root delivery coverage', () => {
  it('bounds refresh attempts even when every current read fails', async () => {
    let unavailable = false;
    let readAttempts = 0;
    const base: ToolExecutor = {
      has: (name) => ['read_file', 'write_file'].includes(name),
      execute: async (name) => {
        if (name === 'write_file') return { ok: true };
        readAttempts++;
        if (unavailable) throw new Error('unavailable');
        return { content: 'OBSOLETE_CONTENT' };
      },
    };
    const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
    const branch = forkBranch(ctx, 'phase');
    for (let index = 0; index < 6; index++) {
      await branch.tools!.execute('read_file', { path: `file-${index}.txt` });
      await branch.tools!.execute('write_file', { path: `file-${index}.txt` });
    }
    unavailable = true;
    readAttempts = 0;
    ctx.llm.enqueue(req => {
      expect(req.userContent).not.toContain('OBSOLETE_CONTENT');
      expect(req.userContent).toContain('2 further file reads omitted');
      return { text: jsonText({ approved: false, reasoning: 'Current content unavailable.', scope: 'ephemeral', modifications: {} }),
        stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await acceptRootResult({ actor: new Actor(3, false, []), task: { description: 'Repair documentation.' },
      result: { ...result, evidence: executorEvidence({}, branch) }, ctx, floor: [], phaseCoverage: [] });
    expect(readAttempts).toBe(4);
  });

  it.each(['same phase', 'later phase'])('replaces obsolete README evidence with current host reads: %s', async (scope) => {
    const old = 'Obsolete documentation: OLD_README_SENTINEL';
    const current = '# Dossier\n' + 'Background context.\n'.repeat(90) + '\nRegenerate the manifest:\npython3 verify_all.py --write-manifest\n';
    let content = old;
    const reads: string[] = [];
    const base: ToolExecutor = {
      has: (name) => ['read_file', 'edit_file'].includes(name),
      execute: async (name, args) => {
        if (name === 'edit_file') { content = String(args['new_string']); return { ok: true }; }
        reads.push(String(args['path']));
        return { content };
      },
    };
    const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
    const first = forkBranch(ctx, 'first');
    await first.tools!.execute('read_file', { path: './README.md' });
    // The first phase may already have frozen its witness before the edit.
    const earlyEvidence = executorEvidence({}, first);
    const writer = scope === 'same phase' ? first : forkBranch(ctx, 'second');
    await writer.tools!.execute('edit_file', { path: 'README.md', new_string: current });
    const evidence = scope === 'same phase' ? executorEvidence({}, first) : earlyEvidence;
    const logBefore = JSON.stringify(ctx.attestations.forAttempt(1));
    const readsBefore = reads.length;
    ctx.llm.enqueue(req => {
      expect(req.userContent).not.toContain('OLD_README_SENTINEL');
      expect(req.userContent).toContain('superseded read result omitted');
      expect(req.userContent).toContain('python3 verify_all.py --write-manifest');
      return { text: jsonText({ approved: true, reasoning: 'Current instructions are present.',
        criteria: [{ id: 'c1', met: true }] }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const accepted = await acceptRootResult({ actor: new Actor(3, false, []),
      task: { description: 'Explain how to regenerate the manifest with verify_all.py.' },
      result: { ...result, evidence }, ctx, floor: [], phaseCoverage: [],
      // Like run bcf35298: this criterion does NOT name README.
      checklist: [{ id: 'c1', behaviour: 'Instructions explain manifest regeneration.', check: { kind: 'review' } }],
      checklistOrigin: { source: 'user' },
    });
    expect(accepted.approved).toBe(true);
    expect(reads.slice(readsBefore)).toEqual(['README.md']);
    expect(ctx.llm.calls).toHaveLength(1);
    expect(JSON.stringify(ctx.attestations.forAttempt(1))).toBe(logBefore);
    expect(logBefore).toContain('OLD_README_SENTINEL');
  });

  it.each(['unreadable', 'still wrong'])('does not turn retired evidence into automatic acceptance: %s', async (state) => {
    let content = 'OLD_DOCUMENT_SENTINEL';
    let unavailable = false;
    const base: ToolExecutor = {
      has: (name) => ['read_file', 'write_file'].includes(name),
      execute: async (name) => {
        if (name === 'write_file') { content = 'CURRENT_DOCUMENT_STILL_WRONG'; return { ok: true }; }
        if (unavailable) throw new Error('read unavailable');
        return { content };
      },
    };
    const ctx = { ...makeCtx(), tools: base, attempt: 1, attestations: createAttestationLog() };
    const branch = forkBranch(ctx, 'phase');
    await branch.tools!.execute('read_file', { path: 'instructions.txt' });
    await branch.tools!.execute('write_file', { path: 'instructions.txt' });
    unavailable = state === 'unreadable';
    ctx.llm.enqueue(req => {
      expect(req.userContent).not.toContain('OLD_DOCUMENT_SENTINEL');
      expect(req.userContent).toContain(unavailable ? 'current read unavailable' : content);
      return { text: jsonText({ approved: false, reasoning: 'Correct current instructions have not been established.',
        scope: 'ephemeral', modifications: {} }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const accepted = await acceptRootResult({ actor: new Actor(3, false, []), task: { description: 'Repair instructions.' },
      result: { ...result, evidence: executorEvidence({}, branch) }, ctx, floor: [], phaseCoverage: [] });
    expect(accepted.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('reviews the actual text beside a false audit using independent textual-check guidance', async () => {
    const ctx = makeCtx();
    const output = readFileSync(new URL('./fixtures/poetry-false-audit.txt', import.meta.url), 'utf8');
    ctx.llm.enqueue(req => {
      expect(req.systemPrompt).toContain(TEXT_VERIFICATION_GUIDANCE);
      expect(req.userContent).toContain('HOST-COMPUTED LITERAL TEXT LAYOUT');
      expect(req.userContent).toContain('"lastShown":"welcome","complete":true');
      expect(req.userContent).toContain('"lastShown":"quietly","complete":true');
      expect(req.userContent).toContain('Hearts once lonely learn patient welcome');
      expect(req.userContent).toContain('Under warm stars, hope steadies quietly');
      expect(req.userContent).toContain('Stanza endings: thaw, sun, leaves, snow.');
      return { text: jsonText({ approved: false, reasoning: 'First two stanzas end welcome and quietly, not thaw and sun.', scope: 'ephemeral', modifications: {} }),
        stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    });
    const accepted = await acceptRootResult({ actor: new Actor(3, false, []),
      task: { description: 'Four stanza endings must be thaw, sun, leaves, snow.', executionMode: 'reasoning' },
      result: { ...result, output, summary: 'All constraints passed.' }, ctx, floor: [], phaseCoverage: [] });
    expect(accepted).toMatchObject({ approved: false, basis: 'validation-call' });
    expect(ctx.llm.calls).toHaveLength(1);
  });
  it('collects descendant evidence only once and carries attempt through nested forks', async () => {
    const ctx = context();
    const beforeFallback = vi.fn();
    const recordPhaseCoverage = vi.fn();
    const nested = forkBranch(forkBranch({ ...ctx, beforeFallback, recordPhaseCoverage }, 'a'), 'b');
    expect(nested.beforeFallback).toBe(beforeFallback);
    expect(nested.recordPhaseCoverage).toBe(recordPhaseCoverage);
    await nested.tools!.execute('validate_html', {});
    expect(ctx.attestations.forAttempt(1)).toHaveLength(1);
    expect(ctx.attestations.forAttempt(1)[0]).toMatchObject({ attempt: 1, branchId: 'b' });
    expect(await rootProofCoverage(ctx, floor)).toMatchObject([{ status: 'covered', observationRefs: [expect.any(String)] }]);
  });
  it.each(['sibling', 'mutated', 'abandoned', 'unbound', 'missing'] as const)('does not cover %s proof', async (kind) => {
    const ctx = context();
    ctx.tools.files['other.html'] = ctx.tools.files['index.html']!;
    await observe(ctx, 'branch', kind === 'sibling' ? 'other.html' : 'index.html');
    if (kind === 'mutated') ctx.tools.files['index.html'] = 'changed';
    if (kind === 'missing') delete ctx.tools.files['index.html'];
    if (kind === 'abandoned') ctx.attempt = 2;
    if (kind === 'unbound') {
      const record = ctx.attestations.forAttempt(1)[0]!;
      if (record.observation.kind !== 'browser') throw new Error('expected browser observation');
      const { document: _document, ...observation } = record.observation;
      ctx.attestations = createAttestationLog();
      ctx.attestations.append({ ...record, observation });
    }
    expect(await rootProofCoverage(ctx, floor)).toEqual([{ kind: 'dom-interaction', deliverable: 'index.html', status: 'uncovered', observationRefs: [] }]);
  });
  it('records direct fallback observations without a branch', async () => {
    const ctx = context();
    await attestingExecutor(ctx.tools, ctx.attestations, undefined, undefined, 2)!.execute('validate_html', {});
    expect(ctx.attestations.forAttempt(2)[0]).toMatchObject({ attempt: 2 });
    expect(ctx.attestations.forAttempt(2)[0]!.branchId).toBeUndefined();
    expect(await rootProofCoverage({ ...ctx, attempt: 2 }, floor)).toMatchObject([{ status: 'covered' }]);
  });
});

describe('one common root acceptance, independent of phase credit', () => {
  it('derives a blinded text reference before judging the complete candidate and checklist', async () => {
    const ctx = context();
    const codingTask: Task = { description: 'Define Hamming distance and compare 0111010 with 1001011.',
      inputs: { rootAcceptanceRefusal: 'candidate-contaminated-refusal', previousStepResult: 'candidate-contaminated-draft' } };
    ctx.llm.enqueue(req => {
      expect(req.actor?.name).toBe('run-text-reference');
      expect(req.userContent).toContain(codingTask.description);
      expect(req.userContent).not.toContain('candidate-contaminated');
      expect(req.userContent).not.toContain('self-approved-six');
      expect(req.tools).toBeUndefined();
      expect(req.executor).toBeUndefined();
      return { text: 'Definition: differing positions. Positions 1,2,3,7: count 4.', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    ctx.llm.enqueue(req => {
      expect(req.actor?.name).toBe('run-root');
      expect(req.userContent).toContain('self-approved-six');
      expect(req.userContent).toContain('Positions 1,2,3,7: count 4');
      expect(req.userContent).toContain('NOT ground-truth evidence');
      expect(req.userContent).toContain('Check omitted requirements');
      expect(req.userContent).toContain('A passage in the task, summary, historical answer or independent reference is NOT a passage in the deliverable');
      expect(req.userContent).toContain('even when every listed acceptance criterion is met');
      return { text: jsonText({ approved: false, reasoning: 'Distance is 4; definition missing.', criteria: [{ id: 'c1', met: false }] }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const accepted = await acceptRootResult({ actor: new Actor(3), task: codingTask,
      result: { ...result, output: 'The distance is 6.', summary: 'self-approved-six' }, delivery: 'text',
      ctx, floor: [], phaseCoverage: [], checklist: [{ id: 'c1', behaviour: 'Correct distance', check: { kind: 'review' } }],
      checklistOrigin: { source: 'user' } });
    expect(accepted.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(2);
  });

  it('keeps a text completeness refusal even when the narrower user checklist is satisfied', async () => {
    const ctx = context();
    ctx.llm.enqueueText('Required: define the measure, then calculate. Expected count: 4.');
    ctx.llm.enqueue(req => {
      expect(req.userContent.lastIndexOf('FINAL ROOT TEXT REVIEW')).toBeGreaterThan(req.userContent.lastIndexOf('INDEPENDENT TEXT REFERENCE'));
      expect(req.userContent).toContain('Required: define the measure');
      return { text: jsonText({ approved: false, reasoning: 'Calculation is correct; the requested definition is absent from the delivered output.',
        scope: 'ephemeral', modifications: { additionalContext: 'Add the requested definition; preserve the correct calculation.' },
        criteria: [{ id: 'c1', met: true, reason: 'Four differing positions are correctly counted.' }] }),
      stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const accepted = await acceptRootResult({ actor: new Actor(3), task: { description: 'Define the distance measure and calculate the distance.' },
      result: { ...result, output: 'The differing positions are 1, 2, 3, 7; distance 4.' }, delivery: 'text', ctx, floor: [], phaseCoverage: [],
      checklist: [{ id: 'c1', behaviour: 'Correct distance', check: { kind: 'review' } }], checklistOrigin: { source: 'user' } });
    expect(accepted.approved).toBe(false);
    expect(accepted.reasoning).toContain('definition is absent');
  });

  it.each(['text', 'files', undefined] as const)('routes the recorded %s delivery to the configured review tier', async (delivery) => {
    const ctx = context();
    if (delivery === 'text') ctx.llm.enqueueText('Independent reference');
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Reviewed actual evidence' }));
    await acceptRootResult({ actor: new Actor(3), task, result: { ...result, output: { delivery: 'text' } },
      ctx, floor: [], phaseCoverage: [], ...(delivery ? { delivery } : {}) });
    expect(ctx.llm.calls).toHaveLength(delivery === 'text' ? 2 : 1);
    expect(ctx.llm.calls[0]!.model).toBe(modelForTier(delivery === 'text' ? 2 : 1));
    expect(ctx.llm.calls[0]!.tools).toBeUndefined();
  });

  it('reviews text even with a covered file floor', async () => {
    const ctx = context();
    await observe(ctx);
    ctx.llm.enqueueText('Independent reference');
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'The text contradicts the source.' }));
    const accepted = await acceptRootResult({ actor: new Actor(3), task, result, delivery: 'text', ctx, floor, phaseCoverage: [] });
    expect(accepted).toMatchObject({ approved: false, basis: 'validation-call' });
    expect(ctx.llm.calls[0]!.model).toBe(modelForTier(2));
  });

  it('does not turn a wrong or truncated independent reference into a mechanical refusal', async () => {
    const ctx = context();
    ctx.llm.enqueue({ text: 'Wrong reference says six. ' + 'x'.repeat(20_000), stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 } });
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'The actual four differences are correct; the reference is mistaken.' }));
    const accepted = await acceptRootResult({ actor: new Actor(3), task,
      result: { ...result, output: 'Four differences.' }, delivery: 'text', ctx, floor: [], phaseCoverage: [] });
    expect(accepted.approved).toBe(true);
    expect(ctx.llm.calls[1]!.userContent).toContain('Reference is incomplete/truncated');
    expect(ctx.llm.calls[1]!.userContent).not.toContain('x'.repeat(16_001));
  });

  it('does not leak a recorded text delivery into a remediation with no root plan', async () => {
    const ctx = context();
    const actor = new Actor(3);
    let pass = 0;
    ctx.llm.enqueueText('Independent reference');
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Incorrect text.' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Still incorrect.' }));
    const outcome = await runDepthTask({ mode: 'deep', task, ctx, floor: [], restart: vi.fn(),
      onTopology: vi.fn(), onAcceptance: vi.fn(), createExecutor: () => ({ actor, handle: async (_task, current) => {
        if (pass++ === 0) current.recordRootPlan?.(makePlan({ delivery: 'text' }));
        return result;
      } }),
    });
    expect(outcome.refusal).toContain('Still incorrect');
    expect(pass).toBe(2);
    expect(ctx.llm.calls.map(call => call.model)).toEqual([modelForTier(2), modelForTier(2), modelForTier(1)]);
  });

  it.each(['short', 'deep'] as const)('keeps L1 execution and routes both %s text passes to L2 review', async (mode) => {
    const ctx = context();
    const recorded = vi.fn();
    const actor = new Actor(mode === 'short' ? 2 : 3);
    const tasks: Task[] = [];
    for (const approved of [false, true]) {
      ctx.llm.enqueueText(jsonText({ output: approved ? 'Corrected audit' : 'False audit' }));
      ctx.llm.enqueueText('Independent reference: identify actual endings.');
      ctx.llm.enqueueText(jsonText({ approved, reasoning: approved ? 'Correct now' : 'Observed birds, expected dawn.' }));
    }
    const outcome = await runDepthTask({ mode, task, ctx: { ...ctx, recordRootPlan: recorded }, floor: [],
      restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor, handle: async (received, current) => {
        tasks.push(received);
        current.recordRootPlan?.(makePlan({ delivery: 'text' }));
        const answer = await current.llm.complete({ model: modelForTier(1), systemPrompt: 'Execute',
          userContent: received.description, role: 'execute', signal: current.signal });
        return { ...result, output: answer.text };
      } }),
    });
    expect(outcome.refusal).toBeUndefined();
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(tasks[1]!.inputs?.['rootAcceptanceRefusal']).toBeDefined();
    expect(ctx.llm.calls.map(call => call.model)).toEqual([1, 2, 2, 1, 2, 2].map(tier => modelForTier(tier as Tier)));
    expect(ctx.llm.calls[3]!.role).toBe('execute');
  });

  it.each([2, 3] as const)('does not probe internal plan/verdict/fallback quotes at tier %s', async (tier) => {
    const ctx = context();
    ctx.tools.files['server.js'] = 'const answer = 42;';
    const staleQuote = 'Line 1 of server.js:\nconst answer = "abandoned implementation";';
    // These strings really occur in Result.trace, outside the delivery claims.
    const delivered: Result = { ...result, output: { files: ['server.js'] }, summary: 'Server written',
      trace: [
        { ts: new Date().toISOString(), atom: 'leaf', kind: 'plan', payload: makePlan({ reasoning: staleQuote }) },
        { ts: new Date().toISOString(), atom: 'cell', kind: 'verdict-result', payload: { approved: true, reasoning: staleQuote } },
        { ts: new Date().toISOString(), atom: 'cell', kind: 'escalated', payload: { diagnostic: staleQuote } },
      ] };
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Unexpected review' }));
    const actor = new Actor(tier, false, ['read_file', 'write_file']);
    const accepted = await acceptRootResult({ actor, task, result: delivered, ctx, floor: [], phaseCoverage: [] });
    expect(accepted).toMatchObject({ approved: true, basis: 'validation-call', probe: { requiresReview: false, contradiction: false } });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).not.toContain('abandoned implementation');
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'False quote' }));

    // The SAME false quote in the final summary is still a delivery claim.
    const reviewed = await acceptRootResult({ actor, task, result: { ...delivered, summary: staleQuote }, ctx, floor: [], phaseCoverage: [] });
    expect(reviewed).toMatchObject({ basis: 'validation-call', probe: { requiresReview: true, contradiction: true } });
    expect(ctx.llm.calls).toHaveLength(2);
    expect(ctx.llm.calls[1]!.userContent).toContain('NOT FOUND');
  });
  it('accepts covered delivery mechanically and copies phase records without reevaluating them', async () => {
    const ctx = context();
    await observe(ctx);
    const phase: PhaseCoverageRecord = { attempt: 1, branchId: 'added-by-plan', acceptor: { name: 'cell', tier: 2 },
      executor: { name: 'leaf', tier: 1 }, obligations: [{ obligation: 'dom-interaction', covered: false, reason: 'No phase proof', eventIds: [] }] };
    const accepted = await acceptRootResult({ actor: new Actor(), task, result, ctx, floor, phaseCoverage: [phase, { ...phase, attempt: 2 }] });
    expect(acceptanceSchema.parse(accepted)).toMatchObject({ approved: true, basis: 'mechanical', phaseCoverage: [phase, { ...phase, attempt: 2 }] });
    expect(ctx.llm.calls).toHaveLength(0);
  });
  it.each([true, false])('reviews uncovered delivery once, accepts=%s, with no method-credit hooks', async (approved) => {
    const ctx = context();
    const recordRunStat = vi.fn();
    const recordSkill = vi.fn();
    const recordTrust = vi.fn();
    ctx.llm.enqueueText(jsonText({ approved, reasoning: 'Reviewed delivery' }));
    const accepted = await acceptRootResult({ actor: new Actor(), task, result,
      ctx: { ...ctx, recordRunStat, recordSkill, recordTrust }, floor, phaseCoverage: [] });
    expect(accepted).toMatchObject({ approved, basis: 'validation-call', floorCoverage: [{ status: 'uncovered' }] });
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.model).toBe(modelForTier(1));
    expect(recordRunStat).not.toHaveBeenCalled();
    expect(recordSkill).not.toHaveBeenCalled();
    expect(recordTrust).not.toHaveBeenCalled();
  });
  it('names the sizes the attempt laid its pages out at, beside the criteria (production run 134d916a)', async () => {
    // "No horizontal overflow at 375 and 1280 pixels" was accepted on checks
    // only ever laid out at 800x600: the acceptor now reads one line saying so.
    const ctx = context();
    await observe(ctx);
    const record = ctx.attestations.forAttempt(1)[0]!;
    if (record.observation.kind !== 'browser') throw new Error('expected browser observation');
    ctx.attestations = createAttestationLog();
    ctx.attestations.append({ ...record, observation: { ...record.observation, viewport: { width: 800, height: 600 } } });
    ctx.attestations.append({ ...record, eventId: 'e-375', observation: { ...record.observation, viewport: { width: 375, height: 667 } } });
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Not laid out at 1280' }));
    await acceptRootResult({ actor: new Actor(), task, result, ctx, floor: [], phaseCoverage: [] });
    expect(ctx.llm.calls[0]!.userContent).toContain('BROWSER LAYOUTS OBSERVED IN THIS ATTEMPT');
    expect(ctx.llm.calls[0]!.userContent).toContain('index.html at 800x600, 375x667');
    // Nothing observed in a browser, nothing said.
    const bare = context();
    bare.llm.enqueueText(jsonText({ approved: true, reasoning: 'Reviewed' }));
    await acceptRootResult({ actor: new Actor(), task, result, ctx: bare, floor: [], phaseCoverage: [] });
    expect(bare.llm.calls[0]!.userContent).not.toContain('BROWSER LAYOUTS OBSERVED');
  });

  it('rejects the delegated failure envelope without a validator call', async () => {
    const ctx = context();
    const accepted = await acceptRootResult({ actor: new Actor(3), task, ctx, floor: [], phaseCoverage: [],
      result: { ...result, summary: NON_JSON_PAYLOAD_SUMMARY_PREFIX + ' broken' } });
    expect(accepted).toMatchObject({ approved: false, gates: [{ id: 'non-json-envelope', disposition: 'reject' }] });
    expect(ctx.llm.calls).toHaveLength(0);
  });
  it('reviews a malformed manifest even when it is not a contradiction', async () => {
    const ctx = context();
    ctx.tools.files[PROBE_MANIFEST_FILENAME] = '{';
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Malformed proof reviewed' }));
    const accepted = await acceptRootResult({ actor: new Actor(3), task, ctx, floor: [], phaseCoverage: [],
      result: { ...result, output: { url: 'http://localhost:5050/', probes: [{ probe: 'web', smoke: '({ok:true})' }] } } });
    expect(accepted).toMatchObject({ basis: 'validation-call', probe: { requiresReview: true, contradiction: false } });
    expect(ctx.llm.calls).toHaveLength(1);
  });
});

describe('depth transition through the production supervision loop', () => {
  it('does not start L3 or accept a result when backend teardown cannot be confirmed', async () => {
    const ctx = context();
    const actor = new Actor(2, true);
    const createExecutor = vi.fn(() => ({ actor, handle: (t: Task, c: RunContext) =>
      superviseLoop(actor, new Actor(1), t, c, {
        applyByScope: async (same) => same, branchOnEscalation: async () => {},
      }) }));
    const onAcceptance = vi.fn();
    const onTopology = vi.fn();
    await expect(runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 1 } }, createExecutor,
      restart: async () => { throw new Error('Worker is still running'); }, onTopology, onAcceptance,
    })).rejects.toThrow('Worker is still running');
    expect(createExecutor).toHaveBeenCalledTimes(1);
    expect(onTopology).toHaveBeenCalledTimes(1);
    expect(onAcceptance).not.toHaveBeenCalled();
  });
  it('rearms mechanical one-shots in a fresh attempt while sharing them across its branches', async () => {
    const ctx = context();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Delivery reviewed' }));
    const checkedAttempts: number[] = [];
    const gateTask = { description: 'running node test-api.js must exit 0' };
    await runDepthTask({ mode: 'short', task, ctx, floor: [], restart: async () => new Executor(),
      onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: (mode) => {
        const actor = new Actor(mode === 'short' ? 2 : 3);
        return { actor, handle: async (_task, current) => {
          const first = forkBranch(current, 'first');
          const sibling = forkBranch(current, 'sibling');
          expect(first.mechanicalPlanRejections!.has('spent-plan-coaching')).toBe(false);
          first.mechanicalPlanRejections!.add('spent-plan-coaching');
          expect(sibling.mechanicalPlanRejections!.has('spent-plan-coaching')).toBe(true);
          const env = buildResultGateEnv({ task: gateTask, result, ctx: first, childName: 'leaf', childToolNames: ['read_file'] });
          expect((await runResultGates(env, first.mechanicalResultRejections)).rejection?.gateId).toBe('required-command-manifest');
          const repeated = await runResultGates(env, sibling.mechanicalResultRejections);
          expect(repeated.rejection).toBeNull();
          expect(repeated.reviewFindings).toMatchObject([{ gateId: 'required-command-manifest' }]);
          checkedAttempts.push(current.attempt!);
          if (mode === 'short') current.beforeFallback!(actor);
          return actor.execute();
        } };
      },
    });
    expect(checkedAttempts).toEqual([1, 2]);
  });
  it('deepens when a mutualized peer reaches the entry fallback moment', async () => {
    const ctx = context();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Delivery reviewed' }));
    const peer = new Actor(2, true);
    const restart = vi.fn(async () => new Executor());
    const root = new Actor(2);
    const deep = new Actor(3);
    const final = await runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 1 } },
      restart, onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: (mode) => mode === 'short' ? {
        actor: root, handle: (t, c) => superviseLoop(peer, new Actor(1), t, c, {
          applyByScope: async (same) => same, branchOnEscalation: async () => {},
        }),
      } : { actor: deep, handle: () => deep.execute() },
    });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(peer.fallbackExecutions).toBe(0);
    expect(final.producedBy.tier).toBe(3);
  });

  it('does not deliver an acceptance that finishes after the run was cancelled', async () => {
    const ctx = context();
    const controller = new AbortController();
    const accepted = vi.fn();
    ctx.llm.enqueue(() => {
      controller.abort(new Error('Deadline passed'));
      return { text: jsonText({ approved: true, reasoning: 'Late verdict' }), stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const actor = new Actor(3);
    await expect(runDepthTask({ mode: 'deep', task, ctx: { ...ctx, signal: controller.signal }, floor,
      restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor, handle: () => actor.execute() }),
    })).rejects.toThrow('Deadline passed');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('exhausts the branch retry, cancels and drains siblings, then permits deep fallback and root rejection', async () => {
    const ctx = context();
    ctx.limits = { ...ctx.limits, maxPlanIterations: 1 };
    // TWO refusals since 2026-09-23: a refused delivery is handed back for one
    // more pass before the run ends (`MAX_ROOT_REMEDIATIONS`), and that budget
    // is per RUN, so a deepened run still gets exactly one.
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Missing final proof' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Still missing final proof' }));
    const short = new Actor(2, true);
    const deep = new Actor(3, true);
    const children: Actor[] = [];
    const order: string[] = [];
    const topologies: TopologyInfo[] = [];
    const acceptances: AcceptanceInfo[] = [];
    const stats = vi.fn();
    const restart = vi.fn(async () => { order.push('restart'); return new Executor(); });
    const originalTask: Task = { ...task, constraints: ['immutable original'] };
    const landedOut = await runDepthTask({ mode: 'short', task: originalTask, ctx: { ...ctx, recordRunStat: stats }, floor,
      restart, onTopology: (item) => topologies.push(item), onAcceptance: (item) => acceptances.push(item),
      createExecutor: (mode) => {
        const actor = mode === 'short' ? short : deep;
        return { actor, handle: async (receivedTask, current) => {
          // The deepened attempt runs the ORIGINAL task, and a remediation pass
          // keeps its description and constraints — only `inputs` gains the
          // acceptor's reasons, so planning and skill matching still key on the
          // same task.
          expect(receivedTask.description).toBe(originalTask.description);
          expect(receivedTask.constraints).toBe(originalTask.constraints);
          expect(current.deadlineAt).toBe(ctx.deadlineAt);
          const supervise = async () => {
            const child = new Actor(1);
            children.push(child);
            return superviseLoop(actor, child, receivedTask, forkBranch(current, 'failure'), {
              applyByScope: async (same) => same,
              branchOnEscalation: async () => { const branch = new Actor(1); children.push(branch); return branch; },
            });
          };
          if (mode === 'deep') return supervise();
          const plan = makePlan({ subtasks: [{ description: 'wait' }, { description: 'fail' }] });
          const siblings = await dispatchWithAggregation(plan.subtasks, plan, current, async (_sub, idx) => {
            if (idx === 1) return supervise();
            await observe(current);
            if (!current.signal.aborted) await new Promise<void>((resolve) => current.signal.addEventListener('abort', () => resolve(), { once: true }));
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            order.push('sibling-drained');
            current.signal.throwIfAborted();
            return result;
          });
          return siblings.results[0]!;
        } };
      },
    });
    // LANDS since 2026-09-24. What this test pins is unchanged: the branch
    // retry drains, the deepening happens exactly once, and the workspace is
    // restarted for it — only the shape of "the root said no" moved from a
    // throw to a returned, refused result.
    expect(landedOut.refusal).toBe('Still missing final proof');
    expect(short.fallbackExecutions).toBe(0);
    // Two, since 2026-09-23: the deepened attempt runs once, is refused, and
    // runs once more with the acceptor's reasons.
    expect(deep.fallbackExecutions).toBe(2);
    // Six, since 2026-09-23: the remediation pass supervises its own children.
    expect(children.filter((child) => child.plans === 1)).toHaveLength(6);
    expect(order).toEqual(['sibling-drained', 'restart']);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(topologies).toEqual([{ at: 'entry', mode: 'short', reason: 'arm', attempt: 1 },
      { at: 'deepening', mode: 'deep', reason: 'fallback-moment', attempt: 2 }]);
    expect(acceptances).toMatchObject([
      { attempt: 2, approved: false, executor: { tier: 3, viaFallback: true }, floorCoverage: [{ status: 'uncovered' }] },
      { attempt: 2, approved: false },
    ]);
    expect(stats.mock.calls.filter(([signal]) => signal === 'deepening')).toHaveLength(1);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(1);
    expect(ctx.llm.calls).toHaveLength(2);
  });
  it('carries a LANDED result through root acceptance, and tells the validator what a landing is', async () => {
    // Root acceptance reached project runs on 2026-09-23 (commit 2102979).
    // Landing on the budget shipped on 2026-09-22, and was never exercised
    // under depth routing, because depth routing was not running on the path
    // that lands. This test exists to put the two together.
    //
    // A landed result reaches the root with `unfinishedPhases` set and a
    // summary whose first word is INCOMPLETE. The profile floor is uncovered
    // (a landed run stopped before proving it), so `review` is true and an LLM
    // verdict decides.
    //
    // Until 2026-09-24 nothing in the payload said an incomplete result could
    // be legitimate, and the only statement the host made about incompleteness
    // was a rejection. `LANDED_RESULT_GUIDANCE` now travels with a landed
    // result and nowhere else; the ordinary-result half below is what proves
    // the "nowhere else".
    const ctx = context();
    const landed: Result = {
      ...result,
      summary: 'INCOMPLETE — the run deadline landed this plan with 1 phase(s) never run: write the README. Delivered so far: built the API',
      unfinishedPhases: ['write the README'],
    };
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'The phases that ran are honest' }));
    const accepted = vi.fn();
    const delivered = await runDepthTask({
      mode: 'short', task, ctx, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor: new Actor(), handle: async () => landed }),
    });
    // The landing survives the root: the typed field is what every reader
    // downstream uses to call the run `partial` rather than a delivery.
    expect(delivered.unfinishedPhases).toEqual(['write the README']);
    expect(accepted).toHaveBeenCalledTimes(1);
    // An uncovered floor forces the verdict call — a landed run stopped before
    // it could prove the floor, so this is its ordinary shape, not an edge.
    expect(accepted.mock.calls[0]![0].basis).toBe('validation-call');
    expect(accepted.mock.calls[0]![0].floorCoverage).toMatchObject([{ status: 'uncovered' }]);
    expect(ctx.llm.calls).toHaveLength(1);

    // THE GAP, stated as a comparison so it cannot be read as a preference.
    // Everything the validator learns about the landing comes from the
    // EXECUTOR'S OWN SUMMARY. Run the same acceptance over an ordinary result
    // and the concept vanishes entirely: the host never names it, so the
    // validator has no statement that an incomplete result can be legitimate,
    // and decides on model prose alone.
    const landedPrompt = JSON.stringify(ctx.llm.calls[0]).toLowerCase();
    expect(landedPrompt).toContain('incomplete');
    // Since 2026-09-24 the host NAMES the landing for the judge that decides
    // it. Before that, everything below was true and this line was not, which
    // is the whole finding: the validator ruled on model prose alone.
    expect(landedPrompt).toContain('this result landed on the run budget');
    expect(landedPrompt).toContain('reject it for being incomplete');

    const plain = context();
    plain.llm.enqueueText(jsonText({ approved: true, reasoning: 'fine' }));
    await runDepthTask({
      mode: 'short', task, ctx: plain, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => result }),
    });
    const plainPrompt = JSON.stringify(plain.llm.calls[0]).toLowerCase();
    for (const word of ['landed', 'unfinishedphases', 'deadline landed']) {
      expect(plainPrompt).not.toContain(word);
    }
    // And the ONE thing the validator is told about incompleteness points the
    // other way. The sentence is scoped to visual artefacts, so it does not
    // decide a landed run on its own — but it is the only statement on the
    // subject the host makes, and it is a rejection.
    expect(plainPrompt).toContain('a visually-incomplete artefact is a failed deliverable');
  });

  it('keeps BOTH reasons when a landed result is then refused', async () => {
    // This test was written on 2026-09-24 to pin the defect: a landed result
    // that the root refused left as a thrown error, the runner
    // recorded `failed`, and the phases that genuinely ran seeded nothing.
    // It now pins the fix, and the case it covers is the one the design nearly
    // missed — the two reasons COMPOSE, and a reader that reports only the
    // phases drops the half that says the work was judged.
    const ctx = context();
    const landed: Result = {
      ...result,
      summary: 'INCOMPLETE — the run deadline landed this plan with 1 phase(s) never run: write the README.',
      unfinishedPhases: ['write the README'],
    };
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'The README was never written' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Still no README' }));
    const out = await runDepthTask({
      mode: 'short', task, ctx, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => landed }),
    });
    expect(out.unfinishedPhases).toEqual(['write the README']);
    expect(out.refusal).toBe('Still no README');
    expect(landingReasons(out)).toEqual([
      'reached its budget with 1 unfinished phase(s) that did not complete with an accepted result: write the README',
      'refused at delivery: Still no README',
    ]);
    expect(out.summary).toContain('REFUSED AT DELIVERY');
    expect(out.summary).toContain('INCOMPLETE');
  });

  it('lands a remediation whose inherited replay stopped before re-checking what the first acceptance listed (run 5dff35b0)', async () => {
    const seed = mkdtempSync(join(tmpdir(), 'atoma-depth-inherited-seed-'));
    const delivered = mkdtempSync(join(tmpdir(), 'atoma-depth-inherited-now-'));
    try {
      writeFileSync(join(seed, 'index.html'), '<p id="mode">Long break</p>\n');
      writeFileSync(join(delivered, 'index.html'), '<p>rewritten</p>\n');
      const start = snapshotStartingWorkspace(seed);
      const listed: ListedCheck = {
        check: { file: 'index.html', interactions: [{ type: 'click', selector: '#long-break' }], smoke: '(() => ({ ok: true }))()' },
        cause: 'element-missing', detail: 'interaction click failed: selector #long-break not found',
      };
      const baseline = { selected: 4, considered: 4, kept: 4, cannotRun: 0 };
      // The first acceptance lists the rewrite; the remediation's replay meets the deadline first.
      const replays: InheritedChecksReport[] = [
        { baseline, replayed: 4, stillPassing: 3, flaky: 0, notReplayed: 0, listed: [listed] },
        { baseline, replayed: 0, stillPassing: 0, flaky: 0, notReplayed: 4, stopped: 'deadline', listed: [] },
      ];
      const base = context();
      const ctx = { ...base,
        startingWorkspace: { start, now: () => snapshotDeliveredWorkspace(delivered, start) },
        inheritedChecks: { ready: Promise.resolve(), baseline: async () => baseline, compare: async () => replays.shift()!,
          reseeded: () => undefined, waiting: () => undefined } };
      base.llm.enqueueText(jsonText({ approved: false, reasoning: 'the rewrite lost the mode line', scope: 'ephemeral', modifications: {},
        inherited: [{ id: 'r1', asked: false }] }));
      base.llm.enqueueText(jsonText({ approved: true, reasoning: 'the page validates' }));
      const accepted = vi.fn();
      const out = await runDepthTask({
        mode: 'short', task, floor: [], restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted, ctx,
        createExecutor: () => ({ actor: new Actor(), handle: async () => result }),
      });
      expect(accepted.mock.calls.map(([info]) => info.approved)).toEqual([false, false]);
      expect(landingReasons(out)).toEqual([expect.stringMatching(
        /^refused at delivery: This run's previous acceptance listed changes it did not judge asked for \(p1 "index\.html" after "click #long-break".*4 of the 4 inherited checks were not replayed \(stopped: deadline\)/)]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(delivered, { recursive: true, force: true });
    }
  });

  it('hands a refusal back for ONE more pass, in the same attempt and workspace', async () => {
    // Measured 2026-09-23 on production runs 69f6f608 and 671da856: root
    // acceptance refused both, naming exactly which behaviours were never
    // probed, and the run ended there. One pass does not cover a goal naming
    // nine verifiable behaviours — the same goal, told to verify, came back
    // with FEWER gaps — so the refusal is handed back instead of ending it.
    const ctx = context();
    const restart = vi.fn();
    const stats = vi.fn();
    const seen: Task[] = [];
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'DELETE and restart persistence remain unverified' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'Every named behaviour is now probed' }));
    const accepted = vi.fn();
    const delivered = await runDepthTask({
      mode: 'short', task, floor, restart, onTopology: vi.fn(), onAcceptance: accepted,
      ctx: { ...ctx, recordRunStat: stats },
      createExecutor: () => ({ actor: new Actor(), handle: async (t) => { seen.push(t); return result; } }),
    });
    expect(delivered).toBe(result);
    expect(seen).toHaveLength(2);
    // The refusal reaches the second pass as DATA, under inputs — the
    // description is what planning and skill matching key on and must not move.
    expect(seen[0]!.inputs?.['rootAcceptanceRefusal']).toBeUndefined();
    expect(seen[1]!.description).toBe(task.description);
    expect(seen[1]!.inputs).toMatchObject({
      rootAcceptanceRefusal: 'DELETE and restart persistence remain unverified',
      rootAcceptanceAttempt: 1,
    });
    // Same attempt, same workspace: the first pass's proof still stands, and
    // nothing is archived. Deepening is the mechanism that replaces a
    // workspace, and this is deliberately not it.
    expect(restart).not.toHaveBeenCalled();
    expect(accepted.mock.calls.map(([info]) => info.attempt)).toEqual([1, 1]);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(1);
  });

  it('keeps the user-approved list through a remediation, on the task and on every acceptance', async () => {
    // docs/acceptance-contract-2026-09-14.md: the planner cannot delete a
    // criterion, and the acceptor reads the HOST-held list, not task inputs.
    const ctx = context();
    const checklist = [{ id: 'c1', behaviour: 'the page shows the monthly total', check: { kind: 'review' as const } }];
    const digest = 'a'.repeat(64);
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'the total is not shown' }));
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'the total is shown' }));
    const seen: Task[] = [];
    const accepted = vi.fn();
    await runDepthTask({
      mode: 'short', task, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted, ctx,
      checklist, checklistOrigin: { source: 'user', digest },
      createExecutor: () => ({ actor: new Actor(), handle: async (t) => {
        seen.push(t);
        // A planner that rewrites its own inputs changes nothing the root reads.
        if (t.inputs) delete t.inputs['acceptanceChecklist'];
        return result;
      } }),
    });
    expect(seen).toHaveLength(2);
    expect(accepted.mock.calls.map(([info]) => [info.checklistSource, info.checklistDigest, info.checklist?.[0]?.id]))
      .toEqual([['user', digest, 'c1'], ['user', digest, 'c1']]);
    const verdictPrompts = ctx.llm.calls.filter((call) => call.actor?.name === 'run-root').map((call) => call.userContent);
    expect(verdictPrompts).toHaveLength(2);
    for (const prompt of verdictPrompts) expect(prompt).toContain('- [REVIEW] c1 the page shows the monthly total');
  });

  it.each([undefined, [], [{ id: 'bogus', met: true }], [{ id: ' C1 ', met: false }], [{ id: '1', met: false }],
    [{ id: 'c1', met: false }, { id: 'C1', met: true }], [{ id: 'c1', met: true }, { id: '1', met: false }]])(
    'refuses an approval missing or contradicting its user criterion judgement: %j', async (criteria) => {
      const ctx = context();
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'done', criteria }));
      const accepted = await acceptRootResult({ actor: new Actor(), task, result, ctx, floor: [], phaseCoverage: [],
        checklist: [{ id: 'c1', behaviour: 'shows the total', check: { kind: 'review' } }],
        checklistOrigin: { source: 'user', digest: 'a'.repeat(64) } });
      expect(accepted.approved).toBe(false);
    });

  it('records one judgement per criterion, and refuses an approval that judges a user criterion unmet', async () => {
    // A person who approved criteria could not tell which ones the delivery
    // was judged to meet: one prose verdict covered the whole list (2026-09-26).
    const checklist = [
      { id: 'c1', behaviour: 'the page shows the monthly total', check: { kind: 'review' as const } },
      { id: 'c2', behaviour: 'uploading a CSV replaces the data', check: { kind: 'review' as const } },
    ];
    const judge = (c2: boolean) => jsonText({ approved: true, reasoning: 'looks done', criteria: [
      { id: 'c1', met: true, reason: 'total rendered' }, { id: 'c2', met: c2, reason: c2 ? 'upload observed' : 'upload never exercised' },
      { id: 'bogus' }, 'not an entry',
    ] });
    // Covered floor, no finding: a user list is still READ, never approved mechanically.
    const user = context();
    await observe(user);
    user.llm.enqueueText(judge(false));
    const refused = await acceptRootResult({ actor: new Actor(), task, result, ctx: user, floor, phaseCoverage: [],
      checklist, checklistOrigin: { source: 'user', digest: 'a'.repeat(64) } });
    expect(user.llm.calls[0]!.userContent).toContain('ALSO emit "criteria"');
    expect(refused.approved).toBe(false);
    expect(refused.reasoning).toMatch(/c2 uploading a CSV replaces the data \(upload never exercised\)/);
    expect(refused.checklist?.map((item) => item.judgement)).toEqual([
      { met: true, reason: 'total rendered' }, { met: false, reason: 'upload never exercised' }]);
    expect(acceptanceSchema.parse(refused)).toBeTruthy();
    // All met: approved, with the judgements kept.
    const met = context();
    met.llm.enqueueText(judge(true));
    const approved = await acceptRootResult({ actor: new Actor(), task, result, ctx: met, floor: [], phaseCoverage: [],
      checklist, checklistOrigin: { source: 'user', digest: 'a'.repeat(64) } });
    expect(approved.approved).toBe(true);
    expect(approved.checklist?.every((item) => item.judgement?.met)).toBe(true);
    // A DRAFTED item judged unmet is recorded, and never fails the run by itself.
    const drafted = context();
    drafted.llm.enqueueText(jsonText({ approved: true, reasoning: 'done', criteria: [{ id: 'c1', met: false }] }));
    const draftedList = [{ id: 'c1', behaviour: 'lists notes', check: { kind: 'http' as const, method: 'GET' as const, path: '/api/notes' } }];
    const kept = await acceptRootResult({ actor: new Actor(), task, result, ctx: drafted, floor: [], phaseCoverage: [],
      checklist: draftedList, checklistOrigin: { source: 'drafted' } });
    expect(kept.approved).toBe(true);
    expect(kept.checklist?.[0]?.judgement).toEqual({ met: false });
    // A LANDED result: criteria of phases that never ran are unmet by
    // construction, and the landing contract keeps the work (adversarial review).
    const landed = context();
    landed.llm.enqueueText(judge(false));
    const partial = await acceptRootResult({ actor: new Actor(), task, ctx: landed, floor: [], phaseCoverage: [],
      result: markLanded(result, [{ description: 'upload phase' }]),
      checklist, checklistOrigin: { source: 'user', digest: 'a'.repeat(64) } });
    expect(partial.approved).toBe(true);
    expect(partial.checklist?.[1]?.judgement).toEqual({ met: false, reason: 'upload never exercised' });
    // A refusal keeps the acceptor's own words for the operator.
    expect(refused.reasoning).toContain("the acceptor's own verdict read: looks done");
  });

  // Review of PR #6: the remediation scope is proven on the judgements a real
  // acceptance records, not on a hand-built checklist, and it never tells the
  // pass to ignore the rest of the refusal it rides beside.
  it('scopes the remediation to the one criterion a real acceptance judged unmet', async () => {
    const checklist = [
      { id: 'c1', behaviour: 'the page shows the monthly total', check: { kind: 'review' as const } },
      { id: 'c2', behaviour: 'uploading a CSV replaces the data', check: { kind: 'review' as const } },
    ];
    const user = context();
    await observe(user);
    user.llm.enqueueText(jsonText({ approved: true, reasoning: 'looks done', criteria: [
      { id: 'c1', met: true }, { id: 'c2', met: false, reason: 'upload never exercised' }] }));
    const refused = await acceptRootResult({ actor: new Actor(), task, result, ctx: user, floor, phaseCoverage: [],
      checklist, checklistOrigin: { source: 'user', digest: 'a'.repeat(64) } });
    expect(refused.approved).toBe(false);
    const scope = remediationTask(task, refused).inputs?.['rootRemediationScope'] as { criterion: { id: string }; metCriteria: string[]; instruction: string };
    expect(scope.criterion.id).toBe('c2');
    expect(scope.metCriteria).toEqual(['c1']);
    expect(scope.instruction).toContain('rootAcceptanceRefusal');
    expect(scope.instruction).not.toMatch(/remediate only/i);
    const inherited = { considered: 1, baselineCannotRun: 0, replayed: 1, stillPassing: 0, flaky: 0, listed: 1, kept: 1, notReplayed: 0, items: [
      { id: 'r1', file: 'index.html', summary: 'removed behaviour', checks: [], asked: false } ] };
    expect(remediationTask(task, { ...refused, inheritedChecks: inherited }).inputs?.['rootRemediationScope']).toBeUndefined();
    // A drafted list of review criteria asks for no judgement: nothing to scope on.
    const drafted = context();
    drafted.llm.enqueueText(jsonText({ approved: false, reasoning: 'the README names a port', criteria: [{ id: 'c2', met: false }] }));
    const draftedRefusal = await acceptRootResult({ actor: new Actor(), task, result, ctx: drafted, floor: [], phaseCoverage: [],
      checklist, checklistOrigin: { source: 'drafted' } });
    expect(draftedRefusal.checklist?.some((item) => item.judgement)).toBe(false);
    expect(remediationTask(task, draftedRefusal).inputs).not.toHaveProperty('rootRemediationScope');
  });

  it('shows the acceptor which widths a criterion names were laid out, and overrides no judgement', async () => {
    // Runs a939374e and 7389feee (2026-09-27): "no horizontal scroll at 375 px"
    // approved on "responsive rules present" with every page laid out at 800x600.
    class Sized extends Executor {
      override async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
        const raw = await super.execute(name, args);
        const width = (args['viewport'] as { width?: number } | undefined)?.width ?? 800;
        return name === 'validate_html' ? { ...(raw as Record<string, unknown>), viewport: { width, height: 600 } } : raw;
      }
    }
    const layOut = async (ctx: RunContext, ...widths: number[]) => {
      const fork = forkBranch(forkBranch(ctx, 'ancestor'), 'descendant');
      for (const width of widths) await fork.tools!.execute('validate_html', { path: 'index.html', viewport: { width } });
    };
    const checklist = [{ id: 'c1', behaviour: 'No horizontal scroll at 375 px wide, and the estimate sits beside the steps at 1280 px',
      check: { kind: 'review' as const } }];
    const approve = () => jsonText({ approved: true, reasoning: 'responsive rules present',
      criteria: [{ id: 'c1', met: true, reason: 'media queries cover both' }] });
    const origin = { source: 'user' as const, digest: 'a'.repeat(64) };

    const half = context(new Sized());
    await layOut(half, 800, 1280);
    half.llm.enqueueText(approve());
    const shown = await acceptRootResult({ actor: new Actor(), task, result, ctx: half, floor, phaseCoverage: [],
      checklist, checklistOrigin: origin });
    expect(half.llm.calls[0]!.userContent).toContain('375 px: NOT LAID OUT, 1280 px: laid out, passed');
    // A fact beside the judgement: making it a refusal is an owner decision
    // (docs/incidents/production-runs-2026-09-27.md).
    expect(shown.approved).toBe(true);
    expect(shown.checklist?.[0]).toMatchObject({
      judgement: { met: true, reason: 'media queries cover both' },
      layouts: [{ width: 375, status: 'not-laid-out' }, { width: 1280, status: 'passed' }],
    });
    expect(acceptanceSchema.parse(shown)).toBeTruthy();

    const both = context(new Sized());
    await layOut(both, 375, 1280);
    both.llm.enqueueText(approve());
    const laidOut = await acceptRootResult({ actor: new Actor(), task, result, ctx: both, floor, phaseCoverage: [],
      checklist, checklistOrigin: origin });
    expect(both.llm.calls[0]!.userContent).toContain('375 px: laid out, passed, 1280 px: laid out, passed');
    expect(laidOut.checklist?.[0]?.layouts?.map((layout) => layout.status)).toEqual(['passed', 'passed']);

    // A drafted list of review items renders once one names a width, and an
    // observation recorded without a viewport was laid out at 800x600.
    const drafted = context();
    await observe(drafted);
    drafted.llm.enqueueText(approve());
    const kept = await acceptRootResult({ actor: new Actor(), task, result, ctx: drafted, floor: [], phaseCoverage: [],
      checklist, checklistOrigin: { source: 'drafted' } });
    expect(drafted.llm.calls[0]!.userContent).toContain('375 px: NOT LAID OUT, 1280 px: NOT LAID OUT');
    expect(kept.approved).toBe(true);
  });

  it('refuses for good after the last remediation, without a third pass', async () => {
    const ctx = context();
    const stats = vi.fn();
    let passes = 0;
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'first refusal' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'second refusal' }));
    const out = await runDepthTask({
      mode: 'short', task, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      ctx: { ...ctx, recordRunStat: stats },
      createExecutor: () => ({ actor: new Actor(), handle: async () => { passes++; return result; } }),
    });
    // LANDS rather than throws since 2026-09-24: the work is real and is kept.
    expect(out.refusal).toBe('second refusal');
    expect(passes).toBe(1 + MAX_ROOT_REMEDIATIONS);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(MAX_ROOT_REMEDIATIONS);
  });

  it('spends no pass the wall clock cannot pay for', async () => {
    // Same floor landing already uses: opening work the deadline will truncate
    // buys nothing, and here it would also cost the refusal's own diagnosis.
    const ctx = context();
    const stats = vi.fn();
    let passes = 0;
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'unverified' }));
    const out = await runDepthTask({
      mode: 'short', task, floor, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      ctx: { ...ctx, recordRunStat: stats, deadlineAt: Date.now() + 5_000 },
      createExecutor: () => ({ actor: new Actor(), handle: async () => { passes++; return result; } }),
    });
    expect(out.refusal).toBe('unverified');
    expect(passes).toBe(1);
    expect(stats.mock.calls.filter(([signal]) => signal === 'root-remediation')).toHaveLength(0);
  });

  it('arm A uses the same root rejection for an L3 fallback and never restarts', async () => {
    const ctx = context();
    const actor = new Actor(3, true);
    const restart = vi.fn();
    const accepted = vi.fn();
    // TWO refusals, since 2026-09-23: the first is handed back for one more
    // pass (`MAX_ROOT_REMEDIATIONS`), and the run ends on the second. What this
    // test pins is unchanged — an L3 fallback never restarts the workspace.
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Reject root' }));
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'Reject root again' }));
    const out = await runDepthTask({ mode: 'deep', task, ctx: { ...ctx, limits: { ...ctx.limits, maxPlanIterations: 1 } }, floor,
      restart, onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor, handle: (t, c) => superviseLoop(actor, new Actor(2), t, c, {
        applyByScope: async (same) => same, branchOnEscalation: async () => {},
      }) }),
    });
    expect(out.refusal).toBe('Reject root again');
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ executor: { name: actor.name, tier: 3, viaFallback: true } }));
    expect(restart).not.toHaveBeenCalled();
  });
  it('does not restart for cancellation or an unrelated failure', async () => {
    const ctx = context();
    const restart = vi.fn();
    await expect(runDepthTask({ mode: 'short', task, ctx, floor, restart, onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => { throw new Error('transport failed'); } }),
    })).rejects.toThrow('transport failed');
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('deadline landing across dispatch and depth acceptance', () => {
  it.each(['sequential', 'concat'] as const)('retains accepted work after a real %s dispatch abort', async mode => {
    const ctx = context();
    const controller = new AbortController();
    const accepted = vi.fn();
    ctx.llm.enqueue({ text: jsonText({ approved: true, reasoning: 'Accepted completed work' }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    const plan = makePlan({ subtasks: [{ description: 'completed' }, { description: 'interrupted' }], aggregation: { mode } });
    const out = await runDepthTask({ mode: 'deep', task, floor, ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 30 * 60_000 },
      restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
      createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        const dispatch = await dispatchWithAggregation(plan.subtasks, plan, current, async (_subtask, idx) => {
          if (idx === 0) return result;
          await Promise.resolve();
          controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
          current.signal.throwIfAborted();
          return result;
        });
        return markLanded(dispatch.results[0]!, dispatch.unfinished);
      } }),
    });
    expect(controller.signal.aborted).toBe(true);
    expect(out.unfinishedPhases).toEqual(['interrupted']);
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
    expect(ctx.llm.calls).toHaveLength(1);
    expect(ctx.llm.calls[0]!.signal?.aborted).toBe(false);
  });
});

it('retains deadline work as refused partial if final acceptance itself expires', async () => {
  const ctx = context();
  const controller = new AbortController();
  const finalization = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(finalization.signal);
  ctx.llm.enqueue(() => {
    finalization.abort(new DOMException('Finalization deadline', 'TimeoutError'));
    return new Promise(() => {}); // The outer lifetime must not trust cooperation.
  });
  try {
    const out = await runDepthTask({ mode: 'short', task, floor,
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 5_000 }, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: vi.fn(),
      createExecutor: () => ({ actor: new Actor(), handle: async () => {
        controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
        return markLanded(result, [{ description: 'unfinished' }]);
      } }),
    });
    expect(out.unfinishedPhases).toEqual(['unfinished']);
    expect(out.refusal).toContain('landing budget');
  } finally { timeout.mockRestore(); }
});

it('honours a library caller\'s own timeout during the verdict when there is no run deadline', async () => {
  // Read as the run deadline, it left a complete result's acceptance with no
  // bound at all: no deadline means no finalization window (2026-09-25
  // adversarial review).
  const ctx = context();
  const controller = new AbortController();
  ctx.llm.enqueue(() => {
    controller.abort(new DOMException('Caller timeout', 'TimeoutError'));
    return new Promise(() => {}); // A transport that ignores abort.
  });
  await expect(runDepthTask({ mode: 'short', task, floor: [],
    ctx: { ...ctx, signal: controller.signal }, restart: vi.fn(), onTopology: vi.fn(),
    onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async () => result }) }))
    .rejects.toThrow('Caller timeout');
});

it('never converts an explicit cancellation into a deadline landing', async () => {
  const ctx = context();
  const controller = new AbortController();
  const accepted = vi.fn();
  await expect(runDepthTask({ mode: 'short', task, floor,
    ctx: { ...ctx, signal: controller.signal }, restart: vi.fn(), onTopology: vi.fn(), onAcceptance: accepted,
    createExecutor: () => ({ actor: new Actor(), handle: async () => {
      controller.abort(new Error('Cancelled by operator'));
      return markLanded(result, [{ description: 'unfinished' }]);
    } }),
  })).rejects.toThrow('Cancelled by operator');
  expect(accepted).not.toHaveBeenCalled();
});

describe('work in hand at the deadline is finalized, landed or complete (2026-09-25 review, 1.2)', () => {
  const approve = (reasoning: string) => ({ text: jsonText({ approved: true, reasoning }), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });

  it('judges a COMPLETE result on the finalization window when the deadline falls during its verdict', async () => {
    const ctx = context();
    const controller = new AbortController();
    const accepted = vi.fn();
    ctx.llm.enqueue(async () => {
      controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return approve('Accepted completed work');
    });
    const out = await runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 5_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: accepted, createExecutor: () => ({ actor: new Actor(), handle: async () => result }) });
    expect(controller.signal.aborted).toBe(true);
    expect(out.refusal).toBeUndefined();
    expect(out.unfinishedPhases).toBeUndefined();
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
    expect(ctx.llm.calls[0]!.signal?.aborted).toBe(false);
  });

  it('keeps a complete result as a refused partial when its verdict outlives the window', async () => {
    const ctx = context();
    const controller = new AbortController();
    const finalization = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(finalization.signal);
    ctx.llm.enqueue(() => {
      controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
      finalization.abort(new DOMException('Finalization deadline', 'TimeoutError'));
      return new Promise(() => {}); // A transport that ignores abort must not hold the run.
    });
    try {
      const out = await runDepthTask({ mode: 'short', task, floor: [],
        ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 5_000 }, restart: vi.fn(), onTopology: vi.fn(),
        onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async () => result }) });
      expect(out.refusal).toContain('landing budget');
      expect(out.unfinishedPhases).toBeUndefined();
      expect(landingReasons(out).length).toBeGreaterThan(0);
    } finally { timeout.mockRestore(); }
  });

  it('lands a refused complete result when the deadline cuts its remediation before a phase', async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'root DOM proof missing' }));
    let passes = 0;
    const out = await runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        passes += 1;
        if (passes === 1) return result;
        controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
        current.signal.throwIfAborted();
        return result;
      } }) });
    expect(passes).toBe(2);
    expect(out.refusal).toMatch(/root DOM proof missing.*remediation pass was cut by the run deadline/);
    expect(out.output).toEqual(result.output);
  });

  it('still treats an explicit cancellation of the remediation pass as an interruption', async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'root DOM proof missing' }));
    let passes = 0;
    await expect(runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        passes += 1;
        if (passes === 1) return result;
        controller.abort(new Error('Cancelled by operator'));
        current.signal.throwIfAborted();
        return result;
      } }) })).rejects.toThrow('Cancelled by operator');
  });

  // Production run dfa20873 (2026-10-03): on the thirty-minute ceiling its
  // first phase closed only through a false trust approval. Taken off the
  // fast path, that phase is cut by the deadline before anything is accepted,
  // and until this landing the run FAILED: `previousSeedRun` skips a failed
  // run, so every relaunch of the project started from nothing again.
  const threePhases = makePlan({
    subtasks: [
      { description: 'Create server.js and its tests' },
      { description: 'Create public/index.html' },
      { description: 'Write README.md' },
    ],
    aggregation: { mode: 'sequential' },
  });

  it('lands a first pass the deadline cut before any phase, with every planned phase unfinished, and judges it', async () => {
    const ctx = context();
    const controller = new AbortController();
    const accepted = vi.fn();
    ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'no phase was accepted' }));
    const out = await runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: accepted, createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        current.recordRootPlan?.(threePhases);
        controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
        current.signal.throwIfAborted();
        return result;
      } }) });
    expect(out.unfinishedPhases).toEqual(['Create server.js and its tests', 'Create public/index.html', 'Write README.md']);
    expect(out.output).toBeNull();
    expect(out.summary).toContain('INCOMPLETE — the run budget ended before any of its 3 planned phase(s)');
    expect(landingReasons(out)[0]).toMatch(/^reached its budget with 3 unfinished phase\(s\)/);
    // Judged like any work in hand before it seeds a run (review of 5f66437b):
    // what it broke is on record in the refusal and the landing reasons.
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
    expect(out.refusal).toContain('no phase was accepted');
    expect(landingReasons(out)).toHaveLength(2);
  });

  it('keeps a genuine failure a failure even when the deadline cut a sibling', async () => {
    const ctx = context();
    const controller = new AbortController();
    await expect(runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        current.recordRootPlan?.(threePhases);
        controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
        throw new Error('supervision exhausted');
      } }) })).rejects.toThrow(); // fails (the attempt reports the abort); it never lands
  });

  it('still fails a first pass the deadline cut before its root plan existed', async () => {
    const ctx = context();
    const controller = new AbortController();
    await expect(runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        controller.abort(new DOMException('Execution deadline', 'TimeoutError'));
        current.signal.throwIfAborted();
        return result;
      } }) })).rejects.toThrow('Execution deadline');
  });

  it('still treats an explicit cancellation of a planned first pass as an interruption', async () => {
    const ctx = context();
    const controller = new AbortController();
    await expect(runDepthTask({ mode: 'short', task, floor: [],
      ctx: { ...ctx, signal: controller.signal, deadlineAt: Date.now() + 90_000 }, restart: vi.fn(), onTopology: vi.fn(),
      onAcceptance: vi.fn(), createExecutor: () => ({ actor: new Actor(), handle: async (_task, current) => {
        current.recordRootPlan?.(threePhases);
        controller.abort(new Error('Cancelled by operator'));
        current.signal.throwIfAborted();
        return result;
      } }) })).rejects.toThrow('Cancelled by operator');
  });
});
