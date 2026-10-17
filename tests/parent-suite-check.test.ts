import { afterEach, describe, expect, it, vi } from 'vitest';
import { chai } from 'vitest';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom, ROOT_PLAN_ATTEMPTS } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { l3StrategySchema, parsePlanPair } from '../src/atoms/json.js';
import { enforceParsedDelegationReview, planSuites } from '../src/atoms/delegationReview.js';
import { parentSuiteRefusal, parentSuiteRegexFindings, parentSuiteUnsupported, suiteRegexPrecheck } from '../src/atoms/parentSuiteCheck.js';
import { VITEST_BUILTIN_MATCHERS, type DelegationReview } from '../src/contracts/parentTests.js';
import type { Plan, Result } from '../src/core/types.js';
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
    for (let attempt = 0; attempt < ROOT_PLAN_ATTEMPTS; attempt++) ctx.llm.enqueueText(JSON.stringify(approval));

    await expect(tissue.handle({ description: 'Implement signed addition' }, ctx)).rejects.toThrow('toMatchSnapshot is unavailable');

    expect(plan).toHaveBeenCalledTimes(ROOT_PLAN_ATTEMPTS);
    expect(execute).not.toHaveBeenCalled();
  });

  function suite(source: string) {
    return { requirement: 'signed addition', cwd: '.', source };
  }
});

/**
 * Run 2e6bdcfc (2026-10-16): a cell's plan reply carried `\\\\s` in its JSON,
 * so the suite the runner executed matched a literal backslash followed by
 * "s". It failed eight times byte for byte, spent a ladder and a root
 * acceptance, and no reviewer named it. Checked at plan time, at zero tokens.
 */
