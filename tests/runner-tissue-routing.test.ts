import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { buildProfile } from '../src/run/profiles/build.js';
import { buildTierClients, makeTransportClient } from '../src/run/providers.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { ensureCanonicalFileScribeL1 } from '../src/atoms/capability.js';
import type { LlmCompletionRequest } from '../src/core/types.js';
import type { VizRun } from '../src/viz/trace.js';
import { OLLAMA_PINS } from './tier-pins.js';
import { makePlan } from './helpers/factories.js';

vi.mock('../src/run/providers.js', async (original) => ({
  ...await original<typeof import('../src/run/providers.js')>(), buildTierClients: vi.fn(), makeTransportClient: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetHostLifecycleSnapshotForTests(); });

describe('task-driven tissue selection through the real runner', () => {
  it.each(['reuse', 'create'] as const)('imports repository context, routes via %s, reads evidence through L1 and accepts text', async (route) => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-routed-run-'));
    const seed = join(root, 'seed');
    const workspace = join(root, 'workspace');
    const runs = join(root, 'runs');
    mkdirSync(seed);
    const readme = 'Authentication uses signed session cookies.';
    writeFileSync(join(seed, 'README.md'), readme);
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS, ATOMA_MODEL_L3: 'api:openai:gpt-6-astra', OPENAI_API_KEY: 'platform-author-key',
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
      ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: workspace, ATOMA_BUILD_TIMEOUT_MS: '60000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0', ATOMA_JEV: '0',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    let tissue = '';
    let cell = '';
    let molecule = '';
    const calls: LlmCompletionRequest[] = [];
    vi.mocked(makeTransportClient).mockClear();
    vi.mocked(makeTransportClient).mockImplementation((transport, opts) => {
      expect(transport).toBe('openai-api');
      expect(opts?.env?.['OPENAI_API_KEY']).toBe('platform-author-key');
      return { complete: async (req) => {
        expect(req.model).toBe('gpt-6-astra');
        expect(req.actor?.name).toBe('platform-tissue-author');
        expect(req.tools).toBeUndefined();
        return { text: JSON.stringify({ description: 'Repository explanation orchestrator', workflow: 'Delegate reading and evidence synthesis to suitable L2 cells.' }),
          stopReason: 'end_turn', usage: { inputTokens: 17, outputTokens: 19 } };
      } };
    });
    const goal = 'Explain how authentication works in this repository. Do not change files.';
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async (req) => {
      calls.push(req);
      let reply: unknown;
      if (req.actor?.name === 'run-router') {
        expect(JSON.parse(req.userContent)).toMatchObject({ task: { description: goal, constraints: [] },
          repository: { excerpts: [{ path: 'README.md', text: readme, truncated: false }] } });
        reply = route === 'reuse' ? { action: 'reuse', name: tissue, reasoning: 'An explanation of an existing repository.' }
          : { action: 'create', reasoning: 'Missing a repository explanation method.' };
      } else if (req.role === 'draft-checklist') reply = { items: [{ behaviour: 'Explains authentication without changing files', check: { kind: 'review' } }] };
      else if (req.role === 'prefilter') reply = { kind: 'reuse', target: req.actor?.tier === 3 ? cell : molecule, confidence: 'high', reasoning: 'Read existing evidence' };
      else if (req.role === 'validate-plan' || req.role === 'validate-result') reply = { approved: true, reasoning: 'The explanation matches the observed README.' };
      else if (req.role === 'plan' && req.actor?.tier !== 1) {
        if (req.actor?.tier === 3) tissue = req.actor.name;
        reply = [
        { strategy: 'reuse', target: req.actor?.tier === 3 ? cell : molecule, reasoning: 'Read and explain' },
        makePlan({ subtasks: [{ description: goal }], aggregation: { mode: 'sequential' } }),
        ];
      }
      else if (req.role === 'plan') reply = { reasoning: 'Read the source', proposedAction: 'Read README.md', expectedOutput: 'A grounded explanation' };
      else if (req.role === 'execute') {
        const args = { path: 'README.md' };
        const startedAt = Date.now();
        const result = await req.executor!.execute('read_file', args);
        req.onToolInvocation?.({ name: 'read_file', args, result, startedAt, durationMs: Date.now() - startedAt });
        reply = { output: { explanation: readme }, summary: 'Explained authentication from the README read during this run.' };
      } else throw new Error(`Unexpected fixture call: ${req.role}`);
      return { text: JSON.stringify(reply), stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    } } });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask({ ...buildProfile, seedCatalog(ctx) {
        buildProfile.seedCatalog(ctx);
        molecule = ensureCanonicalFileScribeL1(ctx.registry, ctx.toolDecls).name;
        cell = ctx.registry.listByTier(2)[0]!.name;
        if (route === 'reuse') tissue = ctx.registry.create(3, {
          description: 'Repository analysis orchestrator', systemPrompt: 'Delegate repository reading and grounded explanations to L2 cells.',
          tools: [...ctx.toolDecls], params: {}, createdBy: 'test-analysis',
        }).name;
      } }, ['--seed', seed, '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', goal], { providerEnv: { ...OLLAMA_PINS } });
      const settled = await handle.settled;
      const path = readdirSync(runs).find((name) => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(runs, path), 'utf8')) as VizRun;
      expect(settled, trace.error).toEqual({ outcome: 'delivered' });
      expect(calls.filter((req) => req.actor?.name === 'run-router')).toHaveLength(1);
      expect(calls.some((req) => req.actor?.tier === 3 && req.actor.name === tissue && req.role === 'plan')).toBe(true);
      expect(trace.events.filter((event) => event.kind === 'topology')).toMatchObject([{ mode: 'deep', attempt: 1 }]);
      expect(trace.events.filter((event) => event.kind === 'acceptance')).toMatchObject([{ approved: true }]);
      expect(trace.task.description).toBe(goal);
      expect(trace.task.constraints).toBeUndefined();
      expect(trace.task.inputs).toHaveProperty('startingRepository');
      expect(trace.label).toBe(`run: ${goal}`);
      const authorEvents = trace.events.filter(event => event.kind === 'llm' && event.actor?.name === 'platform-tissue-author');
      expect(authorEvents).toHaveLength(route === 'create' ? 1 : 0);
      expect(makeTransportClient).toHaveBeenCalledTimes(route === 'create' ? 1 : 0);
      if (route === 'create') expect(authorEvents[0]).toMatchObject({ model: 'api:openai:gpt-6-astra', role: 'plan', usage: { inputTokens: 17, outputTokens: 19 } });
      expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe(readme);
      expect(readdirSync(workspace).filter((name) => !name.startsWith('.atoma-'))).toEqual(['README.md']);
    } finally {
      await handle?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
