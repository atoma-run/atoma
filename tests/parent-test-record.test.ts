import { describe, expect, it } from 'vitest';
import {
  PERSISTED_DETAILS_CHARS,
  PERSISTED_REQUIREMENT_CHARS,
  parentTestCauseSchema,
  parentTestRowSchema,
  persistedParentTestReaderSchema,
  persistedParentTestSchema,
  summarizeParentTests,
  type ParentTestLimits,
} from '../src/contracts/parentTestRecord.js';
import { parentTestSuperseded as coreSuperseded } from '../src/core/parentTests.js';
import { persistedParentTests, type HeldParentTestObservation } from '../src/contracts/parentTests.js';

/**
 * The one projection of persisted parent-test records (G6, 2026-10-16). Every
 * display (viz result view, receipt card, `atoma_run_review`) reads it, so a
 * drift in its states, ranking, counting or bounds shows in all of them.
 */

const LIMITS: ParentTestLimits = { rows: 12, requirementChars: 300, detailsChars: 600, detailRows: 6 };

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    suiteDigest: 'a'.repeat(64),
    workspaceDigest: 'b'.repeat(64),
    status: 'failed',
    cause: 'ran',
    passed: 1,
    failed: 1,
    skipped: 0,
    requirement: 'adds two numbers',
    details: '[{"title":"adds","status":"failed"}]',
    ...overrides,
  };
}

describe('the state of a run result', () => {
  it.each([
    ['undefined', undefined, 'not_recorded'],
    ['null', null, 'not_recorded'],
    ['an array', [], 'not_recorded'],
    ['a result without the field', {}, 'none'],
    ['an empty record list', { parentTests: [] }, 'recorded'],
  ] as const)('reads %s as %s', (_label, result, state) => {
    const summary = summarizeParentTests(result, LIMITS);
    expect(summary.state).toBe(state);
    expect(summary.observations).toEqual([]);
    expect(summary.suites.total).toBe(0);
  });

  it('counts a field that is not an array as one invalid record, never as a pass', () => {
    const summary = summarizeParentTests({ parentTests: 'x' }, LIMITS);
    expect(summary.state).toBe('recorded');
    expect(summary.records.invalid).toBe(1);
    expect(summary.suites.passed).toBe(0);
  });

  it('never reads summary prose: a historical prefix stays `none`', () => {
    const summary = summarizeParentTests({ summary: 'PARENT ACCEPTANCE TESTS (1 failed)\nwork' }, LIMITS);
    expect(summary.state).toBe('none');
  });
});

