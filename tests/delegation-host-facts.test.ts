import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configDefaults } from 'vitest/config';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { enforceParsedDelegationReview } from '../src/atoms/delegationReview.js';
import {
  VITEST_TEST_FILE, planSuitePrecheck, relativeSpecifiers, resolutionCandidates, suiteImportTarget, suiteTestFileImports,
} from '../src/atoms/parentSuiteCheck.js';
import { planSuiteFactsBlock } from '../src/atoms/parentSuiteFacts.js';
import { PARENT_TEST_PLANNING, type DelegationReview } from '../src/contracts/parentTests.js';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { defaultBuiltinTools } from '../src/tools/builtin.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import { runParentTests } from '../src/tools/parentTests.js';
import type { LlmCompletionRequest, LlmCompletionResponse, Plan, Result, ToolExecutor } from '../src/core/types.js';
import { makeCtx, silentLogger } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * What the host knows of a plan's suites, handed to the delegation review
 * (2026-10-17). Replays of run 760fef4c's root review refused one plan three
 * times in six because its imports "resolve under tests/": the suite runs at
 * the root of a copy of its cwd, and every file it imported existed.
 */

const dirs: string[] = [];
const boxes: ToolSandbox[] = [];
const databases: ReturnType<typeof openDb>[] = [];
afterEach(async () => {
  await Promise.all(boxes.splice(0).map(box => box.cleanup()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const db of databases.splice(0)) db.close();
});

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'atoma-suite-facts-'));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  const box = new ToolSandbox(root);
  boxes.push(box);
  const tools = new InMemoryToolRegistry();
  tools.registerAll(defaultBuiltinTools({ sandbox: box, logger: silentLogger() }));
  const ctx = { ...makeCtx(), tools };
  return { root, ctx };
}

const suite = (source: string, cwd = '.') => ({ requirement: 'the module works', cwd, source });
const review = (kinds: Array<'vitest' | 'inspection' | 'other'>, integration: 'vitest' | 'other' = 'other'): DelegationReview => ({
  subtasks: kinds.map((kind, index) => ({ index, kind, reason: 'actual scope' })),
  integration: { kind: integration, reason: 'integration scope' },
  independentWork: false,
  parallelReason: 'one module',
});

describe('reading a suite\'s imports', () => {
  it('reads static, re-exported, dynamic and required relative specifiers, never bare or computed ones', () => {
    expect(relativeSpecifiers([
      "import { test } from 'vitest';",
      "import { a } from './src/a.ts';",
      "export { b } from '../b.js';",
      "const c = await import('./c');",
      "const d = require('./d.cjs');",
      'const e = await import(name);',
      "import fs from 'node:fs';",
    ].join('\n'))).toEqual(['./src/a.ts', '../b.js', './c', './d.cjs']);
  });

  it('tries the files the runner tries, in its order', () => {
    expect(resolutionCandidates('src/a').slice(0, 4)).toEqual(['src/a', 'src/a.mjs', 'src/a.js', 'src/a.mts']);
    expect(resolutionCandidates('src/a.js')).toEqual(['src/a.js', 'src/a.ts', 'src/a.tsx']);
    expect(resolutionCandidates('src/a.ts')).toEqual(['src/a.ts']);
  });

  it('resolves against the suite cwd and says when an import leaves the copy', () => {
    expect(suiteImportTarget('.', './browser/x.js')).toBe('browser/x.js');
    expect(suiteImportTarget('tests', './x.ts')).toBe('tests/x.ts');
    expect(suiteImportTarget('tests', '../browser/x.js')).toBeUndefined();
    expect(suiteImportTarget('.', '../x.js')).toBeUndefined();
  });

  it('names test files by the runner\'s own default include', () => {
    expect(configDefaults.include).toEqual(['**/*.{test,spec}.?(c|m)[jt]s?(x)']);
    for (const file of ['a.test.ts', 'a.spec.js', 'a.test.mts', 'a.test.cjs', 'a.spec.tsx']) expect(VITEST_TEST_FILE.test(file), file).toBe(true);
    for (const file of ['a.ts', 'test.ts', 'a.test.json', 'tests/helpers/harness.js']) expect(VITEST_TEST_FILE.test(file), file).toBe(false);
    expect(suiteTestFileImports('.', "import './tests/x.vitest.test.ts'; import { h } from './tests/helpers/h.js'; import './y.test';"))
      .toEqual(['./tests/x.vitest.test.ts', './y.test']);
  });
});

