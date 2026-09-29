import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jevApproval, prefilterStrategy, SKILL_PREFILTER_SYSTEM_PROMPT } from '../src/atoms/cost.js';
import { L1Atom, INTERNAL_VALIDATION_FAILED_PREFIX } from '../src/atoms/L1Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { resetPrefilterCacheForTests } from '../src/atoms/prefilterCache.js';
import { forkBranch } from '../src/core/branchCtx.js';
import {
  JEV_ENDPOINT,
  JEV_ENV,
  JEV_EVALUATOR,
  JEV_KEY_ENV,
  JEV_ORGS_ENV,
  NEW_RECIPE,
  NO_CANDIDATE,
  createJevDecider,
  describeJevAdmission,
  jevAdmitsOrg,
  jevAsk,
  jevDeciderFromEnv,
} from '../src/core/jev.js';
import type {
  JevApprovalRequest,
  JevChoiceRequest,
  JevDecider,
  JevDecisionInfo,
  JevTwinRequest,
} from '../src/core/types.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { runTraceFile } from '../src/mcp/readers.js';
import { projectRunEnvironment } from '../src/projects/coordinator.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { gpuEventCardCopy } from '../src/viz/client-gl/renderer/copy.js';
import { translate } from '../src/viz/client/i18n-catalog.js';
import { visibleEventKindFilters } from '../src/viz/client/run-utils.js';
import type { VizEvent as ClientVizEvent } from '../src/viz/client/types.js';
import { makePlan } from './helpers/factories.js';
import { jsonText, makeCtx, nsOf } from './helpers.js';
import { ANTHROPIC_PINS, FALLBACK_OPUS } from './tier-pins.js';

/**
 * Jev takes the bounded decisions (docs/jev-decisions-2026-09-28.md): the
 * prefilter's pick, and the APPROVAL half of plan and result validation. These
 * pin what makes that safe to run: Jev only acts where it is asked, a refusal
 * or a silence hands the decision back to the model exactly as before, a
 * failing service cannot hold a run, the credential appears in nothing
 * recorded, and it crosses into a project run only for a named organisation.
 */

const KEY = 'ts-secret-key-0123456789';
const CATALOG = [
  { name: 'Water', description: 'builds and browser-validates static web pages' },
  { name: 'Methane', description: 'builds and probes Node HTTP JSON APIs' },
];

interface JevRequestBody {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;
}

function respond(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1000, output_tokens: 0 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** A fetch answering with `answers`, keeping every request body it received. */
function jevFetch(answers: Record<string, unknown>) {
  const requests: { url: string; body: JevRequestBody; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      body: JSON.parse(init?.body as string) as JevRequestBody,
      headers: init?.headers as Record<string, string>,
    });
    return respond(answers);
  }) as typeof fetch;
  return { impl, requests };
}

const pick = (choice: string, decomposable = 0.1) => ({
  choice: { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.95 } },
  decomposable: { type: 'noul', noul: decomposable },
});

/** A fetch that never answers until its signal aborts. */
const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;

const choiceRequest: JevChoiceRequest = {
  question: 'agent',
  task: { description: 'build a landing page', constraints: ['no dependencies'] },
  candidates: CATALOG,
  actorName: 'Idioblast',
  actorTier: 2,
};

/**
 * A decider that answers from fixed values and keeps what it was asked. An
 * absent value is a Jev that does not answer; `choice: null` is "none of them".
 */
function spyDecider(opts: { choice?: string | null; approve?: number; twinOf?: string | null } = {}) {
  const chosen: JevChoiceRequest[] = [];
  const approvals: JevApprovalRequest[] = [];
  const twins: JevTwinRequest[] = [];
  const decider: JevDecider = {
    twin: async (request) => {
      twins.push(request);
      if (opts.twinOf === undefined) return null;
      return { twinOf: opts.twinOf, confidence: 0.9 };
    },
    choose: async (request) => {
      chosen.push(request);
      if (opts.choice === undefined) return null;
      return { target: opts.choice, confidence: 0.9, decomposable: false };
    },
    approve: async (request) => {
      approvals.push(request);
      if (opts.approve === undefined) return null;
      return { approved: opts.approve >= 0.5, probability: opts.approve };
    },
  };
  return { decider, chosen, approvals, twins };
}

