import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import { runParentTests } from '../src/tools/parentTests.js';
import { parentTestSuiteSchema, type ParentTestSuite } from '../src/contracts/parentTests.js';
import { verifyParentTests, parentTestConsequence, parentTestRejection } from '../src/core/parentTests.js';
import { superviseLoop } from '../src/core/supervisor.js';
import { Atom } from '../src/core/atom.js';
import type { Result, RunContext, Task, Tier } from '../src/core/types.js';
import { planSchema, resultPayloadSchema } from '../src/atoms/json.js';
import { delegatedTaskContext } from '../src/atoms/taskContext.js';
import { forkBranch } from '../src/core/branchCtx.js';
import { dispatchWithAggregation } from '../src/atoms/dispatch.js';
import { parallelDeclaredOutputCollision } from '../src/atoms/l3RootPlan.js';
import { makeCtx, silentLogger } from './helpers.js';
import { makePlan } from './helpers/factories.js';

const dirs: string[] = [];
const boxes: ToolSandbox[] = [];

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'atoma-parent-fixture-'));
  dirs.push(root);
  const box = new ToolSandbox(root);
  boxes.push(box);
  return { root, box };
};

afterEach(async () => {
  await Promise.all(boxes.splice(0).map(box => box.cleanup()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const suite = (source = "import {test,expect} from 'vitest'; import {add} from './add.ts'; test('adds signed values',()=>{expect(add(2,3)).toBe(5); expect(add(-2,1)).toBe(-1)});"): ParentTestSuite => ({
  requirement: 'add returns the sum of its arguments',
  cwd: '.',
  source,
});

const result = (name = 'leaf'): Result => ({
  output: name,
  summary: name,
  producedBy: { tier: 1, name, viaFallback: false },
  trace: [],
});

it('runs real TypeScript through the fixed runner, detects a wrong implementation and ignores project config/scripts', async () => {
  const { root, box } = fixture();
  writeFileSync(path.join(root, 'add.ts'), 'export const add=(a:number,b:number)=>a+b;');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'exit 0' } }));
  writeFileSync(path.join(root, 'vitest.config.ts'), "throw new Error('project config must not execute');");
  const tools = new InMemoryToolRegistry();
  tools.registerAll(defaultBuiltinTools({ sandbox: box, logger: silentLogger() }));
  const ctx: RunContext = { ...makeCtx(), tools };

  const approved = await verifyParentTests({ description: 'add', acceptanceTests: suite() }, result(), forkBranch(forkBranch(ctx, 'l2'), 'l1'));

  expect(approved.parentTests?.[0], approved.summary).toMatchObject({ status: 'passed', passed: 1 });
  expect(parentTestRejection(approved)).toBeNull();
  writeFileSync(path.join(root, 'add.ts'), 'export const add=(_a:number,_b:number)=>5;');
  const rejected = await verifyParentTests({ description: 'add', acceptanceTests: suite() }, result(), ctx);
  expect(rejected.parentTests?.[0], rejected.summary).toMatchObject({ status: 'failed', failed: 1 });
  expect(rejected.parentTests?.[0]?.workspaceDigest).not.toBe(approved.parentTests?.[0]?.workspaceDigest);
  expect(parentTestConsequence(rejected.parentTests![0]!)).toBe('reject');
  expect(rejected.summary).toBe('leaf');
  expect(rejected.refusal).toBeUndefined();
  expect(() => readFileSync(path.join(root, 'atoma.acceptance.test.ts'))).toThrow();
}, 60_000);

// PARENT_TEST_RUNNER_SCOPE tells planners and the delegation review what a suite
// can run (run 7a7af324). The refusals it states (processes, workers, the live
// workspace) are pinned below; this pins what it says a suite CAN do, so the
// text cannot outlive the runner.
it('runs a suite that imports built output and requests an in-process server on loopback', async () => {
  const { root, box } = fixture();
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'dist', 'server.js'), [
    "import http from 'node:http';",
    'export function createServer() {',
    '  return http.createServer((_request, response) => {',
    "    response.setHeader('content-type', 'application/json');",
    '    response.end(JSON.stringify({ ok: true }));',
    '  });',
    '}',
    '',
  ].join('\n'));
  const source = [
    "import { test, expect } from 'vitest';",
    "import { createServer } from './dist/server.js';",
    "test('serves the status route on loopback', async () => {",
    '  const server = createServer();',
    "  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));",
    '  const address = server.address();',
    "  if (!address || typeof address === 'string') throw new Error('no port');",
    '  const response = await fetch(`http://127.0.0.1:${address.port}/api/status`);',
    '  expect(await response.json()).toEqual({ ok: true });',
    '  await new Promise<void>(resolve => server.close(() => resolve()));',
    '});',
  ].join('\n');

  const observation = await runParentTests(box, [JSON.stringify(suite(source))], 60_000);

  expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'passed', cause: 'ran', passed: 1, failed: 0 });
}, 60_000);

