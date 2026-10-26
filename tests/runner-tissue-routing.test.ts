import { mockOtherProofReview } from './helpers/delegationReview.js';
import * as jevModule from '../src/core/jev.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { TraceRecorder } from '../src/viz/trace.js';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTask, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';
import { buildTierClients, makeTransportClient } from '../src/run/providers.js';
import { closeStoreHandles } from '../src/core/stores.js';
import { ensureCanonicalFileScribeL1 } from '../src/atoms/capability.js';
import type { LlmCompletionRequest, Task } from '../src/core/types.js';
import { workspacePreparationSchema } from '../src/contracts/workspacePreparation.js';
import { serveComputeBridge } from '../src/run/computeBridge.js';
import { computeRunnerOptions } from '../src/run/computeRunner.js';
import { localWorkspaceRuntime } from '../src/run/workspaceRuntime.js';
import { workspaceCommandHandler } from '../src/run/workspaceRpc.js';
import { localToolBackend } from '../src/run/toolBackend.js';
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
      else if (req.role === 'validate-plan' || req.role === 'validate-result') reply = { approved: true, reasoning: 'The explanation matches the observed README.', ...mockOtherProofReview(req) };
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
      handle = await startTask(['--seed', seed, '--no-learn-skills', '--no-promote-skills', '--no-direct-skills', goal], { providerEnv: { ...OLLAMA_PINS }, seedCatalog(ctx, canonical) {
        canonical(ctx);
        molecule = ensureCanonicalFileScribeL1(ctx.registry, ctx.toolDecls).name;
        cell = ctx.registry.listByTier(2)[0]!.name;
        if (route === 'reuse') tissue = ctx.registry.create(3, {
          description: 'Repository analysis orchestrator', systemPrompt: 'Delegate repository reading and grounded explanations to L2 cells.',
          tools: [...ctx.toolDecls], params: {}, createdBy: 'test-analysis',
        }).name;
      } });
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