describe('jevAsk — the one Jev client', () => {
  it('posts the typed questions with the bearer credential and prices the answer', async () => {
    const { impl, requests } = jevFetch(pick('Water'));
    const result = await jevAsk({
      apiKey: KEY,
      state: { task: 'build a page' },
      questions: {
        choice: { type: 'choice', instructions: 'pick one', criteria: { Water: 'web', Methane: 'api' } },
        decomposable: { type: 'noul', instructions: 'several deliverables?' },
      },
      fetchImpl: impl,
    });
    expect(requests[0]!.url).toBe(JEV_ENDPOINT);
    expect(requests[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(requests[0]!.body.model).toBe('jev-latest');
    expect(Object.keys(requests[0]!.body.questions)).toEqual(['choice', 'decomposable']);
    expect(result.answers['choice']!.choice).toBe('Water');
    expect(result.answers['decomposable']!.noul).toBe(0.1);
    expect(result.servedModel).toBe('jev-1.13.0');
    // 1000 input tokens at 0.042 USD per million.
    expect(result.costUsd).toBeCloseTo(0.000042, 12);
  });

  it('never carries the credential in an error, even straddling the excerpt cut', async () => {
    for (const body of [`invalid token ${KEY}`, `${'x'.repeat(195)}${KEY} trailing`]) {
      const echoing = (async () => new Response(body, { status: 401 })) as typeof fetch;
      let message = '';
      try {
        await jevAsk({ apiKey: KEY, state: 's', questions: { ok: { type: 'noul', instructions: 'x' } }, fetchImpl: echoing });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('HTTP 401');
      expect(message).not.toContain(KEY.slice(0, 5));
    }
  });

  it('refuses a response missing an asked answer, and a Choice with fewer than two options', async () => {
    const empty = (async () => respond({})) as typeof fetch;
    await expect(
      jevAsk({ apiKey: KEY, state: 's', questions: { ok: { type: 'noul', instructions: 'x' } }, fetchImpl: empty })
    ).rejects.toThrow(/no noul answer for "ok"/);
    await expect(
      jevAsk({
        apiKey: KEY,
        state: 's',
        questions: { c: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } },
        fetchImpl: empty,
      })
    ).rejects.toThrow(/2 to 255 options/);
  });
});

describe('the Jev decider — choices', () => {
  it('takes a pick, asks with a none-of-these option, and records what it did', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = jevFetch(pick('Methane', 0.8));
    const decider = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl });
    const decision = await decider.choose(choiceRequest);

    // Confidence is the probability mass of the chosen candidate's description group.
    expect(decision).toEqual({ target: 'Methane', confidence: 0.95, decomposable: true });
    const body = requests[0]!.body;
    expect(Object.keys(body.questions['choice']!.criteria!)).toEqual(['Water', 'Methane', NO_CANDIDATE]);
    expect(body.state).toEqual({ task: 'build a landing page', constraints: ['no dependencies'] });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'prefilter',
      evaluator: JEV_EVALUATOR,
      candidates: ['Water', 'Methane'],
      outcome: 'picked Methane (decomposable)',
      answer: { choice: 'Methane', yes: { decomposable: 0.8 } },
      actorName: 'Idioblast',
      costUsd: 0.000042,
    });
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it('reads none-of-these as an escalate, and asks the recipe question without decomposition', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = jevFetch({
      choice: { type: 'choice', choice: NO_CANDIDATE, confidence: 0.7, probabilities: { [NO_CANDIDATE]: 0.8 } },
    });
    const decider = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl });
    const decision = await decider.choose({ ...choiceRequest, question: 'recipe' });
    expect(decision).toEqual({ target: null, confidence: 0.8, decomposable: false });
    expect(Object.keys(requests[0]!.body.questions)).toEqual(['choice']);
    expect(records[0]!.outcome).toBe(`picked ${NO_CANDIDATE}`);
  });

  it('reads a pick over identically described clones as their group, and takes the canonical first', async () => {
    // Run dbfaf275: four full-stack clones at 0.19-0.23 and a raw argmax on an
    // untrusted clone at confidence 0.15.
    const same = 'Node full-stack app builder and verifier';
    const clones: JevChoiceRequest = {
      ...choiceRequest,
      candidates: [
        { name: 'Methane', description: 'Node HTTP server builder' },
        { name: 'CarbonDioxide', description: same },
        { name: 'Ethanol', description: same },
        { name: 'Dopamine', description: same },
      ],
    };
    const records: JevDecisionInfo[] = [];
    const { impl } = jevFetch({
      choice: {
        type: 'choice',
        choice: 'Ethanol',
        confidence: 0.15,
        probabilities: { Methane: 0.09, CarbonDioxide: 0.23, Ethanol: 0.23, Dopamine: 0.21, [NO_CANDIDATE]: 0.02 },
      },
      decomposable: { type: 'noul', noul: 0.6 },
    });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(clones);
    expect(decision?.target).toBe('CarbonDioxide');
    expect(decision?.confidence).toBeCloseTo(0.67, 10);
    // 0.6 on a coupled phase is below the conservative decomposition bar.
    expect(decision?.decomposable).toBe(false);
    expect(records[0]!.outcome).toBe('picked CarbonDioxide (first of 3 identical)');
    expect(records[0]!.answer?.choice).toBe('Ethanol');
  });

  it('lets none_of_these win only when it outweighs the best description group', async () => {
    const { impl } = jevFetch({
      choice: { type: 'choice', choice: NO_CANDIDATE, confidence: 0.3, probabilities: { Water: 0.3, Methane: 0.3, [NO_CANDIDATE]: 0.4 } },
      decomposable: { type: 'noul', noul: 0.1 },
    });
    const decision = await createJevDecider({ apiKey: KEY, record: () => {}, fetchImpl: impl }).choose(choiceRequest);
    expect(decision?.target).toBeNull();
  });

  it('asks no decomposition question at L3, where a pick is only a hint', async () => {
    const { impl, requests } = jevFetch(pick('Water'));
    await createJevDecider({ apiKey: KEY, record: () => {}, fetchImpl: impl }).choose({ ...choiceRequest, actorTier: 3 });
    expect(Object.keys(requests[0]!.body.questions)).toEqual(['choice']);
  });

  it('hands back an answer that is not an option', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl } = jevFetch(pick('Ghost'));
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(
      choiceRequest
    );
    expect(decision).toBeNull();
    expect(records[0]).toMatchObject({ outcome: 'model decides', failure: 'answer "Ghost" is not an option' });
  });

  it('gives up at its timeout and hands the decision back', async () => {
    const records: JevDecisionInfo[] = [];
    const decider = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: hangingFetch, timeoutMs: 20 });
    const started = Date.now();
    expect(await decider.choose(choiceRequest)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(records[0]).toMatchObject({ outcome: 'model decides', failure: 'timeout: no answer within 20 ms', costUsd: 0 });
    // Named `failure` so no trace reader of `event.error` takes it for a run error.
    expect(records[0]).not.toHaveProperty('error');
  });

  it('stops asking after three failed calls in a run, whatever succeeded between them', async () => {
    let sent = 0;
    // Fails, succeeds, then fails for good: a success must not reset the count,
    // or a flapping service would keep a run paying timeouts.
    const flapping = (async () => {
      sent += 1;
      return sent === 2 ? respond(pick('Water')) : new Response('overloaded', { status: 529 });
    }) as typeof fetch;
    const records: JevDecisionInfo[] = [];
    const decider = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: flapping });
    await decider.choose(choiceRequest);
    await decider.choose(choiceRequest);
    // A local refusal is not the service's failure: nothing sent, nothing counted.
    await decider.choose({ ...choiceRequest, candidates: [{ name: NO_CANDIDATE, description: 'x' }] });
    await decider.choose({
      ...choiceRequest,
      candidates: Array.from({ length: 255 }, (_, i) => ({ name: `atom-${i}`, description: 'd' })),
    });
    await decider.choose(choiceRequest);
    await decider.choose(choiceRequest);
    await decider.choose(choiceRequest);
    expect(sent).toBe(4);
    expect(records.map((r) => r.failure ?? r.outcome)).toEqual([
      expect.stringMatching(/HTTP 529/),
      'picked Water',
      `a candidate is named ${NO_CANDIDATE}`,
      expect.stringMatching(/255 candidates exceed/),
      expect.stringMatching(/HTTP 529/),
      expect.stringMatching(/HTTP 529/),
      'skipped: 3 failed calls in this run',
    ]);
  });

  it('sends nothing for a run already cancelled, and tells a cancellation from a timeout', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = jevFetch(pick('Water'));
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose({
        ...choiceRequest,
        signal: cancelled.signal,
      })
    ).toBeNull();
    expect(requests).toHaveLength(0);

    const run = new AbortController();
    const pending = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: hangingFetch }).choose({
      ...choiceRequest,
      signal: run.signal,
    });
    setTimeout(() => run.abort(), 10);
    expect(await pending).toBeNull();
    expect(records.map((r) => r.failure)).toEqual(['aborted: the run was cancelled', 'aborted: the run was cancelled']);
  });

  it('still answers when its recorder throws', async () => {
    const decider = createJevDecider({
      apiKey: KEY,
      record: () => {
        throw new Error('disk full');
      },
      fetchImpl: jevFetch(pick('Water')).impl,
    });
    expect(await decider.choose(choiceRequest)).toMatchObject({ target: 'Water' });
  });
});

