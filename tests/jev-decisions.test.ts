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
  JEV_PROGRESSIVE_ENV,
  NEW_RECIPE,
  NO_CANDIDATE,
  createJevDecider,
  describeJevAdmission,
  jevAsk,
  jevDeciderFromEnv,
  jevEnabled,
} from '../src/core/jev.js';
import { JEV_THRESHOLDS } from '../src/core/jevQuestions.js';
import type {
  JevApprovalRequest,
  JevChoiceRequest,
  JevCompilationRequest,
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
 * pin what makes that safe to run: Jev only acts where it is asked, and only
 * on answers the questions' thresholds read as clear; a refusal, an uncertain
 * answer or a silence hands the decision back to the model exactly as before;
 * a failing service cannot hold a run; the credential appears in nothing
 * recorded; and it crosses into a project run only for a named organisation.
 */

const KEY = 'ts-secret-key-0123456789';
const CATALOG = [
  { name: 'Water', description: 'builds and browser-validates static web pages' },
  { name: 'Methane', description: 'builds and probes Node HTTP JSON APIs' },
];

interface QuestionBody {
  type: 'choice' | 'noul' | 'score';
  instructions: unknown;
  criteria?: unknown;
}

interface JevRequestBody {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, QuestionBody>;
}

function respond(answers: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1000, output_tokens: 0 } }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...headers } }
  );
}

/** A clear answer of the question's type: a confident first option, a low noul, the lowest level. */
function defaultAnswer(question: QuestionBody): unknown {
  if (question.type === 'noul') return { type: 'noul', noul: 0.05 };
  if (question.type === 'score') {
    return { type: 'score', score: 0, confidence: 0.95, probabilities: { '0': 0.97, '1': 0.03, '2': 0 } };
  }
  const first = Object.keys(question.criteria as Record<string, unknown>)[0]!;
  return { type: 'choice', choice: first, confidence: 0.95, probabilities: { [first]: 0.97 } };
}

const choiceAnswer = (choice: string, probability = 0.95, confidence = probability) => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: { [choice]: probability },
});
const noulAnswer = (noul: number) => ({ type: 'noul', noul });
const scoreAnswer = (score: number, confidence = 0.9) => ({ type: 'score', score, confidence, probabilities: {} });

/**
 * A fetch that answers EVERY question asked — `answer(id, question)` when it
 * returns something, a clear default otherwise — keeping each request.
 */
function jevServer(answer: (id: string, question: QuestionBody) => unknown = () => undefined) {
  const requests: { url: string; body: JevRequestBody; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as JevRequestBody;
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      body,
      headers: init?.headers as Record<string, string>,
    });
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) answers[id] = answer(id, question) ?? defaultAnswer(question);
    return respond(answers);
  }) as typeof fetch;
  return { impl, requests };
}

/** Answers keyed by question id; anything unlisted gets the clear default. */
const answering = (answers: Record<string, unknown>) => jevServer((id) => answers[id]);

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

