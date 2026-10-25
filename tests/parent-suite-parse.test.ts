import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAst } from 'vite';
import { AtomRegistry } from '../src/registry/atomRegistry.js';
import { openDb } from '../src/registry/db.js';
import { L3Atom, ROOT_PLAN_ATTEMPTS } from '../src/atoms/L3Atom.js';
import { L2Atom } from '../src/atoms/L2Atom.js';
import { enforceParsedDelegationReview } from '../src/atoms/delegationReview.js';
import { parentSuiteParseDiagnostics, parentSuiteParseRefusal, parentSuiteRefusal, parentSuiteRegexFindings, planSuitePrecheck } from '../src/atoms/parentSuiteCheck.js';
import { PARENT_TEST_SOURCE_MAX_CHARS, type DelegationReview } from '../src/contracts/parentTests.js';
import { MockLlmClient } from '../src/core/llm.js';
import type { LlmCompletionRequest, LlmCompletionResponse, Plan, Result } from '../src/core/types.js';
import { makeCtx } from './helpers.js';

/**
 * Run 7d071257 (2026-10-25, Attica): a cell's plan reply wrote `\\n` for every
 * line break of its suite, so the suite the runner wrote held the two
 * characters `\n` and no line break. The runner reported "the suite module did
 * not load; no test ran" (Vite: "Parse failed with 7 errors: Invalid Unicode
 * escape sequence"), the child could not edit the parent's suite, and the root
 * refused a delivery whose code was verified correct. Now refused at plan
 * time, at zero tokens, every time.
 */

/** The suite as the runner received it, decoded from the recorded plan reply (event 7c3f6607). */
const INCIDENT = String.raw`import { test, expect } from 'vitest';\nimport { readFileSync, readdirSync } from 'node:fs';\nimport { presentControl } from './browser/control-presentation.ts';\n\ntest('cancellation temporary roots and cleanup use OS storage', () => {\n  const source = readFileSync('tests/attica-control-cancel.vitest.test.ts', 'utf8');\n  expect(source).not.toMatch(/mkdtempSync\\(path\\.join\\(process\\.cwd\\(\\)/);\n  for (const prefix of ['cancel-inactive-', 'cancel-active-', 'cancel-paused-', 'cancel-lift-']) {\n    expect(source).toContain('path.join(os.tmpdir(), \\"' + prefix + '\\")');\n  }\n  expect(source).toContain('roots.splice(0)');\n  expect(source).toMatch(/fs\\.rmSync\\(root,\\s*\\{\\s*recursive:\\s*true,\\s*force:\\s*true\\s*\\}\\)/);\n  expect(readdirSync('.').filter((name) => /^(cancel-paused-|cancel-lift-)/.test(name))).toEqual([]);\n});\n\ntest('real presentation rejects arbitrary English status labels', () => {\n  expect(presentControl({ status: 'idle', label: 'Initial status' }).statusText).toBe('En attente');\n  expect(presentControl({ status: 'paused', label: 'Old status' }).statusText).toBe('Collecte en pause');\n  expect(presentControl({ status: 'complete', label: 'Fresh status' }).statusText).toBe('Collecte terminée');\n});`;

/** What the planner meant: the same suite escaped once. */
const INTENDED = INCIDENT.replaceAll('\\\\', '\u0000').replaceAll('\\n', '\n').replaceAll('\u0000', '\\');

/** A genuine syntax error: the second test is never closed. */
const UNCLOSED = "import { test, expect } from 'vitest';\nimport { presentControl } from './browser/control-presentation.ts';\n" +
  "test('idle', () => {\n  expect(presentControl({ status: 'idle' }).statusText).toBe('En attente');\n";

/** The recorded L2 reply's shape (event 7c3f6607), through the JSON layer the planner writes. */
function planReply(target: string, source: string): string {
  const strategy = { strategy: 'reuse', target, reasoning: 'A focused TypeScript test repair.' };
  const plan = {
    reasoning: 'One coherent repair phase owns the only changed source and verifies it after mutation.',
    delivery: 'files',
    subtasks: [{
      description: 'Repair tests/attica-control-cancel.vitest.test.ts so cancel-inactive- and cancel-active- allocations use os.tmpdir().',
      executionMode: 'tools', preferredChild: target, criteria: ['c2', 'c3'],
      acceptanceTests: { requirement: 'Cancellation test temporary roots use OS temporary storage with retained cleanup.', cwd: '.', source },
      outputs: ['tests/attica-control-cancel.vitest.test.ts', '.atoma-probes.json'],
    }],
    aggregation: { mode: 'sequential' },
    expectedOutput: 'Updated cancellation test.',
  };
  return JSON.stringify([strategy, plan], null, 2);
}