// Run e3c8a4a2 (2026-10-16): a migration kept browser/attica-store.js as a
// forwarder to an unbuilt dist/ beside the new attica-store.ts; the suite's
// extensionless import loaded the forwarder and failed before any test ran.
// PARENT_TEST_RUNNER_SCOPE states the resolution order; this pins it.
it('resolves an extensionless import to the .js file before a .ts file of the same name', async () => {
  const { root, box } = fixture();
  writeFileSync(path.join(root, 'store.js'), "module.exports = { origin: 'forwarder' };\n");
  writeFileSync(path.join(root, 'store.ts'), "export const origin = 'typescript';\n");
  const source = [
    "import { test, expect } from 'vitest';",
    "import * as bare from './store';",
    "import * as explicit from './store.ts';",
    "test('resolution order', () => {",
    "  expect(bare.origin).toBe('forwarder');",
    "  expect(explicit.origin).toBe('typescript');",
    '});',
  ].join('\n');

  const observation = await runParentTests(box, [JSON.stringify(suite(source))], 60_000);

  expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'passed', cause: 'ran', passed: 1, failed: 0 });
}, 60_000);

// Run 760fef4c (2026-10-17): the collector's session module probes for a
// Chromium binary at import, `existsSync('/usr/bin/chromium')`. Under the
// runner's Node permissions that call THREW ERR_ACCESS_DENIED, where the
// operating system's own refusal and `fs.exists` both answer false: both
// parent suites "failed 0/0" on a module that never loaded, and the run was
// refused at delivery for code whose own suite passed.
it('answers an existence probe outside the copy with false and still refuses reading it', async () => {
  const { root, box } = fixture();
  const outside = fixture();
  const secret = path.join(outside.root, 'secret');
  writeFileSync(secret, 'hidden');
  writeFileSync(path.join(root, 'probe.js'), [
    "import fs, { existsSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    `const outside = ${JSON.stringify(secret)};`,
    'export const named = existsSync(outside);',
    'export const viaDefault = fs.existsSync(outside);',
    "export const viaRequire = createRequire(import.meta.url)('node:fs').existsSync(outside);",
    "export const inside = existsSync('./probe.js');",
    '',
  ].join('\n'));
  // PARENT_TEST_RUNNER_SCOPE says HOME and the temporary directory are inside the copy.
  const source = [
    "import { test, expect } from 'vitest';",
    "import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { homedir, tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { named, viaDefault, viaRequire, inside } from './probe.js';",
    "test('probes', () => {",
    '  expect([named, viaDefault, viaRequire, inside]).toEqual([false, false, false, true]);',
    `  expect(() => readFileSync(${JSON.stringify(secret)}, 'utf8')).toThrow();`,
    '  expect([existsSync(homedir()), existsSync(tmpdir())]).toEqual([true, true]);',
    "  const scratch = mkdtempSync(join(tmpdir(), 'fixture-'));",
    "  writeFileSync(join(homedir(), '.probe'), 'home');",
    "  writeFileSync(join(scratch, 'value'), 'temporary');",
    "  expect(readFileSync(join(scratch, 'value'), 'utf8')).toBe('temporary');",
    '});',
  ].join('\n');

  const observation = await runParentTests(box, [JSON.stringify(suite(source))], 60_000);

  expect(observation, JSON.stringify(observation)).toMatchObject({ status: 'passed', cause: 'ran', passed: 1, failed: 0 });
}, 60_000);

