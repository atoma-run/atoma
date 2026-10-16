import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolSandbox } from '../src/tools/sandbox.js';
import { runParentTests } from '../src/tools/parentTests.js';
import {
  parentTestSuiteDigest,
  persistedParentTests,
  type HeldParentTestObservation,
  type ParentTestObservation,
  type ParentTestSuite,
} from '../src/contracts/parentTests.js';
import { summarizeParentTests } from '../src/contracts/parentTestRecord.js';
import {
  parentTestConsequence,
  parentTestNoResultFinding,
  parentTestRejection,
  parentTestsGrantNothing,
  verifyParentTests,
} from '../src/core/parentTests.js';
import { dependencyBlocker, dispatchWithAggregation } from '../src/atoms/dispatch.js';
import { normalizeReason } from '../src/core/supervisor.js';
import type { Plan, Result, ToolExecutor } from '../src/core/types.js';
import { makeCtx } from './helpers.js';
import { makePlan } from './helpers/factories.js';

/**
 * The third review of the parent-owned tests (2026-10-16): what the real
 * runner reports when the code under test fails without a failing assertion,
 * kills its process or changes permission bits; what supersedes what in a
 * parallel aggregate; and the repeat key of a failing set longer than its
 * excerpt. records/reviews/parent-tests-review-fixes-2026-10-16.md, "Third review".
 */

const POSIX = process.platform !== 'win32';
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const suite = (source: string): ParentTestSuite => ({ requirement: 'add returns the sum of its arguments', cwd: '.', source });
const ADDS = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('adds', async () => {\n  expect(add(2, 3)).toBe(5);\n  await new Promise((resolve) => setTimeout(resolve, 50));\n});";

const leaf = (summary: string, extra: Partial<Result> = {}): Result =>
  ({ output: summary, summary, trace: [], producedBy: { tier: 1, name: 'Water', viaFallback: false }, ...extra });