describe('the Jev decider — approvals', () => {
  const approvalRequest: JevApprovalRequest = {
    subject: 'RESULT',
    task: { description: 'build an API' },
    child: { name: 'Methane', tier: 1, tools: ['write_file', 'fetch_url'] },
    // An output long enough to have pushed the summary out of a single cap.
    payload: { output: 'o'.repeat(30_000), summary: 'all routes probed' },
    // 800 observations (past the evidence cap), the newest being the failure that matters.
    evidence: [
      ...Array.from({ length: 799 }, (_, i) => ({ tool: 'fetch_url', status: 200, n: i })),
      { tool: 'validate_html', ok: false, consoleErrors: 3 },
    ],
    groundTruth: 'GROUND TRUTH: server.js exists',
    actorName: 'Idioblast',
    actorTier: 2,
  };

  it('approves at its own yes, and sends a bounded state naming the child and its tools', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = jevFetch({ acceptable: { type: 'noul', noul: 0.83 } });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).approve(
      approvalRequest
    );
    expect(decision).toEqual({ approved: true, probability: 0.83 });
    const state = requests[0]!.body.state;
    expect(state['child']).toEqual({ name: 'Methane', tier: 1, declaredTools: ['write_file', 'fetch_url'] });
    const shown = state['result'] as { summary: string; output: string };
    expect(shown.summary).toBe('all routes probed');
    expect(shown.output).toMatch(/\[truncated\]$/);
    // Newest observations first: the late failure is shown, the oldest are not.
    const evidence = state['evidence'] as unknown[];
    expect(evidence[evidence.length - 1]).toEqual({ tool: 'validate_html', ok: false, consoleErrors: 3 });
    expect(evidence[0]).toMatch(/older observations omitted/);
    expect(state['groundTruth']).toBe('GROUND TRUTH: server.js exists');
    expect(records[0]).toMatchObject({ role: 'validate-result', outcome: 'approved', childName: 'Methane' });
  });

  it('defers a no to the model, and a failure too', async () => {
    const records: JevDecisionInfo[] = [];
    const no = jevFetch({ acceptable: { type: 'noul', noul: 0.2 } });
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: no.impl }).approve({
        ...approvalRequest,
        subject: 'PLAN',
      })
    ).toEqual({ approved: false, probability: 0.2 });
    const refusing = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: refusing }).approve(approvalRequest)
    ).toBeNull();
    expect(records.map((r) => [r.role, r.outcome])).toEqual([
      ['validate-plan', 'deferred to the model'],
      ['validate-result', 'deferred to the model'],
    ]);
  });

  it('is present only with both the switch and the credential in the snapshot', () => {
    const record = (): void => {};
    expect(jevDeciderFromEnv({}, record)).toBeUndefined();
    expect(jevDeciderFromEnv({ [JEV_ENV]: '1' }, record)).toBeUndefined();
    expect(jevDeciderFromEnv({ [JEV_KEY_ENV]: KEY }, record)).toBeUndefined();
    expect(jevDeciderFromEnv({ [JEV_ENV]: 'true', [JEV_KEY_ENV]: KEY }, record)).toBeUndefined();
    expect(jevDeciderFromEnv({ [JEV_ENV]: '1', [JEV_KEY_ENV]: KEY }, record)).toBeDefined();
  });
});