describe('the zero-token precheck', () => {
  it('refuses a suite that imports a test file, with every other finding of the plan, in one refusal', () => {
    const regex = String.raw`expect('a b').toMatch(/a\\sb/);`;
    const precheck = planSuitePrecheck([
      { label: 'on subtask 0', cwd: '.', source: `import { test, expect } from 'vitest';\nimport './tests/collector.test.ts';\ntest('t', () => { ${regex} });` },
      { label: 'for the plan integration', cwd: '.', source: "import { test, expect } from 'vitest';\ntest('t', () => { expect(1).toMatchSnapshot(); });" },
    ], new Set(), 'cell:A');
    expect(precheck.refusal).toContain('Acceptance suite on subtask 0, line 3');
    expect(precheck.refusal).toContain('Acceptance suite on subtask 0 imports ./tests/collector.test.ts, a test file: its assertions would be the child\'s.');
    expect(precheck.refusal).toContain('Acceptance suite for the plan integration: toMatchSnapshot is unavailable');
  });

  // Review 2026-10-17: the runner's snapshot leaves the read-run copies out,
  // so a suite comparing with one reads ENOENT in every round, and the child
  // is rejected for a suite it cannot change. Refused at plan time, every time,
  // saying what to do rather than that the suite "can never pass" (second review).
  const COPY_SUITE = "import { test, expect } from 'vitest';\nimport { readFileSync } from 'node:fs';\n" +
    "test('restored', () => { expect(readFileSync('browser/x.js', 'utf8')).toBe(readFileSync('.atoma-runs/node_modules/50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a/browser/x.js', 'utf8')); });";
  const COPY_REFUSAL = 'Acceptance suite on subtask 0 names .atoma-runs, which a parent-owned suite cannot read: the runner\'s copy of the workspace leaves it out. ' +
    'Remove the mention; prove a restore or a comparison with another run\'s saved files with sha256sum or diff in a shell subtask (the host also compares ' +
    'the files the criteria name with the read runs\' saved files at acceptance). Revise the suite.';

  it('refuses a suite naming the read-run copies every time, in the one refusal with every other finding', () => {
    const regex = String.raw`expect('a b').toMatch(/a\\sb/);`;
    const memo = new Set<string>();
    const suites = [
      { label: 'on subtask 0', cwd: '.', source: COPY_SUITE },
      { label: 'on subtask 1', cwd: '.', source: `import { test, expect } from 'vitest';\ntest('t', () => { ${regex} });` },
      { label: 'for the plan integration', cwd: '.', source: "import { test, expect } from 'vitest';\ntest('t', () => { expect(1).toMatchSnapshot(); });" },
    ];
    const first = planSuitePrecheck(suites, memo, 'cell:A');
    expect(first.refusal).toContain(COPY_REFUSAL);
    expect(first.refusal).toContain('Acceptance suite on subtask 1, line 2');
    expect(first.refusal).toContain('Acceptance suite for the plan integration: toMatchSnapshot is unavailable');
    // Told once is not excused: it can never pass, so it is refused again.
    expect(planSuitePrecheck([suites[0]!], memo, 'cell:A').refusal).toBe(COPY_REFUSAL);
    // Any mention counts: the copies are absent from the snapshot however they are named.
    expect(planSuitePrecheck([{ label: 'on subtask 0', cwd: '.', source: "import { test, expect } from 'vitest';\nimport { readdirSync } from 'node:fs';\n" +
      "test('t', () => { expect(readdirSync('.atoma-runs')).toHaveLength(1); });" }], memo, 'cell:A').refusal).toBe(COPY_REFUSAL);
    // A suite that merely shares the prefix is not refused.
    expect(planSuitePrecheck([{ label: 'on subtask 0', cwd: '.', source: "import { test, expect } from 'vitest';\ntest('t', () => { expect('.atoma-runsx').toBe('.atoma-runsx'); });" }],
      memo, 'cell:A').refusal).toBeUndefined();
  });

  it('refuses it in the review\'s own enforcement too', () => {
    const plan = makePlan({ subtasks: [{ description: 'Restore x', outputs: ['browser/x.js'], acceptanceTests: suite(COPY_SUITE) }] });
    const refusal = enforceParsedDelegationReview(plan, review(['vitest']), false);
    expect(refusal?.delegationRefusal).toBe('plan');
    expect(refusal?.reasoning).toContain(COPY_REFUSAL);
  });
});