describe('the real runner', () => {
  const dirs: string[] = [];
  const boxes: ToolSandbox[] = [];
  let savedTmp: string | undefined;
  // TMPDIR may be unset (CI): restoring only a defined value left it pointing
  // at a deleted directory for every later test file in the worker.
  let tmpOverridden = false;
  const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(savedTmp ?? tmpdir(), 'atoma-third-review-'));
    dirs.push(root);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), content);
    }
    const box = new ToolSandbox(root);
    boxes.push(box);
    return { root, box };
  };
  const run = (box: ToolSandbox, source = ADDS) => runParentTests(box, [JSON.stringify(suite(source))], 30_000);
  afterEach(async () => {
    if (tmpOverridden) {
      if (savedTmp === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = savedTmp;
    }
    tmpOverridden = false;
    savedTmp = undefined;
    await Promise.all(boxes.splice(0).map((box) => box.cleanup()));
    for (const dir of dirs.splice(0)) {
      try { chmodSync(dir, 0o700); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('a red run with no failing assertion says why, and keys apart', () => {
    it('names an unhandled error the code under test raised after its assertions', async () => {
      const late = (message: string) => `export const add = (a: number, b: number) => a + b;\nsetTimeout(() => { throw new Error(${JSON.stringify(message)}); }, 0);\n`;
      const first = await run(fixture({ 'add.ts': late('late boom') }).box);
      const second = await run(fixture({ 'add.ts': late('other boom') }).box);

      expect(first).toMatchObject({ status: 'failed', cause: 'ran', passed: 1, failed: 0 });
      expect(first.details).toContain('unhandled error: Error: late boom');
      // The tail is the only place the cause shows: kept, as child output.
      expect(first.output).toBeTruthy();
      const reasoning = (observed: ParentTestObservation) => parentTestRejection({ parentTests: [observed] })!.reasoning;
      expect(reasoning(first)).toContain('late boom');
      expect(normalizeReason(reasoning(first))).not.toBe(normalizeReason(reasoning(second)));
    }, 60_000);

    it('names an unhandled rejection', async () => {
      const observed = await run(fixture({ 'add.ts': 'export const add = (a: number, b: number) => a + b;\nvoid Promise.reject(new TypeError("rejected boom"));\n' }).box);
      expect(observed).toMatchObject({ status: 'failed', cause: 'ran', failed: 0 });
      expect(parentTestRejection({ parentTests: [observed] })!.reasoning).toContain('TypeError: rejected boom');
    }, 45_000);

    it('names skipped tests', async () => {
      const source = "import { test, expect } from 'vitest';\nimport { add } from './add.ts';\ntest('adds', () => { expect(add(2, 3)).toBe(5); });\ntest.skip('later', () => {});";
      const observed = await run(fixture({ 'add.ts': 'export const add = (a: number, b: number) => a + b;\n' }).box, source);
      expect(observed).toMatchObject({ status: 'failed', cause: 'ran', failed: 0, skipped: 1 });
      expect(parentTestRejection({ parentTests: [observed] })!.reasoning).toContain('1 test(s) skipped or todo');
    }, 45_000);

    it('keeps a passing suite passing, with no reason entry and no output', async () => {
      const observed = await run(fixture({ 'add.ts': 'export const add = (a: number, b: number) => a + b;\n' }).box);
      expect(observed).toMatchObject({ status: 'passed', cause: 'ran' });
      expect(observed.details).not.toContain('Runner:');
      expect(observed.output).toBeUndefined();
    }, 45_000);
  });

  describe('what ends a run without a report, measured', () => {
    it('reads process.exit in imported code as a failed run: Vitest intercepts it', async () => {
      const observed = await run(fixture({ 'add.ts': 'export const add = (a: number, b: number) => a + b;\nprocess.exit(0);\n' }).box);
      expect(observed).toMatchObject({ status: 'failed', cause: 'ran' });
      expect(observed.details).toContain('process.exit unexpectedly called');
    }, 45_000);

    it.skipIf(!POSIX)('reads a killed process as exited-without-report, coached about the kill, not process.exit', async () => {
      const observed = await run(fixture({ 'add.ts': "export const add = (a: number, b: number) => a + b;\nprocess.kill(process.pid, 'SIGKILL');\n" }).box);
      expect(observed).toMatchObject({ status: 'unavailable', cause: 'exited-without-report' });
      expect(parentTestConsequence(observed)).toBe('reject-once');
      const finding = parentTestNoResultFinding({ parentTests: [observed] })!;
      expect(finding.coaching).toContain('killed or signalled');
      expect(finding.coaching).not.toContain('process.exit');
    }, 45_000);
  });

  describe.skipIf(!POSIX || ROOT)('permission bits the child controls', () => {
    it('refuses an entry the workspace owner cannot read as a typed, coached-once cause, never runner-error', async () => {
      const { root, box } = fixture({ 'add.ts': 'export const add = (a: number, b: number) => a + b;\n', 'src/.keep': '' });
      chmodSync(path.join(root, 'src/.keep'), 0o000);
      const observed = await run(box);
      expect(observed).toMatchObject({ status: 'unavailable', cause: 'snapshot-unreadable' });
      expect(observed.details).toContain('src/.keep');
      expect(parentTestConsequence(observed)).toBe('reject-once');
      expect(parentTestNoResultFinding({ parentTests: [observed] })!.coaching).toContain('Restore read permission');
    }, 45_000);

    it('keeps a red suite red when the code under test made the suite file unreadable', async () => {
      const add = "import { chmodSync } from 'node:fs';\nchmodSync('./atoma.acceptance.test.ts', 0);\nexport const add = (_a: number, _b: number) => 4;\n";
      const observed = await run(fixture({ 'add.ts': add }).box);
      // Whether Vitest still reads the suite after the chmod or not, the run is
      // the code under test's: red, rejected, never a host `runner-error`.
      expect(observed).toMatchObject({ status: 'failed', cause: 'ran' });
      expect(parentTestConsequence(observed)).toBe('reject');
    }, 45_000);

    it('removes its copy although the code under test left a directory without the owner write bit', async () => {
      savedTmp = process.env['TMPDIR'];
      const privateTmp = mkdtempSync(path.join(savedTmp ?? tmpdir(), 'atoma-third-review-tmp-'));
      dirs.push(privateTmp);
      const add = "import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('./locked');\nwriteFileSync('./locked/x', 'x');\nchmodSync('./locked', 0o555);\nexport const add = (a: number, b: number) => a + b;\n";
      const { box } = fixture({ 'add.ts': add });
      tmpOverridden = true;
      process.env['TMPDIR'] = privateTmp;
      const observed = await run(box);
      expect(observed.status).toBe('passed');
      expect(readdirSync(privateTmp).filter((name) => name.startsWith('atoma-acceptance-'))).toEqual([]);
    }, 45_000);
  });
});

describe('supersession follows the host clock, not branch order', () => {
  const ADD = suite(ADDS);
  const observed = (status: ParentTestObservation['status']): ParentTestObservation => ({
    suiteDigest: parentTestSuiteDigest(ADD), workspaceDigest: 'a'.repeat(64), status, cause: 'ran',
    passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, skipped: 0,
    details: JSON.stringify(['', { name: 'adds', status, failures: status === 'failed' ? ['AssertionError: expected 4 to be 5'] : [] }]),
  });

  it('does not let a sibling\'s earlier pass hide a later failure of the same suite in a parallel aggregate', async () => {
    // Branch 1 verifies first and passes; branch 0 verifies later, on the
    // final workspace, and fails. The aggregate lists branch 0 first.
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    const subtasks: Plan['subtasks'] = [{ description: 'shared contract, late' }, { description: 'shared contract, early' }];
    const plan = makePlan({ subtasks, aggregation: { mode: 'concat' } });
    const outcome = await dispatchWithAggregation(subtasks, plan, makeCtx(), async (_subtask, idx) => {
      if (idx === 0) await late;
      const tools: ToolExecutor = { has: (name) => name === 'run_shell', execute: async () => observed(idx === 0 ? 'failed' : 'passed') };
      const verified = await verifyParentTests({ description: 'add', acceptanceTests: ADD }, leaf(`branch ${idx}`), { ...makeCtx(), tools });
      if (idx === 1) releaseLate();
      return verified;
    }, { dispatcher: 'Tracheid' });
    const parentTests = outcome.results.flatMap((result) => result.parentTests ?? []);
    const [failure, pass] = parentTests;

    expect(failure?.status).toBe('failed');
    expect(pass?.status).toBe('passed');
    expect(failure!.observedAt!).toBeGreaterThan(pass!.observedAt!);
    const aggregate = leaf('both', { parentTests });
    expect(parentTestRejection(aggregate)).not.toBeNull();
    expect(parentTestsGrantNothing(aggregate, 'unjudged')).toBe(true);
    expect(dependencyBlocker(aggregate, 'Tracheid')).toBe('failed-suite');
    // The persisted record and every display read the same clock.
    const summary = summarizeParentTests({ parentTests: persistedParentTests(parentTests) }, { rows: 10, requirementChars: 100, detailsChars: 100, detailRows: 10 });
    expect(summary.records.supersededFailures).toBe(0);
    expect(summary.suites).toMatchObject({ failed: 1, passed: 0 });
  });

  it('still supersedes a failure a pass observed later replaced, whatever the order', () => {
    const failure: HeldParentTestObservation = { ...observed('failed'), observedAt: 1_000 };
    const pass: HeldParentTestObservation = { ...observed('passed'), observedAt: 2_000 };
    expect(parentTestRejection(leaf('later pass first', { parentTests: [pass, failure] }))).toBeNull();
    expect(parentTestRejection(leaf('later pass last', { parentTests: [failure, pass] }))).toBeNull();
  });

  it('falls back to record order for records that carry no clock', () => {
    expect(parentTestRejection(leaf('legacy', { parentTests: [observed('failed'), observed('passed')] }))).toBeNull();
    expect(parentTestRejection(leaf('legacy', { parentTests: [observed('passed'), observed('failed')] }))).not.toBeNull();
  });
});

describe('a failing set longer than its excerpt', () => {
  it('keys two sets that differ only past the cut apart', () => {
    const tests = (failing: readonly number[]) => ['', ...Array.from({ length: 14 }, (_, index) => {
      const name = `t${String(index + 1).padStart(2, '0')} ${'requirement '.repeat(6)}`;
      return failing.includes(index + 1)
        ? { name, status: 'failed', failures: [`AssertionError: ${'expected value to equal the contract '.repeat(4)}`] }
        : { name, status: 'passed', failures: [] };
    })];
    const rejection = (failing: readonly number[]) => parentTestRejection(leaf('done', { parentTests: [{
      suiteDigest: 'd'.repeat(64), workspaceDigest: 'a'.repeat(64), status: 'failed', cause: 'ran',
      passed: 14 - failing.length, failed: failing.length, skipped: 0, details: JSON.stringify(tests(failing)),
    }] }))!.reasoning;
    const first = Array.from({ length: 11 }, (_, index) => index + 1);
    const a = rejection([...first, 12]);
    const b = rejection([...first, 13]);

    expect(a).toContain('failing set');
    expect(a.length).toBeLessThan(1_400);
    expect(normalizeReason(a)).not.toBe(normalizeReason(b));
    // Identical sets still repeat: three escalate.
    expect(normalizeReason(rejection([...first, 12]))).toBe(normalizeReason(a));
  });
});
