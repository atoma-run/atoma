import { afterEach, describe, expect, it, vi } from 'vitest';
import { chai } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom } from '../src/atoms/L3Atom.js';
import { enforceParsedDelegationReview } from '../src/atoms/delegationReview.js';
import { parentSuiteRefusal, parentSuiteUnsupported } from '../src/atoms/parentSuiteCheck.js';
import { VITEST_BUILTIN_MATCHERS, type DelegationReview } from '../src/contracts/parentTests.js';
import type { Result } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * The plan-time half of the G2 integrity guard (review 2026-10-16): a parent
 * suite that uses an API the runner's guard refuses or ignores is refused
 * before any child runs, at zero tokens, so the child is never rejected for
 * the parent's choice.
 */

const lines = (...statements: string[]): string => statements.join('\n');
const HEAD = "import { test, expect, vi } from 'vitest';\nimport { add } from './add.ts';";

describe('parentSuiteUnsupported', () => {
  it.each([
    ['a custom equality tester', 'expect.addEqualityTesters([() => true]);', 'addEqualityTesters'],
    ['a snapshot serializer', 'expect.addSnapshotSerializer({ test: () => true, serialize: () => "" });', 'addSnapshotSerializer'],
    ['a file snapshot', "test('s', () => {\n  expect(add(1, 2)).toMatchSnapshot();\n});", 'toMatchSnapshot'],
    ['a file snapshot by element access', "test('s', () => {\n  expect(add(1, 2))['toMatchFileSnapshot']('x.txt');\n});", 'toMatchFileSnapshot'],
    ['an error snapshot', "test('s', () => {\n  expect(() => add(1, 2)).toThrowErrorMatchingSnapshot();\n});", 'toThrowErrorMatchingSnapshot'],
    ['a hand-made asymmetric matcher', "test('s', () => {\n  expect(add(1, 2)).toEqual({ asymmetricMatch: () => true });\n});", 'asymmetricMatch'],
    ['an extend of a built-in matcher', 'expect.extend({\n  toBe() {\n    return { pass: true, message: () => "" };\n  },\n});', 'expect.extend redefining the built-in toBe'],
    ['a name extended twice', lines(
      'expect.extend({ toBeEven: (n: number) => ({ pass: n % 2 === 0, message: () => "" }) });',
      'expect.extend({ toBeEven: (n: number) => ({ pass: true, message: () => "" }) });',
    ), 'expect.extend defining toBeEven twice'],
    ['a spy on a watched static', "vi.spyOn(Object, 'is');", 'vi.spyOn(Object, "is")'],
    ['a spy on a watched prototype member', "vi.spyOn(Array.prototype, 'some');", 'vi.spyOn(Array.prototype, "some")'],
    ['a spy on a computed key of a watched owner', 'vi.spyOn(Reflect, name);', 'vi.spyOn(Reflect, …)'],
  ])('refuses %s', (_name, body, refused) => {
    expect(parentSuiteUnsupported(`${HEAD}\n${body}`)).toContain(refused);
  });

  it('admits inline snapshots, new matcher names, and spies the guard does not watch', () => {
    const source = lines(
      HEAD,
      'expect.extend({',
      '  toBeEven(received: number) {',
      "    return { pass: received % 2 === 0, message: () => 'odd' };",
      '  },',
      '});',
      "test('ok', () => {",
      "  vi.spyOn(Date, 'now').mockReturnValue(0);",
      "  vi.spyOn(JSON, 'parse');",
      "  vi.spyOn(Object, 'freeze');",
      '  expect(add(2, 2)).toBeEven();',
      '  expect(add(2, 2)).toMatchInlineSnapshot(`4`);',
      '});',
    );
    expect(parentSuiteUnsupported(source)).toEqual([]);
  });

  it('never reads names in strings or comments', () => {
    const source = lines(
      HEAD,
      '// expect.addEqualityTesters and toMatchSnapshot are unavailable here',
      "test('mentions toMatchSnapshot and asymmetricMatch', () => {",
      "  expect('addSnapshotSerializer').toBe('addSnapshotSerializer');",
      '});',
    );
    expect(parentSuiteUnsupported(source)).toEqual([]);
  });

  it('never refuses a source that does not parse: the run reports it', () => {
    expect(parentSuiteUnsupported(`${HEAD}\ntest('broken', () => {\n  expect(add(1, 2)).toMatchSnapshot(\n`)).toEqual([]);
  });

  it('pins the built-in matcher names to the Vitest this repository runs', () => {
    const prototype = chai.Assertion.prototype as unknown as Record<string, unknown>;
    const live = Reflect.ownKeys(prototype)
      .filter((key): key is string => typeof key === 'string' && key !== 'constructor')
      .filter((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
        return 'value' in descriptor && typeof descriptor.value === 'function';
      })
      .sort();
    expect([...VITEST_BUILTIN_MATCHERS].sort()).toEqual(live);
  });
});