describe('prefilterStrategy with Jev', () => {
  let dir: string;
  let cacheBefore: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atoma-jev-'));
    cacheBefore = process.env['ATOMA_PREFILTER_CACHE'];
    process.env['ATOMA_PREFILTER_CACHE'] = '0';
    resetPrefilterCacheForTests();
  });
  afterEach(() => {
    if (cacheBefore === undefined) delete process.env['ATOMA_PREFILTER_CACHE'];
    else process.env['ATOMA_PREFILTER_CACHE'] = cacheBefore;
    resetPrefilterCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes Jev's pick as a high-confidence reuse, with no model call", async () => {
    const { decider, chosen } = spyDecider({ choice: 'Methane' });
    const ctx = { ...makeCtx(), jev: decider };
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 'build an API' },
      catalog: CATALOG,
      actor: { name: 'Idioblast', tier: 2 },
    });
    expect(outcome).toMatchObject({ kind: 'reuse', target: 'Methane', confidence: 'high', decomposable: false });
    expect(ctx.llm.calls).toHaveLength(0);
    expect(chosen[0]).toMatchObject({ question: 'agent', actorName: 'Idioblast', actorTier: 2 });
  });

  it("takes Jev's none-of-these as an escalate, with no model call", async () => {
    const ctx = { ...makeCtx(), jev: spyDecider({ choice: null }).decider };
    const outcome = await prefilterStrategy({ ctx, task: { description: 'x' }, catalog: CATALOG });
    expect(outcome?.kind).toBe('escalate');
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('lets the model decide exactly as before when Jev does not answer or throws', async () => {
    const silent = { ...makeCtx(), jev: spyDecider().decider };
    silent.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'web' }));
    expect(await prefilterStrategy({ ctx: silent, task: { description: 'x' }, catalog: CATALOG })).toMatchObject({
      kind: 'reuse',
      target: 'Water',
      reasoning: 'web',
    });
    expect(silent.llm.calls).toHaveLength(1);

    const broken: JevDecider = {
      choose: () => Promise.reject(new Error('exploded')),
      approve: () => Promise.reject(new Error('exploded')),
      twin: () => Promise.reject(new Error('exploded')),
    };
    const throwing = { ...makeCtx(), jev: broken };
    throwing.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'no fit' }));
    expect(await prefilterStrategy({ ctx: throwing, task: { description: 'x' }, catalog: CATALOG })).toMatchObject({
      kind: 'escalate',
      reasoning: 'no fit',
    });
  });

  it('asks the recipe question for the skill prefilter, never offering an excluded candidate', async () => {
    const { decider, chosen } = spyDecider({ choice: 'Water' });
    await prefilterStrategy({
      ctx: { ...makeCtx(), jev: decider },
      task: { description: 'x' },
      catalog: CATALOG,
      exclude: new Set(['Methane']),
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
    });
    expect(chosen[0]!.question).toBe('recipe');
    expect(chosen[0]!.candidates.map((c) => c.name)).toEqual(['Water']);
  });

  it('serves a cached model decision before asking Jev, and never caches a Jev decision', async () => {
    process.env['ATOMA_PREFILTER_CACHE'] = join(dir, 'cache.db');
    resetPrefilterCacheForTests();
    const modelOnly = makeCtx();
    modelOnly.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'web' }));
    await prefilterStrategy({ ctx: modelOnly, task: { description: 'cached' }, catalog: CATALOG });

    const { decider, chosen } = spyDecider({ choice: 'Methane' });
    const replay = await prefilterStrategy({ ctx: { ...makeCtx(), jev: decider }, task: { description: 'cached' }, catalog: CATALOG });
    expect(replay).toMatchObject({ target: 'Water' });
    expect(chosen).toHaveLength(0);

    const jevDecided = await prefilterStrategy({ ctx: { ...makeCtx(), jev: decider }, task: { description: 'fresh' }, catalog: CATALOG });
    expect(jevDecided).toMatchObject({ target: 'Methane' });
    const after = makeCtx();
    after.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'model' }));
    expect(await prefilterStrategy({ ctx: after, task: { description: 'fresh' }, catalog: CATALOG })).toMatchObject({
      kind: 'escalate',
      reasoning: 'model',
    });
    expect(after.llm.calls).toHaveLength(1);
  });

  it('decides inside forks, recording the innermost lane', async () => {
    const records: JevDecisionInfo[] = [];
    const root = {
      ...makeCtx(),
      jev: createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: jevFetch(pick('Water')).impl }),
    };
    const inner = forkBranch(forkBranch(root, 'outer'), 'inner');
    expect(inner.jev).toBeDefined();
    const outcome = await prefilterStrategy({ ctx: inner, task: { description: 'x' }, catalog: CATALOG });
    expect(outcome).toMatchObject({ kind: 'reuse', target: 'Water' });
    expect(records[0]!.branchId).toBe('inner');
  });
});