describe('pending audits at runner shutdown', () => {
  it.each(['failure', 'shutdown'] as const)('keeps pending audit work before closing a trace on %s', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-audit-close-'));
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
      ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: join(root, 'runs'),
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '60000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.spyOn(jevModule, 'jevDeciderFromEnv').mockReturnValue({ choose: async () => null, approve: async () => null, twin: async () => null });
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async () => ({
      text: JSON.stringify({ action: 'reuse', name: 'Meristem', reasoning: 'fixture' }),
      usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn',
    }) } });
    let finishedAudit = false;
    let started!: () => void;
    const startedWork = new Promise<void>(resolveStarted => { started = resolveStarted; });
    let stop!: () => void;
    const hanging = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error('stopped')); });
    // Only await this promise in the shutdown case, so it never rejects unobserved.
    vi.spyOn(L3Atom.prototype, 'handle').mockImplementation(async (_task, ctx) => {
      ctx.jevAudit!.defer(async () => { await new Promise(resolveAudit => setTimeout(resolveAudit, 80)); finishedAudit = true; });
      started();
      if (mode === 'failure') throw new Error('execution failed');
      return hanging;
    });
    const closeStates: boolean[] = [];
    const end = TraceRecorder.prototype.endRun;
    vi.spyOn(TraceRecorder.prototype, 'endRun').mockImplementation(function (this: TraceRecorder, options) {
      closeStates.push(finishedAudit); return end.call(this, options);
    });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(['--no-learn-skills', '--no-direct-skills', 'Audit closure fixture']);
      await startedWork;
      if (mode === 'shutdown') { await handle.shutdown(); stop(); }
      await handle.settled;
      expect(closeStates.length).toBeGreaterThan(0);
      expect(closeStates.every(Boolean)).toBe(true);
    } finally { await handle?.shutdown(); closeStoreHandles(); rmSync(root, { recursive: true, force: true }); }
  });

  it('gives a default run eight hours plus grace before its watchdog settles a pending audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-audit-watchdog-'));
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
      ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: join(root, 'runs'),
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: undefined,
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.spyOn(jevModule, 'jevDeciderFromEnv').mockReturnValue({ choose: async () => null, approve: async () => null, twin: async () => null });
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async () => ({
      text: JSON.stringify({ action: 'reuse', name: 'Meristem', reasoning: 'fixture' }),
      usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn',
    }) } });
    let finishAudit!: () => void;
    const auditGate = new Promise<void>(resolve => { finishAudit = resolve; });
    let started!: () => void;
    const startedWork = new Promise<void>(resolve => { started = resolve; });
    let finishedAudit = false;
    vi.spyOn(L3Atom.prototype, 'handle').mockImplementation(async (_task, ctx) => {
      ctx.jevAudit!.defer(async () => { await auditGate; finishedAudit = true; });
      started();
      return new Promise<never>(() => {});
    });
    const closeStates: boolean[] = [];
    const end = TraceRecorder.prototype.endRun;
    vi.spyOn(TraceRecorder.prototype, 'endRun').mockImplementation(function (this: TraceRecorder, options) {
      closeStates.push(finishedAudit); return end.call(this, options);
    });
    let wedged!: () => void;
    const watchdogFired = new Promise<void>(resolve => { wedged = resolve; });
    const realSetTimeout = globalThis.setTimeout;
    let fireWatchdog: (() => void) | undefined;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 28_800_000 + 60_000) {
        fireWatchdog = () => callback(...args);
        watchdogTimer = realSetTimeout(() => {}, delay);
        return watchdogTimer;
      }
      return realSetTimeout(callback, delay, ...args);
    });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(['--no-learn-skills', '--no-direct-skills', 'Watchdog audit fixture'], { onWedged: wedged });
      await startedWork;
      expect(fireWatchdog).toBeDefined();
      fireWatchdog!();
      finishAudit();
      await watchdogFired;
      expect(closeStates).toEqual([true]);
      const path = readdirSync(join(root, 'runs')).find(name => name.endsWith('.json') && name !== 'index.json')!;
      const trace = JSON.parse(readFileSync(join(root, 'runs', path), 'utf8')) as VizRun;
      expect(trace.error).toMatch(/watchdog: deadline exceeded/);
    } finally {
      finishAudit();
      if (watchdogTimer) clearTimeout(watchdogTimer);
      await handle?.shutdown();
      closeStoreHandles();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The seed copy leaves out node_modules at every depth; the launch receipt
// names the package roots the executor has to reinstall. They are read from
// the seed SOURCE on the host, never from the routing inventory, whose 160-entry
// cut stopped partway through browser/ in run 2f2643d5 (2026-10-26).
describe('package roots of a seeded run', () => {
  const readRunId = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const writeSeed = (seed: string): void => {
    mkdirSync(join(seed, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(seed, 'package.json'), '{"name":"app","scripts":{"test:browser":"vitest run"}}');
    writeFileSync(join(seed, 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(seed, 'node_modules', 'x', 'package.json'), '{}');
    // More root entries than the routing reader's cap, whatever order the filesystem reads them in.
    for (let i = 0; i < 200; i++) writeFileSync(join(seed, `note-${String(i).padStart(3, '0')}.md`), `note ${i}`);
    mkdirSync(join(seed, 'browser', 'node_modules', 'playwright'), { recursive: true });
    writeFileSync(join(seed, 'browser', 'package.json'), '{"dependencies":{"playwright":"1.55.1"}}');
    writeFileSync(join(seed, 'browser', 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(seed, 'browser', 'node_modules', 'playwright', 'package.json'), '{}');
    mkdirSync(join(seed, 'tests', 'fixtures', 'app'), { recursive: true });
    writeFileSync(join(seed, 'tests', 'fixtures', 'app', 'package.json'), '{"name":"fixture"}');
    const readRunCopy = join(seed, '.atoma-runs', 'node_modules', readRunId);
    mkdirSync(readRunCopy, { recursive: true });
    writeFileSync(join(readRunCopy, 'package.json'), '{}');
    writeFileSync(join(readRunCopy, 'package-lock.json'), '{}');
  };
  const expectedRoots = [
    { dir: '.', lockfile: 'package-lock.json' },
    { dir: 'browser', lockfile: 'package-lock.json' },
    { dir: 'tests/fixtures/app', lockfile: null },
  ];
  const launch = async (root: string, opts: Parameters<typeof startTask>[1] = {}): Promise<{ trace: VizRun; task: Task }> => {
    const runs = join(root, 'runs');
    for (const [key, value] of Object.entries({ ...OLLAMA_PINS,
      ATOMA_DB_PATH: join(root, 'store.db'), ATOMA_LEDGER_DB: join(root, 'store.db'),
      ATOMA_SKILLS_DIR: join(root, 'skills'), ATOMA_RUNS_DIR: runs,
      ATOMA_BUILD_WORKSPACE: join(root, 'workspace'), ATOMA_BUILD_TIMEOUT_MS: '60000',
      ATOMA_CONTAINER: '0', ATOMA_REQUIRE_ISOLATION: '0', ATOMA_PREFILTER_CACHE: '0',
    })) vi.stubEnv(key, value);
    resetHostLifecycleSnapshotForTests();
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.spyOn(jevModule, 'jevDeciderFromEnv').mockReturnValue({ choose: async () => null, approve: async () => null, twin: async () => null });
    vi.mocked(buildTierClients).mockReturnValue({ ollama: { complete: async () => ({
      text: JSON.stringify({ action: 'reuse', name: 'Meristem', reasoning: 'fixture' }),
      usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn',
    }) } });
    let rootTask: Task | undefined;
    vi.spyOn(L3Atom.prototype, 'handle').mockImplementation(async (task) => {
      rootTask ??= task;
      throw new Error('stop after launch');
    });
    let handle: Awaited<ReturnType<typeof startTask>> | undefined;
    try {
      handle = await startTask(['--seed', join(root, 'seed'), '--no-learn-skills', '--no-direct-skills', 'Repair the browser suite'], opts);
      await handle.settled;
    } finally { await handle?.shutdown(); closeStoreHandles(); }
    const path = readdirSync(runs).find(name => name.endsWith('.json') && name !== 'index.json')!;
    return { trace: JSON.parse(readFileSync(join(runs, path), 'utf8')) as VizRun, task: rootTask! };
  };

  it('lists every package root of the seed past the routing cap, and still copies no installed tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-package-roots-'));
    try {
      writeSeed(join(root, 'seed'));
      const { trace, task } = await launch(root);
      const preparation = workspacePreparationSchema.parse(trace.task.inputs?.['workspacePreparation']);
      expect(preparation).toEqual({ dependencies: 'excluded-from-seed', packageRoots: expectedRoots, packageRootsComplete: true });
      expect(task.inputs?.['workspacePreparation']).toEqual(preparation);
      // The routing inventory this replaces was cut before browser/.
      const repository = trace.task.inputs?.['startingRepository'] as { files: string[]; incomplete: boolean };
      expect(repository.incomplete).toBe(true);
      expect(repository.files).not.toContain('browser/package.json');
      expect(JSON.stringify(preparation)).not.toContain(readRunId);
      const workspace = join(root, 'workspace');
      expect(existsSync(join(workspace, 'browser', 'package-lock.json'))).toBe(true);
      expect(existsSync(join(workspace, 'node_modules'))).toBe(false);
      expect(existsSync(join(workspace, 'browser', 'node_modules'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Four nested 150-character names put a root past the receipt's 512-character
  // `dir`: its schema parse threw at launch and the run never started (review 2026-10-26).
  it('launches a seed whose package root path a receipt cannot hold, with the scan marked incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atoma-long-roots-'));
    try {
      writeSeed(join(root, 'seed'));
      const long = join(root, 'seed', ...Array.from({ length: 4 }, (_, i) => `${String(i)}${'n'.repeat(149)}`));
      mkdirSync(long, { recursive: true });
      writeFileSync(join(long, 'package.json'), '{}');
      const { trace, task } = await launch(root);
      expect(workspacePreparationSchema.parse(task.inputs?.['workspacePreparation']))
        .toEqual({ dependencies: 'excluded-from-seed', packageRoots: expectedRoots, packageRootsComplete: false });
      expect(trace.task.inputs?.['workspacePreparation']).toEqual(task.inputs?.['workspacePreparation']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads the roots of a Compute run from the seed on the server, never across the workspace channel', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-compute-roots-')));
    const seed = join(root, 'seed');
    const device = join(root, 'device-current');
    writeSeed(seed);
    const handler = workspaceCommandHandler(localWorkspaceRuntime({ root: device, sourceRoot: join(root, 'device-private'), log: () => {} }));
    const commands: string[] = [];
    const server = await serveComputeBridge(async call => {
      commands.push(JSON.stringify(call));
      if (call.channel !== 'workspace') throw new Error('Unexpected bridge call');
      return handler(call.command);
    });
    let runtime: Awaited<ReturnType<typeof computeRunnerOptions>> | undefined;
    try {
      runtime = await computeRunnerOptions(server.address);
      const { trace } = await launch(root, { workspaceRuntime: runtime.workspaceRuntime, prepareWorkspaceSources: runtime.prepareWorkspaceSources,
        createToolBackend: async () => localToolBackend({ workspaceRoot: device, logger: { debug() {}, info() {}, warn() {}, error() {} } }) });
      expect(workspacePreparationSchema.parse(trace.task.inputs?.['workspacePreparation']))
        .toEqual({ dependencies: 'excluded-from-seed', packageRoots: expectedRoots, packageRootsComplete: true });
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.join('\n')).not.toContain(seed);
      expect(existsSync(join(device, 'browser', 'package.json'))).toBe(true);
      expect(existsSync(join(device, 'browser', 'node_modules'))).toBe(false);
    } finally {
      runtime?.close(); await server.close(); await handler.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