describe('the mechanical half of the review', () => {
  const tested = (source = "import { test, expect } from 'vitest';\nimport { a } from './a.ts';\ntest('a', () => { expect(a()).toBe(1); });") => suite(source);

  it('states every plan finding in one refusal, and keeps the fan-out finding its own kind', () => {
    const plan = makePlan({ aggregation: { mode: 'sequential' }, subtasks: [
      { description: 'Implement a', outputs: ['a.ts'] },
      { description: 'Implement b', outputs: ['b.ts'], acceptanceTests: tested("import { test, expect } from 'vitest';\ntest('b', () => { expect(1).toMatchSnapshot(); });") },
    ] });
    const refusal = enforceParsedDelegationReview(plan, { ...review(['vitest', 'vitest']), independentWork: true, parallelReason: 'a and b are independent' }, false);
    expect(refusal?.delegationRefusal).toBe('plan');
    expect(refusal?.reasoning).toContain('Missing parent-owned acceptanceTests on subtask 0');
    expect(refusal?.reasoning).toContain('toMatchSnapshot is unavailable');
    // On a resumed run a fan-out refusal ends the plan; a plan refusal asking to fan out would contradict its precheck.
    expect(refusal?.reasoning).not.toContain('Independent work must have parallel child branches');
  });

  it('keeps a fan-out finding alone a fan-out refusal', () => {
    const plan = makePlan({ aggregation: { mode: 'sequential' }, subtasks: [
      { description: 'Implement a', outputs: ['a.ts'], acceptanceTests: tested() },
      { description: 'Implement b', outputs: ['b.ts'], acceptanceTests: tested() },
    ] });
    const refusal = enforceParsedDelegationReview(plan, { ...review(['vitest', 'vitest']), independentWork: true, parallelReason: 'independent' }, false);
    expect(refusal?.delegationRefusal).toBe('fan-out');
  });

  it('asks for a plan integration suite only when two or more tested branches interact', () => {
    const one = makePlan({ subtasks: [{ description: 'Implement a', outputs: ['a.ts'], acceptanceTests: tested() }, { description: 'Document a', outputs: ['README.md'] }] });
    expect(enforceParsedDelegationReview(one, review(['vitest', 'other'], 'vitest'), false)).toBeUndefined();
    const two = makePlan({ aggregation: { mode: 'concat' }, subtasks: [
      { description: 'Implement a', outputs: ['a.ts'], acceptanceTests: tested() },
      { description: 'Implement b', outputs: ['b.ts'], acceptanceTests: tested(), dependsOn: [0] },
    ] });
    expect(enforceParsedDelegationReview(two, review(['vitest', 'vitest'], 'vitest'), false)?.reasoning).toContain('Missing parent-owned acceptanceTests on plan integration');
  });
});

