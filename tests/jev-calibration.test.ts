import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prefilterStrategy, SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { resetPrefilterCacheForTests } from '../src/atoms/prefilterCache.js';
import { llmVerdict, renderTransportEvidence } from '../src/atoms/verdict.js';
import { APPLICATION_TYPESCRIPT_GUIDANCE, TASK_CONTEXT_HEADER, DELEGATED_SCOPE_GUIDANCE, delegatedTaskContext } from '../src/atoms/taskContext.js';
import {
  calibrate,
  calibrationDetails,
  calibrationReport,
  collectCorpus,
  decisionsOfTrace,
  isRecipePrefilter,
  parsePrefilterPrompt,
  parseValidationPrompt,
  twinCases,
  type CorpusTrace,
  type RecordedDecision,
} from '../src/atoms/jevCalibration.js';
import { JEV_ENDPOINT } from '../src/core/jev.js';
import { JEV_EXCLUSION_STAMPS } from '../src/contracts/llmTrace.js';
import { JEV_THRESHOLDS, buildCompilation } from '../src/core/jevQuestions.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import type { Witness } from '../src/contracts/witness.js';
import { parentTestSuiteDigest, type ParentTestSuite } from '../src/contracts/parentTests.js';
import type { Result } from '../src/core/types.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { DELEGATION_REVIEW_HEADER } from '../src/atoms/delegationReview.js';
import { makePlan } from './helpers/factories.js';
import { jsonText, makeCtx } from './helpers.js';

/**
 * The calibration (`src/atoms/jevCalibration.ts`) measures Jev's questions on
 * the prompts real runs sent the MODEL, read back into the requests the
 * decider would build. A parser that drifted from the renderers would
 * calibrate on states no run ever had, so these render with the PRODUCTION
 * code and parse the result: a changed prompt layout fails here, not silently
 * in a report. The rest pins what the calibration may send and how it reads.
 */

// The same prompt rendered twice must reach the model twice, not the prefilter cache.
beforeEach(() => resetPrefilterCacheForTests());

function decision(role: RecordedDecision['role'], userContent: string, response = '{}', recipe = false): RecordedDecision {
  return {
    runId: 'r',
    orgId: 'o',
    startedAt: '2026-09-27T10:00:00.000Z',
    eventId: `e-${role}-${userContent.length}`,
    role,
    actor: { name: 'Idioblast', tier: 2 },
    recipe,
    userContent,
    response,
  };
}

const seed = { description: 'seed', systemPrompt: 'sys', tools: [], params: {}, createdBy: 'test' };

function atoms() {
  const reg = new AtomRegistry(openDb(':memory:'));
  reg.create(2, seed);
  const fileTools = ['write_file', 'read_file'].map((name) => ({
    name,
    description: name,
    inputSchema: { type: 'object' as const, properties: {} },
  }));
  const l1 = L1Atom.fromType(reg.create(1, { ...seed, tools: fileTools }));
  const l2 = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
  return { l1, l2 };
}

async function prefilterPrompt(): Promise<string> {
  const ctx = makeCtx();
  ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'x' }));
  await prefilterStrategy({
    ctx,
    task: { description: 'Build a landing page.' },
    catalog: [
      { name: 'Water', description: 'builds and browser-validates static web pages' },
      { name: 'Methane', description: 'builds and probes Node HTTP JSON APIs' },
    ],
    actor: { name: 'Idioblast', tier: 2 },
  });
  return ctx.llm.calls[0]!.userContent;
}

async function resultPrompt(extra: { mechanicalFindingsBlock?: string } = {}): Promise<string> {
  const { l1 } = atoms();
  const ctx = makeCtx();
  ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
  await llmVerdict({
    ctx,
    model: 'm',
    supervisorName: 'Idioblast',
    supervisorTier: 2,
    subject: 'RESULT',
    child: l1,
    task: { description: 'Add a page. Document it in the README.' },
    payload: { output: { files: ['index.html'] }, summary: 'Built it.' },
    ...extra,
  });
  return ctx.llm.calls[0]!.userContent;
}