describe('Jev compilation eligibility', () => {
  const request: JevCompilationRequest = {
    skillId: 'replay-recorded-probes', prompt: 'Read the manifest and compare the recorded probes; refuse a mismatch.',
    allowLoopbackNetwork: false, actorName: 'Tracheid', actorTier: 2,
  };

  it.each([
    [0.05, true], [0.2, true], [0.5, null], [0.8, false], [0.95, false],
  ] as const)('reads obstacle probability %s as %s and records its own cost', async (probability, expected) => {
    const { impl, requests } = jevServer(() => noulAnswer(probability));
    const records: JevDecisionInfo[] = [];
    const decider = createJevDecider({ apiKey: KEY, fetchImpl: impl, record: (event) => records.push(event) });
    const answer = await decider.compilable!(request);
    expect(answer?.compilable ?? null).toBe(expected);
    expect(requests[0]!.body.state['compile_request']).toBe(request.prompt);
    expect(requests[0]!.body.state['runtime']).toMatchObject({ direct_loopback_network: false, tool_rpc: false });
    expect(records[0]).toMatchObject({ role: 'compile-skill', actorName: 'Tracheid', candidates: [request.skillId] });
    expect(records[0]!.costUsd).toBeGreaterThan(0);
  });

  it('postpones on one clear obstacle, never from a majority vote', async () => {
    const { impl } = answering({ semantic_judgment: noulAnswer(0.05), unavailable_capability: noulAnswer(0.95), unspecified_inputs: noulAnswer(0.1) });
    const answer = await createJevDecider({ apiKey: KEY, fetchImpl: impl, record: () => {} }).compilable!(request);
    expect(answer).toEqual({ compilable: false, obstacles: ['unavailable_capability'] });
  });

  it('does not cache a no and defers errors, cancellation, malformed or incomplete answers to the compiler', async () => {
    const { impl, requests } = jevServer(() => noulAnswer(0.95));
    const decider = createJevDecider({ apiKey: KEY, fetchImpl: impl, record: () => {} });
    await decider.compilable!(request);
    await decider.compilable!(request);
    expect(requests).toHaveLength(2);
    expect(await decider.compilable!({ ...request, signal: AbortSignal.abort() })).toBeNull();
    expect(requests).toHaveLength(2);
    for (const invalid of [noulAnswer(1.2), { type: 'choice', choice: 'yes' }]) {
      const server = jevServer(() => invalid);
      expect(await createJevDecider({ apiKey: KEY, fetchImpl: server.impl, record: () => {} }).compilable!(request)).toBeNull();
    }
    expect(await createJevDecider({ apiKey: KEY, fetchImpl: hangingFetch, timeoutMs: 10, record: () => {} }).compilable!(request)).toBeNull();
  });

  it('hands an oversized recipe to the compiler instead of judging an excerpt', async () => {
    const { impl, requests } = jevServer();
    const decider = createJevDecider({ apiKey: KEY, fetchImpl: impl, record: () => {} });
    expect(await decider.compilable!({ ...request, prompt: 'x'.repeat(32_001) })).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

/** In CATALOG order: agent_1 is Water, agent_2 is Methane. */
const pickMethane = { choice: choiceAnswer('agent_2'), 'fits::agent_2': noulAnswer(0.9), 'fits::agent_1': noulAnswer(0.2) };

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
    const { impl, requests } = answering({ choice: choiceAnswer('Water'), decomposable: noulAnswer(0.1) });
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
    // The versioned id, never the moving alias: thresholds are measured on it.
    expect(requests[0]!.body.model).toBe('jev-1.13.0');
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

  it.each([-0.1, 1.1])('refuses out-of-range probability %s at the transport boundary', async value => {
    for (const answer of [noulAnswer(value), { type: 'noul', noul: 0.1, confidence: value },
      { type: 'noul', noul: 0.1, probabilities: { yes: value } }]) {
      await expect(jevAsk({ apiKey: KEY, state: 's', questions: { ok: { type: 'noul', instructions: 'x' } },
        fetchImpl: async () => respond({ ok: answer }) })).rejects.toThrow();
    }
  });

  it('refuses a missing answer, one of another type, and out-of-bounds Choices and Scores', async () => {
    const empty = (async () => respond({})) as typeof fetch;
    await expect(
      jevAsk({ apiKey: KEY, state: 's', questions: { ok: { type: 'noul', instructions: 'x' } }, fetchImpl: empty })
    ).rejects.toThrow(/no noul answer for "ok"/);
    const mistyped = (async () => respond({ ok: { type: 'score', noul: 0.4, score: 1, probabilities: {} } })) as typeof fetch;
    await expect(
      jevAsk({ apiKey: KEY, state: 's', questions: { ok: { type: 'noul', instructions: 'x' } }, fetchImpl: mistyped })
    ).rejects.toThrow(/no noul answer for "ok"/);
    await expect(
      jevAsk({
        apiKey: KEY,
        state: 's',
        questions: { c: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } },
        fetchImpl: empty,
      })
    ).rejects.toThrow(/2 to 255 options/);
    await expect(
      jevAsk({
        apiKey: KEY,
        state: 's',
        questions: { s: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) } },
        fetchImpl: empty,
      })
    ).rejects.toThrow(/2 to 10 levels/);
  });

  it('retries a 429 once when the wait it asks for fits the deadline, and keeps the request id', async () => {
    let sent = 0;
    const limited = (async () => {
      sent += 1;
      return sent === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after-ms': '5' } })
        : respond({ ok: noulAnswer(0.9) }, { 'x-typesafe-request-id': 'req-42' });
    }) as typeof fetch;
    const result = await jevAsk({
      apiKey: KEY,
      state: 's',
      questions: { ok: { type: 'noul', instructions: 'x' } },
      fetchImpl: limited,
      deadlineAt: Date.now() + 2_000,
    });
    expect(sent).toBe(2);
    expect(result.answers['ok']!.noul).toBe(0.9);
    expect(result.requestId).toBe('req-42');
  });

  it('does not retry past the deadline, nor without one, nor a refusal', async () => {
    for (const [status, retryAfter, deadlineAt] of [
      [529, '10', Date.now() + 2_000],
      [529, '0', undefined],
      [422, '0', Date.now() + 2_000],
    ] as const) {
      let sent = 0;
      const failing = (async () => {
        sent += 1;
        return new Response('no', { status, headers: { 'retry-after': retryAfter } });
      }) as typeof fetch;
      await expect(
        jevAsk({
          apiKey: KEY,
          state: 's',
          questions: { ok: { type: 'noul', instructions: 'x' } },
          fetchImpl: failing,
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        })
      ).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(sent).toBe(1);
    }
  });
});

