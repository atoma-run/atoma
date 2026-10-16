import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { runParentTests, type ParentTestSeams } from '../src/tools/parentTests.js';
import { parentTestConsequence } from '../src/core/parentTests.js';
import type { ParentTestObservation } from '../src/contracts/parentTests.js';

/**
 * The assertion-integrity guard (review 2026-10-16, F6; follow-up G2), through
 * the real runner: `runParentTests`, the coordinator process and its Vitest
 * thread. Every forger is first run with the guard replaced by a setup that
 * only reports ready (a host-only seam), which is what the runner did before
 * G2: each one turns its wrong implementation into `passed` there.
 */

const dirs: string[] = [];
const boxes: ToolSandbox[] = [];
let savedTmp: string | undefined;

beforeEach(() => {
  savedTmp = process.env['TMPDIR'];
  const privateTmp = mkdtempSync(path.join(tmpdir(), 'atoma-integrity-tmp-'));
  dirs.push(privateTmp);
  process.env['TMPDIR'] = privateTmp;
});

afterEach(async () => {
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  await Promise.all(boxes.splice(0).map(box => box.cleanup()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The pre-G2 runner: no guard, the nonces scrubbed and readiness reported as the guard reports it. */
const UNGUARDED_SETUP = [
  'const provided = (globalThis as any).__vitest_worker__.providedContext;',
  'const nonce = provided.atomaSetup;',
  'delete provided.atomaSetup;',
  'delete provided.atomaGuard;',
  "process.stderr.write('[atoma-integrity-ready:' + nonce + ']\\n');",
].join('\n');
const UNGUARDED: ParentTestSeams = { setupFile: 'unguarded-setup.ts' };

function workspace(files: Record<string, string>): ToolSandbox {
  const root = mkdtempSync(path.join(savedTmp ?? tmpdir(), 'atoma-integrity-fixture-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries({ ...files, 'unguarded-setup.ts': UNGUARDED_SETUP })) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  const box = new ToolSandbox(root);
  boxes.push(box);
  return box;
}

function verify(box: ToolSandbox, source: string, seams?: ParentTestSeams): Promise<ParentTestObservation> {
  const suite = { requirement: 'the module computes the documented values', cwd: '.', source };
  return runParentTests(box, [JSON.stringify(suite)], 30_000, undefined, seams);
}

const lines = (...statements: string[]): string => statements.join('\n');

const ADD_SUITE = lines(
  "import { test, expect } from 'vitest';",
  "import { add } from './add.ts';",
  "test('adds', () => {",
  '  expect(add(2, 3)).toBe(5);',
  '  expect(add(-2, 1)).toBe(-1);',
  '});',
);
const WRONG_ADD = 'export const add = (_a: number, _b: number): number => 5;';

describe('honest suites pass under the guard', () => {
  const APP = lines(
    'export const add = (a: number, b: number): number => a + b;',
    'export const user = (name: string) => ({',
    '  name,',
    '  id: 7,',
    "  tags: ['a', 'b'],",
    '  created: new Date(0),',
    "  meta: new Map([['k', 1]]),",
    '  seen: new Set([1, 2]),',
    '});',
    'export const fail = (message: string): never => {',
    '  throw new TypeError(message);',
    '};',
    'export const later = async (value: number): Promise<number> => value * 2;',
    'export const reject = async (): Promise<never> => {',
    "  throw new Error('nope');",
    '};',
    'export const service = {',
    '  greet(name: string): string {',
    "    return 'hi ' + name;",
    '  },',
    '};',
    'export const call = (callback: (value: number) => void): void => {',
    '  callback(1);',
    '  callback(2);',
    '};',
    'let counter = 0;',
    'export const tick = (): number => ++counter;',
    'export const stamp = (): number => Date.now();',
    'export const parse = (text: string): unknown => JSON.parse(text);',
    'export const wait = (callback: () => void): void => {',
    '  setTimeout(callback, 1000);',
    '};',
  );

  it('keeps every matcher family, extend, each, for, spies and the context expect working', async () => {
    const box = workspace({ 'app.ts': APP });
    const source = lines(
      "import { test, expect, describe, vi } from 'vitest';",
      "import { add, user, fail, later, reject, service, call, tick } from './app.ts';",
      'expect.extend({',
      '  toBeEven(received: number) {',
      "    return { pass: received % 2 === 0, message: () => 'expected ' + received + ' to be even' };",
      '  },',
      '});',
      "test('asymmetric and deep', () => {",
      "  expect(user('ann')).toEqual(expect.objectContaining({ name: expect.any(String), id: 7, tags: expect.arrayContaining(['a']) }));",
      "  expect(user('ann')).toMatchObject({ name: expect.stringContaining('an'), meta: new Map([['k', 1]]) });",
      "  expect(user('ann').seen).toEqual(new Set([2, 1]));",
      "  expect(user('ann')).toStrictEqual(user('ann'));",
      "  expect(user('ann')).toHaveProperty('meta.size', 1);",
      '  expect({ x: 0.1 + 0.2 }).toEqual({ x: expect.closeTo(0.3, 5) });',
      "  expect('abc').toEqual(expect.stringMatching(/^a/));",
      "  expect(user('ann').created).toEqual(new Date(0));",
      '});',
      "test('throws and promises', async () => {",
      "  expect(() => fail('bad')).toThrow(TypeError);",
      '  await expect(later(2)).resolves.toEqual(4);',
      "  await expect(reject()).rejects.toThrow('nope');",
      '});',
      "test('mocks and spies', () => {",
      '  const callback = vi.fn();',
      '  call(callback);',
      '  expect(callback).toHaveBeenCalledWith(2);',
      '  expect(callback).toHaveBeenNthCalledWith(1, expect.any(Number));',
      "  const spy = vi.spyOn(service, 'greet');",
      "  service.greet('bo');",
      "  expect(spy).toHaveReturnedWith('hi bo');",
      '});',
      "test('soft, poll and custom matchers', async () => {",
      '  expect.soft(add(1, 1)).toBe(2);',
      '  await expect.poll(() => tick(), { interval: 1, timeout: 500 }).toBeGreaterThan(2);',
      '  expect(add(1, 1)).toBeEven();',
      '  expect(add(1, 2)).not.toBeEven();',
      '  expect({ n: 4 }).toEqual({ n: expect.toBeEven() });',
      '  expect(3).toSatisfy((n: number) => n > 2);',
      '  expect([1, 2]).to.include(1);',
      '  expect([]).to.be.empty;',
      '});',
      "test.each([[1, 1, 2], [2, 3, 5]])('each %i + %i', (a, b, sum) => {",
      '  expect(add(a, b)).toBe(sum);',
      '});',
      "test.for([[1, 2, 3]])('for %i + %i', ([a, b, sum]) => {",
      '  expect(add(a, b)).toEqual(sum);',
      '});',
      "describe.each([1, 2])('describe %i', (n) => {",
      "  test('doubles', () => {",
      '    expect(add(n, n)).toBe(2 * n);',
      '  });',
      '});',
      "test('context expect', ({ expect }) => {",
      '  expect(add(2, 2)).toEqual(4);',
      '  expect(add(2, 2)).toBeEven();',
      '});',
      "test('inline snapshot', () => {",
      '  expect(add(2, 2)).toMatchInlineSnapshot(`4`);',
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('passed');
    expect(observed.passed).toBe(11);
  }, 30_000);

  it('leaves fake timers and spies on Date.now and JSON.parse to the suite', async () => {
    const box = workspace({ 'app.ts': APP });
    const source = lines(
      "import { test, expect, vi, afterEach } from 'vitest';",
      "import { stamp, parse, wait } from './app.ts';",
      'afterEach(() => {',
      '  vi.useRealTimers();',
      '  vi.restoreAllMocks();',
      '});',
      "test('fake timers', () => {",
      '  vi.useFakeTimers();',
      '  vi.setSystemTime(new Date(1000));',
      '  expect(stamp()).toBe(1000);',
      '  expect(new Date()).toEqual(new Date(1000));',
      '  const callback = vi.fn();',
      '  wait(callback);',
      '  vi.advanceTimersByTime(1000);',
      '  expect(callback).toHaveBeenCalledOnce();',
      '});',
      "test('spy on Date.now', () => {",
      "  vi.spyOn(Date, 'now').mockReturnValue(5);",
      '  expect(stamp()).toEqual(5);',
      '});',
      "test('spy on JSON.parse', () => {",
      "  const spy = vi.spyOn(JSON, 'parse');",
      '  expect(parse(\'{"a":1}\')).toEqual({ a: 1 });',
      '  expect(spy).toHaveBeenCalledWith(\'{"a":1}\');',
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('passed');
  }, 30_000);

  it('skips a Proxy over a Map it cannot read and a 20 MB typed array it need not walk', async () => {
    const box = workspace({ 'app.ts': lines(
      "export const store = () => new Proxy(new Map([['a', 1]]), {",
      '  get(target, key) {',
      '    const value = Reflect.get(target, key, target);',
      "    return typeof value === 'function' ? value.bind(target) : value;",
      '  },',
      '});',
      'export const buffer = (): Uint8Array => new Uint8Array(20_000_000);',
    ) });
    const source = lines(
      "import { test, expect } from 'vitest';",
      "import { store, buffer } from './app.ts';",
      "test('proxy', () => {",
      "  expect(store()).toHaveProperty('size', 1);",
      '});',
      "test('buffer', () => {",
      '  const started = Date.now();',
      '  expect(buffer()).toHaveLength(20_000_000);',
      '  expect({ head: buffer().subarray(0, 4) }).toEqual({ head: new Uint8Array(4) });',
      '  expect(Date.now() - started).toBeLessThan(5000);',
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('passed');
  }, 30_000);
});

describe('a forger is assertions-tampered, and passed without the guard', () => {
  const forgers: ReadonlyArray<[string, Record<string, string>, string, string]> = [
    ['Object.is replaced', { 'add.ts': lines('Object.is = () => true;', WRONG_ADD) }, ADD_SUITE, 'Object.is changed'],
    ['Object.hasOwn replaced', {
      'add.ts': lines(
        'const hasOwn = Object.hasOwn;',
        'export const add = (_a: number, _b: number) => {',
        '  // Equality lists keys through hasOwn: an object with none equals any other.',
        '  Object.hasOwn = (target: object, key: PropertyKey): boolean =>',
        "    typeof key === 'string' && key === 'value' ? false : hasOwn(target, key);",
        '  return { value: 5 };',
        '};',
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  expect(add(-2, 1)).toEqual({ value: -1 });',
      '});',
    ), 'Object.hasOwn changed'],
    ['Function.prototype.call replaced by the code under test', {
      'add.ts': lines(
        'const realCall = Function.prototype.call;',
        'export const add = (_a: number, _b: number) => {',
        '  // A custom tester is called with `{ equals }` and three arguments: answer "equal".',
        '  Function.prototype.call = function (this: (...args: unknown[]) => unknown, self: unknown, ...args: unknown[]) {',
        "    if (args.length === 3 && typeof (self as { equals?: unknown } | null)?.equals === 'function') return true;",
        '    return Reflect.apply(this, self, args);',
        '  } as typeof realCall;',
        '  return { value: 5 };',
        '};',
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  expect(add(-2, 1)).toEqual({ value: -1 });',
      '});',
    ), 'Function.prototype.call changed'],
    ['the Map iterator replaced on two same-size Maps', {
      'add.ts': lines(
        'const iterator = Object.getPrototypeOf(new Map().entries());',
        'const next = iterator.next;',
        'export const add = (_a: number, _b: number) => {',
        '  // The next Map walked looks empty, once; equality then compares sizes only.',
        '  iterator.next = function () {',
        '    iterator.next = next;',
        '    return { done: true, value: undefined };',
        '  };',
        "  return new Map([['sum', 5]]);",
        '};',
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      "  expect(add(-2, 1)).toEqual(new Map([['sum', -1]]));",
      '});',
    ), '%MapIteratorPrototype%.next changed'],
    ['a returned asymmetricMatch (F6b)', {
      'add.ts': 'export const add = (_a: number, _b: number) => ({ asymmetricMatch: () => true });',
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  expect(add(-2, 1)).toEqual(-1);',
      '});',
    ), 'unregistered asymmetric matcher at actual value'],
    ['Array.prototype.asymmetricMatch against a primitive', {
      'pair.ts': lines(
        '(Array.prototype as unknown as { asymmetricMatch: () => boolean }).asymmetricMatch = () => true;',
        "export const pair = (_a: number, _b: number): unknown => 'wrong';",
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { pair } from './pair.ts';",
      "test('pairs', () => {",
      '  expect(pair(1, 2)).toEqual([1, 2]);',
      '});',
    ), 'Array.prototype.asymmetricMatch changed'],
    ['Array.prototype.asymmetricMatch nested in the expected value', {
      'pair.ts': lines(
        '(Array.prototype as unknown as { asymmetricMatch: () => boolean }).asymmetricMatch = () => true;',
        "export const wrap = (_value: number): unknown => ({ v: 'wrong' });",
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { wrap } from './pair.ts';",
      "test('wraps', () => {",
      '  expect(wrap(5)).toEqual({ v: [5] });',
      '});',
    ), 'Array.prototype.asymmetricMatch changed'],
    ['a self-restoring Object.is (F6d)', {
      'add.ts': lines(
        'const original = Object.is;',
        'let calls = 0;',
        'Object.is = (a: unknown, b: unknown): boolean => {',
        '  calls += 1;',
        '  if (calls > 1) Object.is = original;',
        '  return true;',
        '};',
        WRONG_ADD,
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  expect(add(-2, 1)).toBe(-1);',
      '});',
    ), 'Object.is changed'],
    ["the suite's own matcher name taken first", {
      'add.ts': lines(
        "import { expect } from 'vitest';",
        'const forged = {',
        '  toBeSum() {',
        "    return { pass: true, message: () => '' };",
        '  },',
        '};',
        'expect.extend(forged);',
        'export const add = (_a: number, _b: number): number => {',
        "  // Again after the suite's own extend, which ran later than the import.",
        '  expect.extend(forged);',
        '  return 5;',
        '};',
      ),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      'expect.extend({',
      '  toBeSum(received: number, expected: number) {',
      "    return { pass: received === expected, message: () => 'not the sum' };",
      '  },',
      '});',
      "test('adds', () => {",
      '  expect(add(-2, 1)).toBeSum(-1);',
      '});',
    ), 'expect.extend found the matcher name \\"toBeSum\\" already taken'],
    ['a violation the code under test catches', {
      'add.ts': lines('Object.is = () => true;', WRONG_ADD),
    }, lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  try {',
      '    expect(add(-2, 1)).toBe(-1);',
      '  } catch {',
      '    // swallowed by a careless or hostile helper',
      '  }',
      '});',
    ), 'Object.is changed'],
  ];

  it.each(forgers)('%s', async (_name, files, source, named) => {
    const box = workspace(files);
    const unguarded = await verify(box, source, UNGUARDED);
    expect(unguarded.status, unguarded.details).toBe('passed');
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('unavailable');
    expect(observed.cause).toBe('assertions-tampered');
    expect(parentTestConsequence(observed)).toBe('reject');
    expect(observed.details).toContain(`Host: the code under test changed the assertion machinery: [atoma-integrity] ${named}`);
  }, 45_000);

  it('reads a subject that extracts the guard nonce and forges the setup tag as tampering, never as a runner error', async () => {
    const box = workspace({ 'add.ts': lines(
      'Object.is = () => true;',
      WRONG_ADD,
      'export const leak = (error: unknown): never => {',
      '  const nonce = /\\[atoma-integrity:([0-9a-f]{32})\\]/.exec(String(error))?.[1];',
      "  throw new Error('[atoma-integrity-setup:' + nonce + '] the guard could not be installed');",
      '};',
    ) });
    const source = lines(
      "import { test, expect } from 'vitest';",
      "import { add, leak } from './add.ts';",
      "test('adds', () => {",
      '  try {',
      '    expect(add(-2, 1)).toBe(-1);',
      '  } catch (error) {',
      '    leak(error);',
      '  }',
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.cause, observed.details).toBe('assertions-tampered');
  }, 30_000);
});

describe('the framework objects are locked: a replacement fails, honestly', () => {
  it.each([
    ['test.each', lines(
      "import { test } from 'vitest';",
      'try {',
      '  (test as unknown as { each: unknown }).each = () => (name: string) => test(name, () => undefined);',
      '} catch {',
      '  // the lock refused it',
      '}',
      WRONG_ADD,
    ), lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test.each([[-2, 1, -1]])('adds %i and %i', (a, b, sum) => {",
      '  expect(add(a, b)).toBe(sum);',
      '});',
    )],
    ['vi.fn', lines(
      "import { vi } from 'vitest';",
      'const real = vi.fn.bind(vi);',
      'try {',
      '  (vi as unknown as { fn: unknown }).fn = () => {',
      '    const mock = real();',
      '    mock(-1);',
      '    return mock;',
      '  };',
      '} catch {',
      '  // the lock refused it',
      '}',
      'export const add = (_a: number, _b: number, _report?: (sum: number) => void): number => 5;',
    ), lines(
      "import { test, expect, vi } from 'vitest';",
      "import { add } from './add.ts';",
      "test('reports the sum', () => {",
      '  const report = vi.fn();',
      '  add(-2, 1, report);',
      '  expect(report).toHaveBeenCalledWith(-1);',
      '});',
    )],
  ])('%s', async (_name, subject, source) => {
    const box = workspace({ 'add.ts': subject });
    const unguarded = await verify(box, source, UNGUARDED);
    expect(unguarded.status, unguarded.details).toBe('passed');
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('failed');
  }, 45_000);
});

describe('what the guard refuses quietly stays an honest red', () => {
  it('ignores an extend of the built-in toBe, so a wrong add fails', async () => {
    const box = workspace({ 'add.ts': lines(
      "import { expect } from 'vitest';",
      'expect.extend({',
      '  toBe() {',
      "    return { pass: true, message: () => '' };",
      '  },',
      '});',
      WRONG_ADD,
    ) });
    const unguarded = await verify(box, ADD_SUITE, UNGUARDED);
    expect(unguarded.status, unguarded.details).toBe('passed');
    const observed = await verify(box, ADD_SUITE);
    expect(observed.status, observed.details).toBe('failed');
    expect(observed.details).not.toContain('atoma-integrity');
  }, 30_000);

  it('fails a wrong add whose code caught every refused write to the matcher machinery', async () => {
    const box = workspace({ 'add.ts': lines(
      "import { chai } from 'vitest';",
      'const assertion = chai.Assertion.prototype as unknown as Record<string, unknown>;',
      'try {',
      '  assertion.toBe = function () {',
      '    return undefined;',
      '  };',
      '} catch {',
      '  // locked',
      '}',
      'try {',
      "  chai.Assertion.overwriteMethod('toEqual', () => function () {",
      '    return undefined;',
      '  });',
      '} catch {',
      '  // locked',
      '}',
      'try {',
      "  (globalThis as any)[Symbol.for('$$jest-matchers-object')].customEqualityTesters.push(() => true);",
      '} catch {',
      '  // frozen',
      '}',
      'export const add = (_a: number, _b: number) => ({ value: 5 });',
    ) });
    const source = lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  expect(add(-2, 1)).toEqual({ value: -1 });',
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('failed');
  }, 30_000);

  it('removes a child-written __snapshots__ directory, so its bytes never become the expected value', async () => {
    const box = workspace({
      'add.ts': WRONG_ADD,
      '__snapshots__/atoma.acceptance.test.ts.snap': lines('// Vitest Snapshot v1', '', 'exports[`adds 1`] = `5`;', ''),
    });
    const source = lines(
      "import { test, expect } from 'vitest';",
      "import { add } from './add.ts';",
      "test('adds', () => {",
      '  expect(add(-2, 1)).toMatchSnapshot();',
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('failed');
  }, 30_000);
});

describe('runner hygiene', () => {
  it('repeats the same tampering byte for byte, with neither nonce in it', async () => {
    const box = workspace({ 'add.ts': lines('Object.is = () => true;', WRONG_ADD) });
    const first = await verify(box, ADD_SUITE);
    const second = await verify(box, ADD_SUITE);
    expect(first.cause).toBe('assertions-tampered');
    expect(second.details).toBe(first.details);
    expect(first.details).not.toMatch(/[0-9a-f]{32}/);
  }, 30_000);

  it('shows neither nonce to the suite or the code it imports', async () => {
    const box = workspace({ 'add.ts': lines(
      "import { inject } from 'vitest';",
      'export const seen = (): unknown[] => [',
      "  inject('atomaSetup' as never),",
      "  inject('atomaGuard' as never),",
      '  JSON.stringify((globalThis as any).__vitest_worker__.providedContext),',
      '];',
    ) });
    const source = lines(
      "import { test, expect } from 'vitest';",
      "import { seen } from './add.ts';",
      "test('none', () => {",
      "  expect(seen()).toEqual([undefined, undefined, '{}']);",
      '});',
    );
    const observed = await verify(box, source);
    expect(observed.status, observed.details).toBe('passed');
  }, 30_000);

  it('reads the setup tag as a runner error only where setup failed, through the host-only seam', async () => {
    const box = workspace({
      'add.ts': WRONG_ADD,
      'failing-setup.ts': lines(
        'const provided = (globalThis as any).__vitest_worker__.providedContext;',
        "throw new Error('[atoma-integrity-setup:' + provided.atomaSetup + '] Vitest internals missing');",
      ),
    });
    const observed = await verify(box, ADD_SUITE, { setupFile: 'failing-setup.ts' });
    expect(observed.status).toBe('unavailable');
    expect(observed.cause).toBe('runner-error');
    expect(observed.details).toContain('Host: the assertion-integrity guard could not be installed');
    expect(parentTestConsequence(observed)).toBe('review');
  }, 30_000);

  it('never passes a run the guard did not report watching', async () => {
    const box = workspace({
      'add.ts': 'export const add = (a: number, b: number): number => a + b;',
      'silent-setup.ts': 'export {};',
    });
    const observed = await verify(box, ADD_SUITE, { setupFile: 'silent-setup.ts' });
    expect(observed.status).toBe('unavailable');
    expect(observed.cause).toBe('runner-error');
    expect(observed.details).toContain('Host: the assertion-integrity guard did not report ready');
  }, 30_000);
});