describe('reading the model prefilter prompt back', () => {
  it('recovers the task, its constraints and every catalog entry, multi-line ones included', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'x' }));
    const l3Description = 'Node HTTP orchestrator\n    REACHABLE L1 CHILDREN (this L2 can dispatch any leaf task to any of these):\n      - Water: web';
    await prefilterStrategy({
      ctx,
      task: { description: 'Build a page.\nAlso document it.', constraints: ['no dependencies', 'verify it'] },
      catalog: [
        { name: 'Water', description: 'builds web pages' },
        { name: 'Tracheid', description: l3Description },
        { name: 'Excluded', description: 'never shown' },
      ],
      exclude: new Set(['Excluded']),
      actor: { name: 'Idioblast', tier: 2 },
    });
    expect(parsePrefilterPrompt(decision('prefilter', ctx.llm.calls[0]!.userContent))).toEqual({
      question: 'agent',
      task: { description: 'Build a page.\nAlso document it.', constraints: ['no dependencies', 'verify it'] },
      candidates: [
        { name: 'Water', description: 'builds web pages' },
        { name: 'Tracheid', description: l3Description },
      ],
      actorName: 'Idioblast',
      actorTier: 2,
    });
  });

  it('hands a recipe candidate the opening steps the deferring jev event recorded', () => {
    const prompt = 'Task: add a break mode\n\nCatalog:\n  - build-page: build a page\n  - verify-page: verify a page';
    const recorded = { ...decision('prefilter', prompt, '{}', true), details: { 'build-page': '1. write_file index.html' } };
    expect(parsePrefilterPrompt(recorded)?.candidates).toEqual([
      { name: 'build-page', description: 'build a page', detail: '1. write_file index.html' },
      { name: 'verify-page', description: 'verify a page' },
    ]);
    // A trace from before the recording asks without them, as before.
    expect(parsePrefilterPrompt(decision('prefilter', prompt, '{}', true))?.candidates.every((c) => c.detail === undefined)).toBe(true);
  });

  it('tells the recipe prefilter from the agent one by its system prompt', () => {
    expect(isRecipePrefilter(SKILL_PREFILTER_SYSTEM_PROMPT)).toBe(true);
    expect(isRecipePrefilter('You pre-filter catalog lookups for a three-tier LLM orchestrator.')).toBe(false);
  });
});

describe('reading the model validation prompt back', () => {
  it.each(['current', 'historical'] as const)('keeps multiline task text separate from runtime guidance in %s traces', async format => {
    const { l1 } = atoms();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'fixture' }));
    const description = `Build the application.\n${TASK_CONTEXT_HEADER}\nThis literal heading is part of the requested UI.`;
    await llmVerdict({ ctx, model: 'm', supervisorName: 'Cell', supervisorTier: 2,
      subject: 'RESULT', child: l1, task: { description, constraints: ['Preserve data'] },
      payload: { output: 'fixture', summary: 'fixture' }, groundTruthBlock: 'Host fixture.' });
    let prompt = ctx.llm.calls[0]!.userContent;
    if (format === 'historical') {
      // Before the explicit boundary and TypeScript policy were introduced.
      prompt = prompt.replace(`${TASK_CONTEXT_HEADER}\n${APPLICATION_TYPESCRIPT_GUIDANCE}\n`, '')
        .replace(`${TASK_CONTEXT_HEADER}\n`, '');
    }
    const parsed = parseValidationPrompt(decision('validate-result', prompt));
    expect(parsed?.request.task).toEqual({
      description: format === 'current' ? description : description.replace(`${TASK_CONTEXT_HEADER}\n`, ''),
      constraints: ['Preserve data'],
    });
    expect(parsed?.request.context?.join('\n')).toContain('Constraints: ["Preserve data"]');
    if (format === 'current') expect(parsed?.request.context?.join('\n')).toContain(APPLICATION_TYPESCRIPT_GUIDANCE);
  });

  it('recovers the result, the evidence lines the model read and the ground truth', async () => {
    const { l1 } = atoms();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    const evidence: Witness[] = [
      { source: 'recorded-probe', cmd: 'curl localhost', stdout: 'I say it works', match: true },
      { source: 'transport-observed', eventId: '0a0a0a0a-0000-4000-8000-000000000001', tool: 'write_file', observed: 'write_file ok' },
      { source: 'transport-observed', eventId: '0a0a0a0a-0000-4000-8000-000000000002', tool: 'validate_html', observed: 'validate_html: ok=true' },
    ];
    const payload = { output: { files: ['index.html'] }, summary: 'Built it.\n== GROUND TRUTH ==\nok' };
    const groundTruth = '== GROUND-TRUTH EVIDENCE (independent re-validation) ==\nSupervisor independently re-ran validate_html.\nok: true';
    await llmVerdict({
      ctx,
      model: 'm',
      supervisorName: 'Idioblast',
      supervisorTier: 2,
      subject: 'RESULT',
      child: l1,
      task: { description: 'Add a page. Document it in the README.' },
      payload,
      evidence,
      groundTruthBlock: `\n${groundTruth}`,
    });
    const parsed = parseValidationPrompt(decision('validate-result', ctx.llm.calls[0]!.userContent));
    expect(parsed?.eligible).toBe(true);
    expect(parsed?.request).toMatchObject({
      subject: 'RESULT',
      task: { description: 'Add a page. Document it in the README.' },
      child: { name: l1.name, tier: 1, tools: ['write_file', 'read_file'] },
      payload,
      groundTruth,
    });
    // Exactly the lines the model read: transport-observed only.
    expect(parsed?.request.evidence).toEqual(renderTransportEvidence(evidence).lines);
  });

  it('marks a validation the Jev fast path is never asked about', async () => {
    const prompt = await resultPrompt({ mechanicalFindingsBlock: '== MECHANICAL GATE FINDINGS ==\nsomething' });
    expect(parseValidationPrompt(decision('validate-result', prompt))?.eligible).toBe(false);
  });

  it('keeps inherited facts separate from phase requirements when replaying a reasoning validation', async () => {
    const { l1 } = atoms();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'correct' }));
    await llmVerdict({ ctx, model: 'm', supervisorName: 'Cell', supervisorTier: 2, subject: 'RESULT', child: l1,
      task: { description: 'Audit the bound.', executionMode: 'reasoning', constraints: ['No files'],
        inputs: { originalTask: { description: 'P=4, Q=2 on R.' }, previousStepResult: '6' } },
      payload: { output: '6 is optimal', summary: 'proved' } });
    const parsed = parseValidationPrompt(decision('validate-result', ctx.llm.calls[0]!.userContent));
    expect(parsed?.request.task).toEqual({ description: 'Audit the bound.', constraints: ['No files'] });
    expect(parsed?.request.context?.join('\n')).toContain('P=4, Q=2 on R.');
    expect(parsed?.request.context?.join('\n')).toContain('Tools are disabled');
    expect(parsed?.request.child.tools).toEqual([]);
  });

  it.each(['root', 'delegated', 'input-only'] as const)('renders and recovers host-owned validation scope: %s', async kind => {
    const { l1 } = atoms();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'fixture' }));
    const root = { description: 'Implement durable receipts and execute subprocess persistence tests.' };
    const phase = { description: 'Implement durable receipts and basic startup checks. Persistence tests belong to the forthcoming test phase.' };
    const task = kind === 'delegated' ? { ...phase, ...delegatedTaskContext(root, phase) }
      : kind === 'input-only' ? { ...root, inputs: { originalTask: root } } : root;
    await llmVerdict({ ctx, model: 'm', supervisorName: 'Cell', supervisorTier: 2,
      subject: 'RESULT', child: l1, task, payload: { output: 'fixture', summary: 'fixture' },
      groundTruthBlock: 'Host fixture: no filesystem probe needed.' });
    const prompt = ctx.llm.calls[0]!.userContent;
    expect(prompt.includes(DELEGATED_SCOPE_GUIDANCE)).toBe(kind === 'delegated');
    expect(prompt).toContain(root.description);
    const parsed = parseValidationPrompt(decision('validate-result', prompt));
    expect(parsed?.request.task.description).toBe(task.description);
    expect(parsed?.request.context?.includes(DELEGATED_SCOPE_GUIDANCE) ?? false).toBe(kind === 'delegated');
  });

  it("recovers a delegation plan and the tools its delegator's children inherit", async () => {
    const { l2 } = atoms();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok' }));
    const plan = makePlan({ reasoning: 'route it', proposedAction: 'delegate to L1 "Water"', expectedOutput: 'a page' });
    await llmVerdict({
      ctx,
      model: 'm',
      supervisorName: 'Terra',
      supervisorTier: 3,
      subject: 'PLAN',
      child: l2,
      task: { description: 'Build a page.' },
      payload: plan,
    });
    const parsed = parseValidationPrompt(decision('validate-plan', ctx.llm.calls[0]!.userContent));
    expect(parsed?.request).toMatchObject({
      subject: 'PLAN',
      task: { description: 'Build a page.' },
      child: { name: 'Tracheid', tier: 2, tools: l2.toolNames() },
    });
    expect(parsed?.request.payload).toEqual(JSON.parse(JSON.stringify(plan)));
  });
});