describe('the Jev decider — choices', () => {
  it('acts on a confident pick whose own fits question says yes, and records what it did', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = answering({ ...pickMethane, decomposable: noulAnswer(0.85) });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(
      choiceRequest
    );
    expect(decision).toEqual({ target: 'Methane', confidence: 0.95, decomposable: true });
    const body = requests[0]!.body;
    // Opaque keys: the chemistry names mean nothing to a literal reader.
    expect(Object.keys(body.questions['choice']!.criteria as object)).toEqual(['agent_1', 'agent_2', NO_CANDIDATE]);
    expect(Object.keys(body.questions)).toEqual(['choice', 'fits::agent_1', 'fits::agent_2', 'decomposable']);
    expect(body.state).toEqual({ task: 'build a landing page', constraints: ['no dependencies'] });
    expect(JSON.stringify(body)).not.toContain('Methane');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'prefilter',
      evaluator: JEV_EVALUATOR,
      candidates: ['Water', 'Methane'],
      outcome: 'picked Methane (decomposable)',
      answer: { choice: 'Methane', confidence: 0.95, yes: { 'fits:Methane': 0.9, 'fits:Water': 0.2, decomposable: 0.85 } },
      actorName: 'Idioblast',
      costUsd: 0.000042,
    });
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it('hands an unsure pick to the model: low confidence, or a pick that does not itself fit', async () => {
    for (const [answers, reason] of [
      [{ ...pickMethane, choice: choiceAnswer('agent_2', 0.45) }, 'confidence 0.45'],
      [{ ...pickMethane, 'fits::agent_2': noulAnswer(0.5) }, 'Methane fits at 0.50'],
    ] as const) {
      const records: JevDecisionInfo[] = [];
      const { impl } = answering(answers);
      expect(await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(choiceRequest)).toEqual({ withhold: [] });
      expect(records[0]!.outcome).toBe(`model decides (${reason})`);
    }
  });

  it('escalates only when every option says it does not fit, whatever the Choice ranked first', async () => {
    const records: JevDecisionInfo[] = [];
    // A Choice's probabilities sum to 1: its winner says nothing about WHETHER anything fits.
    const { impl } = answering({ choice: choiceAnswer('agent_2'), 'fits::agent_1': noulAnswer(0.1), 'fits::agent_2': noulAnswer(0.15) });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(
      choiceRequest
    );
    expect(decision).toMatchObject({ target: null });
    expect(records[0]!.outcome).toBe(`picked ${NO_CANDIDATE}`);

    const disagreeing = answering({ choice: choiceAnswer(NO_CANDIDATE), 'fits::agent_1': noulAnswer(0.8) });
    expect(await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: disagreeing.impl }).choose(choiceRequest)).toEqual({ withhold: [] });
    expect(records[1]!.outcome).toBe('model decides (none_of_these, yet a candidate fits at 0.80)');
  });

  it('asks identically described clones as one option, and takes the canonical first', async () => {
    // Run dbfaf275: four full-stack clones split the mass and made the argmax a coin toss.
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
    const { impl, requests } = answering({
      choice: choiceAnswer('agent_2', 0.85),
      'fits::agent_2': noulAnswer(0.9),
      // 0.6 on a coupled phase is below the conservative decomposition bar.
      decomposable: noulAnswer(0.6),
    });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(clones);
    expect(Object.keys(requests[0]!.body.questions['choice']!.criteria as object)).toEqual(['agent_1', 'agent_2', NO_CANDIDATE]);
    expect(decision).toEqual({ target: 'CarbonDioxide', confidence: 0.85, decomposable: false });
    expect(records[0]!.outcome).toBe('picked CarbonDioxide (first of 3 identical)');
  });

  it('at L3 gives a routing hint or none, never a model call, and asks no decomposition', async () => {
    const records: JevDecisionInfo[] = [];
    const l3 = { ...choiceRequest, actorTier: 3 as const };
    // A lukewarm Choice is still a hint when the option fits at all...
    const lukewarm = answering({ ...pickMethane, choice: choiceAnswer('agent_2', 0.4), 'fits::agent_2': noulAnswer(0.4) });
    expect(await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: lukewarm.impl }).choose(l3)).toMatchObject({
      target: 'Methane',
    });
    expect(Object.keys(lukewarm.requests[0]!.body.questions)).not.toContain('decomposable');
    // ...and a disagreeing one is no hint rather than a model call.
    const disagreeing = answering({ choice: choiceAnswer(NO_CANDIDATE), 'fits::agent_2': noulAnswer(0.8) });
    expect(await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: disagreeing.impl }).choose(l3)).toMatchObject({
      target: null,
    });
    expect(records[1]!.outcome).toMatch(/^no hint \(/);
  });

  it('asks the recipe question by recipe id, with the opening of each body, and reads build against verify', async () => {
    const recipes: JevChoiceRequest = {
      question: 'recipe',
      task: { description: 'add a break mode to the pomodoro page' },
      candidates: [
        { name: 'serve-and-validate-static-page', description: 'serve and validate a page', detail: '1. start_static_server 2. validate_html' },
        { name: 'build-self-contained-static-page', description: 'build a page', detail: '1. write_file index.html' },
      ],
      actorName: 'Idioblast',
      actorTier: 2,
    };
    const records: JevDecisionInfo[] = [];
    // Run fd64b07e: the verify-only recipe for a task that had to change the page.
    const { impl, requests } = answering({
      choice: choiceAnswer('serve-and-validate-static-page', 0.8),
      'fits::serve-and-validate-static-page': noulAnswer(0.85),
      'fits::build-self-contained-static-page': noulAnswer(0.66),
      task_changes_files: noulAnswer(0.9),
      'changes_files::serve-and-validate-static-page': noulAnswer(0.1),
      'changes_files::build-self-contained-static-page': noulAnswer(0.92),
    });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).choose(recipes);
    // The model decides, and is not offered the recipe that verifies only
    // (run 0a989a58: offered it, the model injected it for the build task).
    expect(decision).toEqual({ withhold: ['serve-and-validate-static-page'] });
    expect(records[0]!.outcome).toBe(
      'model decides (serve-and-validate-static-page changes no files for a task that must; not offered: serve-and-validate-static-page)'
    );
    // Structured, so a reading counts withholds without parsing the outcome.
    expect(records[0]!.withheld).toEqual(['serve-and-validate-static-page']);
    const questions = requests[0]!.body.questions;
    expect(Object.keys(questions['choice']!.criteria as object)).toEqual([
      'serve-and-validate-static-page',
      'build-self-contained-static-page',
      NO_CANDIDATE,
    ]);
    expect((questions['choice']!.criteria as Record<string, unknown>)['serve-and-validate-static-page']).toEqual({
      what: 'serve and validate a page',
      opening_steps: '1. start_static_server 2. validate_html',
    });
    expect(Object.keys(questions)).toContain('task_changes_files');
    expect(Object.keys(questions)).not.toContain('decomposable');
  });

  it('hands back an answer that is not an option', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl } = answering({ choice: choiceAnswer('Ghost') });
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

  it('stops asking after three failed decisions in a run, whatever succeeded between them', async () => {
    let sent = 0;
    // Fails, succeeds, then fails for good: a success must not reset the count,
    // or a flapping service would keep a run paying timeouts. A 422 is not retried.
    const good = answering(pickMethane).impl;
    const flapping = (async (url: string | URL | Request, init?: RequestInit) => {
      sent += 1;
      return sent === 2 ? good(url, init) : new Response('malformed', { status: 422 });
    }) as typeof fetch;
    const records: JevDecisionInfo[] = [];
    const decider = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: flapping });
    await decider.choose(choiceRequest);
    await decider.choose(choiceRequest);
    // A local refusal is not the service's failure: nothing sent, nothing counted.
    await decider.choose({ ...choiceRequest, candidates: [{ name: NO_CANDIDATE, description: 'x' }] });
    await decider.choose({
      ...choiceRequest,
      candidates: Array.from({ length: 255 }, (_, i) => ({ name: `atom-${i}`, description: `d${i}` })),
    });
    await decider.choose(choiceRequest);
    await decider.choose(choiceRequest);
    await decider.choose(choiceRequest);
    expect(sent).toBe(4);
    expect(records.map(r => r.requestCount)).toEqual([1, 1, 0, 0, 1, 1, 0]);
    expect(records.map((r) => r.failure ?? r.outcome)).toEqual([
      expect.stringMatching(/HTTP 422/),
      'picked Methane',
      `a candidate is named ${NO_CANDIDATE}`,
      expect.stringMatching(/255 candidates exceed/),
      expect.stringMatching(/HTTP 422/),
      expect.stringMatching(/HTTP 422/),
      'skipped: 3 failed calls in this run',
    ]);
  });

  it('counts a request retried into an answer as no failure', async () => {
    let sent = 0;
    const good = answering(pickMethane).impl;
    const overloadedOnce = (async (url: string | URL | Request, init?: RequestInit) => {
      sent += 1;
      return sent % 2 === 1 ? new Response('overloaded', { status: 529, headers: { 'retry-after-ms': '1' } }) : good(url, init);
    }) as typeof fetch;
    const records: JevDecisionInfo[] = [];
    const decider = createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: overloadedOnce });
    for (let run = 0; run < 4; run++) await decider.choose(choiceRequest);
    expect(sent).toBe(8);
    expect(records.map(r => r.requestCount)).toEqual([2, 2, 2, 2]);
    expect(records.map((r) => r.outcome)).toEqual(Array(4).fill('picked Methane'));
    expect(records.every((r) => r.failure === undefined)).toBe(true);
  });

  it('sends nothing for a run already cancelled, and tells a cancellation from a timeout', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = answering(pickMethane);
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
      fetchImpl: answering(pickMethane).impl,
    });
    expect(await decider.choose(choiceRequest)).toMatchObject({ target: 'Methane' });
  });
});