// Review 2026-10-17: restoring `existsSync` for ESM named imports re-syncs
// every built-in's ESM bindings, and Vitest had already replaced `process.exit`
// with a catchable error: `import { exit } from 'node:process'` inside a
// catch-all turned a red suite green. The runner holds those bindings.
it('keeps an exit imported from node:process fatal when the code under test catches everything', async () => {
  const { root, box } = fixture();
  writeFileSync(path.join(root, 'quit.js'), [
    "import { exit } from 'node:process';",
    "export function quit() { try { exit(3); } catch { return 'caught'; } return 'continued'; }",
    '',
  ].join('\n'));
  const source = [
    "import { test, expect } from 'vitest';",
    "import { quit } from './quit.js';",
    "test('quits', () => { expect(quit()).toBe('caught'); });",
  ].join('\n');

  const observation = await runParentTests(box, [JSON.stringify(suite(source))], 60_000);

  expect(observation.status, JSON.stringify(observation)).not.toBe('passed');
}, 60_000);

it('isolates test writes and refuses access to the live workspace', async () => {
  const { root, box } = fixture();
  writeFileSync(path.join(root, 'add.ts'), 'original');
  const source = `import {test,expect} from 'vitest'; import {writeFileSync,readFileSync,symlinkSync} from 'node:fs'; import {Worker} from 'node:worker_threads'; import {spawnSync} from 'node:child_process'; test('snapshot',()=>{writeFileSync('./add.ts','temporary'); expect(readFileSync('./add.ts','utf8')).toBe('temporary'); expect(()=>new Worker('0',{eval:true,execArgv:[]})).toThrow(); expect(()=>spawnSync(process.execPath,['-e','0'])).toThrow(); expect(()=>writeFileSync(${JSON.stringify(path.join(root,'add.ts'))},'bad')).toThrow(); expect(()=>{symlinkSync(${JSON.stringify(path.join(root,'add.ts'))},'./escape');writeFileSync('./escape','bad');}).toThrow();});`;

  const observation = await runParentTests(box, [JSON.stringify(suite(source))], 30_000);

  expect(observation, observation.details).toMatchObject({ status: 'passed' });
  expect(readFileSync(path.join(root, 'add.ts'), 'utf8')).toBe('original');
}, 45_000);

it.each([
  "import {test} from 'vitest'; test.skip('missing',()=>{});",
  "import {test} from 'vitest'; test.only('focused',()=>{});",
  "export const noTests = true;",
])('never approves an incomplete suite: %s', async source => {
  const { box } = fixture();

  const observation = await runParentTests(box, [JSON.stringify(suite(source))], 30_000);

  expect(observation.status).not.toBe('passed');
}, 45_000);

it('bounds a hung runner and rejects escaping links without executing them', async () => {
  const { root, box } = fixture();

  const observation = await runParentTests(box, [JSON.stringify(suite("while(true){}"))], 500);

  expect(observation.status).not.toBe('passed');
  const outside = fixture();
  writeFileSync(path.join(outside.root, 'secret'), 'hidden');
  symlinkSync(path.join(outside.root, 'secret'), path.join(root, 'escape'));
  expect((await runParentTests(box, [JSON.stringify(suite())], 1000)).details).toContain('outside the project');
}, 15_000);

it('does not trust a child result or a mismatched suite receipt', async () => {
  expect(resultPayloadSchema.parse({ ...result(), parentTests: [{ status: 'passed' }] })).not.toHaveProperty('parentTests');
  const tools = {
    has: () => true,
    execute: vi.fn(async () => ({
      suiteDigest: 'other',
      workspaceDigest: 'x',
      status: 'passed',
      passed: 1,
      failed: 0,
      skipped: 0,
      details: '',
    })),
  };

  const observed = await verifyParentTests({ description: 'x', acceptanceTests: suite() }, result(), { ...makeCtx(), tools });

  expect(observed.parentTests?.[0]?.status).toBe('unavailable');
  expect((await verifyParentTests({ description: 'text' }, result(), makeCtx())).parentTests).toBeUndefined();
  expect(parentTestSuiteSchema.safeParse({ ...suite(), cwd: '../outside' }).success).toBe(false);
});