describe('the host facts block', () => {
  const files = {
    'src/a.ts': 'export const a = () => 1;\n',
    'src/app.css': 'body {}\n',
    'public/index.html': '<p>hi</p>\n',
    'vendor/lib/package.json': JSON.stringify({ main: 'main.js' }),
    'vendor/lib/main.js': 'module.exports = { lib: 1 };\n',
    'tests/old.test.ts': "import { a } from '../src/a.ts';\n",
  };
  const facts = (source: string, outputs: string[], cwd = '.'): Plan => makePlan({ subtasks: [
    { description: 'Change the modules', outputs, acceptanceTests: suite(source, cwd) },
  ] });

  it('states where each import resolves and reads existing source separately', async () => {
    const { ctx } = workspace(files);
    const source = [
      "import { test, expect } from 'vitest';",
      "import { a } from './src/a';",
      "import './src/app.css';",
      "import page from './public/index.html?raw';",
      "import { lib } from './vendor/lib';",
      "import { n } from './src/new.ts';",
      "import { h } from './tests/helpers/h.ts';",
      "import { d } from './dist/server.js';",
      "import { o } from '../outside.ts';",
      "test('t', () => { expect(a() + lib + n + h + d + o).toBe(page.length); });",
    ].join('\n');
    const block = await planSuiteFactsBlock(facts(source, ['src/new.ts', 'tests/']), ctx);
    expect(block.split('\n').slice(0, 2)).toEqual([
      'HOST FACTS ON THE SUITES, computed from the workspace and this plan; facts, not a verdict. Each suite runs as atoma.acceptance.test.ts at the root of a copy of its cwd, not at any path a subtask writes, and its relative imports resolve from there:',
      '- subtask 0 suite (cwd .): ./src/a → src/a.ts, exists; ./src/app.css → src/app.css, exists; ./public/index.html?raw → public/index.html, exists; ' +
        './vendor/lib → vendor/lib, a directory with a package.json and no index file; the entry it names is not checked; ./src/new.ts → src/new.ts, declared by this plan before the suite runs; ' +
        './tests/helpers/h.ts → tests/helpers/h.ts, declared by this plan before the suite runs; ./dist/server.js → not present now, and no subtask declares it; ' +
        '../outside.ts → outside the copied cwd, never present.',
    ]);
    expect(block).toContain('export const a = () => 1;');
    expect(block).not.toContain('body {}');
  });

  it('exposes the real required argument and method behind a suite that fails before its intended assertion', async () => {
    const { root, ctx } = workspace({
      'collector.js': "export function collect({startUrl, output}) { if (!startUrl || !output) throw new Error('startUrl and output required'); return output; }",
      'store.ts': 'export class Store { loadPause() { return null; } }',
    });
    const broken = "import { test, expect } from 'vitest'; import { collect } from './collector.js'; import { Store } from './store.ts'; test('collect', () => { expect(collect({startUrl:'fixture'})).toBe('rows'); expect(new Store().getPauseState()).toBe(null); });";
    const block = await planSuiteFactsBlock(facts(broken, []), ctx);
    expect(block).toContain('startUrl and output required');
    expect(block).toContain('loadPause()');
    expect(block).not.toContain('getPauseState');
    const box = new ToolSandbox(root);
    boxes.push(box);
    const failed = await runParentTests(box, [JSON.stringify(suite(broken))], 60_000);
    expect(failed).toMatchObject({ status: 'failed', failed: 1 });
    expect(failed.details).toContain('startUrl and output required');
    const fixed = broken.replace("startUrl:'fixture'", "startUrl:'fixture',output:'rows'").replace('getPauseState()', 'loadPause()');
    expect(await runParentTests(box, [JSON.stringify(suite(fixed))], 60_000)).toMatchObject({ status: 'passed', passed: 1 });
  }, 90_000);

  it('shows the late validation-before-browser branch of imported modules at the Attica run size', async () => {
    // b04565ec: the reviewer saw only a 3,559-character server head and
    // claimed an invalid /api/start request would launch a browser.
    const padding = '// current state request response session fixture target\n';
    const route = `export function start(maxPages: number) {
  if (maxPages < 1) return { status: 400 };
  throw new Error('browser launch would occur only after validation');
}`;
    const server = padding.repeat(390) + route;
    const { root, ctx } = workspace({
      'server.ts': server,
      'store.ts': padding.repeat(150) + 'export const store = 1;',
      'collector.ts': padding.repeat(440) + 'export const collector = 1;',
      'fixture.ts': padding.repeat(45) + 'export const fixture = 1;',
    });
    const source = `import { test, expect } from 'vitest';
import { start } from './server.ts';
import { store } from './store.ts';
import { collector } from './collector.ts';
import { fixture } from './fixture.ts';
test('invalid start cannot launch the browser', () => {
  expect(start(0).status).toBe(400);
  expect(store + collector + fixture).toBe(3);
});`;
    const block = await planSuiteFactsBlock(facts(source, []), ctx);
    expect(block).toContain(JSON.stringify(server));
    expect(block).toContain(JSON.stringify(route).slice(1, -1));
    const box = new ToolSandbox(root);
    boxes.push(box);
    expect(await runParentTests(box, [JSON.stringify(suite(source))], 60_000))
      .toMatchObject({ status: 'passed', passed: 1 });
  }, 90_000);

  it('bounds imported source, deduplicates it, and reports unreadable content without inventing absence', async () => {
    const { ctx } = workspace(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`src/m${i}.ts`, `export const m${i} = ${i};`])));
    const calls: Array<Record<string, unknown>> = [];
    const tools: ToolExecutor = { has: name => ctx.tools.has(name), execute: async (name, args) => {
      if (name === 'read_file') {
        calls.push(args);
        if (args['path'] === 'src/m1.ts') throw new Error('unreadable');
      }
      return await ctx.tools.execute(name, args);
    } };
    const source = Array.from({ length: 8 }, (_, i) => `import './src/m${i}.ts';`).join('\n') + "\nimport './src/m0.ts';";
    const block = await planSuiteFactsBlock(facts(source, []), { ...ctx, tools });
    expect(calls).toHaveLength(6);
    expect(calls.every(args => args['observationOnly'] === true)).toBe(true);
    expect(block).toContain('2 additional imported source files omitted');
    expect(block).toContain('current read unavailable');
    expect(block).toContain('This establishes no current content or absence');
    expect(block).toContain('not a prohibition on changes the task requests');
  });

  // Second review 2026-10-17.
  it('names what a directory can load from, and a race before what exists now', async () => {
    const { ctx } = workspace({ ...files, 'bare/readme.txt': 'nothing to load\n', 'feat/old.txt': 'present\n' });
    const plan = makePlan({ aggregation: { mode: 'concat' }, subtasks: [
      { description: 'Use them', outputs: ['src/a.ts'], acceptanceTests: suite([
        "import { test } from 'vitest';",
        "import { lib } from './vendor/lib';",
        "import { bare } from './bare';",
        "import { feat } from './feat';",
        "import type { Shape } from './types/shape.ts';",
        "test('t', () => { void [lib, bare, feat]; });",
      ].join('\n')) },
      { description: 'Write feat', outputs: ['feat/index.ts'] },
    ] });
    expect(await planSuiteFactsBlock(plan, ctx)).toContain(
      '- subtask 0 suite (cwd .): ./vendor/lib → vendor/lib, a directory with a package.json and no index file; the entry it names is not checked; ' +
      './bare → bare, a directory with no index file and no package.json, which cannot load; ' +
      './feat → feat/index.ts, declared only by a subtask this suite does not wait for.');
  });

  it('shows no block when a directory cannot be listed, rather than a false "not present"', async () => {
    const { ctx } = workspace(files);
    const tools = ctx.tools;
    const flaky: ToolExecutor = { has: name => tools.has(name),
      execute: async (name, args) => {
        if (name === 'list_files' && args['path'] === 'src') throw new Error('ENOENT: an entry vanished while listing');
        return await tools.execute(name, args);
      } };
    const block = await planSuiteFactsBlock(facts("import { test } from 'vitest';\nimport { a } from './src/a.ts';\ntest('t', () => { a(); });", []), { ...ctx, tools: flaky });
    expect(block).toBe('');
  });

  // Review 2026-10-17: a host read_file marked files read, which switched off
  // write_file's blind-overwrite refusal for the rest of the run.
  it('reads nothing a child could then overwrite blindly', async () => {
    // A written module no suite imports is what made the first version read every code file.
    const { ctx } = workspace({ ...files, 'src/b.ts': 'export const b = () => 2;\n', 'src/main.ts': "import { b } from './b.js';\nb();\n" });
    const block = await planSuiteFactsBlock(facts("import { test } from 'vitest';\nimport { a } from './src/a.ts';\ntest('t', () => { a(); });", ['src/a.ts', 'src/b.ts']), ctx);
    expect(block).toContain('./src/a.ts → src/a.ts, exists.');
    for (const path of ['src/a.ts', 'src/b.ts', 'src/main.ts']) {
      await expect(ctx.tools.execute('write_file', { path, content: 'export {};\n' })).rejects.toThrow('nothing in this run has read it');
    }
  });

  it('observation-only reads withhold overwrite permission; an ordinary read still grants it', async () => {
    const { ctx } = workspace({ 'src/a.ts': 'export const a = () => 1;\n' });
    await expect(ctx.tools.execute('write_file', { path: 'src/a.ts', content: 'export {};\n' }))
      .rejects.toThrow('nothing in this run has read it');
    const observed = await ctx.tools.execute('read_file', { path: 'src/a.ts', observationOnly: true });
    expect(observed).toMatchObject({ content: 'export const a = () => 1;\n' });
    await expect(ctx.tools.execute('write_file', { path: 'src/a.ts', content: 'export {};\n' }))
      .rejects.toThrow('nothing in this run has read it');
    await ctx.tools.execute('read_file', { path: 'src/a.ts' });
    await ctx.tools.execute('read_file', { path: 'src/a.ts', observationOnly: true });
    await expect(ctx.tools.execute('write_file', { path: 'src/a.ts', content: 'export {};\n' })).resolves.toBeDefined();
  });

  it('says an imported test file is one, and writes nothing without tools or suites', async () => {
    const { ctx } = workspace(files);
    const block = await planSuiteFactsBlock(facts("import { test } from 'vitest';\nimport './old.test.ts';\ntest('t', () => {});", ['src/a.ts'], 'tests'), ctx);
    expect(block).toContain('- subtask 0 suite (cwd tests): ./old.test.ts → tests/old.test.ts, exists, a test file.');
    expect(await planSuiteFactsBlock(makePlan({ subtasks: [{ description: 'x' }] }), ctx)).toBe('');
    expect(await planSuiteFactsBlock(facts("import './src/a.ts';", ['src/a.ts']), makeCtx())).toBe('');
  });

  // The facts claim what the runner does: pinned on the real runner, across its process boundary.
  it('agrees with the runner: what exists loads, what is not present does not', async () => {
    const { root, ctx } = workspace({ 'src/a.ts': 'export const a = () => 1;\n', 'src/twin.ts': 'export const twin = 2;\n',
      'vendor/lib/package.json': JSON.stringify({ main: 'main.js' }), 'vendor/lib/main.js': 'module.exports = { lib: 3 };\n' });
    const loads = "import { test, expect } from 'vitest';\nimport { a } from './src/a';\nimport { twin } from './src/twin.js';\nimport { lib } from './vendor/lib';\ntest('loads', () => { expect(a() + twin + lib).toBe(6); });";
    const missing = "import { test, expect } from 'vitest';\nimport { m } from './src/m';\ntest('loads', () => { expect(m).toBe(1); });";
    expect(await planSuiteFactsBlock(facts(loads, []), ctx)).toContain('./src/a → src/a.ts, exists; ./src/twin.js → src/twin.ts, exists; ./vendor/lib → vendor/lib, a directory with a package.json');
    expect(await planSuiteFactsBlock(facts(missing, []), ctx)).toContain('./src/m → not present now, and no subtask declares it.');
    const box = new ToolSandbox(root);
    boxes.push(box);
    expect(await runParentTests(box, [JSON.stringify(suite(loads))], 60_000)).toMatchObject({ status: 'passed', passed: 1 });
    expect((await runParentTests(box, [JSON.stringify(suite(missing))], 60_000)).details).toContain('the suite module did not load');
  }, 90_000);

  it('reaches the root review, and a test-file import is refused once before any review', async () => {
    const { ctx } = workspace(files);
    const db = openDb(':memory:');
    databases.push(db);
    const registry = new AtomRegistry(db);
    const tissue = L3Atom.buildWithModel(registry.create(3, { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' }), registry, 'mock');
    const imports = (target: string) => facts(`import { test, expect } from 'vitest';\nimport { a } from '${target}';\ntest('a', () => { expect(a()).toBe(1); });`, ['src/a.ts']);
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValueOnce(imports('./tests/old.test.ts')).mockResolvedValue(imports('./src/a.ts'));
    const done: Result = { output: {}, summary: 'done', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
    vi.spyOn(tissue, 'execute').mockResolvedValue(done);
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'scope reviewed', delegationReview: review(['vitest']) }));

    await tissue.handle({ description: 'Change module a' }, ctx);

    expect(plan).toHaveBeenCalledTimes(2);
    expect(String(plan.mock.calls[1]?.[2])).toContain('imports ./tests/old.test.ts, a test file');
    const reviews = ctx.llm.calls.filter(call => call.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW =='));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.userContent).toContain('- subtask 0 suite (cwd .): ./src/a.ts → src/a.ts, exists.');
    expect(reviews[0]!.userContent).toContain('export const a = () => 1;');
  });

  it.each([false, true])('repairs a refused root plan using the observed interface (parse retry: %s)', async parseRetry => {
    const module = 'export const schedule = { nextDueAt: 1234 };\n';
    const { ctx } = workspace({ 'scheduler.ts': module });
    const db = openDb(':memory:');
    databases.push(db);
    const registry = new AtomRegistry(db);
    const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
    const cell = registry.create(2, seed);
    const tissue = L3Atom.buildWithModel(registry.create(3, seed), registry, 'mock');
    const done: Result = { output: {}, summary: 'done', trace: [], producedBy: { name: cell.name, tier: 2, viaFallback: false } };
    vi.spyOn(tissue, 'execute').mockResolvedValue(done);
    let planCalls = 0;
    const response = (value: unknown): LlmCompletionResponse => ({ text: JSON.stringify(value), stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 } });
    const route = (request: LlmCompletionRequest): LlmCompletionResponse => {
      if (request.role === 'prefilter') return response({ kind: 'reuse', target: cell.name, confidence: 'high', reasoning: 'fits' });
      if (request.role === 'plan') {
        planCalls++;
        if (parseRetry && planCalls === 2) return { ...response(null), text: 'not a plan' };
        const field = request.userContent.includes('Task: A separate scheduler task') || request.userContent.includes(module.trim())
          ? 'nextDueAt' : 'nextRunAt';
        const plan = facts("import { test, expect } from 'vitest';\nimport { schedule } from './scheduler.ts';\n" +
          `test('due time', () => { expect(schedule.${field}).toBe(1234); });`, ['scheduler.ts']);
        return response([{ strategy: 'reuse', target: cell.name, reasoning: 'test the current interface' }, plan]);
      }
      if (request.role === 'validate-plan') {
        const encoded = /^PLAN: (.*)$/m.exec(request.userContent)?.[1];
        const plan = JSON.parse(encoded!) as Plan;
        // Like the incident's first review, prose can name the wrong interface.
        if (plan.subtasks[0]!.acceptanceTests!.source.includes('schedule.nextRunAt')) {
          return response({ approved: false, reasoning: 'The suite does not prove the due time.',
            modifications: { additionalContext: 'Use nextRunAt from the real scheduler.' }, scope: 'ephemeral' });
        }
        return response({ approved: true, reasoning: 'The suite uses the observed interface.', delegationReview: review(['vitest']) });
      }
      throw new Error(`Unexpected ${request.role} call`);
    };
    for (let i = 0; i < 30; i++) ctx.llm.enqueue(route);
    const task = { description: 'Verify the scheduler due time', constraints: ['offline only'] };
    await expect(tissue.handle(task, ctx)).resolves.toBe(done);
    const prompts = ctx.llm.calls.filter(call => call.role === 'plan').map(call => call.userContent);
    expect(prompts).toHaveLength(parseRetry ? 3 : 2);
    expect(prompts[0]).not.toContain(module.trim());
    expect(prompts[1]).toContain('HOST OBSERVATIONS FROM THE PREVIOUS PLAN REVIEW');
    expect(prompts[1]).toContain(module.trim());
    expect(prompts[1]).toContain('Use nextRunAt from the real scheduler.');
    if (parseRetry) {
      expect(prompts[2]).toContain(module.trim());
      expect(prompts[2]!.split('HOST OBSERVATIONS FROM THE PREVIOUS PLAN REVIEW')).toHaveLength(2);
    }
    expect(task).toEqual({ description: 'Verify the scheduler due time', constraints: ['offline only'] });
    for (const call of ctx.llm.calls.filter(call => call.role === 'prefilter')) expect(call.userContent).not.toContain(module.trim());
    await expect(ctx.tools.execute('write_file', { path: 'scheduler.ts', content: 'export {};\n' }))
      .rejects.toThrow('nothing in this run has read it');
    await tissue.handle({ description: 'A separate scheduler task' }, ctx);
    expect(ctx.llm.calls.filter(call => call.role === 'plan').at(-1)!.userContent)
      .not.toContain('HOST OBSERVATIONS FROM THE PREVIOUS PLAN REVIEW');
  });

  it('refuses a suite naming the read-run copies before any review, and the planner hears why', async () => {
    const { ctx } = workspace(files);
    const db = openDb(':memory:');
    databases.push(db);
    const registry = new AtomRegistry(db);
    const tissue = L3Atom.buildWithModel(registry.create(3, { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' }), registry, 'mock');
    const copy = facts("import { test, expect } from 'vitest';\nimport { readFileSync } from 'node:fs';\n" +
      "test('a', () => { expect(readFileSync('src/a.ts', 'utf8')).toBe(readFileSync('.atoma-runs/node_modules/50019ee0-1f0e-4a55-8a4b-1f2e3d4c5b6a/src/a.ts', 'utf8')); });", ['src/a.ts']);
    const own = facts("import { test, expect } from 'vitest';\nimport { a } from './src/a.ts';\ntest('a', () => { expect(a()).toBe(1); });", ['src/a.ts']);
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValueOnce(copy).mockResolvedValue(own);
    const done: Result = { output: {}, summary: 'done', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
    vi.spyOn(tissue, 'execute').mockResolvedValue(done);
    ctx.llm.enqueueText(JSON.stringify({ approved: true, reasoning: 'scope reviewed', delegationReview: review(['vitest']) }));

    await tissue.handle({ description: 'Restore module a to the bytes of run 50019ee0' }, ctx);

    expect(plan).toHaveBeenCalledTimes(2);
    expect(String(plan.mock.calls[1]?.[2])).toContain('names .atoma-runs, which a parent-owned suite cannot read: the runner\'s copy of the workspace leaves it out. Remove the mention');
    expect(String(plan.mock.calls[1]?.[2])).not.toContain('can never pass');
    // Zero tokens: the one model call is the review of the second plan.
    expect(ctx.llm.calls.filter(call => call.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW =='))).toHaveLength(1);
  });

  it('hands a kept test-file import to the review as a fact: a real module may carry a test-like name', () => {
    const memo = new Set<string>();
    const suites = [{ label: 'on subtask 0', cwd: '.', source: "import { test } from 'vitest';\nimport { spec } from './src/openapi.spec.ts';\ntest('t', () => { spec(); });" }];
    expect(planSuitePrecheck(suites, memo, 'root:Meristem').refusal).toContain('imports ./src/openapi.spec.ts, a test file');
    const kept = planSuitePrecheck(suites, memo, 'root:Meristem');
    expect(kept.refusal).toBeUndefined();
    expect(kept.facts).toEqual(['HOST FACT: Acceptance suite on subtask 0 imports ./src/openapi.spec.ts, named like a test file. The planner was told once and kept it: approve only if it is an application module, not a suite whose assertions the child writes.']);
  });
});

it('tells the planner that discovery fans out like any other plan', () => {
  expect(PARENT_TEST_PLANNING).toContain('Discovery fans out like any other plan: give each independent inspection its own parallel subtask.');
});