const review = (count: number): DelegationReview => ({
  subtasks: Array.from({ length: count }, (_, index) => ({ index, kind: 'vitest' as const, reason: 'implementation' })),
  integration: { kind: 'other', reason: 'one module' },
  independentWork: false,
  parallelReason: 'one module',
});

describe('the mechanical half of the delegation review', () => {
  const suite = (source: string) => ({ requirement: 'signed addition', cwd: '.', source });

  it('refuses a subtask suite that uses a file snapshot, as a plan refusal naming the subtask', () => {
    const plan = makePlan({ subtasks: [{ description: 'Implement add', outputs: ['add.ts'], acceptanceTests: suite(lines(
      HEAD,
      "test('adds', () => {",
      '  expect(add(2, 3)).toMatchSnapshot();',
      '});',
    )) }] });
    const refusal = enforceParsedDelegationReview(plan, review(1), false);
    expect(refusal?.delegationRefusal).toBe('plan');
    expect(refusal?.reasoning).toContain('Acceptance suite on subtask 0: toMatchSnapshot is unavailable in the parent-owned runner');
  });

  it('refuses a plan integration suite that redefines a built-in matcher', () => {
    const plan = makePlan({
      subtasks: [{ description: 'Implement add', outputs: ['add.ts'], acceptanceTests: suite(`${HEAD}\ntest('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});`) }],
      acceptanceTests: suite(lines(HEAD, 'expect.extend({', '  toEqual() {', "    return { pass: true, message: () => '' };", '  },', '});')),
    });
    const refusal = enforceParsedDelegationReview(plan, review(1), false);
    expect(refusal?.delegationRefusal).toBe('plan');
    expect(refusal?.reasoning).toContain('Acceptance suite for the plan integration: expect.extend redefining the built-in toEqual');
  });

  it('keeps an ordinary suite executable', () => {
    const plan = makePlan({ subtasks: [{ description: 'Implement add', outputs: ['add.ts'], acceptanceTests: suite(lines(
      HEAD,
      "test('adds', () => {",
      '  expect(add(2, 3)).toBe(5);',
      '});',
    )) }] });
    expect(enforceParsedDelegationReview(plan, review(1), false)).toBeUndefined();
  });

  it('states every refused name and the alternative in one refusal', () => {
    const text = parentSuiteRefusal('on subtask 2', lines(HEAD, 'expect.addEqualityTesters([]);', "vi.spyOn(Object, 'keys');"));
    expect(text).toContain('addEqualityTesters, vi.spyOn(Object, "keys") are unavailable');
    expect(text).toContain('inline snapshots work');
  });
});

describe('a root plan whose suite the runner would refuse', () => {
  const databases: ReturnType<typeof openDb>[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('is replanned before any child runs, even when the reviewer approves it', async () => {
    const db = openDb(':memory:');
    databases.push(db);
    const registry = new AtomRegistry(db);
    const tissue = L3Atom.buildWithModel(registry.create(3, { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' }), registry, 'mock');
    const ctx = makeCtx();
    const snapshotPlan = makePlan({ subtasks: [{ description: 'Implement add', outputs: ['add.ts'], acceptanceTests: suite(lines(
      HEAD,
      "test('adds', () => {",
      '  expect(add(2, 3)).toMatchSnapshot();',
      '});',
    )) }] });
    const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(snapshotPlan);
    const result: Result = { output: {}, summary: 'never', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(result);
    const approval = { approved: true, reasoning: 'looks fine', delegationReview: review(1) };
    for (let attempt = 0; attempt < 3; attempt++) ctx.llm.enqueueText(JSON.stringify(approval));

    await expect(tissue.handle({ description: 'Implement signed addition' }, ctx)).rejects.toThrow('toMatchSnapshot is unavailable');

    expect(plan).toHaveBeenCalledTimes(3);
    expect(execute).not.toHaveBeenCalled();
  });

  function suite(source: string) {
    return { requirement: 'signed addition', cwd: '.', source };
  }
});