describe('validation with Jev', () => {
  const seed = { description: 'seed', systemPrompt: 'sys', tools: [], params: {}, createdBy: 'test' };
  const plan = makePlan({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' });
  const result = { output: 'x', summary: 's', trace: [], producedBy: { tier: 1 as const, name: 'Water', viaFallback: false } };

  function untrustedL2() {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    reg.create(1, seed); // zero successes: no trust fast path
    return { l2: L2Atom.fromType(reg.getByName('Tracheid')!, reg), l1: L1Atom.fromType(reg.getByName('Water')!) };
  }

  it('L2 approves a plan and a result on Jev yes, with no model call', async () => {
    const { l2, l1 } = untrustedL2();
    const { decider, approvals } = spyDecider({ approve: 0.9 });
    const ctx = { ...makeCtx(), jev: decider };
    const vp = await l2.validatePlan(l1, plan, { description: 't' }, ctx);
    const vr = await l2.validateResult(l1, result, { description: 't' }, ctx);
    expect(vp).toMatchObject({ approved: true, reasoning: expect.stringMatching(/jev fast-path/) });
    expect(vr).toMatchObject({ approved: true, reasoning: expect.stringMatching(/jev fast-path/) });
    expect(ctx.llm.calls).toHaveLength(0);
    expect(approvals.map((a) => [a.subject, a.child.name, a.actorName])).toEqual([
      ['PLAN', 'Water', 'Tracheid'],
      ['RESULT', 'Water', 'Tracheid'],
    ]);
  });

  it('L2 hands a Jev no — or silence — to the model validator', async () => {
    for (const approve of [0.2, undefined]) {
      const { l2, l1 } = untrustedL2();
      const ctx = { ...makeCtx(), jev: spyDecider(approve === undefined ? {} : { approve }).decider };
      ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'model verdict' }));
      const verdict = await l2.validatePlan(l1, plan, { description: 't' }, ctx);
      expect(verdict).toMatchObject({ approved: true, reasoning: 'model verdict' });
      expect(ctx.llm.calls).toHaveLength(1);
    }
  });

  it('L2 never asks Jev about a result the mechanical gates rejected', async () => {
    const { l2, l1 } = untrustedL2();
    const { decider, approvals } = spyDecider({ approve: 0.99 });
    const ctx = { ...makeCtx(), jev: decider };
    const verdict = await l2.validateResult(
      l1,
      { ...result, summary: `${INTERNAL_VALIDATION_FAILED_PREFIX}: API request failed` },
      { description: 't' },
      ctx
    );
    expect(verdict.approved).toBe(false);
    expect(approvals).toHaveLength(0);
  });

  /** An L2 over an untrusted file-writing child whose workspace holds `files`. */
  function probedL2(files: Record<string, string>) {
    const reg = new AtomRegistry(openDb(':memory:'));
    reg.create(2, seed);
    const fileTools = ['write_file', 'read_file', 'list_files'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: {} },
    }));
    const l1Type = reg.create(1, { ...seed, tools: fileTools });
    const calls: string[] = [];
    const tools = {
      has: (name: string) => ['read_file', 'list_files', 'write_file'].includes(name),
      execute: async (name: string, args: Record<string, unknown>) => {
        calls.push(name);
        if (name === 'read_file') {
          const path = String(args['path']);
          if (!(path in files)) throw new Error(`ENOENT: no such file "${path}"`);
          return { path, content: files[path] };
        }
        if (name === 'list_files') {
          return { path: '.', entries: Object.entries(files).map(([n, c]) => ({ name: n, kind: 'file', size: c.length })) };
        }
        return { ok: true };
      },
    };
    return {
      l2: L2Atom.fromType(reg.getByName('Tracheid')!, reg),
      l1: L1Atom.fromType(reg.getByName(l1Type.name)!),
      tools,
      calls,
    };
  }

  it('L2 never asks Jev when the ground truth contradicts the result', async () => {
    const { l2, l1, tools } = probedL2({ 'index.js': 'x' });
    const { decider, approvals } = spyDecider({ approve: 0.99 });
    const ctx = { ...makeCtx(), tools, jev: decider };
    ctx.llm.enqueueText(JSON.stringify({ approved: false, reasoning: 'README missing' }));
    const verdict = await l2.validateResult(
      l1,
      { ...result, output: { files: ['index.js', 'README.md'] }, summary: 'wrote both' },
      { description: 'write files' },
      ctx
    );
    expect(approvals).toHaveLength(0);
    expect(verdict.approved).toBe(false);
    expect(ctx.llm.calls).toHaveLength(1);
  });

  it('L2 never asks Jev when a declared proof obligation is uncovered', async () => {
    const { l2, l1 } = untrustedL2();
    const { decider, approvals } = spyDecider({ approve: 0.99 });
    const ctx = { ...makeCtx(), jev: decider };
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'model verdict' }));
    const verdict = await l2.validateResult(
      l1,
      result,
      { description: 'click the button', proofObligations: ['dom-interaction'] },
      ctx
    );
    expect(approvals).toHaveLength(0);
    expect(verdict).toMatchObject({ approved: true, proofUncovered: true });
  });

  it('L2 hands a Jev no on a result to the model with the probe it already ran', async () => {
    const { l2, l1, tools, calls } = probedL2({ 'index.js': 'x' });
    const { decider, approvals } = spyDecider({ approve: 0.1 });
    const ctx = { ...makeCtx(), tools, jev: decider };
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'model verdict' }));
    const verdict = await l2.validateResult(
      l1,
      { ...result, output: { path: 'index.js' }, summary: 'wrote it' },
      { description: 'write a file' },
      ctx
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.groundTruth).toMatch(/index\.js/);
    expect(verdict).toMatchObject({ approved: true, reasoning: 'model verdict' });
    expect(ctx.llm.calls).toHaveLength(1);
    // One probe: the block Jev saw is the block the model received.
    expect(calls.filter((c) => c === 'read_file')).toHaveLength(1);
  });

  it('marks a Jev approval so no recipe is learned from it', async () => {
    const { l2, l1 } = untrustedL2();
    const ctx = { ...makeCtx(), jev: spyDecider({ approve: 0.9 }).decider };
    const verdict = await l2.validateResult(l1, result, { description: 't' }, ctx);
    expect(verdict).toMatchObject({ approved: true, viaJev: true });
  });

  it('L3 approves a cell plan and result on Jev yes, with no model call', async () => {
    const reg = new AtomRegistry(openDb(':memory:'));
    const l3 = L3Atom.buildWithModel(reg.create(3, seed), reg, FALLBACK_OPUS);
    const l2 = L2Atom.fromType(reg.create(2, seed), reg);
    const ctx = { ...makeCtx(), jev: spyDecider({ approve: 0.9 }).decider };
    const vp = await l3.validatePlan(l2, plan, { description: 't' }, ctx);
    const vr = await l3.validateResult(
      l2,
      { output: 'x', summary: 's', trace: [], producedBy: { tier: 2, name: l2.name, viaFallback: false } },
      { description: 't' },
      ctx
    );
    expect(vp.approved).toBe(true);
    expect(vr.approved).toBe(true);
    expect(ctx.llm.calls).toHaveLength(0);
  });

  it('jevApproval is a no-op without a decider', async () => {
    const ctx = makeCtx();
    const child = { name: 'Water', tier: 1 as const, toolNames: () => [] };
    expect(
      await jevApproval({ ctx, subject: 'PLAN', supervisorName: 'T', supervisorTier: 2, child, task: { description: 't' }, payload: {} })
    ).toBeNull();
  });
});