describe('the corpus: model decisions, in the window, from runs Jev did not decide', () => {
  const llm = (id: string, role: string, name = 'Idioblast') => ({
    id,
    kind: 'llm',
    role,
    actor: { name, tier: 2 },
    systemPrompt: 'sys',
    userContent: 'prompt',
    response: '{}',
  });

  it('reads prefilters and phase validations, never a run actor\'s call or a failed one', () => {
    const found = decisionsOfTrace(
      {
        startedAt: '2026-09-27T10:00:00.000Z',
        events: [
          llm('a', 'prefilter'),
          llm('b', 'validate-result'),
          llm('c', 'validate-result', 'run-root'),
          // The criteria batches, the text reference and the tissue router are
          // run actors too, each with its own prompt layout: read as decisions,
          // they were 42 % "unparsed" in the October 1–9 window.
          llm('c2', 'validate-result', 'run-criteria'),
          llm('c3', 'validate-result', 'run-text-reference'),
          llm('c4', 'prefilter', 'run-router'),
          llm('d', 'plan'),
          { ...llm('e', 'validate-plan'), response: undefined },
          { id: 'j', kind: 'jev', role: 'prefilter' },
        ],
      },
      { runId: 'r', orgId: 'o' }
    );
    expect(found.decisions.map((d) => d.eventId)).toEqual(['a', 'b']);
    expect(found.jevEvents).toBe(1);
  });

  it('pairs a recipe prefilter with the opening steps its actor\'s jev deferral recorded', () => {
    const recipe = (id: string, name = 'Idioblast') => ({ ...llm(id, 'prefilter', name), systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT });
    const jev = (name: string, details?: Record<string, string>) =>
      ({ id: `j-${name}`, kind: 'jev', role: 'prefilter', actor: { name, tier: 2 }, outcome: 'model decides', ...(details ? { details } : {}) });
    const found = decisionsOfTrace(
      {
        startedAt: '2026-10-10T10:00:00.000Z',
        events: [
          jev('Idioblast', { 'build-page': '1. write_file' }),
          jev('Tracheid', { 'other-recipe': '1. run_shell' }),
          recipe('r1'),
          // An agent prefilter of the same actor reads no recipe steps.
          llm('a1', 'prefilter'),
          // A later recipe deferral replaces what its actor read.
          jev('Idioblast', { 'verify-page': '1. validate_html' }),
          recipe('r2'),
          // A jev event without details (an older binary) leaves the next decision bare.
          jev('Idioblast'),
          recipe('r3'),
        ],
      },
      { runId: 'r', orgId: 'o' }
    );
    expect(found.decisions.map((d) => [d.eventId, d.details])).toEqual([
      ['r1', { 'build-page': '1. write_file' }],
      ['a1', undefined],
      ['r2', { 'verify-page': '1. validate_html' }],
      ['r3', { 'verify-page': '1. validate_html' }],
    ]);
  });

  it('keeps the window, skips a file last written before it unread, and leaves out a run Jev decided in', () => {
    const reads: string[] = [];
    const trace = (runId: string, startedAt: string, jev = false, modifiedAtMs?: number): CorpusTrace => ({
      runId,
      orgId: 'o',
      ...(modifiedAtMs !== undefined ? { modifiedAtMs } : {}),
      read: () => {
        reads.push(runId);
        return { startedAt, events: [llm(`${runId}-1`, 'prefilter'), ...(jev ? [{ id: 'j', kind: 'jev' }] : [])] };
      },
    });
    const traces = [
      trace('late', '2026-09-28T09:00:00.000Z'),
      trace('early', '2026-09-26T09:00:00.000Z'),
      trace('old', '2026-09-20T09:00:00.000Z', false, Date.parse('2026-09-21T00:00:00.000Z')),
      trace('after', '2026-09-30T09:00:00.000Z'),
      trace('jev', '2026-09-27T09:00:00.000Z', true),
      { runId: 'broken', orgId: 'o', read: () => null },
    ];
    const corpus = collectCorpus({ traces, since: '2026-09-26', until: '2026-09-29' });
    expect(corpus.decisions.map((d) => d.runId)).toEqual(['early', 'late']);
    expect(reads).not.toContain('old');
    expect(corpus.traces).toEqual({ read: 5, inWindow: 3, unreadable: 1, withJev: 1 });
    expect(collectCorpus({ traces, since: '2026-09-26', until: '2026-09-29', includeJevRuns: true }).decisions.map((d) => d.runId)).toEqual([
      'early',
      'jev',
      'late',
    ]);
  });

  // Review 2026-10-16, group F: four validations Decision never takes by
  // policy were read as calibration material. Production stamps them on the
  // call; the calibration keeps them in the corpus and counts them apart.
  describe('the validations Decision never takes', () => {
    let runsDir: string;

    beforeEach(() => {
      runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-excluded-'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(runsDir, { recursive: true, force: true });
    });

    const SUITE: ParentTestSuite = {
      requirement: 'add returns the sum of its arguments',
      cwd: '.',
      source: "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('adds', () => {\n  expect(add(2, -3)).toBe(-1);\n});",
    };

    const passed = {
      suiteDigest: parentTestSuiteDigest(SUITE),
      suite: SUITE,
      workspaceDigest: 'a'.repeat(64),
      status: 'passed' as const,
      cause: 'ran' as const,
      passed: 1,
      failed: 0,
      skipped: 0,
      details: JSON.stringify(['', { name: 'adds', status: 'passed', failures: [] }]),
    };

    const contractReview = (subtasks: number) => jsonText({
      approved: true,
      reasoning: 'scope reviewed',
      delegationReview: {
        subtasks: Array.from({ length: subtasks }, (_, index) => ({ index, kind: 'vitest', reason: 'implements add' })),
        integration: { kind: 'other', reason: 'one module' },
        independentWork: false,
        parallelReason: 'one module',
      },
    });

    function actors() {
      const registry = new AtomRegistry(openDb(':memory:'));
      const seedOf = (description: string) => ({ ...seed, description });
      const tissue = L3Atom.buildWithModel(registry.create(3, seedOf('orchestrator')), registry, 'mock');
      const cell = L2Atom.fromType(registry.create(2, seedOf('module author')), registry);
      const molecule = L1Atom.fromType(registry.create(1, seedOf('module writer')));
      return { tissue, cell, molecule };
    }

    function leafResult(extra: Partial<Result> = {}): Result {
      return {
        output: { exports: ['add(a, b)'] },
        summary: 'added the function',
        trace: [],
        producedBy: { tier: 1, name: 'Water', viaFallback: false },
        ...extra,
      };
    }

    /** Every validation of the four kinds, and two controls, through production code and the real recorder. */
    async function recordedRun() {
      const { tissue, cell, molecule } = actors();
      const recorder = new TraceRecorder(runsDir);
      recorder.beginRun({ description: 'goal' });
      const base = makeCtx();
      const ctx = { ...base, llm: new RecordingLlmClient(base.llm, recorder) };
      const suitePlan = makePlan({ subtasks: [{ description: 'Implement add', outputs: ['add.ts'], acceptanceTests: SUITE }] });
      const ids: Record<string, string> = {};
      const last = () => recorder.currentRun!.events.filter((event) => event.kind === 'llm').at(-1)!.id;

      // (a) L3 reviewing an L2 plan carrying suites: a delegation-contract review.
      base.llm.enqueueText(contractReview(1));
      expect((await tissue.validatePlan(cell, suitePlan, { description: 'Add numbers' }, ctx)).approved).toBe(true);
      ids['l3-plan-with-suite'] = last();

      // (b) The root review of the tissue's own plan.
      vi.spyOn(tissue, 'plan').mockResolvedValue(suitePlan);
      vi.spyOn(tissue, 'execute').mockResolvedValue(leafResult());
      base.llm.enqueueText(contractReview(1));
      await tissue.handle({ description: 'Implement signed addition' }, ctx);
      ids['root-review'] = last();

      // (c) L2 judging a molecule's RESULT on a suite-bearing task.
      base.llm.enqueueText(jsonText({ approved: true, reasoning: 'the suite passed' }));
      await cell.validateResult(molecule, leafResult({ parentTests: [passed] }), { description: 'Implement add', acceptanceTests: SUITE }, ctx);
      ids['l2-result-under-suite'] = last();

      // (d) L3 judging a cell's RESULT that carries passing aggregated observations.
      base.llm.enqueueText(jsonText({ approved: true, reasoning: 'delivered' }));
      await tissue.validateResult(cell, leafResult({ parentTests: [passed] }), { description: 'Implement add' }, ctx);
      ids['l3-result-with-observations'] = last();

      // Controls: Decision decides both.
      base.llm.enqueueText(jsonText({ approved: true, reasoning: 'routes the work' }));
      await tissue.validatePlan(cell, makePlan({ subtasks: [{ description: 'Write the README' }] }), { description: 'Document add' }, ctx);
      ids['l3-plan-without-suite'] = last();
      base.llm.enqueueText(jsonText({ approved: true, reasoning: 'writes add.ts' }));
      await cell.validatePlan(molecule, makePlan(), { description: 'Implement add', acceptanceTests: SUITE }, ctx);
      ids['l2-plan-of-l1-under-suite'] = last();

      const run = JSON.parse(JSON.stringify(recorder.endRun()!)) as { startedAt: string; jevExclusionStamps?: unknown; events: Record<string, unknown>[] };
      return { run, events: run.events, ids };
    }

    it('counts apart the validations Decision never takes, stamped by production', async () => {
      const { run, ids } = await recordedRun();
      // The recorder marks the trace as written by code that stamps.
      expect(run.jevExclusionStamps).toBe(JEV_EXCLUSION_STAMPS);
      const found = decisionsOfTrace(run, { runId: 'r', orgId: 'o' });
      const excludedOf = (key: string) => found.decisions.find((decision) => decision.eventId === ids[key])?.excluded;

      expect(found.decisions.map((decision) => decision.eventId)).toEqual(Object.values(ids));
      expect(excludedOf('l3-plan-with-suite')).toBe('delegation-review');
      expect(excludedOf('root-review')).toBe('delegation-review');
      expect(excludedOf('l2-result-under-suite')).toBe('parent-suite');
      expect(excludedOf('l3-result-with-observations')).toBe('parent-suite');
      expect(excludedOf('l3-plan-without-suite')).toBeUndefined();
      expect(excludedOf('l2-plan-of-l1-under-suite')).toBeUndefined();
      const controls = found.decisions.filter((decision) => !decision.excluded);
      for (const control of controls) expect(parseValidationPrompt(control)?.eligible).toBe(true);

      const { impl, bodies } = fakeJev();
      const calibration = await calibrate({ decisions: found.decisions, apiKey: 'k', fetchImpl: impl, concurrency: 1 });

      expect(calibration.excluded).toEqual({ 'delegation-review': 2, 'parent-suite': 2 });
      expect(calibration.ineligible).toEqual({ PLAN: 0, RESULT: 0 });
      expect(calibration.records.map((record) => record.id)).toEqual([ids['l3-plan-without-suite'], ids['l2-plan-of-l1-under-suite']]);
      // Each control asks the documented and the legacy questions; nothing else is sent.
      expect(bodies).toHaveLength(4);
    });

    it('reads a trace by its host-rendered structure only when its writer predates the stamp, whatever its date', async () => {
      const { events, ids } = await recordedRun();
      const unstamped = events.map((event) => {
        const { jevExcluded: _stamp, ...rest } = event;
        return rest;
      });
      const excludedIn = (marker: boolean, startedAt = '2026-10-16T06:00:00.000Z') => {
        const found = decisionsOfTrace({ startedAt, events: unstamped, ...(marker ? { jevExclusionStamps: JEV_EXCLUSION_STAMPS } : {}) }, { runId: 'r', orgId: 'o' });
        return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, found.decisions.find((decision) => decision.eventId === id)?.excluded]));
      };
      const historical = {
        'l3-plan-with-suite': 'delegation-review',
        'root-review': 'delegation-review',
        'l2-result-under-suite': 'parent-suite',
        'l3-result-with-observations': 'parent-suite',
        'l3-plan-without-suite': undefined,
        'l2-plan-of-l1-under-suite': undefined,
      };
      expect(excludedIn(false)).toEqual(historical);
      // A trace an older deploy wrote AFTER any calendar cutover is still read
      // by its structure: the writer decides, never the date (second review).
      expect(excludedIn(false, '2026-10-20T06:00:00.000Z')).toEqual(historical);
      // A writer that stamps: the text never decides.
      expect(Object.values(excludedIn(true)).every((excluded) => excluded === undefined)).toBe(true);
      // Read as text alone, every one of them looks eligible: before the stamp,
      // the calibration sent all six.
      const recent = decisionsOfTrace({ startedAt: '2026-10-20T06:00:00.000Z', events: unstamped, jevExclusionStamps: JEV_EXCLUSION_STAMPS }, { runId: 'r', orgId: 'o' });
      for (const decision of recent.decisions) expect(parseValidationPrompt(decision)?.eligible).toBe(true);
    });

    it('keeps a historical control whose task text carries the review header before its plan', async () => {
      const { tissue, cell } = actors();
      const recorder = new TraceRecorder(runsDir);
      recorder.beginRun({ description: 'goal' });
      const base = makeCtx();
      const ctx = { ...base, llm: new RecordingLlmClient(base.llm, recorder) };
      base.llm.enqueueText(jsonText({ approved: true, reasoning: 'routes the work' }));
      const description = `Document the review screen.\n${DELEGATION_REVIEW_HEADER}\nThis heading is shown to users.`;

      await tissue.validatePlan(cell, makePlan({ subtasks: [{ description: 'Write the README' }] }), { description }, ctx);

      const events = JSON.parse(JSON.stringify(recorder.endRun()!.events)) as unknown[];
      const found = decisionsOfTrace({ startedAt: '2026-10-16T06:00:00.000Z', events }, { runId: 'r', orgId: 'o' });
      expect(found.decisions).toHaveLength(1);
      expect(found.decisions[0]!.userContent).toContain(`\n${DELEGATION_REVIEW_HEADER}\n`);
      expect(found.decisions[0]!.excluded).toBeUndefined();
    });
  });
});

