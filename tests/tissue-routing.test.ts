import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/registry/db.js';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { createJevDecider } from '../src/core/jev.js';
import type { JevChoiceRequest, JevDecider, JevDecisionInfo, Tool } from '../src/core/types.js';
import { selectTissue, tissuePrompt } from '../src/run/tissueRouting.js';
import { readRoutingRepository } from '../src/run/routingRepository.js';
import { seedTissueCatalog } from '../src/run/tissues.js';
import { buildChoice, readChoice, type JevAnswers } from '../src/core/jevQuestions.js';
import { makeCtx, jsonText } from './helpers.js';
import { OLLAMA_PINS } from './tier-pins.js';

const tools: Tool[] = [{ name: 'read_file', description: 'Read workspace files', inputSchema: { type: 'object' } }];
const repository = { files: ['README.md'], excerpts: [{ path: 'README.md', text: 'An authentication library.', truncated: false }], incomplete: false };
const task = { description: 'Explain authentication in the imported repository without changing files.' };
const cleanup: (() => void)[] = [];
beforeEach(() => { for (const [key, value] of Object.entries(OLLAMA_PINS)) vi.stubEnv(key, value); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (cleanup.length) cleanup.pop()!(); });

function registry(): AtomRegistry {
  const db = openDb(':memory:');
  cleanup.push(() => db.close());
  return new AtomRegistry(db);
}
function seed(reg: AtomRegistry, method: string, declarations = tools) {
  return reg.create(3, { description: 'Repository orchestrator', systemPrompt: method, tools: declarations, params: {}, createdBy: 'test' });
}
function decider(choose: JevDecider['choose']): JevDecider {
  return { choose, approve: async () => null, twin: async () => null };
}