describe('the Jev decider — twins', () => {
  const twinRequest: JevTwinRequest = {
    kind: 'event',
    draft: {
      id: 'recover-missing-evidence',
      description: 'paste evidence on retry',
      whenToUse: 'validator rejects narrative-only summaries lacking evidence',
      body: 'Re-run the probes and paste their outputs.',
    },
    existing: [
      { id: 'recover-recorded-verification-evidence', description: 'capture verification output', whenToUse: 'narrative-only summaries' },
      { id: 'recover-undeclared-server-stop', description: 'no stop tool', whenToUse: 'plan proposes stopping a server' },
    ],
    actorName: 'Tracheid',
    actorTier: 2,
  };

  it('names the existing recipe a draft duplicates, asking over the existing ones plus new_recipe', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = jevFetch({
      choice: {
        type: 'choice',
        choice: 'recover-recorded-verification-evidence',
        confidence: 0.8,
        probabilities: { 'recover-recorded-verification-evidence': 0.85 },
      },
    });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).twin(twinRequest);
    expect(decision).toEqual({ twinOf: 'recover-recorded-verification-evidence', confidence: 0.8 });
    expect(Object.keys(requests[0]!.body.questions['choice']!.criteria!)).toEqual([
      'recover-recorded-verification-evidence',
      'recover-undeclared-server-stop',
      NEW_RECIPE,
    ]);
    expect(records[0]).toMatchObject({
      role: 'learn-event-skill',
      outcome: 'not saved: twin of recover-recorded-verification-evidence',
    });
  });

  it('reads new_recipe as a new recipe, asks nothing when there is nothing to duplicate, and fails open', async () => {
    const newOne = jevFetch({ choice: { type: 'choice', choice: NEW_RECIPE, confidence: 0.7, probabilities: { [NEW_RECIPE]: 0.8 } } });
    const records: JevDecisionInfo[] = [];
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: newOne.impl }).twin(twinRequest)
    ).toEqual({ twinOf: null, confidence: 0.7 });

    const none = jevFetch(pick('Water'));
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: none.impl }).twin({ ...twinRequest, existing: [] })
    ).toBeNull();
    expect(none.requests).toHaveLength(0);

    const refusing = (async () => new Response('down', { status: 503 })) as typeof fetch;
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: refusing }).twin(twinRequest)
    ).toBeNull();
    expect(records.map((r) => r.outcome)).toEqual(['saved: new recipe', 'saved as before']);
  });

  it('keeps a recovery recipe Jev judges a twin out of the catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atoma-jev-twin-'));
    const learnBefore = process.env['ATOMA_SKILL_LEARN'];
    try {
      process.env['ATOMA_SKILL_LEARN'] = '1';
      const skills = new SkillRegistry(dir);
      const reg = new AtomRegistry(openDb(':memory:'));
      const seed = { description: 'seed', systemPrompt: 'sys', tools: [], params: {}, createdBy: 'test' };
      reg.create(2, seed);
      reg.create(1, { ...seed, description: 'web builder', systemPrompt: 'You are an L1.' });
      // An existing recovery recipe whose trigger does NOT match the rejection
      // below, so it is not injected and the run counts as a novel event.
      skills.save(nsOf(reg, 'Water'), {
        id: 'recover-old',
        description: 'capture evidence',
        whenToUse: 'plan omits a reload persistence check',
        kind: 'llm',
        trigger: 'plan omits a reload persistence check',
        body: 'Add the check.',
      });
      const { decider, twins } = spyDecider({ twinOf: 'recover-old' });
      const neuron = L2Atom.fromType(reg.getByName('Tracheid')!, reg, [], skills);
      const ctx = { ...makeCtx(), jev: decider };
      ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 't' }));
      const execute = (payload: unknown) =>
        ctx.llm.enqueue((req) => {
          req.onToolInvocation?.({ name: 'write_file', args: { path: 'a.txt' }, result: { ok: true }, durationMs: 1, startedAt: Date.now() });
          return { text: jsonText(payload), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
        });
      ctx.llm.enqueueText(jsonText({ reasoning: 'r', proposedAction: 'a', expectedOutput: 'e' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
      execute({ output: 'draft', summary: 'first attempt' });
      ctx.llm.enqueueText(jsonText({ approved: false, reasoning: 'RESULT is missing the ground-truth evidence block', scope: 'ephemeral' }));
      ctx.llm.enqueueText(jsonText({ reasoning: 'r2', proposedAction: 'a2', expectedOutput: 'e2' }));
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'plan ok' }));
      execute({ output: 'fixed', summary: 'second attempt with evidence' });
      ctx.llm.enqueueText(jsonText({ approved: true, reasoning: 'ok now' }));
      ctx.llm.enqueueText('not json, no task skill');
      ctx.llm.enqueueText(
        jsonText({
          id: 'recover-missing-evidence',
          trigger: 'validator rejects result missing ground-truth evidence',
          description: 'paste evidence on retry',
          body: 'Re-run the probe and paste its output.',
        })
      );

      await neuron.handleDirect({ description: 'build a page' }, ctx);

      const ids = skills.loadFor(nsOf(reg, 'Water')).map((s) => s.id);
      expect(ids).toEqual(['recover-old']);
      expect(twins.map((t) => [t.kind, t.draft.id, t.existing.map((e) => e.id)])).toEqual([
        ['event', 'recover-missing-evidence', ['recover-old']],
      ]);
    } finally {
      if (learnBefore === undefined) delete process.env['ATOMA_SKILL_LEARN'];
      else process.env['ATOMA_SKILL_LEARN'] = learnBefore;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('who lets Jev decide', () => {
  const HOST = {
    PATH: '/bin',
    ...ANTHROPIC_PINS,
    ANTHROPIC_API_KEY: 'host-key',
    [JEV_KEY_ENV]: KEY,
    [JEV_ORGS_ENV]: 'org-a, org-b',
    // A host-level switch must never reach a tenant run by itself.
    [JEV_ENV]: '1',
  };
  const BASE = {
    dbPath: '/control/atoma.db',
    workspacePath: '/control/workspace',
    runsPath: '/control/runs',
    skillsPath: '/control/skills',
    runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31',
    artifactManifestPath: '/control/manifest.json',
  };

  it('says at boot whether the host lets Jev decide, and why not', () => {
    const org = 'd28f40d2-14d7-45c7-bce3-928dcb0041a6';
    expect(describeJevAdmission({})).toBeNull();
    expect(describeJevAdmission({ [JEV_KEY_ENV]: KEY })).toMatch(/off .*names no organisation/);
    expect(describeJevAdmission({ [JEV_ORGS_ENV]: org })).toMatch(/off .*TYPESAFE_API_KEY is absent/);
    expect(describeJevAdmission({ [JEV_KEY_ENV]: KEY, [JEV_ORGS_ENV]: `${org}, my-org-slug` })).toBe(
      `jev: deciding in project runs of 1 organisation(s) (${JEV_EVALUATOR}); ` +
        'not organisation ids, so they match no run: my-org-slug'
    );
    expect(JSON.stringify(describeJevAdmission({ [JEV_KEY_ENV]: KEY, [JEV_ORGS_ENV]: org }))).not.toContain(KEY);
  });

  it('admits an organisation only when the host holds the key and names it', () => {
    expect(jevAdmitsOrg(HOST, 'org-a')).toBe(true);
    expect(jevAdmitsOrg(HOST, 'org-b')).toBe(true);
    expect(jevAdmitsOrg(HOST, 'org-c')).toBe(false);
    expect(jevAdmitsOrg(HOST, undefined)).toBe(false);
    expect(jevAdmitsOrg({ ...HOST, [JEV_KEY_ENV]: ' ' }, 'org-a')).toBe(false);
    expect(jevAdmitsOrg({ ...HOST, [JEV_ORGS_ENV]: '' }, 'org-a')).toBe(false);
  });

  it('forwards the key and the switch into an admitted project run, and nothing into any other', () => {
    const admitted = projectRunEnvironment({ ...BASE, hostEnv: HOST, orgId: 'org-a' }).environment;
    expect(admitted[JEV_KEY_ENV]).toBe(KEY);
    expect(admitted[JEV_ENV]).toBe('1');
    expect(admitted[JEV_ORGS_ENV]).toBeUndefined();

    for (const orgId of ['org-c', undefined]) {
      const other = projectRunEnvironment({ ...BASE, hostEnv: HOST, ...(orgId ? { orgId } : {}) }).environment;
      expect(other[JEV_KEY_ENV]).toBeUndefined();
      expect(other[JEV_ENV]).toBeUndefined();
    }
  });
});

describe('the jev trace event', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-trace-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  it('is recorded with its own cost and stays out of the run LLM totals', () => {
    const recorder = new TraceRecorder(runsDir);
    recorder.beginRun({ description: 'goal' });
    recorder.recordJevDecision({
      role: 'validate-result',
      evaluator: JEV_EVALUATOR,
      answer: { yes: { acceptable: 0.83 } },
      outcome: 'approved',
      durationMs: 180,
      usage: { inputTokens: 1000, outputTokens: 0 },
      costUsd: 0.000042,
      actorName: 'Idioblast',
      actorTier: 2,
      childName: 'Methane',
      branchId: 'b1',
    });
    const run = recorder.endRun()!;
    expect(run.events.find((e) => e.kind === 'jev')).toMatchObject({
      kind: 'jev',
      outcome: 'approved',
      actor: { name: 'Idioblast', tier: 2 },
      child: { name: 'Methane' },
      branchId: 'b1',
      costUsd: 0.000042,
    });
    expect(run.totals).toMatchObject({ calls: 0, costUsd: 0 });
  });

  it('shows its outcome and failure in the MCP trace summary', () => {
    const recorder = new TraceRecorder(runsDir);
    const run = recorder.beginRun({ description: 'goal' });
    const base = {
      evaluator: JEV_EVALUATOR,
      durationMs: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
    };
    recorder.recordJevDecision({ ...base, role: 'prefilter', outcome: 'picked Methane' });
    recorder.recordJevDecision({ ...base, role: 'validate-result', outcome: 'deferred to the model', failure: 'timeout: no answer within 2000 ms' });
    recorder.endRun();
    const summary = runTraceFile(join(runsDir, `${run.id}.json`), {}) as { events: Record<string, unknown>[] };
    const jevEvents = summary.events.filter((e) => e['kind'] === 'jev');
    expect(jevEvents.map((e) => [e['role'], e['outcome'], e['failure']])).toEqual([
      ['prefilter', 'picked Methane', undefined],
      ['validate-result', 'deferred to the model', 'timeout: no answer within 2000 ms'],
    ]);
    // The failure never masquerades as an event error.
    expect(jevEvents.every((e) => e['error'] === undefined)).toBe(true);
  });
});