interface Body {
  questions: Record<string, { type: 'choice' | 'noul' | 'score'; criteria?: unknown }>;
}

/** TypeSafe, answering every question: `answer(id)` when it returns something, a clear default otherwise. */
function fakeJev(answer: (id: string, body: Body) => unknown = () => undefined, delayMs = 0) {
  const bodies: Body[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).toBe(JEV_ENDPOINT);
    const body = JSON.parse(init?.body as string) as Body;
    bodies.push(body);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const given = answer(id, body);
      if (given !== undefined) answers[id] = given;
      else if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.05 };
      else if (question.type === 'score') answers[id] = { type: 'score', score: 0, confidence: 0.9, probabilities: {} };
      else {
        const first = Object.keys(question.criteria as object)[0]!;
        answers[id] = { type: 'choice', choice: first, confidence: 0.95, probabilities: { [first]: 0.97 } };
      }
    }
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 2000, output_tokens: 0 } }), {
      status: 200,
      headers: { 'x-typesafe-request-id': `req-${bodies.length}` },
    });
  }) as typeof fetch;
  return { impl, bodies };
}

describe('calibrating: both designs, on the same decisions', () => {
  it('asks the live compilation questions without labels, and re-reads their raw scores', async () => {
    const request = { skillId: 'replay-probes', prompt: 'Read a recorded manifest and replay its checks.', allowLoopbackNetwork: false };
    const { impl, bodies } = fakeJev((id) => ({ type: 'noul', noul: id === 'semantic_judgment' ? 0.85 : 0.05 }));
    const calibration = await calibrate({ decisions: [], compilations: [
      { request, expected: true }, { request, expected: false }, { request, expected: null },
    ], apiKey: 'k', fetchImpl: impl });
    expect(bodies).toHaveLength(3); // no legacy request and no generating model
    const plan = buildCompilation(request);
    if (typeof plan === 'string') throw new Error(plan);
    expect(bodies[0]).toMatchObject({ state: plan.state, questions: plan.questions });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]); // changing the label cannot change what Jev sees
    expect(calibration.records.map((row) => row.id)).toEqual(['replay-probes#1', 'replay-probes#2', 'replay-probes#3']);
    expect(calibrationReport(calibration.records)).toMatchObject({ compilation: {
      cases: 3, labelled: 2, postponed: 3, falsePostponements: 1, falseAllowances: 0, deferred: 0,
    } });
    expect(calibrationReport(calibration.records, { thresholds: { ...JEV_THRESHOLDS, compilationObstacle: 0.9 }, sweep: true }))
      .toMatchObject({ compilation: { postponed: 0, falsePostponements: 0, deferred: 3, sweep: expect.any(Array) } });
    expect(calibrationDetails(calibration.records)[0]).toMatchObject({
      skillId: request.skillId, expected: true, compilable: false,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), yes: { semantic_judgment: 0.85 },
    });
  });

  it('records interrupted earlier jobs so resuming never replays a later paid success', async () => {
    const prompt = await prefilterPrompt();
    const decisions = [0, 1, 2].map(i => ({ ...decision('prefilter', prompt,
      jsonText({ kind: 'escalate', reasoning: 'x' })), eventId: `p${i}` }));
    const abort = new AbortController();
    const { impl } = fakeJev();
    let calls = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (++calls === 1) return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      return impl(url, init);
    };
    const result = await calibrate({ decisions, apiKey: 'k', fetchImpl, concurrency: 2, signal: abort.signal,
      onProgress: () => abort.abort() });
    expect(result.records.map(record => record.id)).toEqual(['p0', 'p1']);
    expect(result.records[0]).toHaveProperty('failure');
    expect(result.records[1]).toHaveProperty('answers');
    expect(result.resumeAt).toBe(2);
    expect(result.unasked).toBe(1);
  });

  it('reports unasked compilation cases when cancelled without spending or inventing answers', async () => {
    const { impl, bodies } = fakeJev();
    const calibration = await calibrate({ decisions: [], compilations: [{
      request: { skillId: 'x', prompt: 'mechanical recipe', allowLoopbackNetwork: false }, expected: true,
    }], apiKey: 'k', signal: AbortSignal.abort(), fetchImpl: impl });
    expect(calibration).toMatchObject({ records: [], unasked: 1 });
    expect(bodies).toHaveLength(0);
  });

  it('asks the documented and the legacy questions, and reads a false approval against the model', async () => {
    const pick = await prefilterPrompt();
    const result = await resultPrompt();
    const decisions = [
      decision('prefilter', pick, jsonText({ kind: 'reuse', target: 'Methane', confidence: 'high', reasoning: 'x' })),
      // The model REFUSED this result; the documented questions will approve it.
      decision('validate-result', result, jsonText({ approved: false, reasoning: 'no proof' })),
      decision('validate-result', await resultPrompt({ mechanicalFindingsBlock: '== MECHANICAL GATE FINDINGS ==\nx' }), jsonText({ approved: false })),
      decision('validate-result', 'not a validation prompt', jsonText({ approved: true })),
    ];
    const { impl, bodies } = fakeJev((id) => {
      if (id === 'choice') return { type: 'choice', choice: 'agent_2', confidence: 0.9, probabilities: { agent_2: 0.9 } };
      if (id === 'fits::agent_2') return { type: 'noul', noul: 0.9 };
      // The legacy approval's single yes: below its 0.5, so it defers.
      if (id === 'acceptable') return { type: 'noul', noul: 0.4 };
      return undefined;
    });
    const calibration = await calibrate({ decisions, apiKey: 'k', fetchImpl: impl, concurrency: 1 });
    // Two decisions asked, each of both designs; the gate-flagged one and the unparseable one never leave.
    expect(bodies).toHaveLength(4);
    expect(calibration).toMatchObject({ unparsed: 1, ineligible: { PLAN: 0, RESULT: 1 }, unasked: 0, resumeAt: null });
    expect(calibration.records.map((record) => record.requestIds)).toEqual([['req-1', 'req-2'], ['req-3', 'req-4']]);

    const report = calibrationReport(calibration.records) as {
      totals: { answered: number; costUsd: number; inputTokens: { median: number } };
      approvals: { subject: string; documented: { falseApprovals: number }; legacy: { falseApprovals: number }; falseApprovals: string[] }[];
      prefilter: { bucket: string; documented: { agree: number }; legacy: { agree: number } }[];
    };
    expect(report.totals).toMatchObject({ answered: 2, inputTokens: { median: 2000 } });
    // 2000 input tokens per request, four requests, at 0.042 USD per million.
    expect(report.totals.costUsd).toBeCloseTo(0.000336, 9);
    expect(report.approvals).toEqual([
      expect.objectContaining({
        subject: 'RESULT',
        documented: expect.objectContaining({ falseApprovals: 1 }),
        legacy: expect.objectContaining({ falseApprovals: 0 }),
        falseApprovals: [decisions[1]!.eventId],
      }),
    ]);
    // The model reused Methane with high confidence; the documented pick agrees.
    expect(report.prefilter).toEqual([
      expect.objectContaining({ bucket: 'agent@L2', documented: { agree: 1, disagree: 0, deferred: 0 } }),
    ]);

    // The same answers under a stricter reading: no approval, and what blocked it is counted.
    const strict = calibrationReport(calibration.records, { thresholds: { ...JEV_THRESHOLDS, requirementShown: 0.99 }, sweep: true }) as {
      approvals: { documented: { falseApprovals: number }; sweep: unknown[] }[];
    };
    expect(strict.approvals[0]!.documented.falseApprovals).toBe(0);
    expect(strict.approvals[0]!.sweep).toHaveLength(16);
    const details = calibrationDetails(calibration.records, { limit: 5 });
    expect(details[1]).toMatchObject({ kind: 'approval', model: 'refused', documented: 'approved', legacy: 'deferred to the model' });
  });

  it('reads a recipe decision with its offer floor, as production does (2026-10-06)', async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'x' }));
    await prefilterStrategy({
      ctx,
      task: { description: 'Build a Node CLI that redacts secret values in NDJSON.' },
      catalog: [
        { name: 'build-text-frequency-cli', description: 'build a word-count CLI' },
        { name: 'build-schema-csv-json-cli', description: 'build a CSV to JSON CLI' },
      ],
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
      actor: { name: 'Idioblast', tier: 2 },
    });
    // Run d8bd792d: the model reused the word-count recipe.
    const decisions = [decision('prefilter', ctx.llm.calls[0]!.userContent,
      jsonText({ kind: 'reuse', target: 'build-text-frequency-cli', confidence: 'high', reasoning: 'a CLI' }), true)];
    const { impl } = fakeJev((id) => {
      if (id === 'choice') return { type: 'choice', choice: 'none_of_these', confidence: 0.46, probabilities: { none_of_these: 0.46 } };
      if (id === 'fits::build-text-frequency-cli') return { type: 'noul', noul: 0.34 };
      if (id === 'task_changes_files' || id.startsWith('changes_files::')) return { type: 'noul', noul: 0.9 };
      return undefined;
    });
    const calibration = await calibrate({ decisions, apiKey: 'k', fetchImpl: impl, concurrency: 1 });
    // Read with the floor, the documented answer is no recipe — against the model.
    expect(calibrationDetails(calibration.records)[0]).toMatchObject({
      kind: 'prefilter', documented: expect.stringContaining('below the 0.5 floor'),
    });
    // Re-read without it, the same answers hand the decision to the model.
    expect(calibrationDetails(calibration.records, { thresholds: { ...JEV_THRESHOLDS, recipeOffer: 0 } })[0]).toMatchObject({
      documented: expect.stringMatching(/^model decides/),
    });
  });

  it('asks labelled twin cases first, and says where to resume when its budget runs out', async () => {
    const cases = twinCases({
      recipes: {
        a: { kind: 'event', description: 'paste evidence', whenToUse: 'narrative-only summaries', body: 'rerun probes' },
        b: { kind: 'event', description: 'capture evidence', whenToUse: 'narrative-only summaries' },
        c: { kind: 'event', description: 'stop no server', whenToUse: 'plan stops a server' },
      },
      cases: [{ draft: 'a', existing: ['b', 'c'], twins: ['b'] }],
    });
    if (typeof cases === 'string') throw new Error(cases);
    const prompt = await prefilterPrompt();
    const decisions = [0, 1, 2].map((i) => ({
      ...decision('prefilter', prompt, jsonText({ kind: 'escalate', reasoning: 'x' })),
      eventId: `p${i}`,
    }));
    const { impl } = fakeJev((id) => (id === 'twin::b' ? { type: 'score', score: 1.8, confidence: 0.8, probabilities: {} } : undefined), 30);
    const calibration = await calibrate({ decisions, twins: cases, apiKey: 'k', fetchImpl: impl, concurrency: 1, budgetMs: 10 });
    expect(calibration.records.map((record) => record.id)).toEqual(['a']);
    expect(calibration.resumeAt).toBe(0);
    const report = calibrationReport(calibration.records) as { twins: { documentedRight: number; rows: { documented: string }[] } };
    expect(report.twins).toMatchObject({ documentedRight: 1, rows: [{ documented: 'not saved: twin of b' }] });
  });

  it('refuses twin cases that name a recipe it was not given', () => {
    const recipes = { a: { kind: 'task' as const, description: 'd', whenToUse: 'w' } };
    expect(twinCases({ recipes, cases: [{ draft: 'z', existing: [], twins: [] }] })).toMatch(/draft "z"/);
    expect(twinCases({ recipes, cases: [{ draft: 'a', existing: ['y'], twins: [] }] })).toMatch(/recipe "y"/);
    expect(twinCases({ recipes: { ...recipes, b: recipes.a }, cases: [{ draft: 'a', existing: [], twins: ['b'] }] })).toMatch(
      /not one of its existing/
    );
  });
});