it('delegates only the reviewed child suite, freezing its bytes instead of inheriting integration tests', () => {
  const parent = { description: 'integration', acceptanceTests: suite('integration') };
  expect(delegatedTaskContext(parent, { description: 'inspect' }).acceptanceTests).toBeUndefined();
  const subtask = { description: 'module', acceptanceTests: suite() };

  const delegated = delegatedTaskContext(parent, subtask);
  subtask.acceptanceTests.source = 'weakened';

  expect(delegated.acceptanceTests?.source).not.toBe('weakened');
  expect(Object.isFrozen(delegated.acceptanceTests)).toBe(true);
});

class Worker extends Atom {
  readonly model = 'mock';

  constructor(readonly tier: Tier) {
    super({ name: `tier${tier}`, ordinal: 0, systemPrompt: '', tools: [], params: {} });
  }

  async plan() {
    return makePlan();
  }

  async execute() {
    return result(this.name);
  }

  async validatePlan() {
    return { approved: true as const, reasoning: 'plan reviewed' };
  }

  async validateResult() {
    return { approved: true as const, reasoning: 'semantic review' };
  }
}

it('the shared supervision loop verifies before credit and verifies fallback too', async () => {
  const parent = new Worker(2);
  const child = new Worker(1);
  const credit = vi.fn();
  const task: Task = { description: 'add', acceptanceTests: suite() };
  const digest = createHash('sha256').update(JSON.stringify(task.acceptanceTests)).digest('hex');
  const execute = vi.fn(async () => ({
    suiteDigest: digest,
    workspaceDigest: 'x',
    status: 'failed',
    passed: 0,
    failed: 1,
    skipped: 0,
    details: 'bad sum',
  }));
  const ctx: RunContext = {
    ...makeCtx(),
    tools: { has: () => true, execute },
    limits: { ...makeCtx().limits, maxExecIterations: 1 },
  };

  const delivered = await superviseLoop(parent, child, task, ctx, {
    applyByScope: async c => c,
    branchOnEscalation: async () => {},
    onApproved: credit,
  });

  expect(credit).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(delivered.producedBy.viaFallback).toBe(true);
  expect(parentTestRejection(delivered)).not.toBeNull();
});

describe('dependency-aware parallel branches', () => {
  it('runs independent L2-shaped branches concurrently and starts a dependent branch without a global barrier', async () => {
    const plan = makePlan({
      subtasks: [
        { description: 'A' },
        { description: 'B' },
        { description: 'A consumer', dependsOn: [0] },
        { description: 'join', dependsOn: [1, 2] },
      ],
    });
    const starts: number[] = [];
    const resolvers = new Map<number, (r: Result) => void>();
    const run = vi.fn((task: typeof plan.subtasks[number], index: number) => {
      starts.push(index);
      if (index === 2) {
        expect(task.inputs?.['dependencyResults']).toEqual([expect.objectContaining({ index: 0, summary: 'A' })]);
        return Promise.resolve(result('C'));
      }
      if (index === 3) return Promise.resolve(result('join'));
      return new Promise<Result>(resolve => resolvers.set(index, resolve));
    });

    const completion = dispatchWithAggregation(plan.subtasks, plan, makeCtx(), run, { dispatcher: 'Dispatcher' });

    await vi.waitFor(() => expect(starts).toEqual([0, 1]));
    resolvers.get(0)!(result('A'));
    await vi.waitFor(() => expect(starts).toEqual([0, 1, 2]));
    resolvers.get(1)!(result('B'));
    const outcome = await completion;
    expect(starts).toEqual([0, 1, 2, 3]);
    expect(outcome.results.map(r => r.summary)).toEqual(['A', 'B', 'C', 'join']);
  });

  it('rejects malformed dependencies before work and ignores ordered output overlap', async () => {
    const plan = makePlan({
      subtasks: [
        { description: 'A', outputs: ['x.ts'] },
        { description: 'join', outputs: ['x.ts'], dependsOn: [0] },
      ],
    });
    expect(parallelDeclaredOutputCollision(plan)).toBeNull();
    const invalid = { ...plan, subtasks: [{ description: 'cycle', dependsOn: [0] }] };
    const run = vi.fn();

    expect(planSchema.safeParse(invalid).success).toBe(false);
    await expect(dispatchWithAggregation(invalid.subtasks, invalid, makeCtx(), run, { dispatcher: 'Dispatcher' })).rejects.toThrow('earlier');
    expect(run).not.toHaveBeenCalled();
  });

  it('settles siblings and never starts a consumer of a failed dependency', async () => {
    const plan = makePlan({
      subtasks: [
        { description: 'A' },
        { description: 'B' },
        { description: 'join', dependsOn: [0, 1] },
      ],
    });
    const run = vi.fn(async (_task, index) => {
      if (index === 0) throw new Error('failed dependency');
      return result();
    });

    await expect(dispatchWithAggregation(plan.subtasks, plan, makeCtx(), run, { dispatcher: 'Dispatcher' })).rejects.toThrow('failed dependency');

    expect(run.mock.calls.map(call => call[1])).toEqual([0, 1]);
  });
});