describe('regular expressions a suite cannot mean', () => {
  // The TypeScript the runner executes, as two escaping layers made it.
  const overEscaped = String.raw`  expect(script).toMatch(/!\\s+-name\\s+['"]x\\.test\\.js['"]/);`;
  const intended = String.raw`  expect(script).toMatch(/!\s+-name\s+['"]x\.test\.js['"]/);`;
  const suiteOf = (...body: string[]) => lines("import { test, expect } from 'vitest';", "import { script } from './scripts.ts';", "test('excludes', () => {", ...body, '});');
  /** A planner's reply, through the parser the root and every cell use. */
  const parsedSuite = (source: string): string => {
    const plan = { reasoning: 'one module', subtasks: [{ description: 'Exclude the browser suites', outputs: ['scripts.ts'],
      acceptanceTests: { requirement: 'npm test excludes the browser suites', cwd: '.', source } }], aggregation: { mode: 'concat' }, expectedOutput: 'scripts.ts' };
    const text = JSON.stringify([{ strategy: 'reuse', target: 'Cell', reasoning: 'r' }, plan]);
    return parsePlanPair(text, l3StrategySchema, 'end_turn').plan.subtasks[0]!.acceptanceTests!.source;
  };

  it('finds the escaped backslashes of the recorded shape after the plan parser, and nothing in the intended one', () => {
    expect(parentSuiteRegexFindings(parsedSuite(suiteOf(overEscaped)))).toEqual([{
      kind: 'escaped-backslash', form: 'literal', line: 4, pattern: String.raw`/!\\s+-name\\s+['"]x\\.test\\.js['"]/`,
      key: String.raw`/!\\s+-name\\s+['"]x\\.test\\.js['"]/`, detail: [String.raw`\\s`, String.raw`\\.`],
    }]);
    expect(parentSuiteRegexFindings(parsedSuite(suiteOf(intended)))).toEqual([]);
  });

  it('reads RegExp strings and String.raw, refuses an invalid pattern, and never reads strings or comments', () => {
    const findings = parentSuiteRegexFindings(suiteOf(
      String.raw`  expect('a1').toMatch(new RegExp('\\\\d'));`,
      String.raw`  expect('a1').toMatch(RegExp(String.raw` + '`\\\\w`' + String.raw`, 'u'));`,
      String.raw`  expect('a1').toMatch(new RegExp('\\d'));`,
      String.raw`  expect('(').toMatch(/a\\(b/);`,
      String.raw`  const text = '/x\\\\s/'; // /y\\s/`,
    ));
    expect(findings.map(finding => [finding.kind, finding.line, finding.detail[0]?.slice(0, 20)])).toEqual([
      ['escaped-backslash', 4, String.raw`\\d`],
      ['escaped-backslash', 5, String.raw`\\w`],
      ['invalid', 7, 'Invalid regular expr'],
    ]);
  });

  it('admits ordinary patterns, including a literal backslash before a non-class character', () => {
    expect(parentSuiteRegexFindings(suiteOf(
      String.raw`  expect('a/b').toMatch(/[\\/]/);`,
      String.raw`  expect('C:\\Users').toMatch(/^C:\\Users$/);`,
      String.raw`  expect('555-1234').toMatch(/^\d{3}-\d{4}$/);`,
      String.raw`  expect(' ').toMatch(/^\s*$/u);`,
    ))).toEqual([]);
  });

  it('refuses an escaped backslash once per pattern and run, then hands it to the review as a host fact', () => {
    const memo = new Set<string>();
    const suites = [{ label: 'on subtask 0', source: suiteOf(overEscaped) }];
    const first = suiteRegexPrecheck(suites, memo, 'cell:A');
    expect(first.refusal).toContain('Acceptance suite on subtask 0, line 4');
    expect(first.refusal).toContain(String.raw`\\s, \\. each match a literal backslash followed by the next character`);
    expect(first.refusal).toContain(String.raw`for /\s/ write \\s in the JSON string, never \\\\s. Halve every doubled backslash in that pattern.`);
    const kept = suiteRegexPrecheck(suites, memo, 'cell:A');
    expect(kept.refusal).toBeUndefined();
    expect(kept.facts).toHaveLength(1);
    expect(kept.facts[0]).toMatch(/^HOST FACT: Acceptance suite on subtask 0, line 4: .* approve only if the text under test contains those backslashes and the suite's requirement says so\.$/);
  });

  it('refuses an invalid pattern every time: that suite module can never load', () => {
    const memo = new Set<string>();
    const suites = [{ label: 'for the plan integration', source: suiteOf(String.raw`  expect('(').toMatch(/a\\(b/);`) }];
    expect(suiteRegexPrecheck(suites, memo, 'cell:A').refusal).toContain('is invalid');
    expect(suiteRegexPrecheck(suites, memo, 'cell:A').refusal).toContain('so the suite module cannot load');
  });

  // Review 2026-10-17 of the first version of this check.
  it('never refuses an invalid RegExp string: it throws only when its line runs, and a suite may test that', () => {
    expect(parentSuiteRegexFindings(suiteOf("  expect(() => new RegExp('(')).toThrow(SyntaxError);", "  expect(() => new RegExp('a', 'gg')).toThrow();"))).toEqual([]);
  });

  it('reads a RegExp string whatever its flags, and gives the escaping rule of strings', () => {
    const line = String.raw`  expect('a b').toMatch(new RegExp('a\\\\sb', flags));`;
    expect(parentSuiteRegexFindings(suiteOf(line))).toMatchObject([{ kind: 'escaped-backslash', form: 'string', line: 4, detail: [String.raw`\\s`] }]);
    const refusal = suiteRegexPrecheck([{ label: 'on subtask 0', source: suiteOf(line) }], new Set(), 'cell:A').refusal;
    expect(refusal).toContain(String.raw`for new RegExp('\\s') write \\\\s in the JSON string, never \\\\\\\\s`);
    expect(refusal).not.toContain('a regex literal holds one backslash');
  });

  it('names a pattern in two suites twice, and tells each planner once', () => {
    const memo = new Set<string>();
    const two = [{ label: 'on subtask 0', source: suiteOf(overEscaped) }, { label: 'on subtask 1', source: suiteOf(overEscaped) }];
    const first = suiteRegexPrecheck(two, memo, 'cell:A');
    expect(first.refusal).toContain('Acceptance suite on subtask 0, line 4');
    expect(first.refusal).toContain('Acceptance suite on subtask 1, line 4');
    expect(first.facts).toEqual([]);
    expect(suiteRegexPrecheck(two, memo, 'cell:B').refusal).toContain('Acceptance suite on subtask 0, line 4');
    expect(suiteRegexPrecheck(two, memo, 'cell:A').facts).toHaveLength(2);
  });

  it('numbers the remaining suites from zero on a resumed plan, as the review and the planner see them', () => {
    const plan = makePlan({ subtasks: [{ description: 'done' }, { description: 'done too' },
      { description: 'left', acceptanceTests: { requirement: 'r', cwd: '.', source: suiteOf(overEscaped) } }] });
    expect(planSuites(plan, 2).map(suite => suite.label)).toEqual(['on subtask 0', 'for the plan integration']);
  });

  // Second review 2026-10-17.
  it('names an invalid literal whatever the number of other findings, remembers whole patterns, and advises String.raw', () => {
    const many = [1, 2, 3, 4, 5].map(n => String.raw`  expect('x').toMatch(/a${n}\\s/);`);
    const invalid = String.raw`  expect('(').toMatch(/a\\(b/);`;
    expect(suiteRegexPrecheck([{ label: 'on subtask 0', source: suiteOf(...many, invalid) }], new Set(), 'p').refusal).toContain('is invalid');
    const long = (tail: string) => String.raw`  expect('x').toMatch(/` + 'a'.repeat(90) + String.raw`\\s${tail}/);`;
    const memo = new Set<string>();
    expect(suiteRegexPrecheck([{ label: 'on subtask 0', source: suiteOf(long('1')) }], memo, 'p').refusal).toBeDefined();
    expect(suiteRegexPrecheck([{ label: 'on subtask 0', source: suiteOf(long('2')) }], memo, 'p').refusal).toBeDefined();
    const raw = String.raw`  expect('a b').toMatch(new RegExp(String.raw` + '`a\\\\sb`' + '));';
    expect(suiteRegexPrecheck([{ label: 'on subtask 0', source: suiteOf(raw) }], new Set(), 'p').refusal)
      .toContain(String.raw`a String.raw template holds one backslash per escape: for String.raw` + '`\\s`' + String.raw` write \\s in the JSON string, never \\\\s`);
  });

  describe('in the root review and in a cell plan review', () => {
    const databases: ReturnType<typeof openDb>[] = [];
    afterEach(() => {
      for (const db of databases.splice(0)) db.close();
    });
    const actors = () => {
      const db = openDb(':memory:');
      databases.push(db);
      const registry = new AtomRegistry(db);
      const seed = { description: 'module author', systemPrompt: 'delegate', tools: [], params: {}, createdBy: 'test' };
      const tissue = L3Atom.buildWithModel(registry.create(3, seed), registry, 'mock');
      const cellType = registry.create(2, seed);
      return { tissue, cell: L2Atom.fromType(registry.getByName(cellType.name)!, registry) };
    };
    const planWith = (body: string) => makePlan({ subtasks: [{ description: 'Exclude the browser suites', outputs: ['scripts.ts'],
      acceptanceTests: { requirement: 'npm test excludes the browser suites', cwd: '.', source: suiteOf(body) } }] });
    const approval = JSON.stringify({ approved: true, reasoning: 'scope reviewed', delegationReview: review(1) });
    const done: Result = { output: {}, summary: 'done', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };

    it('replans the root before any review, then reviews a kept pattern with the host fact', async () => {
      const { tissue } = actors();
      const ctx = makeCtx();
      const plan = vi.spyOn(tissue, 'plan').mockResolvedValue(planWith(overEscaped));
      vi.spyOn(tissue, 'execute').mockResolvedValue(done);
      ctx.llm.enqueueText(approval);

      await tissue.handle({ description: 'Exclude the browser suites from npm test' }, ctx);

      expect(plan).toHaveBeenCalledTimes(2);
      expect(String(plan.mock.calls[1]?.[2])).toContain('Acceptance suite on subtask 0, line 4');
      const reviews = ctx.llm.calls.filter(call => call.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW =='));
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.userContent).toContain('HOST FACT: Acceptance suite on subtask 0, line 4');
    });

    it('reviews a corrected root plan without the fact', async () => {
      const { tissue } = actors();
      const ctx = makeCtx();
      const plan = vi.spyOn(tissue, 'plan').mockResolvedValueOnce(planWith(overEscaped)).mockResolvedValue(planWith(intended));
      vi.spyOn(tissue, 'execute').mockResolvedValue(done);
      ctx.llm.enqueueText(approval);

      await tissue.handle({ description: 'Exclude the browser suites from npm test' }, ctx);

      expect(plan).toHaveBeenCalledTimes(2);
      const reviews = ctx.llm.calls.filter(call => call.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW =='));
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.userContent).not.toContain('HOST FACT');
    });

    it('remembers a finding as told only when the refusal was sent, after the caller\'s own precheck', async () => {
      const { tissue } = actors();
      const ctx = makeCtx();
      const parallel = planWith(overEscaped);
      const sequential = { ...planWith(overEscaped), aggregation: { mode: 'sequential' as const } };
      const proposals = [parallel, sequential, sequential];
      const feedback: string[][] = [];
      ctx.llm.enqueueText(approval);
      const reviewed = (tissue as unknown as { reviewedRootPlan: (args: unknown, ctx: unknown) => Promise<unknown> }).reviewedRootPlan({
        propose: (previous: readonly string[]) => { feedback.push([...previous]); return Promise.resolve(proposals.shift()!); },
        precheck: (next: Plan) => next.aggregation.mode === 'sequential' ? undefined : 'Remaining plan rejected before review: return sequential.',
        reviewTask: { description: 'Exclude the browser suites' }, from: 0, allowDiscovery: false, continuation: true,
      }, ctx);

      await expect(reviewed).resolves.toBeDefined();
      expect(feedback).toHaveLength(3);
      expect(feedback[2]!.join(' ')).toContain('Acceptance suite on subtask 0, line 4');
      const reviews = ctx.llm.calls.filter(call => call.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW =='));
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.userContent).toContain('HOST FACT: Acceptance suite on subtask 0, line 4');
    });

    it('keeps a suite finding in the planner\'s feedback after a later review refusal', async () => {
      const { tissue } = actors();
      const ctx = makeCtx();
      const proposals = [planWith(overEscaped), planWith(intended), planWith(overEscaped)];
      const feedback: string[][] = [];
      ctx.llm.enqueueText(JSON.stringify({ approved: false, reasoning: 'Another gap in the plan.' }));
      ctx.llm.enqueueText(approval);
      const reviewed = (tissue as unknown as { reviewedRootPlan: (args: unknown, ctx: unknown) => Promise<unknown> }).reviewedRootPlan({
        propose: (previous: readonly string[]) => { feedback.push([...previous]); return Promise.resolve(proposals.shift()!); },
        reviewTask: { description: 'Exclude the browser suites' }, from: 0, allowDiscovery: false, continuation: false,
      }, ctx);

      await expect(reviewed).resolves.toBeDefined();
      expect(feedback).toHaveLength(3);
      expect(feedback[2]!.join(' ')).toContain('Acceptance suite on subtask 0, line 4');
      expect(feedback[2]!.join(' ')).toContain('Another gap in the plan.');
      const reviews = ctx.llm.calls.filter(call => call.userContent.includes('== REQUIRED DELEGATION CONTRACT REVIEW =='));
      expect(reviews[1]!.userContent).toContain('HOST FACT: Acceptance suite on subtask 0, line 4');
    });

    it('tells each task of a cell once: another subtask of the same cell type is another prompt', async () => {
      const { tissue, cell } = actors();
      const ctx = makeCtx();
      for (const description of ['Exclude the browser suites', 'Exclude the slow suites']) {
        const verdict = await tissue.validatePlan(cell, planWith(overEscaped), { description }, ctx);
        expect(verdict).toMatchObject({ approved: false, delegationRefusal: 'plan' });
      }
      expect(ctx.llm.calls).toHaveLength(0);
    });

    it('refuses a cell plan without a review call, then reviews it with the fact when kept', async () => {
      const { tissue, cell } = actors();
      const ctx = makeCtx();
      const task = { description: 'Exclude the browser suites' };

      const first = await tissue.validatePlan(cell, planWith(overEscaped), task, ctx);
      expect(first).toMatchObject({ approved: false, delegationRefusal: 'plan' });
      expect(first.reasoning).toContain('Acceptance suite on subtask 0, line 4');
      expect(ctx.llm.calls).toHaveLength(0);

      ctx.llm.enqueueText(approval);
      await tissue.validatePlan(cell, planWith(overEscaped), task, ctx);
      expect(ctx.llm.calls).toHaveLength(1);
      expect(ctx.llm.calls[0]!.userContent).toContain('HOST FACT: Acceptance suite on subtask 0, line 4');
    });
  });
});