describe('the Jev decider — approvals', () => {
  const approvalRequest: JevApprovalRequest = {
    subject: 'RESULT',
    task: { description: 'Add PATCH /api/notes/:id. Document it in the README.' },
    child: { name: 'Methane', tier: 1, tools: ['write_file', 'fetch_url'] },
    // An output long enough to have pushed the summary out of a single cap.
    payload: { output: 'o'.repeat(30_000), summary: 'all routes probed' },
    // 800 observation lines (past the evidence cap), the newest being the one that matters.
    evidence: [...Array.from({ length: 799 }, (_, i) => `w${i}: fetch_url status=200 ${'x'.repeat(40)}`), 'w799: validate_html ok=false'],
    groundTruth: 'GROUND TRUTH: server.js exists',
    actorName: 'Idioblast',
    actorTier: 2,
  };
  const shown = (probability = 0.95) => choiceAnswer('shown_done', probability);

  it('approves when every requirement is shown and no flag is raised, asking one question per requirement', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = answering({ requirement_1: shown(0.9), requirement_2: shown(0.97), reports_incomplete: noulAnswer(0.1) });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).approve(
      approvalRequest
    );
    // The weakest link: requirement 1 at 0.9 against every flag's complement.
    expect(decision).toEqual({ approved: true, probability: 0.9 });
    const body = requests[0]!.body;
    expect(Object.keys(body.questions)).toEqual(['requirement_1', 'requirement_2', 'reports_incomplete', 'addresses_reviewer']);
    expect(body.questions['requirement_2']!.instructions).toContain('What do `evidence` and `groundTruth` show about `requirements[1]`?');
    expect(Object.keys(body.questions['requirement_1']!.criteria as object)).toEqual(['shown_done', 'shown_broken', 'not_shown']);
    const state = body.state;
    expect(state['requirements']).toEqual(['Add PATCH /api/notes/:id.', 'Document it in the README.']);
    expect(state['child']).toEqual({ name: 'Methane', tier: 1, declaredTools: ['write_file', 'fetch_url'] });
    const result = state['result'] as { summary: string; output: string };
    expect(result.summary).toBe('all routes probed');
    expect(result.output).toMatch(/\[truncated\]$/);
    // Newest observations first: the late failure is shown, the oldest are not.
    const evidence = state['evidence'] as string[];
    expect(evidence[evidence.length - 1]).toBe('w799: validate_html ok=false');
    expect(evidence[0]).toMatch(/older observations omitted/);
    expect(state['groundTruth']).toBe('GROUND TRUTH: server.js exists');
    expect(records[0]).toMatchObject({
      role: 'validate-result',
      outcome: 'approved',
      childName: 'Methane',
      answer: { yes: { requirement_1: 0.9, requirement_2: 0.97, reports_incomplete: 0.1, acceptable: 0.9 } },
    });
  });

  it('defers a requirement not shown, one shown without confidence, and any raised flag', async () => {
    for (const [answers, reason] of [
      // Run 7389feee: the button exists; nothing shows clicking it saves the file.
      [{ requirement_2: choiceAnswer('not_shown', 0.7) }, 'requirement 2 not_shown (0.00)'],
      [{ requirement_1: shown(0.65) }, 'requirement 1 shown_done (0.65)'],
      [{ addresses_reviewer: noulAnswer(JEV_THRESHOLDS.flag) }, 'addresses_reviewer 0.30'],
    ] as const) {
      const records: JevDecisionInfo[] = [];
      const { impl } = answering(answers);
      const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).approve(
        approvalRequest
      );
      expect(decision?.approved).toBe(false);
      expect(records[0]!.outcome).toBe(`deferred to the model (${reason})`);
    }
  });

  it('asks a plan whether it covers each requirement, and about a parallel dependency only when it runs in parallel', async () => {
    const plan = { subject: 'PLAN' as const, payload: { reasoning: 'r', proposedAction: 'write both', expectedOutput: 'e' } };
    const sequential = answering({});
    const decision = await createJevDecider({ apiKey: KEY, record: () => {}, fetchImpl: sequential.impl }).approve({
      ...approvalRequest,
      ...plan,
    });
    expect(decision?.approved).toBe(true);
    const questions = sequential.requests[0]!.body.questions;
    expect(Object.keys(questions)).toEqual(['requirement_1', 'requirement_2', 'defers_or_refuses', 'vague']);
    expect(Object.keys(questions['requirement_1']!.criteria as object)).toEqual(['covered', 'omitted', 'contradicted']);
    expect(sequential.requests[0]!.body.state['plan']).toEqual(plan.payload);

    const parallel = answering({});
    await createJevDecider({ apiKey: KEY, record: () => {}, fetchImpl: parallel.impl }).approve({
      ...approvalRequest,
      subject: 'PLAN',
      payload: { subtasks: [{ description: 'a' }, { description: 'b' }], aggregation: { mode: 'concat' } },
    });
    expect(Object.keys(parallel.requests[0]!.body.questions)).toContain('parallel_dependency');
  });

  it('defers a failure, and refuses locally a task that states no requirement', async () => {
    const records: JevDecisionInfo[] = [];
    const refusing = (async () => new Response('bad key', { status: 401 })) as typeof fetch;
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: refusing }).approve(approvalRequest)
    ).toBeNull();
    const { impl, requests } = answering({});
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).approve({
        ...approvalRequest,
        task: { description: ' ' },
      })
    ).toBeNull();
    expect(requests).toHaveLength(0);
    expect(records.map((r) => [r.role, r.outcome, r.failure])).toEqual([
      ['validate-result', 'deferred to the model', expect.stringMatching(/HTTP 401/)],
      ['validate-result', 'deferred to the model', 'the task states no requirement to check'],
    ]);
  });

  it('is present whenever the snapshot holds the credential, unless its switch is 0', () => {
    const record = (): void => {};
    expect(jevDeciderFromEnv({}, record)).toBeUndefined();
    expect(jevDeciderFromEnv({ [JEV_ENV]: '1' }, record)).toBeUndefined();
    // On by default (owner decision 2026-09-30): the key alone is enough.
    expect(jevDeciderFromEnv({ [JEV_KEY_ENV]: KEY }, record)).toBeDefined();
    expect(jevDeciderFromEnv({ [JEV_ENV]: '1', [JEV_KEY_ENV]: KEY }, record)).toBeDefined();
    expect(jevDeciderFromEnv({ [JEV_ENV]: '0', [JEV_KEY_ENV]: KEY }, record)).toBeUndefined();
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

  it('does not offer the model a recipe Jev withholds, and escalates when it withholds them all', async () => {
    const recipes = [
      { name: 'serve-and-validate-static-page', description: 'serves and validates a page' },
      { name: 'build-self-contained-static-page', description: 'builds a page' },
    ];
    const withholding = (withhold: string[]): JevDecider => ({
      choose: async () => ({ withhold }),
      approve: async () => null,
      twin: async () => null,
    });
    const ctx = { ...makeCtx(), jev: withholding(['serve-and-validate-static-page']) };
    ctx.llm.enqueueText(jsonText({ kind: 'reuse', target: 'serve-and-validate-static-page', confidence: 'high', reasoning: 'serves' }));
    const outcome = await prefilterStrategy({
      ctx,
      task: { description: 'add keyboard shortcuts to the page' },
      catalog: recipes,
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
    });
    expect(ctx.llm.calls[0]!.userContent).not.toContain('serve-and-validate-static-page');
    expect(ctx.llm.calls[0]!.userContent).toContain('build-self-contained-static-page');
    // A withheld recipe the model names anyway is refused like any stranger.
    expect(outcome).toMatchObject({ kind: 'escalate' });

    const none = { ...makeCtx(), jev: withholding(recipes.map((r) => r.name)) };
    expect(
      await prefilterStrategy({ ctx: none, task: { description: 'x' }, catalog: recipes, systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT })
    ).toMatchObject({ kind: 'escalate', reasoning: expect.stringContaining('contradicts the task on files') });
    expect(none.llm.calls).toHaveLength(0);
  });

  it("keeps a recipe body's opening out of the model's prompt and cache key", async () => {
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ kind: 'escalate', reasoning: 'model' }));
    await prefilterStrategy({
      ctx,
      task: { description: 'x' },
      catalog: [{ name: 'serve-page', description: 'serves a page', detail: 'SECRET-OPENING write_file' }],
      systemPrompt: SKILL_PREFILTER_SYSTEM_PROMPT,
    });
    expect(ctx.llm.calls[0]!.userContent).not.toContain('SECRET-OPENING');
  });

  it('isolates model-only cache entries from Jev, and never caches a Jev decision', async () => {
    process.env['ATOMA_PREFILTER_CACHE'] = join(dir, 'cache.db');
    resetPrefilterCacheForTests();
    const modelOnly = makeCtx();
    modelOnly.llm.enqueueText(jsonText({ kind: 'reuse', target: 'Water', confidence: 'high', reasoning: 'web' }));
    await prefilterStrategy({ ctx: modelOnly, task: { description: 'cached' }, catalog: CATALOG });

    const { decider, chosen } = spyDecider({ choice: 'Methane' });
    const replay = await prefilterStrategy({ ctx: { ...makeCtx(), jev: decider }, task: { description: 'cached' }, catalog: CATALOG });
    expect(replay).toMatchObject({ target: 'Methane' });
    expect(chosen).toHaveLength(1);

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
      jev: createJevDecider({
        apiKey: KEY,
        record: (i) => records.push(i),
        fetchImpl: answering({ choice: choiceAnswer('agent_1'), 'fits::agent_1': noulAnswer(0.9) }).impl,
      }),
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

  it("shows Jev the model validator's evidence lines: transport-observed only, never declared probes", async () => {
    const { decider, approvals } = spyDecider({ approve: 0.9 });
    const ctx = { ...makeCtx(), jev: decider };
    await jevApproval({
      ctx,
      subject: 'RESULT',
      supervisorName: 'Tracheid',
      supervisorTier: 2,
      child: { name: 'Water', tier: 1, toolNames: () => ['validate_html'] },
      task: { description: 'build a page' },
      payload: { output: 'x', summary: 's' },
      evidence: [
        { source: 'recorded-probe', cmd: 'curl localhost', stdout: 'I say it works', match: true },
        { source: 'transport-observed', eventId: 'e1', tool: 'validate_html', observed: 'validate_html: ok=true' },
      ],
    });
    expect(approvals[0]!.evidence).toEqual(['e1: validate_html: ok=true']);
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
      // The draft's own id is never a candidate twin of itself.
      { id: 'recover-missing-evidence', description: 'paste evidence on retry', whenToUse: 'narrative-only summaries' },
    ],
    actorName: 'Tracheid',
    actorTier: 2,
  };

  it('names the existing recipe a draft duplicates, from one pairwise Score per existing recipe', async () => {
    const records: JevDecisionInfo[] = [];
    const { impl, requests } = answering({
      'twin::recover-recorded-verification-evidence': scoreAnswer(1.8, 0.8),
      'twin::recover-undeclared-server-stop': scoreAnswer(0.1),
    });
    const decision = await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: impl }).twin(twinRequest);
    expect(decision).toEqual({ twinOf: 'recover-recorded-verification-evidence', confidence: 0.8 });
    const questions = requests[0]!.body.questions;
    expect(Object.keys(questions)).toEqual(['twin::recover-recorded-verification-evidence', 'twin::recover-undeclared-server-stop']);
    expect(questions['twin::recover-undeclared-server-stop']).toMatchObject({
      type: 'score',
      instructions: { existing_recipe: { description: 'no stop tool', applies_when: 'plan proposes stopping a server' } },
    });
    expect((questions['twin::recover-undeclared-server-stop']!.criteria as unknown[]).length).toBe(3);
    expect(records[0]).toMatchObject({
      role: 'learn-event-skill',
      candidates: ['recover-recorded-verification-evidence', 'recover-undeclared-server-stop'],
      outcome: 'not saved: twin of recover-recorded-verification-evidence',
      answer: { scores: { 'recover-recorded-verification-evidence': 1.8, 'recover-undeclared-server-stop': 0.1 } },
    });
  });

  it('keeps a merely related draft, asks nothing when there is nothing to compare, and fails open', async () => {
    const related = answering({ 'twin::recover-recorded-verification-evidence': scoreAnswer(1.2) });
    const records: JevDecisionInfo[] = [];
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: related.impl }).twin(twinRequest)
    ).toEqual({ twinOf: null, confidence: 0.9 });

    const none = answering({});
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: none.impl }).twin({ ...twinRequest, existing: [] })
    ).toBeNull();
    expect(none.requests).toHaveLength(0);

    const refusing = (async () => new Response('down', { status: 503 })) as typeof fetch;
    expect(
      await createJevDecider({ apiKey: KEY, record: (i) => records.push(i), fetchImpl: refusing }).twin(twinRequest)
    ).toBeNull();
    expect(records.map((r) => r.outcome)).toEqual(['saved: new recipe', 'saved as before: partial twin comparison (0/2)']);
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
    [JEV_PROGRESSIVE_ENV]: '1',
    // Read until 2026-09-30; now it limits nothing, and never crosses into a run.
    [JEV_ORGS_ENV]: 'org-a, org-b',
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
    expect(describeJevAdmission({})).toBe('jev: off (TYPESAFE_API_KEY is absent, so no run can ask it)');
    expect(describeJevAdmission({ [JEV_KEY_ENV]: KEY })).toBe(`jev: deciding in every run (${JEV_EVALUATOR})`);
    expect(describeJevAdmission({ [JEV_KEY_ENV]: KEY, [JEV_ENV]: '0' })).toBe('jev: off for every run (ATOMA_JEV=0)');
    expect(describeJevAdmission(HOST)).toBe(
      `jev: deciding in every run (${JEV_EVALUATOR}); ATOMA_JEV_ORGS is no longer read and can be removed`
    );
    expect(describeJevAdmission(HOST)).not.toContain(KEY);
  });

  it('lets Jev decide for every organisation, existing or new, unless the platform switch is off', () => {
    expect(jevEnabled(HOST)).toBe(true);
    expect(jevEnabled({ ...HOST, [JEV_ENV]: '1' })).toBe(true);
    expect(jevEnabled({ ...HOST, [JEV_ENV]: '0' })).toBe(false);
    expect(jevEnabled({ ...HOST, [JEV_KEY_ENV]: ' ' })).toBe(false);
  });

  it('forwards the key and the switch into every project run, and nothing once the platform switch is off', () => {
    // Named or not in the old list, created today or never seen before: all the same.
    for (const orgId of ['org-a', 'org-c', 'e22494f2-3ef2-442d-8fd3-87b0e4c0c3c1', undefined]) {
      const run = projectRunEnvironment({ ...BASE, hostEnv: HOST, ...(orgId ? { orgId } : {}) }).environment;
      expect(run[JEV_KEY_ENV]).toBe(KEY);
      expect(run[JEV_ENV]).toBe('1');
      expect(run[JEV_PROGRESSIVE_ENV]).toBe('1');
      expect(run[JEV_ORGS_ENV]).toBeUndefined();
    }
    const off = projectRunEnvironment({ ...BASE, hostEnv: { ...HOST, [JEV_ENV]: '0' }, orgId: 'org-a' }).environment;
    expect(off[JEV_KEY_ENV]).toBeUndefined();
    expect(off[JEV_PROGRESSIVE_ENV]).toBeUndefined();
    // The run log then says the platform turned Jev off, not that a key is missing.
    expect(off[JEV_ENV]).toBe('0');
  });
});