describe('ranking and counting', () => {
  it('lists open records first, then superseded, then passed, later records first within a rank', () => {
    const parentTests = [
      record({ suiteDigest: 'a1', status: 'failed', requirement: 'first failure' }),
      record({ suiteDigest: 'b1', status: 'passed', requirement: 'b passes' }),
      record({ suiteDigest: 'a1', status: 'passed', requirement: 'a passes later' }),
      record({ suiteDigest: 'c1', status: 'unavailable', cause: 'worker-missing', requirement: 'c did not run' }),
      record({ suiteDigest: 'd1', status: 'failed', requirement: 'd fails' }),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    const order = summary.observations.map(row => row.requirement);
    expect(order).toEqual(['d fails', 'c did not run', 'first failure', 'a passes later', 'b passes']);
    expect(summary.observations[2]!.superseded).toBe(true);
    expect(summary.records.supersededFailures).toBe(1);
  });

  it('counts each suite by its last record', () => {
    const parentTests = [
      record({ suiteDigest: 'a1', status: 'passed' }),
      record({ suiteDigest: 'a1', status: 'failed' }),
      record({ suiteDigest: 'b1', status: 'unavailable', cause: 'landing' }),
      record({ suiteDigest: 'c1', status: 'failed' }),
      record({ suiteDigest: 'c1', status: 'passed' }),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    expect(summary.suites).toEqual({ total: 3, passed: 1, failed: 1, unavailable: 1 });
  });

  it('keeps the last record per suite, workspace and status, and accounts for every one', () => {
    const parentTests = [
      record({ requirement: 'earlier copy', details: 'first' }),
      record({ requirement: 'later copy', details: 'second' }),
      record({ workspaceDigest: 'c'.repeat(64) }),
      ...Array.from({ length: 14 }, (_, n) => record({ suiteDigest: `s${n}`, status: 'passed' })),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    expect(summary.records.total).toBe(17);
    expect(summary.records.distinct).toBe(16);
    expect(summary.records.listed).toBe(12);
    expect(summary.records.omitted).toBe(4);
    expect(summary.records.listed + summary.records.omitted).toBe(summary.records.distinct);
    const kept = summary.observations.find(row => row.workspaceDigest === 'b'.repeat(64))!;
    expect(kept.requirement).toBe('later copy');
    expect(kept.details).toBe('second');
  });

  it('computes superseded before deduplication, so a kept failure keeps its own flag', () => {
    const parentTests = [
      record({ status: 'failed', details: 'old failure' }),
      record({ status: 'passed' }),
      record({ status: 'failed', details: 'new failure' }),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    const failure = summary.observations.find(row => row.status === 'failed')!;
    expect(failure.details).toBe('new failure');
    expect(failure.superseded).toBe(false);
  });

  it('follows core’s superseded rule over the valid records: an invalid pass supersedes nothing', () => {
    const parentTests = [
      record({ suiteDigest: 'a1', status: 'failed' }),
      { suiteDigest: 'a1', status: 'passed' },
      record({ suiteDigest: 'b1', status: 'passed' }),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    expect(summary.records.invalid).toBe(1);
    const failure = summary.observations.find(row => row.suiteDigest === 'a1')!;
    expect(failure.superseded).toBe(false);
    const valid = [parentTests[0], parentTests[2]] as unknown as Parameters<typeof coreSuperseded>[0];
    expect(coreSuperseded(valid, 0)).toBe(false);
  });

  it('supersedes across workspaces, keyed on the suite digest alone, as the gate does', () => {
    const parentTests = [
      record({ workspaceDigest: 'w1', status: 'failed' }),
      record({ workspaceDigest: 'w2', status: 'passed' }),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    expect(summary.observations.find(row => row.status === 'failed')!.superseded).toBe(true);
  });
});

describe('bounds and untrusted text', () => {
  it('keeps a row whose cause this binary does not know, with the cause unrecorded', () => {
    const summary = summarizeParentTests({ parentTests: [record({ status: 'unavailable', cause: 'from-the-future' })] }, LIMITS);
    expect(summary.records.invalid).toBe(0);
    expect(summary.observations[0]!.cause).toBeNull();
  });

  it('slices an over-length requirement instead of refusing the record', () => {
    const summary = summarizeParentTests({ parentTests: [record({ requirement: 'r'.repeat(5000) })] }, LIMITS);
    expect(summary.records.invalid).toBe(0);
    expect(summary.observations[0]!.requirement).toHaveLength(300);
  });

  it('replaces control characters other than newline and tab', () => {
    const summary = summarizeParentTests({ parentTests: [record({ requirement: 'a\u0007b\nc\td\u001b[31m', details: 'x\u0000y' })] }, LIMITS);
    expect(summary.observations[0]!.requirement).toBe('a�b\nc\td�[31m');
    expect(summary.observations[0]!.details).toBe('x�y');
  });

  it('keeps details only on the first open rows, cut and flagged', () => {
    const parentTests = [
      record({ suiteDigest: 'p1', status: 'passed', details: 'passed details' }),
      ...Array.from({ length: 8 }, (_, n) => record({ suiteDigest: `f${n}`, details: 'd'.repeat(700) })),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    const withDetails = summary.observations.filter(row => row.details !== null);
    expect(withDetails).toHaveLength(6);
    expect(withDetails.every(row => row.details!.length === 600 && row.detailsTruncated)).toBe(true);
    expect(summary.observations.find(row => row.status === 'passed')!.details).toBeNull();
  });

  it('carries an empty workspace digest as written, and a digest that is not hex as empty', () => {
    const parentTests = [
      record({ suiteDigest: 'a1', status: 'unavailable', cause: 'no-executor', workspaceDigest: '' }),
      record({ suiteDigest: '"'.repeat(5000), workspaceDigest: 'b'.repeat(65) }),
    ];
    const summary = summarizeParentTests({ parentTests }, LIMITS);
    expect(summary.observations.map(row => row.workspaceDigest)).toEqual(['', '']);
    expect(summary.observations[0]!.suiteDigest).toBe('');
  });

  it('replaces lone surrogates, including one a cut leaves behind', () => {
    const summary = summarizeParentTests({ parentTests: [record({ requirement: `${'r'.repeat(299)}😀`, details: 'a\ud800b' })] }, LIMITS);
    expect(summary.observations[0]!.requirement).toBe(`${'r'.repeat(299)}\uFFFD`);
    expect(summary.observations[0]!.details).toBe('a\uFFFDb');
  });

  it('produces rows that pass the strict row schema', () => {
    const summary = summarizeParentTests({ parentTests: [record(), record({ status: 'unavailable', cause: undefined, judged: true })] }, LIMITS);
    for (const row of summary.observations) expect(parentTestRowSchema.strict().safeParse(row).success).toBe(true);
  });
});

describe('the writer and the reader agree', () => {
  const held = (cause: (typeof parentTestCauseSchema.options)[number], judged: boolean): HeldParentTestObservation => ({
    suiteDigest: 'a'.repeat(64),
    suite: { requirement: 'q'.repeat(4000), cwd: '.', source: 'import { test } from "vitest"; test("SECRET_SOURCE", () => {});' },
    workspaceDigest: 'w'.repeat(64),
    status: cause === 'ran' ? 'failed' : 'unavailable',
    cause,
    passed: 0,
    failed: cause === 'ran' ? 1 : 0,
    skipped: 0,
    details: 'z'.repeat(4000),
    output: 'CHILD_OUTPUT',
    ...(judged ? { judged: true as const } : {}),
  });

  it.each(parentTestCauseSchema.options.flatMap(cause => [[cause, false], [cause, true]] as const))(
    'persists %s (judged=%s) in the writer shape the reader reads',
    (cause, judged) => {
      const [persisted] = persistedParentTests([held(cause, judged)]);
      expect(persistedParentTestSchema.strict().safeParse(persisted).success).toBe(true);
      expect(persistedParentTestReaderSchema.safeParse(persisted).success).toBe(true);
      expect(persisted!.requirement).toHaveLength(PERSISTED_REQUIREMENT_CHARS);
      expect(persisted!.details).toHaveLength(PERSISTED_DETAILS_CHARS);
      expect(JSON.stringify(persisted)).not.toMatch(/SECRET_SOURCE|CHILD_OUTPUT/);
      const summary = summarizeParentTests({ parentTests: [persisted] }, LIMITS);
      expect(summary.observations[0]!.cause).toBe(cause);
      expect(summary.observations[0]!.judged).toBe(judged);
    },
  );
});