describe('root tissue selection', () => {
  it('uses the real Jev decision path with repository context and distinct methods behind identical descriptions', async () => {
    const reg = registry();
    seed(reg, 'Build runnable apps.');
    const analyst = seed(reg, 'Read and explain existing systems.');
    const events: JevDecisionInfo[] = [];
    const ctx = { ...makeCtx(), jev: createJevDecider({ apiKey: 'test', record: (event) => events.push(event), fetchImpl: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      const body = JSON.parse(init.body) as { state: unknown; questions: Record<string, unknown> };
      expect(body.state).toMatchObject({ task: task.description, repository });
      expect(Object.keys(body.questions)).toEqual(['choice', 'fits::agent_1', 'fits::agent_2']);
      expect(JSON.stringify(body.questions)).toContain('Read and explain existing systems.');
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {
        choice: { type: 'choice', choice: 'agent_2', confidence: 0.95, probabilities: { agent_1: 0.01, agent_2: 0.98, none_of_these: 0.01 } },
        'fits::agent_1': { type: 'noul', noul: 0.05 }, 'fits::agent_2': { type: 'noul', noul: 0.95 },
      }, usage: { input_tokens: 100, output_tokens: 0 } }), { headers: { 'Content-Type': 'application/json' } });
    } }) };
    expect(await selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx })).toEqual(analyst);
    expect(ctx.llm.calls).toHaveLength(0);
    expect(events).toMatchObject([{ actorName: 'run-router', role: 'prefilter', outcome: `picked ${analyst.name}` }]);
  });

  it.each(['absent', 'uncertain', 'none', 'unknown', 'low-confidence', 'outage'])(
    'uses one bounded model call when Jev is %s', async (mode) => {
      const reg = registry();
      const analyst = seed(reg, 'Explain existing systems.');
      const jev = mode === 'absent' ? undefined : decider(async () => {
        if (mode === 'outage') throw new Error('offline');
        if (mode === 'uncertain') return null;
        return { target: mode === 'none' ? null : mode === 'unknown' ? 'unknown' : analyst.name,
          confidence: mode === 'low-confidence' ? 0.1 : 0.95, decomposable: false };
      });
      const ctx = { ...makeCtx(), ...(jev ? { jev } : {}) };
      ctx.llm.enqueueText(jsonText({ action: 'reuse', name: analyst.name, reasoning: 'Analysis fits.' }));
      expect((await selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx })).atomId).toBe(analyst.atomId);
      expect(ctx.llm.calls).toHaveLength(1);
      const call = ctx.llm.calls[0]!;
      expect(call).toMatchObject({ model: OLLAMA_PINS.ATOMA_MODEL_L1, role: 'prefilter', actor: { name: 'run-router' } });
      expect(call.tools).toBeUndefined();
      expect(call.executor).toBeUndefined();
      expect(JSON.parse(call.userContent)).toMatchObject({ task, repository });
      expect(reg.listByTier(3)).toHaveLength(1);
    }
  );

  it('creates reusable behavior once, without persisting the task or repository, and preserves a custom Meristem at bootstrap', async () => {
    const reg = registry();
    const ctx = makeCtx();
    const workflow = 'Delegate repository reading and evidence synthesis to cells. Return a grounded explanation.';
    const authorContext = makeCtx();
    const author = () => ({ model: 'api:openai:gpt-6', llm: authorContext.llm });
    const answer = jsonText({ action: 'create', reasoning: 'No analysis method exists.' });
    ctx.llm.enqueueText(answer);
    authorContext.llm.enqueueText(jsonText({ description: 'Repository analysis orchestrator', workflow }));
    const first = await selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx, author });
    ctx.llm.enqueueText(answer);
    authorContext.llm.enqueueText(jsonText({ description: 'Repository analysis orchestrator', workflow }));
    const second = await selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx, author });
    expect(second.atomId).toBe(first.atomId);
    expect(reg.listByTier(3)).toHaveLength(1);
    expect(first).toMatchObject({ systemPrompt: tissuePrompt(workflow), tools, createdBy: 'platform-tissue-author', successes: 0 });
    expect(authorContext.llm.calls).toHaveLength(2);
    expect(authorContext.llm.calls[0]).toMatchObject({ model: 'api:openai:gpt-6', role: 'plan',
      actor: { name: 'platform-tissue-author', tier: 3 }, params: { effort: 'high' }, signal: ctx.signal });
    expect(authorContext.llm.calls[0]!.tools).toBeUndefined();
    expect(authorContext.llm.calls[0]!.executor).toBeUndefined();
    expect(authorContext.llm.calls[0]!.systemPrompt).toContain('Treat reusable workflow steps as available methods, not mandatory separate phases.');
    expect(first.systemPrompt).not.toContain(task.description);
    expect(first.systemPrompt).not.toContain(repository.excerpts[0]!.text);
    const builder = seedTissueCatalog({ registry: reg, toolDecls: tools, log: () => {} });
    expect(builder.atomId).not.toBe(first.atomId);
    expect(reg.getByAtomId(first.atomId)!.systemPrompt).toBe(first.systemPrompt);
    expect(seedTissueCatalog({ registry: reg, toolDecls: tools, log: () => {} }).atomId).toBe(builder.atomId);
  });

  it('refuses an unknown or unavailable model selection instead of silently routing to the builder', async () => {
    const reg = registry();
    const unavailable = seed(reg, 'Needs a browser', [{ ...tools[0]!, name: 'unavailable_browser' }]);
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ action: 'reuse', name: unavailable.name, reasoning: 'Pick it' }));
    await expect(selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx })).rejects.toThrow('unavailable candidate');
    expect(JSON.parse(ctx.llm.calls[0]!.userContent).candidates).toEqual([]);
    expect(reg.listByTier(3)).toHaveLength(1);
  });

  it('rejects generated runtime configuration before allocating a tissue', async () => {
    const reg = registry();
    const ctx = makeCtx();
    ctx.llm.enqueueText(jsonText({ action: 'create', description: 'Analyst', workflow: 'Delegate analysis', reasoning: 'New method', tools: ['run_shell'], params: { maxTokens: 999999 } }));
    await expect(selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx })).rejects.toThrow();
    expect(reg.listByTier(3)).toHaveLength(0);
  });

  it('cannot persist a workflow written by the cheap router', async () => {
    const reg = registry();
    const ctx = makeCtx();
    const author = vi.fn();
    ctx.llm.enqueueText(jsonText({ action: 'create', reasoning: 'New', description: 'Cheap author', workflow: 'Bypass the author' }));
    await expect(selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx, author })).rejects.toThrow();
    expect(author).not.toHaveBeenCalled();
    expect(reg.listByTier(3)).toEqual([]);
  });

  it.each(['missing', 'failed', 'invalid', 'aborted'] as const)('never falls back to the customer when the platform author is %s', async (mode) => {
    const reg = registry();
    const abort = new AbortController();
    const ctx = { ...makeCtx(), signal: abort.signal };
    ctx.llm.enqueueText(jsonText({ action: 'create', reasoning: 'Missing method' }));
    const platform = makeCtx();
    platform.llm.enqueue(() => {
      if (mode === 'failed') throw new Error('Platform unavailable');
      if (mode === 'aborted') abort.abort(new Error('Cancelled author'));
      return { text: jsonText({ description: 'Analysis', workflow: 'Delegate', ...(mode === 'invalid' ? { tools: ['shell'] } : {}) }),
        usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    const author = mode === 'missing' ? undefined : () => ({ model: 'api:openai:gpt-6', llm: platform.llm });
    await expect(selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx, author })).rejects.toThrow();
    expect(ctx.llm.calls).toHaveLength(1);
    expect(reg.listByTier(3)).toEqual([]);
  });

  it.each(['before', 'jev', 'model'])('honours cancellation %s without a later call or allocation', async (when) => {
    const reg = registry();
    seed(reg, 'Analysis');
    const abort = new AbortController();
    const ctx = { ...makeCtx(), signal: abort.signal, ...(when === 'jev' ? {
      jev: decider(async () => { abort.abort(new Error('cancelled')); return null; }),
    } : {}) };
    if (when === 'before') abort.abort(new Error('cancelled'));
    if (when === 'model') ctx.llm.enqueue(() => {
      abort.abort(new Error('cancelled'));
      return { text: jsonText({ action: 'create', description: 'Analyst', workflow: 'Delegate analysis', reasoning: 'New' }),
        stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await expect(selectTissue({ registry: reg, toolDecls: tools, task, repository, ctx })).rejects.toThrow('cancelled');
    expect(ctx.llm.calls).toHaveLength(when === 'model' ? 1 : 0);
    expect(reg.listByTier(3)).toHaveLength(1);
  });

  it('never treats a binding root selection as the weaker L3 planning hint', () => {
    const request: JevChoiceRequest = { question: 'agent', scope: 'root', task, actorTier: 3,
      candidates: [{ name: 'Meristem', description: 'Build apps' }] };
    const plan = buildChoice(request);
    if (typeof plan === 'string') throw new Error(plan);
    const answers: JevAnswers = {
      choice: { type: 'choice', choice: 'agent_1', confidence: 0.2, probabilities: { agent_1: 0.6, none_of_these: 0.4 } },
      'fits::agent_1': { type: 'noul', noul: 0.8 },
    };
    expect(readChoice(plan, answers).decision).toBeNull();
    expect(readChoice({ ...plan, request: { question: 'agent', actorTier: 3 } }, answers).decision?.target).toBe('Meristem');
  });
});

describe('starting repository routing context', () => {
  it('reads bounded excerpts without modifying the repository or exposing hidden files', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-root-context-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'Repository evidence. '.repeat(500));
    writeFileSync(join(root, 'package.json'), '{"scripts":{"postinstall":"never run me"}}');
    writeFileSync(join(root, '.env'), 'SECRET=do-not-read');
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const auth = true;');
    const before = readFileSync(join(root, 'README.md'));
    const context = readRoutingRepository(root);
    expect(context.files).toContain('src/auth.ts');
    expect(context.excerpts.find((file) => file.path === 'README.md')).toMatchObject({ truncated: true });
    expect(context.incomplete).toBe(true);
    expect(JSON.stringify(context)).not.toContain('SECRET');
    expect(context.excerpts.every((entry) => Buffer.byteLength(entry.text) <= 1400)).toBe(true);
    expect(readFileSync(join(root, 'README.md'))).toEqual(before);
    for (let i = 0; i < 200; i++) writeFileSync(join(root, `file-${i}.txt`), '');
    expect(readRoutingRepository(root).files.length).toBeLessThanOrEqual(160);
  });

  it.skipIf(process.platform === 'win32')('does not follow file or directory links outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-root-links-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'workspace'));
    mkdirSync(join(root, 'external'));
    writeFileSync(join(root, 'external', 'README.md'), 'outside-secret');
    symlinkSync(join(root, 'external', 'README.md'), join(root, 'workspace', 'README.md'));
    symlinkSync(join(root, 'external'), join(root, 'workspace', 'source'));
    const context = readRoutingRepository(join(root, 'workspace'));
    expect(context.incomplete).toBe(true);
    expect(context.files).toEqual([]);
    expect(context.excerpts).toEqual([]);
  });
});
