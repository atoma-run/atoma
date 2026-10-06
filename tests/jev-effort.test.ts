import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { L1Atom } from '../src/atoms/L1Atom.js';
import { jevOutcomeReport } from '../src/atoms/jevOutcomes.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { JEV_EFFORT_HOLDOUT_RATE, createJevDecider } from '../src/core/jev.js';
import { JEV_THRESHOLDS, readEffort } from '../src/core/jevQuestions.js';
import { AnthropicLlmClient, MockLlmClient } from '../src/core/llm.js';
import { ClaudeCliLlmClient } from '../src/core/llmClaudeCli.js';
import { CodexCliLlmClient } from '../src/core/llmCodexCli.js';
import { RoutingLlmClient } from '../src/core/llmRouting.js';
import { InMemoryMetrics, MetricsLlmClient } from '../src/core/metrics.js';
import { BudgetGateLlmClient, RunBudgetMeter, ToolIterationCeilingLlmClient } from '../src/core/runBudget.js';
import { CODEX_MODEL_CAPABILITIES_ENV } from '../src/contracts/codexModels.js';
import type {
  JevDecider,
  JevDecisionInfo,
  JevEffortRequest,
  LlmClient,
  LlmCompletionRequest,
  ToolInvocationInfo,
} from '../src/core/types.js';
import { RecordingLlmClient } from '../src/viz/recordingLlm.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { gpuEventCardCopy } from '../src/viz/client-gl/renderer/copy.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import type { VizEvent as ClientVizEvent } from '../src/viz/client/types.js';
import { jsonText, makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * Jev sets a molecule execution's reasoning effort (owner decision
 * 2026-10-06, docs/jev-decisions-2026-09-28.md#execution-effort-owner-decision-2026-10-06).
 * These pin what makes that safe: only a decisive, consistent pair of answers
 * acts; `low` never lands on a retry; a type's own pin and a transport that
 * would drop the answer mean Jev is not asked; the decision reaches the
 * execute call through a fork and through the run's real decorator stack.
 */

const KEY = 'ts-secret-key-0123456789';

interface JevRequestBody {
  state: Record<string, unknown>;
  questions: Record<string, { type: string }>;
}

/** A Jev endpoint answering the two effort Nouls, keeping each request. */
function effortServer(spelledOut: number, openProblem: number) {
  const requests: JevRequestBody[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as JevRequestBody;
    requests.push(body);
    return new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { spelled_out: { type: 'noul', noul: spelledOut }, open_problem: { type: 'noul', noul: openProblem } },
      usage: { input_tokens: 800, output_tokens: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { impl, requests };
}

const request: JevEffortRequest = {
  task: { description: 'Replay each command in .atoma-probes.json in recorded order.', constraints: ['no new files'] },
  plan: { reasoning: 'r', proposedAction: 'run each recorded command', expectedOutput: 'their exit codes' },
  tools: ['run_shell', 'read_file'],
  retry: false,
  actorName: 'Methane',
  actorTier: 1,
};

const answers = (spelledOut: number, openProblem: number) => ({
  spelled_out: { type: 'noul' as const, noul: spelledOut },
  open_problem: { type: 'noul' as const, noul: openProblem },
});

describe('reading the execution-effort answers', () => {
  it.each([
    [0.95, 0.05, 'low'],
    [0.05, 0.95, 'high'],
    [JEV_THRESHOLDS.effortClear, JEV_THRESHOLDS.effortRuledOut, 'low'],
    [0.79, 0.05, null],
    [0.95, 0.21, null],
    [0.5, 0.5, null],
    // Contradictory answers are not a reading of either kind.
    [0.95, 0.95, null],
    [0.05, 0.05, null],
  ] as const)('spelled_out %s, open_problem %s → %s', (spelledOut, openProblem, expected) => {
    const reading = readEffort({ retry: false }, answers(spelledOut, openProblem));
    expect(reading.decision?.effort ?? null).toBe(expected);
    expect(reading.answer.yes).toEqual({ spelled_out: spelledOut, open_problem: openProblem });
    if (expected === null) expect(reading.outcome).toMatch(/^default effort \(spelled_out [\d.]+, open_problem [\d.]+\)$/);
    else expect(reading.outcome).toBe(`effort ${expected}`);
  });

  it('never lowers a retry, and still raises one', () => {
    const low = readEffort({ retry: true }, answers(0.95, 0.05));
    expect(low.decision).toBeNull();
    expect(low.outcome).toBe('default effort (retry of a refused attempt; spelled_out 0.95, open_problem 0.05)');
    expect(readEffort({ retry: true }, answers(0.05, 0.95)).decision).toEqual({ effort: 'high' });
  });

  it('keeps the default on an answer outside [0, 1]', () => {
    const reading = readEffort({ retry: false }, { spelled_out: { noul: 1.4 }, open_problem: { noul: 0.1 } });
    expect(reading).toMatchObject({ decision: null, outcome: 'default effort (invalid effort answer)' });
  });
});

describe('the decider', () => {
  it('asks two Nouls over the task, its plan and its tools, and records its own cost', async () => {
    const { impl, requests } = effortServer(0.92, 0.04);
    const records: JevDecisionInfo[] = [];
    const decider = createJevDecider({ apiKey: KEY, effortHoldoutRate: 0, fetchImpl: impl, record: (info) => records.push(info) });
    await expect(decider.effort!(request)).resolves.toEqual({ effort: 'low' });
    expect(Object.keys(requests[0]!.questions)).toEqual(['spelled_out', 'open_problem']);
    expect(Object.values(requests[0]!.questions).every((question) => question.type === 'noul')).toBe(true);
    expect(requests[0]!.state).toMatchObject({
      task: request.task.description, constraints: ['no new files'],
      plan: request.plan, tools: ['run_shell', 'read_file'],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ role: 'execute-effort', actorName: 'Methane', actorTier: 1, outcome: 'effort low' });
    expect(records[0]!.costUsd).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it('says a reasoning task has no tools rather than sending an empty list', async () => {
    const { impl, requests } = effortServer(0.5, 0.5);
    const decider = createJevDecider({ apiKey: KEY, effortHoldoutRate: 0, fetchImpl: impl, record: () => undefined });
    await decider.effort!({ ...request, tools: [] });
    expect(requests[0]!.state['tools']).toBe('none: the answer is written text');
  });

  it('holds out a decisive reading at random, recording what Jev read', async () => {
    const records: JevDecisionInfo[] = [];
    const draws = [0.49, 0.5];
    const { impl } = effortServer(0.92, 0.04);
    const decider = createJevDecider({ apiKey: KEY, fetchImpl: impl, record: (info) => records.push(info),
      effortHoldoutRate: 0.5, random: () => draws.shift()! });
    await expect(decider.effort!(request)).resolves.toBeNull();
    await expect(decider.effort!(request)).resolves.toEqual({ effort: 'low' });
    expect(records.map((record) => [record.outcome, record.answer?.choice])).toEqual([
      ['default effort (held out from low; spelled_out 0.92, open_problem 0.04)', 'low'],
      ['effort low', 'low'],
    ]);
  });

  it('draws only for a decisive reading, and ships at the pre-registered rate', async () => {
    const random = vi.fn(() => 0);
    const records: JevDecisionInfo[] = [];
    const { impl } = effortServer(0.5, 0.5);
    const decider = createJevDecider({ apiKey: KEY, fetchImpl: impl, record: (info) => records.push(info), random });
    await expect(decider.effort!(request)).resolves.toBeNull();
    await decider.effort!({ ...request, retry: true });
    expect(random).not.toHaveBeenCalled();
    expect(records[0]!.answer?.choice).toBeUndefined();
    expect(JEV_EFFORT_HOLDOUT_RATE).toBe(0.5);
  });

  it('keeps the default and records the failure when Jev does not answer', async () => {
    const records: JevDecisionInfo[] = [];
    const failing = (async () => new Response('down', { status: 400 })) as unknown as typeof fetch;
    const decider = createJevDecider({ apiKey: KEY, effortHoldoutRate: 0, fetchImpl: failing, record: (info) => records.push(info) });
    await expect(decider.effort!(request)).resolves.toBeNull();
    expect(records[0]).toMatchObject({ role: 'execute-effort', outcome: 'default effort' });
    expect(records[0]!.failure).toMatch(/^HTTP 400/);
  });
});

// ---------------------------------------------------------------------------
// The execute call
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const molecule = (params: Record<string, unknown> = {}) =>
  new L1Atom({ name: 'Methane', ordinal: 2, systemPrompt: 'you run things', tools: [], params, model: MODEL });

function call(name: string, args: Record<string, unknown>): ToolInvocationInfo {
  return { name, args, durationMs: 1, startedAt: 1, result: 'ok' };
}

/** An execute turn that reports `invocations` through the transport, then answers. */
function executeWith(invocations: readonly ToolInvocationInfo[] = []) {
  return (req: LlmCompletionRequest) => {
    for (const info of invocations) req.onToolInvocation?.(info);
    return { text: jsonText({ output: 'x', summary: 'done' }), stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } };
  };
}

function ctxWith(spelledOut: number, openProblem: number, honours = true) {
  const ctx = makeCtx();
  if (honours) ctx.llm.honoursEffortFor = (model) => model === MODEL;
  const server = effortServer(spelledOut, openProblem);
  const records: JevDecisionInfo[] = [];
  const jev = createJevDecider({ apiKey: KEY, effortHoldoutRate: 0, fetchImpl: server.impl, record: (info) => records.push(info) });
  return { ctx: { ...ctx, jev }, llm: ctx.llm, requests: server.requests, records };
}

describe('L1 execution effort', () => {
  it('carries the effort Jev set on the execute call', async () => {
    const { ctx, llm } = ctxWith(0.05, 0.93);
    llm.enqueue(executeWith());
    await molecule({ temperature: 0 }).execute({ description: 'Design a scheduler for interacting constraints.' }, makePlan(), ctx);
    expect(llm.calls[0]!.role).toBe('execute');
    expect(llm.calls[0]!.params).toEqual({ temperature: 0, effort: 'high' });
  });

  it('leaves the call as it was when Jev keeps the default', async () => {
    const { ctx, llm, requests } = ctxWith(0.5, 0.5);
    llm.enqueue(executeWith());
    await molecule().execute({ description: 'Build the page.' }, makePlan(), ctx);
    expect(requests).toHaveLength(1);
    expect(llm.calls[0]!.params).toEqual({});
  });

  it('does not ask when the transport would drop the answer', async () => {
    const { ctx, llm, requests, records } = ctxWith(0.95, 0.05, false);
    llm.enqueue(executeWith());
    await molecule().execute({ description: 'Copy a.txt to b.txt.' }, makePlan(), ctx);
    expect(requests).toHaveLength(0);
    expect(records).toHaveLength(0);
    expect(llm.calls[0]!.params?.effort).toBeUndefined();
  });

  it("does not ask over a type's own effort pin", async () => {
    const { ctx, llm, requests } = ctxWith(0.95, 0.05);
    llm.enqueue(executeWith());
    await molecule({ effort: 'medium' }).execute({ description: 'Copy a.txt to b.txt.' }, makePlan(), ctx);
    expect(requests).toHaveLength(0);
    expect(llm.calls[0]!.params?.effort).toBe('medium');
  });

  it('lowers a first attempt, never the retry of the same task', async () => {
    const { ctx, llm, records } = ctxWith(0.95, 0.05);
    const atom = molecule();
    llm.enqueue(executeWith([call('run_shell', { cmd: 'node probe.js' })]));
    llm.enqueue(executeWith());
    await atom.execute({ description: 'Replay the recorded probes.' }, makePlan(), ctx);
    await atom.execute({ description: 'Replay the recorded probes.' }, makePlan(), ctx);
    expect(llm.calls[0]!.params?.effort).toBe('low');
    expect(llm.calls[1]!.userContent).toContain('== YOUR PREVIOUS ATTEMPT AT THIS TASK ==');
    expect(llm.calls[1]!.params?.effort).toBeUndefined();
    expect(records.map((record) => record.outcome)).toEqual([
      'effort low', 'default effort (retry of a refused attempt; spelled_out 0.95, open_problem 0.05)',
    ]);
  });

  it('keeps the effort when a custom decider throws', async () => {
    const ctx = makeCtx();
    ctx.llm.honoursEffortFor = () => true;
    const jev: JevDecider = {
      choose: async () => null, approve: async () => null, twin: async () => null,
      effort: async () => { throw new Error('custom decider broke'); },
    };
    ctx.llm.enqueue(executeWith());
    await molecule().execute({ description: 'Copy a.txt to b.txt.' }, makePlan(), { ...ctx, jev });
    expect(ctx.llm.calls[0]!.params?.effort).toBeUndefined();
  });

  it('reaches the execute call through a fork, recorded in the lane of the decision', async () => {
    const { ctx, llm, records } = ctxWith(0.05, 0.93);
    llm.enqueue(executeWith());
    const branch = forkBranch(ctx, 'lane-7');
    await molecule().execute({ description: 'Solve the puzzle generator.' }, makePlan(), branch);
    expect(llm.calls[0]!.params?.effort).toBe('high');
    expect(llm.calls[0]!.branchId).toBe('lane-7');
    expect(records[0]!.branchId).toBe('lane-7');
  });
});

describe('forkBranch forwards every Jev method', () => {
  it('forwards compilable and effort with the lane stamped, and the transport capability', async () => {
    const seen: { method: string; branchId: string | undefined }[] = [];
    const jev: JevDecider = {
      choose: async () => null, approve: async () => null, twin: async () => null,
      compilable: async (req) => { seen.push({ method: 'compilable', branchId: req.branchId }); return null; },
      effort: async (req) => { seen.push({ method: 'effort', branchId: req.branchId }); return null; },
    };
    const ctx = makeCtx();
    ctx.llm.honoursEffortFor = (model) => model === MODEL;
    const branch = forkBranch(forkBranch({ ...ctx, jev }, 'outer'), 'inner');
    await branch.jev!.compilable!({ skillId: 's', prompt: 'p', allowLoopbackNetwork: false });
    await branch.jev!.effort!(request);
    expect(seen).toEqual([{ method: 'compilable', branchId: 'inner' }, { method: 'effort', branchId: 'inner' }]);
    expect(branch.llm.honoursEffort?.(MODEL)).toBe(true);
    expect(branch.llm.honoursEffort?.('claude-haiku-4-5-20251001')).toBe(false);
  });

  it('adds no optional method a decider lacks', () => {
    const jev: JevDecider = { choose: async () => null, approve: async () => null, twin: async () => null };
    const branch = forkBranch({ ...makeCtx(), jev }, 'lane');
    expect(branch.jev!.compilable).toBeUndefined();
    expect(branch.jev!.effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Whether the answer can land: the run's own stack, transport by transport
// ---------------------------------------------------------------------------

describe('which transports honour an effort', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-effort-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  /** The runner's `observeClient` order, around a router — what `ctx.llm` is in a run. */
  function runStack(clients: ConstructorParameters<typeof RoutingLlmClient>[0]): LlmClient {
    const recorder = new TraceRecorder(runsDir);
    const meter = new RunBudgetMeter(new InMemoryMetrics(), { tokens: null, costUsd: null }, () => undefined);
    return new ToolIterationCeilingLlmClient(
      new BudgetGateLlmClient(new MetricsLlmClient(new RecordingLlmClient(new RoutingLlmClient(clients), recorder), meter), meter),
      null
    );
  }

  const sdk = { messages: { create: vi.fn() } } as unknown as Anthropic;

  it('reads each selector off the transport it routes to', () => {
    const llm = runStack({ 'anthropic-api': new AnthropicLlmClient(sdk), 'zai-api': new AnthropicLlmClient(sdk) });
    expect(llm.honoursEffort?.('api:anthropic:claude-sonnet-5')).toBe(true);
    expect(llm.honoursEffort?.('api:anthropic:claude-haiku-4-5-20251001')).toBe(false);
    // Z.ai is served on the Anthropic wire, whose gate knows only claude-* ids.
    expect(llm.honoursEffort?.('api:zai:glm-4.5-air')).toBe(false);
    // A transport the run did not build honours nothing, nor a selector it cannot parse.
    expect(llm.honoursEffort?.('api:openai:gpt-5.6-sol')).toBe(false);
    expect(llm.honoursEffort?.('claude-sonnet-5')).toBe(false);
  });

  it('follows the Claude CLI alias resolution', () => {
    const cli = new ClaudeCliLlmClient({ env: {} });
    expect(cli.honoursEffort('sonnet')).toBe(true);
    expect(cli.honoursEffort('opus')).toBe(true);
    expect(cli.honoursEffort('haiku')).toBe(false);
    expect(new ClaudeCliLlmClient({ env: { ATOMA_CLAUDE_MODEL: 'haiku' } }).honoursEffort('sonnet')).toBe(false);
  });

  it('on Codex, only when both ends reach the model as asked', () => {
    const inventory = (efforts: string[]) => ({
      [CODEX_MODEL_CAPABILITIES_ENV]: JSON.stringify([
        { id: 'gpt-5.6-terra', label: 'Terra', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts },
      ]),
    });
    const spawnFn = vi.fn(() => { throw new Error('no call is made'); });
    expect(new CodexCliLlmClient({ spawnFn, env: {} }).honoursEffort('gpt-5.6-terra')).toBe(true);
    expect(new CodexCliLlmClient({ spawnFn, env: inventory(['low', 'medium', 'high']) }).honoursEffort('gpt-5.6-terra')).toBe(true);
    expect(new CodexCliLlmClient({ spawnFn, env: inventory(['medium', 'high']) }).honoursEffort('gpt-5.6-terra')).toBe(false);
    expect(new CodexCliLlmClient({ spawnFn, env: inventory(['low', 'medium', 'high']) }).honoursEffort('absent-model')).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('the effort card in the run view', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-effort-card-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

  /** Through the real decider and the real recorder: a reworded outcome must fail here. */
  async function cardFor(spelledOut: number, openProblem: number, retry = false, effortHoldoutRate = 0) {
    const recorder = new TraceRecorder(runsDir);
    recorder.beginRun({ description: 'goal' });
    const { impl } = effortServer(spelledOut, openProblem);
    await createJevDecider({ apiKey: KEY, effortHoldoutRate, fetchImpl: impl, record: (info) => recorder.recordJevDecision(info) })
      .effort!({ ...request, retry });
    const events = JSON.parse(JSON.stringify(recorder.endRun()!.events)) as ClientVizEvent[];
    return events.filter((event) => event.kind === 'jev').map((event) => gpuEventCardCopy(event, t))[0]!;
  }

  it('badges the effort Jev set, and the default it kept', async () => {
    expect(await cardFor(0.95, 0.05)).toMatchObject({ title: 'Jev · execute-effort', decision: 'effort low', body: 'effort low' });
    expect(await cardFor(0.05, 0.95)).toMatchObject({ decision: 'effort high' });
    const kept = await cardFor(0.95, 0.05, true);
    expect(kept.decision).toBe('default effort');
    expect(kept.body).toBe('default effort (retry of a refused attempt; spelled_out 0.95, open_problem 0.05)');
    expect(kept.meta).toContain('L1 Methane');
    const heldOut = await cardFor(0.05, 0.95, false, 1);
    expect(heldOut).toMatchObject({ decision: 'default effort',
      body: 'default effort (held out from high; spelled_out 0.05, open_problem 0.95)' });
  });
});

describe('the effort rows of the outcome report', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-effort-outcomes-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  /**
   * A trace recorded through the real decider, recorder and recording client:
   * the pairing reads what a run writes, so a renamed field or outcome fails here.
   */
  it('pairs each decision with the execute call it set and what became of it', async () => {
    const recorder = new TraceRecorder(runsDir);
    const run = recorder.beginRun({ description: 'goal' });
    const mock = new MockLlmClient();
    mock.honoursEffortFor = () => true;
    const draws = [0.9, 0.1];
    const readings: Record<string, [number, number]> = { Methane: [0.95, 0.05], Water: [0.05, 0.95] };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as JevRequestBody;
      const [spelledOut, openProblem] = String(body.state['task']).startsWith('Copy') ? readings['Methane']! : readings['Water']!;
      return new Response(JSON.stringify({ answers: answers(spelledOut, openProblem), usage: { input_tokens: 10 } }), { status: 200 });
    }) as typeof fetch;
    const jev = createJevDecider({ apiKey: KEY, fetchImpl, record: (info) => recorder.recordJevDecision(info),
      effortHoldoutRate: 0.5, random: () => draws.shift() ?? 0.9 });
    const ctx = { ...makeCtx(), llm: new RecordingLlmClient(mock, recorder), jev };
    const atom = (name: string) => new L1Atom({ name, ordinal: 1, systemPrompt: 's', tools: [], params: {}, model: MODEL });

    // Methane: Jev reads low, applied, and the molecule is credited.
    mock.enqueue(executeWith());
    await atom('Methane').execute({ description: 'Copy a.txt to b.txt.' }, makePlan(), forkBranch(ctx, 'lane-1'));
    recorder.record({ id: 'credit', ts: Date.now(), kind: 'registry', op: 'recordSuccess', name: 'Methane' });
    // Water: Jev reads high, held out, and the lane runs another execution.
    const water = atom('Water');
    mock.enqueue(executeWith([call('write_file', { path: 'solver.js' })]));
    mock.enqueue(executeWith());
    await water.execute({ description: 'Design the constraint solver.' }, makePlan(), forkBranch(ctx, 'lane-2'));
    await water.execute({ description: 'Design the constraint solver.' }, makePlan(), forkBranch(ctx, 'lane-2'));

    const trace: unknown = JSON.parse(JSON.stringify(recorder.endRun()));
    const report = jevOutcomeReport(trace, run.id);
    expect(report.effortCount).toBe(3);
    expect(report.effort.map(({ atom: name, read, arm, firstAttempt, given, result, branchId }) =>
      ({ name, read, arm, firstAttempt, given, result, branchId }))).toEqual([
      { name: 'Methane', read: 'low', arm: 'applied', firstAttempt: true, given: 'low', result: 'approved', branchId: 'lane-1' },
      { name: 'Water', read: 'high', arm: 'held-out', firstAttempt: true, given: null, result: 'refused', branchId: 'lane-2' },
      // The retry's own reading: high again, applied this time (draw 0.9).
      { name: 'Water', read: 'high', arm: 'applied', firstAttempt: false, given: 'high', result: 'unknown', branchId: 'lane-2' },
    ]);
    expect(report.effort.every((row) => typeof row.executeDurationMs === 'number' && row.executeEventId !== null)).toBe(true);
  });
});