const review = (count: number): DelegationReview => ({
  subtasks: Array.from({ length: count }, (_, index) => ({ index, kind: 'vitest' as const, reason: 'implementation' })),
  integration: { kind: 'other', reason: 'one module' },
  independentWork: false,
  parallelReason: 'one module',
});
const approval = JSON.stringify({ approved: true, reasoning: 'scope reviewed', delegationReview: review(1) });
const done: Result = { output: {}, summary: 'done', trace: [], producedBy: { name: 'cell', tier: 2, viaFallback: false } };
const isReview = (call: { role?: string }): boolean => call.role === 'validate-plan';

/** The runner's own parser (Vite's, in the worker): the oracle the host check stands in for. */
const runnerRefusal = (source: string): string | undefined => {
  try {
    parseAst(source, { lang: 'ts', sourceType: 'module' }, 'atoma.acceptance.test.ts');
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe('a suite source that does not parse', () => {
  it('names the suite, the first diagnostics, and the double escaping, where the runner refused it as in production', () => {
    expect(runnerRefusal(INCIDENT)).toMatch(/^Parse failed with 7 errors:\nInvalid Unicode escape sequence/);
    const text = parentSuiteParseRefusal('on subtask 0', INCIDENT);
    expect(text).toContain('Acceptance suite on subtask 0 does not parse as the TypeScript module the runner loads, so no test in it can run: ' +
      'line 1, column 39: Invalid character; line 1, column 40: ');
    expect(text).toContain('errors in all).');
    expect(text).toContain(String.raw`Its source holds the two characters \n and no line break: it was escaped twice in the JSON and must carry real line breaks.`);
    expect(text).toContain(String.raw`Escape once: a line break is \n in the JSON string, never \\n, and a backslash the TypeScript keeps is \\, never \\\\.`);
    expect(text?.match(/line \d+, column \d+/g)).toHaveLength(3);
  });

  it('names a genuine syntax error with its diagnostic and no escaping advice', () => {
    expect(runnerRefusal(UNCLOSED)).toMatch(/^Parse failed with 1 error/);
    const text = parentSuiteParseRefusal('for the plan integration', UNCLOSED);
    expect(text).toBe('Acceptance suite for the plan integration does not parse as the TypeScript module the runner loads, so no test in it ' +
      "can run: line 5, column 1: '}' expected. Revise the suite.");
  });

  it('calls a bare backslash in a multi-line source escaping too', () => {
    const source = "import { test, expect } from 'vitest';\ntest('a', () => {\n  expect(1).toBe(1);\\n});\n";
    expect(parentSuiteParseDiagnostics(source)[0]).toMatchObject({ line: 3, atBackslash: true });
    expect(parentSuiteParseRefusal('on subtask 1', source)).toContain('A backslash stands outside any string: the source was escaped twice in the JSON.');
  });

  it('admits a valid suite, escape sequences in its strings and regexes included, as the runner does', () => {
    const escapes = String.raw`import { test, expect } from 'vitest'; test('a', () => { expect('a\nb').toMatch(/a\sb|\n/); });`;
    for (const source of [INTENDED, escapes]) {
      expect(runnerRefusal(source)).toBeUndefined();
      expect(parentSuiteParseRefusal('on subtask 0', source)).toBeUndefined();
    }
    expect(INTENDED.split('\n')).toHaveLength(20);
  });

  it('admits the strict-mode lexical forms the runner accepts, and refuses an octal escape in an untagged template, as it does', () => {
    const head = "import { test, expect } from 'vitest';\n";
    for (const body of ["expect('\\01').toBe('\\x01');", "expect('\\8').toBe('8');", "expect('\\09'.length).toBe(2);",
      'expect(010).toBe(8);', "test('mode', () => { expect(0o777 & 0777).toBe(511); });", 'expect(08.5).toBe(8.5);',
      'expect(String.raw`\\01`).toBe("\\\\01");']) {
      const source = `${head}${body}\n`;
      expect(runnerRefusal(source), body).toBeUndefined();
      expect(parentSuiteParseRefusal('on subtask 0', source), body).toBeUndefined();
    }
    // Admitted, such a suite still gets the API and regex checks a parsed suite gets.
    const spied = `${head}import { vi } from 'vitest';\nvi.spyOn(Object, 'is');\nexpect(0777).toBe(511);\n`;
    expect(parentSuiteRefusal('on subtask 0', spied)).toContain("vi.spyOn(Object, \"is\")");
    expect(parentSuiteRegexFindings(`${head}expect('a1').toMatch(/a\\\\d/);\nexpect(0777).toBe(511);\n`)).toMatchObject([{ kind: 'escaped-backslash' }]);
    for (const [body, error] of [['expect(`\\01`).toBe("");', 'Octal escape sequences are not allowed'], ['expect(`a${1}\\8`).toBe("");', "Escape sequence '\\8' is not allowed"]]) {
      const source = `${head}${body}\n`;
      expect(runnerRefusal(source), body).toMatch(/Bad escape sequence in untagged template literal/);
      expect(parentSuiteParseRefusal('on subtask 0', source), body).toContain(error);
    }
  });

  it('gives no escaping advice to a one-line suite whose only \\n is inside a string', () => {
    const source = String.raw`import { test, expect } from 'vitest'; test('lines', () => { expect('a\nb'.split('\n')).toHaveLength(2);`;
    expect(source).not.toContain('\n');
    expect(runnerRefusal(source)).toMatch(/^Parse failed with 1 error/);
    const text = parentSuiteParseRefusal('on subtask 0', source);
    expect(text).toContain("'}' expected");
    expect(text).not.toContain('escaped twice');
    expect(text).not.toContain('Escape once');
    expect(parentSuiteParseDiagnostics(String.raw`const a = 'x\u{zz}';`)[0]).toMatchObject({ atBackslash: false });
  });

  it('refuses an await, a for await or a return the module cannot hold, as the runner does, and admits their valid shapes', () => {
    const head = "import { describe, test, expect } from 'vitest';\n";
    const refused: Array<[string, string]> = [
      ["test('loads', () => {\n  const value = await Promise.resolve(1);\n  expect(value).toBe(1);\n});", "line 3, column 17: 'await' expressions"],
      ["describe('group', () => {\n  await Promise.resolve();\n});", "line 3, column 3: 'await' expressions"],
      ["function collect(items) {\n  for await (const item of items) expect(item).toBe(1);\n}", "line 3, column 3: 'for await' loops"],
      ["class Fixture { value = await Promise.resolve(1); }", "line 2, column 25: 'await' expressions"],
      ["class Fixture { get value() { return await Promise.resolve(1); } }", "line 2, column 38: 'await' expressions"],
      ["if (process.env.SKIP) return;\ntest('a', () => { expect(1).toBe(1); });", "line 2, column 23: A 'return' statement can only be used within a function body"],
    ];
    for (const [body, finding] of refused) {
      const source = `${head}${body}\n`;
      expect(runnerRefusal(source), body).toMatch(/^Parse failed with 1 error/);
      const text = parentSuiteParseRefusal('on subtask 0', source);
      expect(text, body).toContain(`Acceptance suite on subtask 0 does not parse as the TypeScript module the runner loads, so no test in it can run: ${finding}`);
      expect(text, body).not.toContain('escaped twice');
    }
    const admitted = [
      "const config = await Promise.resolve({ ok: true });\ntest('a', () => { expect(config.ok).toBe(true); });",
      'for await (const item of [Promise.resolve(1)]) expect(item).toBe(1);',
      "test('loads', async () => {\n  await expect(Promise.resolve(1)).resolves.toBe(1);\n  for await (const item of [1]) expect(item).toBe(1);\n});",
      "describe('group', () => {\n  test('a', async function () { expect(await Promise.resolve(2)).toBe(2); });\n});",
      "class Fixture { async load() { return await Promise.resolve(1); } run = async () => await this.load(); }",
      "async function load(value = await Promise.resolve(1)) { return value; }",
      "const object = { async read() { return await Promise.resolve(1); }, await: 2 };\nfunction plain() { return object.await; }",
      "test('a', () => { const f = () => { return 1; }; expect(f()).toBe(1); });",
    ];
    for (const body of admitted) {
      const source = `${head}${body}\n`;
      expect(runnerRefusal(source), body).toBeUndefined();
      expect(parentSuiteParseRefusal('on subtask 0', source), body).toBeUndefined();
    }
  });

  it('stays bounded on the largest suite a plan may carry', () => {
    const big = (INCIDENT + ';').repeat(Math.ceil(PARENT_TEST_SOURCE_MAX_CHARS / INCIDENT.length)).slice(0, PARENT_TEST_SOURCE_MAX_CHARS);
    const started = performance.now();
    const text = parentSuiteParseRefusal('on subtask 0', big)!;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(text.length).toBeLessThan(1200);
  });

  it('refuses every time, beside the other findings of the plan, in one refusal', () => {
    const memo = new Set<string>();
    const suites = [{ label: 'on subtask 0', source: INCIDENT }, { label: 'for the plan integration', source: UNCLOSED }];
    for (let round = 0; round < 3; round++) {
      const { refusal } = planSuitePrecheck(suites, memo, 'cell:Companion:task');
      expect(refusal).toContain('Acceptance suite on subtask 0 does not parse');
      expect(refusal).toContain('Acceptance suite for the plan integration does not parse');
    }
    expect(planSuitePrecheck([{ label: 'on subtask 0', source: INTENDED }], memo, 'cell:Companion:task').refusal).toBeUndefined();
  });

  it('is refused by the review\'s mechanical half too, so a resumed approval of it is never reused', () => {
    const plan: Plan = {
      reasoning: 'r', subtasks: [{ description: 'Repair the test', outputs: ['t.ts'], acceptanceTests: { requirement: 'r', cwd: '.', source: INCIDENT } }],
      aggregation: { mode: 'sequential' }, expectedOutput: 'o',
    };
    expect(enforceParsedDelegationReview(plan, review(1), false)).toMatchObject({ approved: false, delegationRefusal: 'plan' });
    const fixed = { ...plan, subtasks: [{ ...plan.subtasks[0]!, acceptanceTests: { requirement: 'r', cwd: '.', source: INTENDED } }] };
    expect(enforceParsedDelegationReview(fixed, review(1), false)).toBeUndefined();
  });
});

describe('the incident\'s plan reply in the root review and in a cell plan review', () => {
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
    return { tissue, cell: L2Atom.fromType(registry.getByName(cellType.name)!, registry), cellName: cellType.name };
  };

  /** Routes by role: the real L3 planner (prefilter, plan) and the root review. */
  function routedLlm(cellName: string, plans: string[], reviews: string[]): MockLlmClient {
    const llm = new MockLlmClient();
    const route = (req: LlmCompletionRequest): LlmCompletionResponse => {
      const text = req.role === 'prefilter' ? JSON.stringify({ kind: 'reuse', target: cellName, confidence: 'high', reasoning: 'fits' })
        : req.role === 'plan' ? plans.shift() : req.role === 'validate-plan' ? reviews.shift() : undefined;
      if (text === undefined) throw new Error(`Unexpected ${req.role} call`);
      return { text, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } };
    };
    for (let i = 0; i < 40; i++) llm.enqueue(route);
    return llm;
  }

  it('replans the root before any review or execution, telling the planner, then reviews and runs the suite escaped once', async () => {
    const { tissue, cellName } = actors();
    const ctx = makeCtx({ llm: routedLlm(cellName, [planReply(cellName, INCIDENT), planReply(cellName, INTENDED)], [approval]) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(done);

    await tissue.handle({ description: 'Finish the Attica control-page repair' }, ctx);

    const calls = ctx.llm.calls.filter(call => call.role === 'plan' || isReview(call));
    expect(calls.map(call => call.role)).toEqual(['plan', 'plan', 'validate-plan']);
    expect(calls[1]!.userContent).toContain('Acceptance suite on subtask 0 does not parse as the TypeScript module the runner loads');
    expect(calls[1]!.userContent).toContain('it was escaped twice in the JSON and must carry real line breaks');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].subtasks[0]?.acceptanceTests?.source).toBe(INTENDED);
  });

  it('never executes a root whose planner keeps the suite escaped twice', async () => {
    const { tissue, cellName } = actors();
    const plans = Array.from({ length: ROOT_PLAN_ATTEMPTS }, () => planReply(cellName, INCIDENT));
    const ctx = makeCtx({ llm: routedLlm(cellName, plans, []) });
    const execute = vi.spyOn(tissue, 'execute').mockResolvedValue(done);

    await expect(tissue.handle({ description: 'Finish the Attica control-page repair' }, ctx)).rejects.toThrow('does not parse');

    expect(ctx.llm.calls.filter(isReview)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses the cell\'s own parsed plan without a review call, every time, and reviews it escaped once', async () => {
    const { tissue, cell } = actors();
    const task = { description: 'Repair the cancellation test roots', acceptanceTests: { requirement: 'roots', cwd: '.', source: INTENDED } };
    const cellCtx = makeCtx();
    cellCtx.llm.enqueueText(planReply('Ammonia', INCIDENT));
    const plan = await cell.plan(task, cellCtx);
    expect(plan.subtasks[0]?.acceptanceTests?.source).toBe(INCIDENT);

    const ctx = makeCtx();
    for (let round = 0; round < 2; round++) {
      const verdict = await tissue.validatePlan(cell, plan, task, ctx);
      expect(verdict).toMatchObject({ approved: false, delegationRefusal: 'plan' });
      expect(verdict.reasoning).toContain('Acceptance suite on subtask 0 does not parse');
      expect(verdict.reasoning).toContain('it was escaped twice in the JSON');
    }
    expect(ctx.llm.calls).toHaveLength(0);

    cellCtx.llm.enqueueText(planReply('Ammonia', INTENDED));
    const fixed = await cell.plan(task, cellCtx);
    ctx.llm.enqueueText(approval);
    await tissue.validatePlan(cell, fixed, task, ctx);
    expect(ctx.llm.calls.filter(isReview)).toHaveLength(1);
    expect(ctx.llm.calls[0]!.userContent).not.toContain('does not parse');
  });
});