it('L3 reviews even a trusted L2, reuses unchanged approval, and reviews changed test bytes again', async () => {
  const { AtomRegistry } = await import('../src/registry/atomRegistry.js');
  const { openDb } = await import('../src/registry/db.js');
  const { L3Atom } = await import('../src/atoms/L3Atom.js');
  const { L2Atom } = await import('../src/atoms/L2Atom.js');
  const db = openDb(':memory:');
  const reg = new AtomRegistry(db);
  const seed = { description: 'test', systemPrompt: 'supervisor', tools: [], params: {}, createdBy: 'test' };
  reg.create(3, seed);
  reg.create(2, seed);
  for (let i = 0; i < 10; i++) reg.recordSuccess('Tracheid');
  const tissue = L3Atom.buildWithModel(reg.getByName('Meristem')!, reg, 'mock');
  const cell = L2Atom.fromType(reg.getByName('Tracheid')!, reg);
  const plan = makePlan({ subtasks: [{ description: 'addition', acceptanceTests: suite() }] });
  const ctx = makeCtx();
  const task = { description: 'addition' };
  ctx.llm.enqueueText(JSON.stringify({
    approved: true,
    reasoning: 'Tests cover signed addition and import the actual module.',
    delegationReview: {
      subtasks: [{ index: 0, kind: 'vitest', reason: 'addition' }],
      integration: { kind: 'other', reason: 'single module' },
      independentWork: false,
      parallelReason: 'single addition module',
    },
  }));

  expect((await tissue.validatePlan(cell, plan, task, ctx)).approved).toBe(true);
  expect((await tissue.validatePlan(cell, plan, task, ctx)).approved).toBe(true);
  expect(ctx.llm.calls).toHaveLength(1);

  ctx.llm.enqueueText(JSON.stringify({
    approved: false,
    reasoning: 'The replacement assertion is trivial.',
    scope: 'ephemeral',
    modifications: { additionalContext: 'Exercise actual addition.' },
  }));
  const altered = {
    ...plan,
    subtasks: [{ description: 'addition', acceptanceTests: suite("import {test,expect} from 'vitest'; test('trivial',()=>expect(true).toBe(true));") }],
  };
  expect((await tissue.validatePlan(cell, altered, task, ctx)).approved).toBe(false);
  expect(ctx.llm.calls).toHaveLength(2);
  db.close();
});

it('preserves completed work when the budget prevents integration tests, while cancellation still aborts', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('deadline', 'TimeoutError'));
  const tools = { has: () => true, execute: vi.fn() };
  const ctx: RunContext = { ...makeCtx(), tools, signal: controller.signal, deadlineAt: Date.now() - 1 };

  const kept = await verifyParentTests({ description: 'integration', acceptanceTests: suite() }, result('completed modules'), ctx);

  expect(kept.output).toBe('completed modules');
  expect(kept.unfinishedPhases).toContain('acceptance tests: integration');
  expect(kept.parentTests?.[0]?.status).toBe('unavailable');
  expect(tools.execute).not.toHaveBeenCalled();
  expect(kept.parentTests?.[0]?.cause).toBe('landing');
  expect(kept.refusal).toBeUndefined();
  const cancel = new AbortController();
  cancel.abort(new Error('user cancelled'));
  await expect(verifyParentTests({ description: 'integration', acceptanceTests: suite() }, result(), { ...ctx, signal: cancel.signal })).rejects.toThrow('user cancelled');
});