describe('the jev trace event', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'atoma-jev-trace-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  it('is recorded with its own cost and request id, and stays out of the run LLM totals', () => {
    const recorder = new TraceRecorder(runsDir);
    recorder.beginRun({ description: 'goal' });
    recorder.recordJevDecision({
      role: 'validate-result',
      evaluator: JEV_EVALUATOR,
      requestId: 'req-7',
      requestCount: 2,
      answer: { yes: { requirement_1: 0.9, acceptable: 0.9 } },
      outcome: 'approved',
      durationMs: 180,
      usage: { inputTokens: 1000, outputTokens: 0 },
      costUsd: 0.000042,
      actorName: 'Idioblast',
      actorTier: 2,
      childName: 'Methane',
      branchId: 'b1',
    });
    recorder.recordJevDecision({
      role: 'learn-skill',
      evaluator: JEV_EVALUATOR,
      answer: { choice: NEW_RECIPE, confidence: 0.9, scores: { 'serve-api': 0.4 } },
      outcome: 'saved: new recipe',
      durationMs: 90,
      usage: { inputTokens: 500, outputTokens: 0 },
      costUsd: 0.000021,
    });
    const run = recorder.endRun()!;
    const events = run.events.filter((e) => e.kind === 'jev');
    expect(events[0]).toMatchObject({
      kind: 'jev',
      outcome: 'approved',
      requestId: 'req-7',
      requestCount: 2,
      actor: { name: 'Idioblast', tier: 2 },
      child: { name: 'Methane' },
      branchId: 'b1',
      costUsd: 0.000042,
    });
    expect(events[1]).toMatchObject({ answer: { scores: { 'serve-api': 0.4 } } });
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
    const { impl } = answering(answers);
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
    const [card] = await cardsFor((d) => d.choose(choiceRequest), { ...pickMethane, choice: choiceAnswer('agent_2', 0.9) });
    expect(card).toMatchObject({ title: 'Jev · prefilter', decision: '→ Methane', body: 'picked Methane' });
    expect(card!.meta).toContain('L2 Idioblast');
    expect(card!.footer).toMatch(/^jev-1\.13\.0 · conf 90% · \d+ms · \$0\.0000 · /);
  });

  it('preserves a compilation postponement through the recorder and the client card', async () => {
    const [card] = await cardsFor((d) => d.compilable!({
      skillId: 'build-page', prompt: 'Write and design an arbitrary page',
      allowLoopbackNetwork: false, actorName: 'Idioblast', actorTier: 2,
    }), { semantic_judgment: noulAnswer(0.95), unavailable_capability: noulAnswer(0.05), unspecified_inputs: noulAnswer(0.05) });
    expect(card).toMatchObject({ title: 'Jev · compile-skill',
      body: 'compilation postponed: semantic_judgment; reconsider on next credited success' });
    expect(card!.meta).toContain('L2 Idioblast');
  });

  it('badges an approval with its weakest link, and a deferral as the model deciding', async () => {
    const [approved] = await cardsFor((d) => d.approve(approval), { requirement_1: choiceAnswer('shown_done', 0.83) });
    expect(approved).toMatchObject({ title: 'Jev · validate-result', decision: '✓ approved' });
    expect(approved!.footer).toContain('score 83%');
    const [deferred] = await cardsFor((d) => d.approve(approval), { requirement_1: choiceAnswer('not_shown', 0.8) });
    expect(deferred!.decision).toBe('↑ model decides');
    expect(deferred!.body).toBe('deferred to the model (requirement 1 not_shown (0.00))');
  });

  it('badges an unsure pick as the model deciding, and none-of-these or no hint as an escalation', async () => {
    const [unsure] = await cardsFor((d) => d.choose(choiceRequest), { ...pickMethane, choice: choiceAnswer('agent_2', 0.3) });
    expect(unsure!.decision).toBe('↑ model decides');
    const [none] = await cardsFor((d) => d.choose(choiceRequest), {
      choice: choiceAnswer(NO_CANDIDATE, 0.8),
      'fits::agent_1': noulAnswer(0.1),
      'fits::agent_2': noulAnswer(0.1),
    });
    expect(none!.decision).toBe('↑ escalate');
    const [noHint] = await cardsFor((d) => d.choose({ ...choiceRequest, actorTier: 3 }), {
      choice: choiceAnswer(NO_CANDIDATE, 0.8),
      'fits::agent_1': noulAnswer(0.6),
    });
    expect(noHint!.decision).toBe('↑ escalate');
  });

  it('badges as an escalation a recipe pick left with nothing that fits once withheld recipes are gone', async () => {
    const recipes: JevChoiceRequest = {
      question: 'recipe',
      task: { description: 'add keyboard shortcuts to the pomodoro page' },
      candidates: [
        { name: 'serve-and-validate-static-page', description: 'serve and validate a page' },
        { name: 'build-text-frequency-cli', description: 'build a word-count CLI' },
      ],
      actorName: 'Tracheid',
      actorTier: 2,
    };
    let decision: unknown;
    const [card] = await cardsFor(
      async (d) => {
        decision = await d.choose(recipes);
      },
      {
        choice: choiceAnswer('serve-and-validate-static-page', 0.8),
        'fits::serve-and-validate-static-page': noulAnswer(0.9),
        'fits::build-text-frequency-cli': noulAnswer(0.05),
        task_changes_files: noulAnswer(0.97),
        'changes_files::serve-and-validate-static-page': noulAnswer(0.1),
        'changes_files::build-text-frequency-cli': noulAnswer(0.95),
      }
    );
    // Not a model call on a catalog Jev reads as fitting nothing: an escalate.
    expect(decision).toMatchObject({ target: null });
    expect(card!.decision).toBe('↑ escalate');
    expect(card!.body).toBe(
      'picked none_of_these (serve-and-validate-static-page changes no files for a task that must; not offered: serve-and-validate-static-page; nothing else fits)'
    );
  });

  it('badges a twin verdict both ways', async () => {
    const [duplicate] = await cardsFor((d) => d.twin(twin), { 'twin::serve-json-api': scoreAnswer(1.9, 0.8) });
    expect(duplicate).toMatchObject({ title: 'Jev · learn-skill', decision: '✕ duplicate recipe' });
    const [fresh] = await cardsFor((d) => d.twin(twin), { 'twin::serve-json-api': scoreAnswer(0.4, 0.8) });
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