describe('the jev card in the run view', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-card-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  const t = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);

  /**
   * The card reads the outcome strings the decider writes, so these go through
   * the real decider and the real recorder rather than hand-written events: a
   * reworded outcome in `jev.ts` must fail here, not blank a badge in production.
   */
  async function cardsFor(ask: (decider: JevDecider) => Promise<unknown>, answers: Record<string, unknown>) {
    const recorder = new TraceRecorder(runsDir);
    recorder.beginRun({ description: 'goal' });
    const { impl } = jevFetch(answers);
    await ask(createJevDecider({ apiKey: KEY, record: (info) => recorder.recordJevDecision(info), fetchImpl: impl }));
    return jevEventsOf(recorder).map((event) => gpuEventCardCopy(event, t));
  }

  /** What the client receives: the recorded events, as JSON off the wire. */
  function jevEventsOf(recorder: TraceRecorder): ClientVizEvent[] {
    const events = JSON.parse(JSON.stringify(recorder.endRun()!.events)) as ClientVizEvent[];
    return events.filter((event) => event.kind === 'jev');
  }

  const approval: JevApprovalRequest = {
    subject: 'RESULT',
    task: { description: 'build an API' },
    child: { name: 'Methane', tier: 1, tools: ['write_file'] },
    payload: { output: 'done', summary: 'routes probed' },
    actorName: 'Idioblast',
    actorTier: 2,
  };
  const twin: JevTwinRequest = {
    kind: 'task',
    draft: { id: 'serve-api', description: 'serve an API', whenToUse: 'api goals', body: 'steps' },
    existing: [{ id: 'serve-json-api', description: 'serve a JSON API', whenToUse: 'api goals' }],
    actorName: 'Idioblast',
    actorTier: 2,
  };

  it('names the decision, the pick and what it cost', async () => {
    const [card] = await cardsFor((d) => d.choose(choiceRequest), pick('Methane'));
    expect(card).toMatchObject({ title: 'Jev · prefilter', decision: '→ Methane', body: 'picked Methane' });
    expect(card!.meta).toContain('L2 Idioblast');
    expect(card!.footer).toMatch(/^jev-1\.13\.0 · conf 90% · \d+ms · \$0\.0000 · /);
  });

  it('badges an approval, and a lukewarm yes as the model deciding', async () => {
    const [approved] = await cardsFor((d) => d.approve(approval), { acceptable: { type: 'noul', noul: 0.83 } });
    expect(approved).toMatchObject({ title: 'Jev · validate-result', decision: '✓ approved' });
    expect(approved!.footer).toContain('p 83%');
    const [deferred] = await cardsFor((d) => d.approve(approval), { acceptable: { type: 'noul', noul: 0.2 } });
    expect(deferred).toMatchObject({ decision: '↑ model decides', body: 'deferred to the model' });
  });

  it('badges none-of-these as an escalation', async () => {
    const [card] = await cardsFor((d) => d.choose(choiceRequest), {
      choice: { type: 'choice', choice: NO_CANDIDATE, confidence: 0.7, probabilities: { [NO_CANDIDATE]: 0.8 } },
      decomposable: { type: 'noul', noul: 0.1 },
    });
    expect(card!.decision).toBe('↑ escalate');
  });

  it('badges a twin verdict both ways', async () => {
    const [duplicate] = await cardsFor((d) => d.twin(twin), {
      choice: { type: 'choice', choice: 'serve-json-api', confidence: 0.8, probabilities: { 'serve-json-api': 0.85 } },
    });
    expect(duplicate).toMatchObject({ title: 'Jev · learn-skill', decision: '✕ duplicate recipe' });
    const [fresh] = await cardsFor((d) => d.twin(twin), {
      choice: { type: 'choice', choice: NEW_RECIPE, confidence: 0.8, probabilities: { [NEW_RECIPE]: 0.85 } },
    });
    expect(fresh!.decision).toBe('✓ new recipe');
  });

  it('shows why Jev did not answer, without calling it a run error', async () => {
    const recorder = new TraceRecorder(runsDir);
    recorder.beginRun({ description: 'goal' });
    const decider = createJevDecider({
      apiKey: KEY,
      record: (info) => recorder.recordJevDecision(info),
      fetchImpl: hangingFetch,
      timeoutMs: 5,
    });
    await decider.approve(approval);
    const [event] = jevEventsOf(recorder);
    const card = gpuEventCardCopy(event!, t);
    expect(card.decision).toBe('↑ model decides');
    expect(card.body).toMatch(/^deferred to the model · timeout/);
  });

  it('offers a Jev filter only on a run Jev decided for', () => {
    const without = [{ id: 'l1', kind: 'llm', ts: 1 }];
    expect(visibleEventKindFilters(without)).not.toContain('jev');
    expect(visibleEventKindFilters([...without, { id: 'j1', kind: 'jev', ts: 2 }])).toContain('jev');
  });
});
